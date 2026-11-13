/**
 * Revenue: what the gateway's wallet holds beyond what it owes. Shared by the admin CLI
 * (revenue:show, revenue:export) and the admin API, so both compute "sweepable" the same way.
 *
 *   sweepable = eCash held at trusted mints - owed payouts - customer balances (rounded up)
 *
 * Owed payouts include every unfinished change, refund and export, so an export in flight is
 * never counted twice. Other-mint eCash (held aside for other-mint fundings) is never sweepable.
 */
import { randomUUID } from 'node:crypto';
import type { GatewayWallet } from './cashu/wallet.ts';
import type { Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';
import { type Ledger, sha256 } from './ledger.ts';
import { msubToUnitsCeil } from './pricing.ts';

export interface RevenueDeps {
  db: DB;
  ledger: Ledger;
  wallet: GatewayWallet;
}

export interface Holding {
  mint: string;
  unit: string;
  trusted: boolean;
  unspent: number;
  reserved: number;
  owed: number;
}

export interface Revenue {
  unit: Unit;
  holdings: Holding[];
  /** Unspent eCash at trusted mints, whole units. */
  unspent: number;
  /** Unspent eCash at other mints (never sweepable). */
  other_unspent: number;
  /** Unfinished payouts (change, refunds, exports), whole units. */
  owed: number;
  /** Customer balances, msub and rounded up to whole units. */
  liabilities_msub: number;
  liabilities: number;
  /** Active reservations (part of the balances above), msub. */
  reserved_msub: number;
  sweepable: number;
}

export class ExportError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function holdings(d: RevenueDeps): Holding[] {
  const owedRows = d.db
    .prepare("SELECT mint, unit, SUM(amount) AS owed FROM outgoing WHERE status IN ('owed', 'reserved', 'prepared') GROUP BY mint, unit")
    .all() as Array<{ mint: string; unit: string; owed: number }>;
  const rows: Holding[] = d.wallet.holdings().map((h) => ({ ...h, trusted: d.wallet.isTrusted(h.mint) }));
  // A payout owed at a mint where no proof row exists yet still counts.
  for (const o of owedRows) {
    if (!rows.some((r) => r.mint === o.mint && r.unit === o.unit)) {
      rows.push({ mint: o.mint, unit: o.unit, trusted: d.wallet.isTrusted(o.mint), unspent: 0, reserved: 0, owed: o.owed });
    }
  }
  return rows;
}

export function revenue(d: RevenueDeps, unit: Unit): Revenue {
  const hs = holdings(d).filter((h) => h.unit === unit);
  const unspent = hs.filter((h) => h.trusted).reduce((s, h) => s + h.unspent, 0);
  const other = hs.filter((h) => !h.trusted).reduce((s, h) => s + h.unspent, 0);
  const owed = hs.reduce((s, h) => s + h.owed, 0);
  const liabilitiesMsub = d.ledger.liabilities()[unit] ?? 0;
  const liabilities = msubToUnitsCeil(liabilitiesMsub);
  const reserved = d.db
    .prepare("SELECT COALESCE(SUM(r.amount_msub), 0) AS s FROM reservations r JOIN accounts a ON a.id = r.account_id WHERE r.status = 'active' AND a.unit = ?")
    .get(unit) as { s: number };
  return {
    unit,
    holdings: hs,
    unspent,
    other_unspent: other,
    owed,
    liabilities_msub: liabilitiesMsub,
    liabilities,
    reserved_msub: reserved.s,
    sweepable: Math.max(0, unspent - owed - liabilities),
  };
}

export interface ExportPlan {
  unit: Unit;
  mint: string;
  amount: number;
  /** Most that can be exported from this mint right now. */
  max: number;
  revenue: Revenue;
}

/**
 * Works out an export without changing anything: the mint (default: the trusted mint holding the
 * most) and the amount (default: everything sweepable there). Throws ExportError when it cannot.
 */
export function planExport(d: RevenueDeps, unit: Unit, opts: { mint?: string; amount?: number } = {}): ExportPlan {
  const r = revenue(d, unit);
  const trusted = r.holdings.filter((h) => h.trusted).sort((a, b) => b.unspent - a.unspent);
  const want = opts.mint?.trim().replace(/\/+$/, '');
  const mint = want ? trusted.find((h) => h.mint === want)?.mint : trusted[0]?.mint;
  if (!mint) throw new ExportError('no_ecash', opts.mint ? 'no eCash held at that mint (only trusted mints can be exported from)' : `no eCash held in ${unit}`);
  const atMint = trusted.find((h) => h.mint === mint)!.unspent;
  const max = Math.max(0, Math.min(atMint, r.sweepable));
  const amount = opts.amount ?? max;
  if (max < 1) throw new ExportError('nothing_sweepable', `nothing sweepable in ${unit} (wallet ${r.unspent}, owed ${r.owed}, customer balances ${r.liabilities})`);
  if (!Number.isInteger(amount) || amount < 1 || amount > max) {
    throw new ExportError('invalid_amount', `amount must be 1..${max} ${unit} (wallet ${r.unspent}, owed ${r.owed}, customer balances ${r.liabilities})`);
  }
  return { unit, mint, amount, max, revenue: r };
}

/**
 * Records an export as an owed payout plus a history row, in one transaction that re-checks the
 * plan, so two exports racing can never take more than is sweepable. Returns the payout id;
 * issue it with issueExport (crash safe: an owed or prepared payout is finished by recovery).
 */
export function oweExport(d: RevenueDeps, p: { unit: Unit; mint: string; amount: number; lockPubkey?: string | null; source: 'admin' | 'cli' }): { id: string; outgoingId: string } {
  return tx(d.db, () => {
    planExport(d, p.unit, { mint: p.mint, amount: p.amount });
    const outgoingId = d.wallet.oweRaw({ mint: p.mint, unit: p.unit, amount: p.amount, purpose: 'export', lockPubkey: p.lockPubkey ?? null });
    const id = 'exp_' + randomUUID().replaceAll('-', '');
    d.db
      .prepare('INSERT INTO revenue_exports (id, outgoing_id, mint, unit, amount, locked, lock_pubkey, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, outgoingId, p.mint, p.unit, p.amount, p.lockPubkey ? 1 : 0, p.lockPubkey ?? null, p.source, now());
    return { id, outgoingId };
  });
}

/** Issues the export's token (or returns the one recovery finished), records its hash and marks it delivered. */
export async function issueExport(d: RevenueDeps, exportId: string): Promise<string> {
  const row = d.db.prepare('SELECT outgoing_id FROM revenue_exports WHERE id = ?').get(exportId) as { outgoing_id: string } | undefined;
  if (!row) throw new ExportError('not_found', 'unknown export', 404);
  const token = await d.wallet.issue(row.outgoing_id);
  d.db.prepare('UPDATE revenue_exports SET token_hash = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?').run(sha256(token), now(), exportId);
  return token;
}

export interface ExportHistoryRow {
  id: string;
  created_at: number;
  delivered_at: number | null;
  mint: string;
  unit: string;
  amount: number;
  locked: boolean;
  lock_pubkey: string | null;
  source: string;
  token_hash: string | null;
  status: string;
  error: string | null;
}

/** Export history, newest first. A payout finished by recovery gets its token hash filled in here. */
export function exportHistory(d: RevenueDeps, limit = 100): ExportHistoryRow[] {
  const rows = d.db
    .prepare(
      `SELECT e.*, o.status AS o_status, o.error AS o_error, o.token AS o_token FROM revenue_exports e
       LEFT JOIN outgoing o ON o.id = e.outgoing_id ORDER BY e.created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
  return rows.map((r) => {
    let tokenHash: string | null = r.token_hash;
    if (!tokenHash && r.o_status === 'done' && r.o_token) {
      tokenHash = sha256(r.o_token);
      d.db.prepare('UPDATE revenue_exports SET token_hash = ? WHERE id = ?').run(tokenHash, r.id);
    }
    return {
      id: r.id,
      created_at: r.created_at,
      delivered_at: r.delivered_at,
      mint: r.mint,
      unit: r.unit,
      amount: r.amount,
      locked: !!r.locked,
      lock_pubkey: r.lock_pubkey,
      source: r.source,
      token_hash: tokenHash,
      status: r.o_status ?? 'unknown',
      error: r.o_error ?? null,
    };
  });
}
