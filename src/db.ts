import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateRequestRows } from './usage.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Prepaid balances. Only a SHA-256 of the bearer key is stored.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL,
  balance_msub INTEGER NOT NULL DEFAULT 0 CHECK (balance_msub >= 0),
  invite_id TEXT,
  created_at INTEGER NOT NULL,
  frozen_at INTEGER                 -- set by the operator: spending blocked, refunds allowed
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount_msub INTEGER NOT NULL,
  status TEXT NOT NULL,             -- active | settled | released
  charged_msub INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS reservations_active ON reservations(account_id, status);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- topup | charge | refund
  amount_msub INTEGER NOT NULL,     -- signed
  ref TEXT,
  created_at INTEGER NOT NULL
);

-- Incoming tokens (topups and NUT-24 payments). token_hash makes redemption idempotent.
CREATE TABLE IF NOT EXISTS incoming (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,            -- topup | nut24
  account_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL,             -- new | prepared | done | rejected
  preview TEXT,                     -- serialized SwapPreview (NUT-19 replay)
  counters TEXT,                    -- JSON {keysetId,start,count} (NUT-09 restore)
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outgoing tokens (change, refunds, revenue export).
CREATE TABLE IF NOT EXISTS outgoing (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,            -- change | refund | export
  account_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL,             -- owed | reserved | prepared | done | failed
  inputs TEXT,                      -- JSON array of proof secrets reserved for this op
  preview TEXT,
  counters TEXT,
  token TEXT,
  error TEXT,
  lock_pubkey TEXT,                 -- NUT-11: send outputs locked to this key (random secrets, not NUT-13)
  pinned INTEGER NOT NULL DEFAULT 0, -- 1: pays out exactly the proofs reserved under op_id = id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outgoing_request ON outgoing(request_id);
CREATE INDEX IF NOT EXISTS outgoing_account ON outgoing(account_id);

-- The gateway's own eCash wallet.
CREATE TABLE IF NOT EXISTS proofs (
  secret TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  keyset_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  proof TEXT NOT NULL,
  state TEXT NOT NULL,              -- unspent | reserved | spent | recovered (held aside, recovered_funds)
  op_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proofs_state ON proofs(mint, unit, state);

-- NUT-13 deterministic secret counters per mint keyset.
CREATE TABLE IF NOT EXISTS counters (
  mint TEXT NOT NULL,
  keyset_id TEXT NOT NULL,
  next INTEGER NOT NULL,
  PRIMARY KEY (mint, keyset_id)
);

-- eCash a counter scan found at the mint under this wallet's seed, unspent, and that no row here accounts
-- for: what stood behind balances an earlier database held (memory storage, a lost volume), and possibly
-- payouts people have not redeemed yet. Its proofs are kept in state 'recovered', never spent by Bellows
-- and owed to no balance; the operator decides what to do with it. One row per scan of a mint and unit.
CREATE TABLE IF NOT EXISTS recovered_funds (
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  proofs INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL,             -- open | redeemed | revoked
  account_id TEXT,
  nut24_uses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER
);

-- Funding a balance through the funding mint: Lightning (NUT-04 bolt11), on-chain (NUT-30) or eCash
-- from another mint (received there, melted to pay a bolt11 quote at the funding mint). Keys never appear here.
CREATE TABLE IF NOT EXISTS fundings (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,             -- lightning | onchain | foreign
  account_id TEXT NOT NULL,
  unit TEXT NOT NULL,               -- balance unit = unit of the funding mint quote
  mint TEXT NOT NULL,               -- funding mint
  quote TEXT,                       -- funding mint quote id
  request TEXT,                     -- bolt11 invoice or bitcoin address
  amount INTEGER,                   -- units to mint (lightning, foreign); NULL for onchain
  expires_at INTEGER,               -- ms; for onchain: end of the watch window
  lock_key TEXT,                    -- onchain: NUT-20 private key the quote is locked to
  state TEXT NOT NULL,              -- quoted | receiving | melting | pending | minting | done | expired | failed | refunded
  credited INTEGER NOT NULL DEFAULT 0,
  mint_op TEXT,                     -- JSON: in-flight mint (amount, outputs, counters); NUT-19 replay / NUT-09 restore
  next_check INTEGER NOT NULL DEFAULT 0,
  observed TEXT,                    -- JSON: last quote state seen at the mint
  f_mint TEXT,                      -- foreign: the token's mint
  f_unit TEXT,
  f_token_hash TEXT,
  f_amount INTEGER,                 -- foreign: token value after its input fees
  f_melt_quote TEXT,
  f_fee_max INTEGER,                -- foreign: most the foreign mint can keep (input fees + fee reserve)
  f_melt_op TEXT,                   -- JSON: in-flight melt (outputs, counters)
  f_attempts INTEGER NOT NULL DEFAULT 0,
  f_change_token TEXT,
  f_refund_token TEXT,
  f_lock_pubkey TEXT,               -- foreign: lock change and refund tokens to this key (NUT-11)
  f_unlisted INTEGER NOT NULL DEFAULT 0, -- foreign: 1 when the customer chose a mint that is not accepted (lower cap)
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS fundings_quote ON fundings(mint, quote);
CREATE INDEX IF NOT EXISTS fundings_due ON fundings(state, next_check);
CREATE INDEX IF NOT EXISTS fundings_account ON fundings(account_id);

-- Other mints the operator accepts through the admin API, on top of BELLOWS_FOREIGN_ALLOW. url is the
-- normalized key (mintKey in funding.ts); name is the mint's own /v1/info name at the time it was added.
CREATE TABLE IF NOT EXISTS operator_mints (
  url TEXT PRIMARY KEY,
  name TEXT,
  note TEXT,
  added_at INTEGER NOT NULL
);

-- Revenue exports from the admin API or CLI. The token itself is never stored here (the payout row
-- in outgoing holds it for re-delivery, as for every payout); this is the operator's history.
CREATE TABLE IF NOT EXISTS revenue_exports (
  id TEXT PRIMARY KEY,
  outgoing_id TEXT NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  lock_pubkey TEXT,
  source TEXT NOT NULL,             -- admin | cli
  token_hash TEXT,                  -- sha256 of the issued token, set once it is issued
  created_at INTEGER NOT NULL,
  delivered_at INTEGER              -- when the token was handed to the operator (shown once)
);

CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id);

-- Requests in flight that were paid with eCash (NUT-24): what crash recovery needs to return the payment as
-- change. A row is deleted when its request settles; balance payments have no row (their reservation is the hold).
-- No prompt or completion content, and nothing tied to a balance.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  payment TEXT NOT NULL,            -- nut24
  unit TEXT NOT NULL,
  model TEXT NOT NULL,
  supplier TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,             -- new | paid | running | failed (payment outcome still unknown)
  reserved_msub INTEGER,
  paid_units INTEGER,
  lock_pubkey TEXT,                 -- X-Cashu-Pubkey: change is locked to it
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);

-- Billing aggregates: one row per UTC day, unit, model and supplier (src/usage.ts). fit_* are the sums the
-- admin cost fit needs (input x input, input x output, output x output, input x cost, output x cost) over
-- requests whose cost the supplier reported.
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  unit TEXT NOT NULL,
  model TEXT NOT NULL,
  supplier TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  encrypted INTEGER NOT NULL DEFAULT 0,
  nut24 INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  charged_msub INTEGER NOT NULL DEFAULT 0,
  shortfall_msub INTEGER NOT NULL DEFAULT 0, -- owed by requests settled after their reservation was released, not covered by the balance
  price_nusd INTEGER NOT NULL DEFAULT 0,
  cost_nusd INTEGER NOT NULL DEFAULT 0,
  supplier_reported INTEGER NOT NULL DEFAULT 0,
  fit_ii REAL NOT NULL DEFAULT 0,
  fit_io REAL NOT NULL DEFAULT 0,
  fit_oo REAL NOT NULL DEFAULT 0,
  fit_ic REAL NOT NULL DEFAULT 0,
  fit_oc REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, unit, model, supplier)
);
`;

/** Columns added after the first release: CREATE TABLE IF NOT EXISTS does not add them to an existing file. */
const ADDED_COLUMNS: Array<[table: string, column: string, decl: string]> = [
  ['outgoing', 'lock_pubkey', 'TEXT'],
  ['outgoing', 'pinned', 'INTEGER NOT NULL DEFAULT 0'],
  ['fundings', 'f_lock_pubkey', 'TEXT'],
  ['requests', 'lock_pubkey', 'TEXT'],
  ['accounts', 'frozen_at', 'INTEGER'],
  ['fundings', 'f_unlisted', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_daily', 'shortfall_msub', 'INTEGER NOT NULL DEFAULT 0'],
];

export type DB = DatabaseSync;

/**
 * Refuses to start a new database next to an existing forge.db. A Forge AI image set its database path
 * itself, so an upgrade on the same volume would otherwise open an empty database with a fresh wallet
 * while the old balances, owed payouts and in-flight fundings sit unread in forge.db.
 */
export function refuseOrphanedForgeDb(path: string): void {
  if (path === ':memory:' || existsSync(path)) return;
  if (existsSync(join(dirname(path), 'forge.db'))) {
    throw new Error(`found forge.db next to ${path}: set BELLOWS_DB_PATH to it or rename it (docs/MIGRATE-FROM-FORGE-AI.md)`);
  }
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  tx(db, () => forgetClients(db));
  return db;
}

/** Per-request columns an earlier release kept in requests (with the balance id). Dropped once folded into usage_daily. */
const OLD_REQUEST_COLUMNS = ['account_id', 'input_tokens', 'output_tokens', 'usage_source', 'charged_msub', 'change_units', 'latency_ms', 'price_nusd', 'supplier_cost_nusd', 'cost_source'];

/**
 * Brings a database from an earlier release to "blind by default", and is a no-op on one that is already
 * there: per-request rows become daily aggregates, settled reservations and per-request ledger charges go,
 * and an invite is unlinked from a balance once that balance has been funded.
 */
function forgetClients(db: DB) {
  migrateRequestRows(db);
  const cols = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.includes('account_id')) db.exec('DROP INDEX IF EXISTS requests_account');
  for (const c of OLD_REQUEST_COLUMNS) if (cols.includes(c)) db.exec(`ALTER TABLE requests DROP COLUMN ${c}`);
  db.prepare("DELETE FROM requests WHERE payment = 'balance'").run();
  db.prepare("DELETE FROM reservations WHERE status <> 'active'").run();
  db.prepare("DELETE FROM ledger WHERE kind = 'charge'").run();
  const funded = 'SELECT a.id FROM accounts a WHERE a.balance_msub > 0 OR EXISTS (SELECT 1 FROM ledger l WHERE l.account_id = a.id)';
  db.prepare(`UPDATE invites SET account_id = NULL WHERE account_id IN (${funded})`).run();
  db.prepare(`UPDATE accounts SET invite_id = NULL WHERE invite_id IS NOT NULL AND id IN (${funded})`).run();
}

/** Runs fn inside BEGIN IMMEDIATE / COMMIT. fn must be synchronous. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function now(): number {
  return Date.now();
}
