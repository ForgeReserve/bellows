import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';
import { log } from './log.ts';

// Kept from Forge AI so existing keys and clients that choose their own key keep working.
export const KEY_PREFIX = 'sk-forge-';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function newApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('base64url');
}

export function isApiKeyShape(k: string): boolean {
  return /^sk-forge-[A-Za-z0-9_-]{24,64}$/.test(k);
}

export interface Account {
  id: string;
  unit: Unit;
  balance_msub: number;
  invite_id: string | null;
  created_at: number;
}

export class LedgerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class Ledger {
  readonly db: DB;
  /**
   * Reservations settled by settle() in this process, so a repeated call returns the first result. Kept in
   * memory only: a settled reservation is deleted, because a row per request tied to a balance is what
   * "blind by default" rules out.
   */
  private readonly settled = new Map<string, { charged: number; accountId: string }>();
  /**
   * Reservations made by this process and not yet settled: the balance and amount each holds, and whether a
   * request is still serving it. Kept in memory on purpose: after a restart no request is live, so every
   * reservation left active is abandoned and the sweep may release it. The amount lets a reservation that
   * was released under a running request still be charged: a backstop for a broken one-process invariant
   * (an overlapping restart on the same file, say), not a supported topology (docs/PAYMENTS.md, Known limits).
   */
  private readonly holds = new Map<string, { accountId: string; amountMsub: number; live: boolean }>();
  constructor(db: DB) {
    this.db = db;
  }

  findByKey(key: string): Account | undefined {
    return this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at FROM accounts WHERE key_hash = ?').get(sha256(key)) as
      | Account
      | undefined;
  }

  get(id: string): Account | undefined {
    return this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at FROM accounts WHERE id = ?').get(id) as Account | undefined;
  }

  /** Must run inside a transaction when combined with other writes. */
  createAccountRaw(key: string, unit: Unit, inviteId: string | null): Account {
    const id = 'acct_' + randomUUID();
    this.db
      .prepare('INSERT INTO accounts (id, key_hash, unit, balance_msub, invite_id, created_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, sha256(key), unit, inviteId, now());
    return this.get(id)!;
  }

  /**
   * Raw credit; caller provides the transaction. A funded balance is no longer linked to the invite that
   * opened it (the link only lets an unfunded balance give its invite back).
   */
  creditRaw(accountId: string, msub: number, kind: string, ref: string | null) {
    this.db.prepare('UPDATE accounts SET balance_msub = balance_msub + ?, invite_id = NULL WHERE id = ?').run(msub, accountId);
    this.db.prepare('INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(accountId, kind, msub, ref, now());
    this.db.prepare('UPDATE invites SET account_id = NULL WHERE account_id = ?').run(accountId);
  }

  reservedMsub(accountId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(amount_msub), 0) AS s FROM reservations WHERE account_id = ? AND status = 'active'").get(accountId) as {
      s: number;
    };
    return r.s;
  }

  available(accountId: string): number {
    const a = this.get(accountId);
    if (!a) return 0;
    return a.balance_msub - this.reservedMsub(accountId);
  }

