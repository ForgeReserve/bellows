import { PaymentError } from './cashu/wallet.ts';
import type { Unit } from './config.ts';
import { type DB, tx } from './db.ts';
import { type Account, type Invites, isApiKeyShape, type Ledger, LedgerError, newApiKey } from './ledger.ts';
import { MSUB_PER_UNIT } from './pricing.ts';

/** Funding states that may still credit the balance. */
export const OPEN_FUNDING_STATES = ['quoted', 'receiving', 'melting', 'pending', 'minting'] as const;

export interface OpenedAccount {
  account: Account;
  /** The bearer key, only when the gateway generated it (return it to the client once). */
  generatedKey?: string;
  /** true when this call created the balance (and redeemed the invite). */
  created: boolean;
}

/**
 * Finds the balance for a bearer key, or opens a new one. Shared by every funding method so the
 * invite rule is the same everywhere: a new balance needs an open invite while invite-only, and
 * redeeming it binds the invite to the balance. Only a SHA-256 of the key is stored.
 */
export function openAccount(
  d: { db: DB; ledger: Ledger; invites: Invites; inviteOnly: boolean },
  p: { key?: string; invite?: string; unit: Unit },
): OpenedAccount {
  const { db, ledger, invites } = d;
  if (p.key) {
    const a = ledger.findByKey(p.key);
    if (a) {
      if (a.unit !== p.unit) throw new LedgerError('wrong_unit', `this balance is in ${a.unit}; this funding is in ${p.unit}`);
      return { account: a, created: false };
    }
    if (!isApiKeyShape(p.key)) throw new LedgerError('invalid_key', 'unknown balance key', 401);
  }
  if (d.inviteOnly) {
    const inv = p.invite ? invites.lookup(p.invite) : undefined;
    if (!inv) throw new LedgerError('invite_required', 'an invite code is required to open a balance', 403);
    if (inv.status === 'redeemed') throw new LedgerError('invite_used', 'invite code was already redeemed', 403);
    if (inv.status !== 'open') throw new LedgerError('invite_invalid', 'invite code is not valid', 403);
  }
  const key = p.key ?? newApiKey();
  const account = tx(db, () => {
    const a = ledger.createAccountRaw(key, p.unit, null);
    if (d.inviteOnly) {
      const inviteId = invites.redeemRaw(p.invite!, a.id);
      db.prepare('UPDATE accounts SET invite_id = ? WHERE id = ?').run(inviteId, a.id);
    }
    return ledger.get(a.id)!;
  });
  return { account, generatedKey: p.key ? undefined : key, created: true };
}

/**
 * Deletes a balance that never received anything and has nothing in flight, and reopens its invite.
 * Used when the first funding of a new balance fails or expires.
 */
