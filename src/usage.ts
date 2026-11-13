/**
 * Billing aggregates. A settled request is added to one row per UTC day, unit, model and supplier, and
 * nothing about it is kept on its own: no row per request and nothing tied to a balance.
 *
 * The cost fit in the admin API (per-million prices from the supplier's reported costs, by least squares)
 * needs only five sums over the supplier-reported requests, so those sums are kept instead of the requests.
 */
import type { DB } from './db.ts';

export const DAY_MS = 86_400_000;

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** First day (YYYY-MM-DD) of a window of `days` days ending today, and its midnight in ms (UTC). */
export function windowStart(days: number, nowMs = Date.now()): { day: string; since: number } {
  const midnight = new Date(nowMs);
  midnight.setUTCHours(0, 0, 0, 0);
  const since = midnight.getTime() - (days - 1) * DAY_MS;
  return { day: dayOf(since), since };
}

export interface SettledUsage {
  at: number;
  unit: string;
  model: string;
  supplier: string;
  /** settled (ok or partial) or failed. */
  ok: boolean;
  encrypted: boolean;
  nut24: boolean;
  /** Billed from an estimate or a flat schedule rather than usage the supplier reported. */
  estimated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  chargedMsub: number;
  priceNusd: number;
  costNusd: number | null;
  /** The cost is the supplier's own figure (feeds the price fit). */
  supplierReported: boolean;
}

/** Adds one request to its day's row. Runs inside the caller's transaction when combined with other writes. */
export function recordUsageRaw(db: DB, u: SettledUsage): void {
  const i = u.inputTokens ?? 0;
  const o = u.outputTokens ?? 0;
  const c = u.costNusd ?? 0;
  const fit = u.ok && u.supplierReported && u.costNusd != null && u.inputTokens != null && u.outputTokens != null;
  db.prepare(
    `INSERT INTO usage_daily (day, unit, model, supplier, requests, ok, failed, encrypted, nut24, estimated, input_tokens, output_tokens,
       charged_msub, price_nusd, cost_nusd, supplier_reported, fit_ii, fit_io, fit_oo, fit_ic, fit_oc)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, unit, model, supplier) DO UPDATE SET
       requests = requests + 1, ok = ok + excluded.ok, failed = failed + excluded.failed, encrypted = encrypted + excluded.encrypted,
       nut24 = nut24 + excluded.nut24, estimated = estimated + excluded.estimated,
       input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
       charged_msub = charged_msub + excluded.charged_msub, price_nusd = price_nusd + excluded.price_nusd, cost_nusd = cost_nusd + excluded.cost_nusd,
       supplier_reported = supplier_reported + excluded.supplier_reported,
       fit_ii = fit_ii + excluded.fit_ii, fit_io = fit_io + excluded.fit_io, fit_oo = fit_oo + excluded.fit_oo,
       fit_ic = fit_ic + excluded.fit_ic, fit_oc = fit_oc + excluded.fit_oc`,
  ).run(
    dayOf(u.at),
    u.unit,
    u.model,
    u.supplier,
    u.ok ? 1 : 0,
    u.ok ? 0 : 1,
    u.encrypted ? 1 : 0,
    u.nut24 ? 1 : 0,
    u.ok && u.estimated ? 1 : 0,
    u.ok ? i : 0,
    u.ok ? o : 0,
    u.ok ? u.chargedMsub : 0,
    u.ok ? Math.round(u.priceNusd) : 0,
    u.ok ? c : 0,
    fit ? 1 : 0,
    fit ? i * i : 0,
    fit ? i * o : 0,
    fit ? o * o : 0,
    fit ? i * c : 0,
    fit ? o * c : 0,
  );
}

export interface UsageRow {
  day: string;
  unit: string;
  model: string;
  supplier: string;
  requests: number;
  ok: number;
  failed: number;
  encrypted: number;
  nut24: number;
  estimated: number;
  input_tokens: number;
  output_tokens: number;
  charged_msub: number;
  price_nusd: number;
  cost_nusd: number;
  supplier_reported: number;
  fit_ii: number;
  fit_io: number;
  fit_oo: number;
  fit_ic: number;
  fit_oc: number;
}

export function usageSince(db: DB, day: string): UsageRow[] {
  return db.prepare('SELECT * FROM usage_daily WHERE day >= ? ORDER BY day, unit, model, supplier').all(day) as unknown as UsageRow[];
}

/** A NUT-24 payment for this request whose outcome is not known yet (recovery may still finish it). */
export function paymentPending(db: DB, requestId: string): boolean {
  return !!db.prepare("SELECT 1 FROM incoming WHERE request_id = ? AND status IN ('new', 'prepared')").get(requestId);
}

/**
 * Folds request rows left by an earlier release (one row per request, with the balance id) into the daily
 * aggregates and deletes them. Rows still in flight, and failed rows whose payment recovery may still
 * finish, stay. Idempotent.
 */
export function migrateRequestRows(db: DB): number {
  const cols = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('input_tokens')) return 0;
  const rows = db.prepare("SELECT * FROM requests WHERE status IN ('settled', 'failed', 'aborted')").all() as any[];
  let n = 0;
  for (const r of rows) {
    if (r.status === 'failed' && r.payment === 'nut24' && paymentPending(db, r.id)) continue;
    const ok = r.status === 'settled';
    const source = r.usage_source as string | null;
    recordUsageRaw(db, {
      at: Number(r.created_at),
      unit: r.unit,
      model: r.model,
      supplier: r.supplier,
      ok,
      encrypted: !!r.encrypted,
      nut24: r.payment === 'nut24',
      estimated: source === 'estimate' || source === 'flat',
      inputTokens: r.input_tokens ?? null,
      outputTokens: r.output_tokens ?? null,
      chargedMsub: r.charged_msub ?? 0,
      priceNusd: r.price_nusd ?? 0,
      costNusd: r.supplier_cost_nusd ?? null,
      supplierReported: r.cost_source === 'supplier',
    });
    db.prepare('DELETE FROM requests WHERE id = ?').run(r.id);
    n++;
  }
  return n;
}