  /** Atomically holds msub against the balance. Throws insufficient_balance. */
  reserve(accountId: string, msub: number): string {
    const id = tx(this.db, () => {
      const a = this.get(accountId);
      if (!a) throw new LedgerError('invalid_key', 'unknown account', 401);
      if (this.isFrozen(accountId)) throw new LedgerError('account_frozen', 'this balance is frozen by the operator; refunds still work', 403);
      const avail = a.balance_msub - this.reservedMsub(accountId);
      if (avail < msub) {
        throw new LedgerError('insufficient_balance', `balance too low: need ${msub} msub, available ${avail} msub`, 402);
      }
      const id = 'res_' + randomUUID();
      this.db.prepare("INSERT INTO reservations (id, account_id, amount_msub, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(id, accountId, msub, now());
      return id;
    });
    this.holds.set(id, { accountId, amountMsub: msub, live: true });
    return id;
  }

  /** True while a request in this process is still serving this reservation (it has not settled or been disowned). */
  isLive(reservationId: string): boolean {
    return this.holds.get(reservationId)?.live === true;
  }

  /**
   * The request that made this reservation ended without settling (an error escaped it): the reservation is
   * abandoned, and the stale sweep releases it in this process.
   */
  disown(reservationId: string) {
    const h = this.holds.get(reservationId);
    if (h) h.live = false;
  }

  /**
   * Settles a reservation: charges min(actual, reserved), releases the rest and deletes the reservation.
   * Idempotent within this process: a second call on a settled reservation returns the first result.
   */
  settle(reservationId: string, actualMsub: number, _ref?: string, accountId?: string): { charged: number; balance: number; shortfall: number } {
    return tx(this.db, () => this.settleRaw(reservationId, actualMsub, accountId));
  }

  /**
   * settle() inside the caller's transaction. No per-request ledger row is written: the balance is the record.
   *
   * A reservation this process made that was released before it settled (this process's own sweep never
   * releases a live one, so only a second process on the same file can, which is unsupported: this is the
   * backstop for that broken invariant) is still charged min(actual, reserved),
   * capped at what the balance now covers (balance less its other active reservations). What the balance
   * could not cover is returned as `shortfall` and logged, without the balance id.
   *
   * A reservation this process never made settles as charged 0 and never throws. `accountId` is the
   * caller's fallback for the balance it reports in that case.
   */
  settleRaw(reservationId: string, actualMsub: number, accountId?: string): { charged: number; balance: number; shortfall: number } {
    const r = this.db.prepare('SELECT account_id, amount_msub FROM reservations WHERE id = ?').get(reservationId) as
      | { account_id: string; amount_msub: number }
      | undefined;
    if (!r) {
      const done = this.settled.get(reservationId);
      if (done) return { charged: done.charged, balance: this.get(done.accountId)?.balance_msub ?? 0, shortfall: 0 };
      const hold = this.holds.get(reservationId);
      if (hold) return this.settleReleasedRaw(reservationId, hold, actualMsub);
      log.warn('reservation_released', {});
      return { charged: 0, balance: accountId ? (this.get(accountId)?.balance_msub ?? 0) : 0, shortfall: 0 };
    }
    const charged = Math.max(0, Math.min(Math.ceil(actualMsub), r.amount_msub));
    if (charged > 0) this.db.prepare('UPDATE accounts SET balance_msub = balance_msub - ? WHERE id = ?').run(charged, r.account_id);
    this.db.prepare('DELETE FROM reservations WHERE id = ?').run(reservationId);
    this.holds.delete(reservationId);
    this.remember(reservationId, charged, r.account_id);
    return { charged, balance: this.get(r.account_id)!.balance_msub, shortfall: 0 };
  }

  /** A late charge for a reservation released before its request settled. */
  private settleReleasedRaw(reservationId: string, hold: { accountId: string; amountMsub: number }, actualMsub: number) {
    const owed = Math.max(0, Math.min(Math.ceil(actualMsub), hold.amountMsub));
    const balance = this.get(hold.accountId)?.balance_msub ?? 0;
    const charged = Math.min(owed, Math.max(0, balance - this.reservedMsub(hold.accountId)));
    const shortfall = owed - charged;
    if (charged > 0) this.db.prepare('UPDATE accounts SET balance_msub = balance_msub - ? WHERE id = ?').run(charged, hold.accountId);
    this.holds.delete(reservationId);
    this.remember(reservationId, charged, hold.accountId);
    log.warn('settled_after_release', { owed_msub: owed, charged_msub: charged, shortfall_msub: shortfall });
    return { charged, balance: balance - charged, shortfall };
  }

  private remember(reservationId: string, charged: number, accountId: string) {
    this.settled.set(reservationId, { charged, accountId });
    while (this.settled.size > 10_000) this.settled.delete(this.settled.keys().next().value!);
  }

  /**
   * On startup and periodically: releases (deletes), without charge, active reservations older than
   * olderThanMs that no request in this process is serving: those left by a crash or restart, or disowned
   * by a request that ended without settling. A reservation a running request
   * still holds is never released, however old.
   */
  releaseStale(olderThanMs: number): number {
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM reservations WHERE status = 'active' AND created_at <= ?").all(now() - olderThanMs) as Array<{ id: string }>;
      const del = this.db.prepare('DELETE FROM reservations WHERE id = ?');
      let n = 0;
      for (const { id } of rows) {
        if (this.isLive(id)) continue;
        del.run(id);
        this.holds.delete(id);
        n++;
      }
      return n;
    });
  }

  /** Debits whole units for a refund; caller provides the transaction. Returns msub debited. */
  debitRaw(accountId: string, msub: number, kind: string, ref: string) {
    const r = this.db.prepare('UPDATE accounts SET balance_msub = balance_msub - ? WHERE id = ? AND balance_msub >= ?').run(msub, accountId, msub);
    if (Number(r.changes) !== 1) throw new LedgerError('insufficient_balance', 'balance changed, retry', 409);
    this.db.prepare('INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(accountId, kind, -msub, ref, now());
  }

  isFrozen(accountId: string): boolean {
    const r = this.db.prepare('SELECT frozen_at FROM accounts WHERE id = ?').get(accountId) as { frozen_at: number | null } | undefined;
    return !!r?.frozen_at;
  }

  /** Operator freeze: blocks reserve() (all spending). Refunds (debitRaw) and credits still work. */
  setFrozen(accountId: string, frozen: boolean): boolean {
    const r = this.db.prepare('UPDATE accounts SET frozen_at = ? WHERE id = ?').run(frozen ? now() : null, accountId);
    return Number(r.changes) > 0;
  }

  /** Totals per unit: how many balances, what they hold, what is reserved and how many are frozen. Never one row per balance. */
  totals(): Array<{ unit: string; balances: number; balance_msub: number; reserved_msub: number; frozen: number }> {
    return this.db
      .prepare(
        `SELECT a.unit, COUNT(*) AS balances, COALESCE(SUM(a.balance_msub), 0) AS balance_msub,
           (SELECT COALESCE(SUM(r.amount_msub), 0) FROM reservations r JOIN accounts b ON b.id = r.account_id WHERE b.unit = a.unit AND r.status = 'active') AS reserved_msub,
           SUM(CASE WHEN a.frozen_at IS NULL THEN 0 ELSE 1 END) AS frozen
         FROM accounts a GROUP BY a.unit ORDER BY a.unit`,
      )
      .all() as Array<{ unit: string; balances: number; balance_msub: number; reserved_msub: number; frozen: number }>;
  }

  /** Total customer liability per unit, in msub. */
  liabilities(): Record<string, number> {
    const rows = this.db.prepare('SELECT unit, COALESCE(SUM(balance_msub), 0) AS s FROM accounts GROUP BY unit').all() as Array<{ unit: string; s: number }>;
    return Object.fromEntries(rows.map((r) => [r.unit, r.s]));
  }
}

