/**
 * verifyBellows: fetch a Bellows' identity document, check its attestation with the app's verifier, and
 * accept it only when the attested build is on the approved-builds list. On any failure it throws, and
 * the caller sends nothing.
 */
import { type ApprovedBuild, type BuildsFile, findBuild, type Measurement, measurementEquals, measurementProblems, parseBuilds, parseMeasurement } from './builds.ts';
import { fromBase64, toHex } from './bytes.ts';
import { DEV_ATTESTATION_FORMAT } from './dev.ts';
import { BellowsVerifyError } from './errors.ts';
import { type KeyConfig, parseKeyConfig } from './hpke.ts';
import { type AttestationDocument, bindingFor, decodeStatement, IDENTITY_FORMAT, STORAGE_KINDS, type Storage, WELL_KNOWN_PATH } from './identity.ts';
import type { AttestationVerifier } from './verifier.ts';

export interface VerifyOptions {
  /** The approved builds: a builds.json object (checked here) or a list already checked. */
  approvedBuilds: BuildsFile | unknown;
  /** Hardware verification for the attestation formats the app accepts. */
  verifier: AttestationVerifier | readonly AttestationVerifier[];
  /** Accept the development stand-in. Never set this for real use: a stand-in proves nothing. */
  allowDevelopment?: boolean;
  /** fetch to use (default: the global one). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

export interface VerifiedBellows {
  /** The origin that was verified. */
  origin: string;
  /** The RFC 9458 key configuration, as served and bound. */
  keyConfig: Uint8Array;
  key: KeyConfig;
  /** The approved build the attestation proved. */
  build: ApprovedBuild;
  measurement: Measurement;
  relays: string[];
  operator: unknown;
  /**
   * Where this Bellows keeps balances, as its attested statement says. memory: every restart of the Bellows
   * loses every balance, so keep only what you are about to spend there. A statement without the field
   * (an older Bellows) reads as volume.
   */
  storage: Storage;
  /**
   * Memory storage: the most one balance may hold, per unit, in whole units (cents for usd), as the attested
   * statement says. Warn people before they fund past it; the Bellows refuses a credit that would pass it.
   * null: the statement states no cap.
   */
  balanceMax: Record<string, number> | null;
  /** True only for the development stand-in (allowDevelopment). */
  development: boolean;
  /** SHA-256 binding of the statement, hex. Changes on every restart of the Bellows (new key). */
  binding: string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function approvedList(input: unknown): readonly ApprovedBuild[] {
  if (Array.isArray(input)) return parseBuilds({ format: 'bellows-builds/v1', builds: input }).builds;
  return parseBuilds(input).builds;
}

export async function verifyBellows(url: string, opts: VerifyOptions): Promise<VerifiedBellows> {
  const builds = approvedList(opts.approvedBuilds);
  const verifiers = Array.isArray(opts.verifier) ? (opts.verifier as readonly AttestationVerifier[]) : [opts.verifier as AttestationVerifier];
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new BellowsVerifyError('fetch_failed', `not a URL: ${url}`);
  }
  const doFetch = opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let body: unknown;
  try {
    const res = await doFetch(origin + WELL_KNOWN_PATH, { signal: opts.signal, headers: { accept: 'application/json' }, redirect: 'error' });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (e) {
    throw new BellowsVerifyError('fetch_failed', `could not read ${origin}${WELL_KNOWN_PATH}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const badDoc = (why: string) => new BellowsVerifyError('bad_document', `identity document: ${why}`);
  if (!isObject(body) || body.format !== IDENTITY_FORMAT) throw badDoc(`format must be ${IDENTITY_FORMAT}`);
  if (typeof body.statement !== 'string') throw badDoc('statement is missing');
  const att = body.attestation;
  if (!isObject(att) || typeof att.format !== 'string') throw badDoc('attestation is missing');
  let bytes: Uint8Array;
  let st: unknown;
  try {
    ({ bytes, statement: st } = decodeStatement(body.statement));
  } catch {
    throw badDoc('statement is not base64 JSON');
  }
  if (!isObject(st)) throw badDoc('statement must be an object');
  if (typeof st.version !== 'string') throw badDoc('statement.version is missing');
  if (st.measurement !== null && measurementProblems(st.measurement, 'statement.measurement').length) throw badDoc('statement.measurement is malformed');
  if (!isObject(st.hpke) || typeof st.hpke.key_config !== 'string') throw badDoc('statement.hpke.key_config is missing');
  if (!Array.isArray(st.relays) || !st.relays.every((r) => typeof r === 'string')) throw badDoc('statement.relays must be a list of URLs');
  if (st.storage !== undefined && !(STORAGE_KINDS as readonly unknown[]).includes(st.storage)) throw badDoc(`statement.storage must be ${STORAGE_KINDS.join(' or ')}`);
  if (st.balance_max !== undefined && !(isObject(st.balance_max) && Object.values(st.balance_max).every((v) => Number.isSafeInteger(v) && (v as number) > 0))) {
    throw badDoc('statement.balance_max must map units to positive whole numbers');
  }

  const development = att.format === DEV_ATTESTATION_FORMAT;
  if (development && !opts.allowDevelopment) {
    throw new BellowsVerifyError('development_refused', 'this Bellows offers only a development stand-in, not hardware attestation');
  }
  const verifier = verifiers.find((v) => v.formats.includes(att.format as string));
  if (!verifier) throw new BellowsVerifyError('no_verifier', `no verifier for attestation format ${att.format}`);

  const binding = await bindingFor(bytes);
  let measurement: Measurement;
  try {
    const out = await verifier.verify(att as AttestationDocument, binding);
    measurement = parseMeasurement(out?.measurement, 'attested measurement');
  } catch (e) {
    // A malformed measurement from the verifier is an attestation failure, not a bad builds file.
    if (e instanceof BellowsVerifyError && e.code !== 'bad_builds') throw e;
    throw new BellowsVerifyError('attestation_invalid', `attestation refused: ${e instanceof Error ? e.message : String(e)}`);
  }
  const build = findBuild(builds, measurement);
  if (!build) throw new BellowsVerifyError('build_not_approved', `the attested build (${measurement.type} ${measurement.registers.join(',')}) is not on the approved list`);
  const claimed = st.measurement as Measurement | null;
  if (claimed && !measurementEquals(claimed, measurement)) throw new BellowsVerifyError('build_mismatch', 'the build the server claims is not the build its attestation proves');
  if (st.version !== build.version) throw new BellowsVerifyError('build_mismatch', `the server says version ${st.version}; the attested build is version ${build.version}`);

  let keyConfig: Uint8Array;
  try {
    keyConfig = fromBase64(st.hpke.key_config);
  } catch {
    throw new BellowsVerifyError('bad_key_config', 'HPKE key config is not base64');
  }
  const key = parseKeyConfig(keyConfig);
  return {
    origin,
    keyConfig,
    key,
    build,
    measurement,
    relays: [...(st.relays as string[])],
    operator: st.operator ?? null,
    storage: (st.storage as Storage | undefined) ?? 'volume',
    balanceMax: st.balance_max === undefined ? null : { ...(st.balance_max as Record<string, number>) },
    development,
    binding: toHex(binding),
  };
}
