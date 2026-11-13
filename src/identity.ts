/**
 * Enclave identity (docs/DESIGN.md, S4). At boot Bellows makes an HPKE key pair in memory, writes a
 * statement (version, claimed measurement, key configuration, relays, operator announcement, storage),
 * asks the platform's attester for an attestation that binds the statement's hash, and serves the result
 * at /.well-known/bellows. The private key never leaves memory and is new on every boot.
 *
 * The attestation is made again every BELLOWS_ATTEST_REFRESH_MINUTES (platform collateral such as freshness
 * witnesses ages), over the same statement. While a refresh fails, the last good document is served.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomInt } from 'node:crypto';
import { toBase64 } from '../client/bytes.ts';
import type { Measurement } from '../client/builds.ts';
import { AEAD_AES_128_GCM, encodeKeyConfig, KDF_HKDF_SHA256, KEM_X25519_HKDF_SHA256, type KeyConfig } from '../client/hpke.ts';
import { type AttestationDocument, bindingFor, encodeStatement, IDENTITY_FORMAT, type IdentityDocument, type Statement, type Storage } from '../client/identity.ts';
import { devAttester } from './attest/dev.ts';
import { AttestationUnavailable, tinfoilAttester } from './attest/tinfoil.ts';
import type { Config } from './config.ts';
import { errText, log } from './log.ts';

export type AttesterKind = 'dev' | 'tinfoil';

/** Hardware attestation for one platform: a document that binds the 32-byte reportData. */
export interface Attester {
  readonly kind: AttesterKind;
  attest(reportData: Uint8Array): Promise<AttestationDocument>;
}

/** The cipher suites the key configuration offers. */
export const HPKE_SUITES = [{ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM }];

export interface HpkeKeyPair {
  config: KeyConfig;
  /** RFC 9458 encoding of `config`. */
  keyConfig: Uint8Array;
  /** X25519 private key. In memory only; never logged or serialized. */
  privateKey: KeyObject;
}

export function generateHpkeKeyPair(keyId = randomInt(256)): HpkeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (!x) throw new Error('X25519 public key export failed');
  const config: KeyConfig = { keyId, kemId: KEM_X25519_HKDF_SHA256, publicKey: new Uint8Array(Buffer.from(x, 'base64url')), suites: HPKE_SUITES };
  return { config, keyConfig: encodeKeyConfig(config), privateKey };
}

export interface IdentityOptions {
  attester: Attester;
  version: string;
  measurement: Measurement | null;
  relays: string[];
  operator: unknown;
  /** Where balances are kept (BELLOWS_STORAGE). Default: volume. */
  storage?: Storage;
  /** Make the attestation again after this long. */
  refreshMs: number;
  /** After a failed attestation, wait this long before trying again (requests meanwhile get 503). */
  retryMs?: number;
  now?: () => number;
  keyPair?: HpkeKeyPair;
}

export class Identity {
  readonly attesterKind: AttesterKind;
  readonly keyConfig: Uint8Array;
  readonly keyId: number;
  /** SHA-256 of the key configuration, hex: safe to log, changes on every boot. */
  readonly keyConfigSha256: string;
  readonly statement: Statement;
  readonly statementBytes: Uint8Array;
  readonly #privateKey: KeyObject;
  readonly #attester: Attester;
  readonly #refreshMs: number;
  readonly #retryMs: number;
  readonly #now: () => number;
  #current?: { doc: IdentityDocument; at: number };
  #pending?: Promise<IdentityDocument>;
  #failedAt?: number;
  #lastError = '';
  #timer?: ReturnType<typeof setInterval>;

