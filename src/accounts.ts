import type { Unit } from './config.ts';
import { type DB, tx } from './db.ts';
import { type Account, type Invites, isApiKeyShape, type Ledger, LedgerError, newApiKey } from './ledger.ts';

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
