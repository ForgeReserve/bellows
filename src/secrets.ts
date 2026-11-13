/**
 * Secrets: supplier API keys, the wallet secret and the admin token. They come from exactly one source,
 * never from environment literals in a deploy config:
 *  - file: a JSON object of name to value, mode 0600. For development and for hosts without a secret store.
 *  - platform: the secrets the hosting platform releases to the sealed machine after it has proved which
 *    build is running. They reach the process as environment variables set by the platform, not by the
 *    deploy config (NOT VERIFIED on real sealed hardware; see docs/DESIGN.md, S3).
 *  - memory: values held in the process only (tests, and a development database kept in memory).
 *
 * Error messages name a secret, never its value.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SecretsKind = 'file' | 'platform' | 'memory';

export interface SecretsSource {
  readonly kind: SecretsKind;
  /** Where the values come from, for the startup line: a file path or the source kind. Never a value. */
  readonly where: string;
  /** The value, or undefined when it is unset or empty. */
  get(name: string): string | undefined;
}

/** Wallet secret: at least 32 random bytes as hex. The NUT-13 wallet seed is derived from it (src/wallet-seed.ts). */
export const WALLET_SECRET = 'BELLOWS_WALLET_SECRET';
/** A 64-byte hex seed used as is, as BELLOWS_WALLET_SEED was before secrets moved out of the environment. */
export const LEGACY_WALLET_SEED = 'BELLOWS_WALLET_SEED';
/** The admin token itself; only its SHA-256 is kept in memory. */
export const ADMIN_TOKEN = 'BELLOWS_ADMIN_TOKEN';
/** Or the SHA-256 (hex) of the admin token, so the token itself need not be stored anywhere. */
export const ADMIN_TOKEN_HASH = 'BELLOWS_ADMIN_TOKEN_HASH';
/** Optional Tinfoil admin key for the credit figures in the admin overview. */
export const TINFOIL_ADMIN_KEY = 'TINFOIL_ADMIN_KEY';

/** Secret names that do not depend on the model catalog. Supplier keys are named by apiKeySecret there. */
export const FIXED_SECRET_NAMES = [WALLET_SECRET, LEGACY_WALLET_SEED, ADMIN_TOKEN, ADMIN_TOKEN_HASH, TINFOIL_ADMIN_KEY] as const;

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function memorySecrets(values: Record<string, string | undefined>): SecretsSource {
  const copy = { ...values };
  return { kind: 'memory', where: 'memory', get: (name) => nonEmpty(copy[name]) };
}

/**
 * Secrets released by the hosting platform. On the first target platform these are environment variables
 * the platform sets inside the sealed machine (NOT VERIFIED there).
 */
export function platformSecrets(env: NodeJS.ProcessEnv): SecretsSource {
  return { kind: 'platform', where: 'platform', get: (name) => nonEmpty(env[name]) };
}

/** Reads a JSON secrets file once. Refuses a file other users can read, and never echoes its content. */
export function fileSecrets(path: string): SecretsSource {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`secrets file ${path} is missing`);
  }
  if (!st.isFile()) throw new Error(`secrets file ${path} is not a regular file`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`secrets file ${path} can be read by other users: run chmod 600 on it`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // The parser's own message quotes the file, which may hold a secret.
    throw new Error(`secrets file ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`secrets file ${path} must hold a JSON object of name to value`);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`secrets file ${path}: ${name} must be a string`);
    values[name] = value;
  }
  return { kind: 'file', where: path, get: (name) => nonEmpty(values[name]) };
}

/** A fresh wallet secret: 32 random bytes as hex. */
export function newWalletSecret(): string {
  return randomBytes(32).toString('hex');
}

export interface PendingSecretsFile {
  readonly path: string;
  /** Writes the file (mode 0600). Fails if it exists by then. */
  write(): void;
}

/**
 * A development secrets file that does not exist yet: a new wallet secret, served from memory now and
 * written to `path` by write().
 */
export function pendingDevSecrets(path: string): PendingSecretsFile & { source: SecretsSource } {
  const values: Record<string, string> = { [WALLET_SECRET]: newWalletSecret() };
  return {
    path,
    source: { kind: 'file', where: path, get: (name) => nonEmpty(values[name]) },
    write() {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(values, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    },
  };
}
