/**
 * The NUT-13 wallet seed. It is derived from the wallet secret with HKDF-SHA256 and never written to the
 * database, so a restored volume and a fresh one agree on it as long as the same secret is released.
 *
 * Which seed is used, in order:
 *  1. BELLOWS_WALLET_SEED in the secrets source: a 64-byte hex seed used as is (what the variable of the
 *     same name did before secrets left the environment).
 *  2. A seed an earlier version stored in the database (meta.wallet_seed). It stays in use, so the outputs
 *     already derived from it can still be restored, and startup says so.
 *  3. The seed derived from BELLOWS_WALLET_SECRET.
 *
 * The database keeps a check value for the seed in use (an HMAC under the seed, which reveals nothing about
 * it). A later start with a different seed is refused: outputs written under one seed cannot be restored
 * under another. A database without a check value that already holds wallet state was written by an earlier
 * version that did not record its seed; it is refused unless the seed it ran with is supplied (or stored).
 */
import { createHmac, hkdfSync } from 'node:crypto';
import type { DB } from './db.ts';
import { LEGACY_WALLET_SEED, type SecretsSource, WALLET_SECRET } from './secrets.ts';

const HKDF_SALT = 'bellows';
const HKDF_INFO = 'bellows/wallet-seed/v1';
const CHECK_LABEL = 'bellows/wallet-seed-check/v1';

export type WalletSeedSource = 'derived' | 'stored' | 'legacy_secret';

export const WALLET_SECRET_RE = /^(?:[0-9a-f]{2}){32,}$/i;
export const LEGACY_SEED_RE = /^[0-9a-f]{128}$/i;

/** HKDF-SHA256 of the wallet secret (hex, at least 32 bytes) to a 64-byte BIP-39 style seed. */
export function deriveWalletSeed(secretHex: string): Uint8Array {
  if (!WALLET_SECRET_RE.test(secretHex)) throw new Error(`${WALLET_SECRET} must be at least 32 bytes of hex`);
  return new Uint8Array(hkdfSync('sha256', Buffer.from(secretHex, 'hex'), HKDF_SALT, HKDF_INFO, 64));
}

/** A value that identifies a seed without revealing it. */
export function walletSeedCheck(seed: Uint8Array): string {
  return createHmac('sha256', seed).update(CHECK_LABEL).digest('hex');
}

const meta = (db: DB, key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;

/** Whether the wallet has written anything: NUT-13 counters, proofs, or mint and melt operations. */
function hasWalletState(db: DB): boolean {
  return ['counters', 'proofs', 'incoming', 'outgoing'].some((t) => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get() !== undefined);
}

export function resolveWalletSeed(db: DB, secrets: SecretsSource): { seed: Uint8Array; source: WalletSeedSource } {
  const legacy = secrets.get(LEGACY_WALLET_SEED);
  const stored = meta(db, 'wallet_seed');
  const secret = secrets.get(WALLET_SECRET);
  let seed: Uint8Array;
  let source: WalletSeedSource;
  if (legacy) {
    if (!LEGACY_SEED_RE.test(legacy)) throw new Error(`${LEGACY_WALLET_SEED} must be 64 bytes of hex`);
    seed = new Uint8Array(Buffer.from(legacy, 'hex'));
    source = 'legacy_secret';
  } else if (stored) {
    seed = new Uint8Array(Buffer.from(stored, 'hex'));
    source = 'stored';
  } else if (secret) {
    seed = deriveWalletSeed(secret);
    source = 'derived';
  } else {
    throw new Error(`no wallet secret: set ${WALLET_SECRET} in the secrets source (${secrets.where})`);
  }
  const check = walletSeedCheck(seed);
  const known = meta(db, 'wallet_seed_check');
  if (known && known !== check) {
    throw new Error(
      `the wallet seed in use (${source}) is not the one this database was written under: release the same wallet secret (or ${LEGACY_WALLET_SEED}) the database ran with, and remove the other`,
    );
  }
  if (!known) {
    // No check value yet: either a fresh database or one written by a version that did not record its seed.
    // Fail closed, because outputs written under one seed cannot be restored under another.
    if (stored && legacy && stored.toLowerCase() !== legacy.toLowerCase()) {
      throw new Error(`${LEGACY_WALLET_SEED} in the secrets source differs from the seed this database stored`);
    }
    if (source === 'derived' && hasWalletState(db)) {
      throw new Error(
        `this database holds wallet state from an earlier version that did not record its seed: put the ${LEGACY_WALLET_SEED} it ran with in the secrets source`,
      );
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('wallet_seed_check', ?)").run(check);
  }
  return { seed, source };
}