export class Invites {
  readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  create(label?: string): { id: string; code: string } {
    const code = 'inv-' + randomBytes(12).toString('base64url');
    const id = 'invite_' + randomUUID();
    this.db.prepare("INSERT INTO invites (id, code_hash, label, status, created_at) VALUES (?, ?, ?, 'open', ?)").run(id, sha256(code), label ?? null, now());
    return { id, code };
  }

  lookup(code: string): { id: string; status: string; account_id: string | null } | undefined {
    return this.db.prepare('SELECT id, status, account_id FROM invites WHERE code_hash = ?').get(sha256(code)) as any;
  }

  /** Valid for NUT-24 use: exists and is not revoked. Counts uses. */
  checkForNut24(code: string | undefined): boolean {
    if (!code) return false;
    const inv = this.lookup(code);
    if (!inv || inv.status === 'revoked') return false;
    this.db.prepare('UPDATE invites SET nut24_uses = nut24_uses + 1 WHERE id = ?').run(inv.id);
    return true;
  }

  /** Redeems once, binding the invite to an account. Caller provides the transaction. */
  redeemRaw(code: string, accountId: string): string {
    const inv = this.lookup(code);
    if (!inv || inv.status === 'revoked') throw new LedgerError('invite_invalid', 'invite code is not valid', 403);
    if (inv.status === 'redeemed') throw new LedgerError('invite_used', 'invite code was already redeemed', 403);
    this.db.prepare("UPDATE invites SET status = 'redeemed', account_id = ?, redeemed_at = ? WHERE id = ?").run(accountId, now(), inv.id);
    return inv.id;
  }

  revoke(idOrCode: string): boolean {
    const r = this.db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ? OR code_hash = ?").run(idOrCode, sha256(idOrCode));
    return Number(r.changes) > 0;
  }

  /** The operator's invites. Never which balance redeemed one. */
  list() {
    return this.db.prepare('SELECT id, label, status, nut24_uses, created_at, redeemed_at FROM invites ORDER BY created_at').all();
  }
}
