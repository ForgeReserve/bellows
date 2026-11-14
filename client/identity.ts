/**
 * The identity document a Bellows serves at /.well-known/bellows:
 *
 *   {
 *     "format": "bellows-identity/v1",
 *     "statement": "<base64 of the statement JSON bytes>",
 *     "attestation": { "format": "<attestation format URI>", ... }
 *   }
 *
 * The statement holds everything a client acts on: the Bellows version, the build measurement it claims, its
 * HPKE key configuration, its relays, its operator announcement, where it keeps balances (storage) and, for
 * memory storage, the most one balance may hold (balance_max). The statement travels as base64 so the
 * exact bytes are hashed, never a re-serialization. The attestation binds
 *
 *   binding = SHA-256( "bellows-identity/v1" || 0x00 || statement bytes )
 *
 * which is the 32-byte value the attester was given (its report data). Whoever stands between the client
 * and the sealed machine cannot change the key, the relays or the announcement without breaking that hash.
 */
import { fromBase64, sha256, utf8Decode, utf8Encode } from './bytes.ts';
import type { Measurement } from './builds.ts';

export const IDENTITY_FORMAT = 'bellows-identity/v1';
export const WELL_KNOWN_PATH = '/.well-known/bellows';

/**
 * Where a Bellows keeps its database. volume: on the encrypted volume, so balances survive a restart.
 * memory: in memory inside the sealed machine, so every restart loses every balance.
 */
export const STORAGE_KINDS = ['volume', 'memory'] as const;
export type Storage = (typeof STORAGE_KINDS)[number];

export interface Statement {
  /** The Bellows release version the server says it runs. */
  version: string;
  /** The measurement the server says it has; the client trusts only the one the attestation proves. */
  measurement: Measurement | null;
  hpke: {
    /** RFC 9458 key configuration, base64. */
    key_config: string;
  };
  /** Oblivious HTTP relays for this Bellows (URLs). */
  relays: string[];
  /** The operator's announcement, as the operator published it, or null. */
  operator: unknown;
  /** Where balances are kept (BELLOWS_STORAGE). A statement without it comes from an older Bellows: volume. */
  storage?: Storage;
  /**
   * Memory storage only: the most one balance may hold, per unit ("sat", "usd"), in whole units (cents for
   * usd). Absent: no cap is stated.
   */
  balance_max?: Record<string, number>;
}

/** An attestation document. `format` picks the verifier; the rest belongs to that format. */
export interface AttestationDocument {
  format: string;
  [k: string]: unknown;
}

export interface IdentityDocument {
  format: typeof IDENTITY_FORMAT;
  statement: string;
  attestation: AttestationDocument;
}

/** The 32 bytes the attestation must bind for these statement bytes. */
export function bindingFor(statementBytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(utf8Encode(IDENTITY_FORMAT), new Uint8Array([0]), statementBytes);
}

export function encodeStatement(s: Statement): Uint8Array<ArrayBuffer> {
  return utf8Encode(JSON.stringify(s));
}

export function decodeStatement(b64: string): { bytes: Uint8Array<ArrayBuffer>; statement: unknown } {
  const bytes = fromBase64(b64);
  return { bytes, statement: JSON.parse(utf8Decode(bytes)) as unknown };
}