  constructor(o: IdentityOptions) {
    const pair = o.keyPair ?? generateHpkeKeyPair();
    this.#privateKey = pair.privateKey;
    this.#attester = o.attester;
    this.#refreshMs = o.refreshMs;
    this.#retryMs = o.retryMs ?? 5_000;
    this.#now = o.now ?? Date.now;
    this.attesterKind = o.attester.kind;
    this.keyConfig = pair.keyConfig;
    this.keyId = pair.config.keyId;
    this.keyConfigSha256 = createHash('sha256').update(pair.keyConfig).digest('hex');
    this.statement = {
      version: o.version,
      measurement: o.measurement,
      hpke: { key_config: toBase64(pair.keyConfig) },
      relays: [...o.relays],
      operator: o.operator ?? null,
      storage: o.storage ?? 'volume',
    };
    this.statementBytes = encodeStatement(this.statement);
  }

  /** The HPKE private key, for the Oblivious HTTP gateway. Never serialize or log it. */
  hpkePrivateKey(): KeyObject {
    return this.#privateKey;
  }

  /** Whether a document has been made, and the last failure if any. Never key material. */
  status(): { attested: boolean; attester: AttesterKind; ageSeconds?: number; lastError?: string } {
    const c = this.#current;
    return {
      attested: !!c,
      attester: this.attesterKind,
      ageSeconds: c ? Math.round((this.#now() - c.at) / 1000) : undefined,
      lastError: this.#failedAt !== undefined ? this.#lastError : undefined,
    };
  }

  /**
   * The identity document. Attests on first use and when the last one is older than the refresh interval.
   * A refresh runs in the background while the previous document is served. Throws
   * AttestationUnavailable when no document has been made yet and the attester fails.
   */
  async document(): Promise<IdentityDocument> {
    const now = this.#now();
    const c = this.#current;
    if (c && now - c.at < this.#refreshMs) return c.doc;
    if (this.#pending) return c ? c.doc : this.#pending;
    if (this.#failedAt !== undefined && now - this.#failedAt < this.#retryMs) {
      if (c) return c.doc;
      throw new AttestationUnavailable(`not attested yet: ${this.#lastError}`);
    }
    const p = this.#refresh();
    if (c) {
      p.catch(() => {});
      return c.doc;
    }
    return p;
  }

  #refresh(): Promise<IdentityDocument> {
    const run = async () => {
      try {
        const binding = await bindingFor(this.statementBytes);
        const attestation = await this.#attester.attest(binding);
        const doc: IdentityDocument = { format: IDENTITY_FORMAT, statement: toBase64(this.statementBytes), attestation };
        this.#current = { doc, at: this.#now() };
        this.#failedAt = undefined;
        log.info('attested', { attester: this.attesterKind, format: attestation.format, hpke_key_sha256: this.keyConfigSha256 });
        return doc;
      } catch (e) {
        this.#failedAt = this.#now();
        this.#lastError = errText(e);
        log.warn('attestation_failed', { attester: this.attesterKind, err: this.#lastError, serving_previous: !!this.#current });
        throw e instanceof AttestationUnavailable ? e : new AttestationUnavailable(errText(e));
      } finally {
        this.#pending = undefined;
      }
    };
    this.#pending = run();
    return this.#pending;
  }

  /** Attest now, then keep the document fresh. */
  start(): void {
    this.document().catch(() => {});
    this.#timer ??= setInterval(() => this.document().catch(() => {}), Math.min(this.#refreshMs, 60_000));
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/** The attester the configuration names. */
export function configuredAttester(config: Config): Attester {
  if (config.attester === 'tinfoil') return tinfoilAttester({ socketPath: config.env.BELLOWS_TINFOIL_ATTESTATION_SOCKET });
  return devAttester({ measurement: config.buildMeasurement! });
}

export function createIdentity(config: Config, attester: Attester = configuredAttester(config)): Identity {
  return new Identity({
    attester,
    version: config.version,
    measurement: config.buildMeasurement,
    relays: config.env.BELLOWS_RELAYS,
    operator: config.operatorAnnouncement,
    storage: config.storage,
    refreshMs: config.env.BELLOWS_ATTEST_REFRESH_MINUTES * 60_000,
  });
}