export function releaseIfEmpty(db: DB, accountId: string): boolean {
  return tx(db, () => {
    const a = db.prepare('SELECT balance_msub FROM accounts WHERE id = ?').get(accountId) as { balance_msub: number } | undefined;
    if (!a || a.balance_msub !== 0) return false;
    const ledgerRows = (db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE account_id = ?').get(accountId) as { n: number }).n;
    if (ledgerRows > 0) return false;
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    const busy = (
      db.prepare(`SELECT COUNT(*) AS n FROM fundings WHERE account_id = ? AND (state IN (${marks}) OR credited > 0)`).get(accountId, ...OPEN_FUNDING_STATES) as {
        n: number;
      }
    ).n;
    if (busy > 0) return false;
    const pendingIn = (
      db.prepare("SELECT COUNT(*) AS n FROM incoming WHERE account_id = ? AND status = 'prepared'").get(accountId) as { n: number }
    ).n;
    if (pendingIn > 0) return false;
    db.prepare("UPDATE invites SET status = 'open', account_id = NULL, redeemed_at = NULL WHERE account_id = ?").run(accountId);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    return true;
  });
}

/**
 * The balance cap of memory storage (BELLOWS_MEMORY_MAX_BALANCE_*, docs/OPERATE.md): a balance may not grow
 * past it, counting what is already on its way there: open fundings (an unpaid Lightning invoice, a quoted or
 * moving token from another mint), top-ups whose swap outcome is not yet known, and top-ups this process is
 * receiving right now. Every credit path asks for room before any eCash is taken, and is refused rather than
 * part-credited, so the payer keeps the whole token or invoice. Each check runs in the same synchronous step
 * as the claim it guards (a top-up's claim, a funding row's insert), so two requests cannot take one room.
 */
export class BalanceCap {
  /** Top-ups being received in this process: account id -> token hash -> whole units. */
  private readonly receiving = new Map<string, Map<string, number>>();

  private readonly db: DB;
  /** Whole units per unit; null: no cap (volume storage). */
  readonly max: Partial<Record<Unit, number>> | null;

  constructor(db: DB, max: Partial<Record<Unit, number>> | null) {
    this.db = db;
    this.max = max;
  }

  /** Whole units this balance may still take. `except`: a token hash whose own room is not counted. */
  room(accountId: string, unit: Unit, except?: string): number {
    const max = this.max?.[unit];
    if (max === undefined) return Infinity;
    const balance = (this.db.prepare('SELECT balance_msub FROM accounts WHERE id = ?').get(accountId) as { balance_msub: number } | undefined)?.balance_msub ?? 0;
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    const funding = (
      this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM fundings WHERE account_id = ? AND state IN (${marks})`).get(accountId, ...OPEN_FUNDING_STATES) as { s: number }
    ).s;
    let held = balance + funding * MSUB_PER_UNIT;
    const counted = new Set<string>();
    const unsettled = this.db.prepare("SELECT token_hash, amount FROM incoming WHERE account_id = ? AND purpose = 'topup' AND status = 'prepared'").all(accountId) as Array<{
      token_hash: string;
      amount: number;
    }>;
    for (const r of unsettled) {
      counted.add(r.token_hash);
      if (r.token_hash !== except) held += r.amount * MSUB_PER_UNIT;
    }
    for (const [hash, amount] of this.receiving.get(accountId) ?? []) if (hash !== except && !counted.has(hash)) held += amount * MSUB_PER_UNIT;
    return Math.max(0, Math.floor((max * MSUB_PER_UNIT - held) / MSUB_PER_UNIT));
  }

  /** Refuses (400 balance_limit) a credit of `amount` whole units that does not fit. */
  check(accountId: string, unit: Unit, amount: number, except?: string): void {
    const room = this.room(accountId, unit, except);
    if (amount <= room) return;
    const max = this.max![unit]!;
    throw new PaymentError(
      'balance_limit',
      `this Bellows keeps balances in memory, so one balance holds at most ${max} ${unit}; ${room} ${unit} more fits in this one. Nothing was taken`,
      400,
      { unit, balance_max: max, room },
    );
  }

  /**
   * An eCash top-up: refuses it when it does not fit, else holds its room until the receive ends (call the
   * returned function then). A token already received, or whose swap outcome is unknown, already has its
   * room (or its credit) and is let through, so a retry is never refused after the mint took the token.
   */
  claimTopup(accountId: string, unit: Unit, tokenHash: string, amount: number): () => void {
    if (this.max?.[unit] === undefined) return () => {};
    const prior = (this.db.prepare('SELECT status FROM incoming WHERE token_hash = ?').get(tokenHash) as { status: string } | undefined)?.status;
    // Already received, unsettled, or being received by another request (which holds its room).
    if (prior === 'prepared' || prior === 'done' || this.receiving.get(accountId)?.has(tokenHash)) return () => {};
    this.check(accountId, unit, amount, tokenHash);
    let mine = this.receiving.get(accountId);
    if (!mine) this.receiving.set(accountId, (mine = new Map()));
    mine.set(tokenHash, amount);
    return () => {
      mine.delete(tokenHash);
      if (mine.size === 0 && this.receiving.get(accountId) === mine) this.receiving.delete(accountId);
    };
  }
}
