/**
 * Operator admin API (/admin/api/*). There is no admin page; anything else under /admin answers 404.
 *
 * Access control, in order:
 *  - No admin token in the secrets source (BELLOWS_ADMIN_TOKEN, or its SHA-256 as BELLOWS_ADMIN_TOKEN_HASH):
 *    everything under /admin answers 404.
 *  - Token: X-Bellows-Admin-Token: <token> (or Authorization: Bearer <token> when no proxy auth sits in
 *    front); its sha256 must equal the configured one. Wrong or missing: 401. The token is never logged.
 *  - Every non-GET request: same-origin Origin header (CSRF) and a JSON body.
 *  - No CORS: these routes never send Access-Control-* headers, so browsers block other origins.
 *  - Rate limits, never keyed on a client address: failed logins share one budget, and requests with the
 *    right token share another (so failed logins cannot use up the operator's own budget).
 * Self-hosted operators should keep /admin off the public internet (a private network or a proxy with its own
 * auth). In a sealed deployment (the Tinfoil kit) TLS ends inside the enclave and the shim serves /admin/api at
 * the public origin, so the token (generated with `openssl rand -hex 32`) is its only protection. A token given
 * only as BELLOWS_ADMIN_TOKEN_HASH skips the length and space checks, since a hash hides them.
 *
 * Blind by default: every answer is an aggregate (totals, counts, supplier costs, health). There is no
 * listing of balances, fundings or requests. Every action is logged as admin_action with counts and
 * amounts only: no tokens, codes or contacts.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { OPEN_FUNDING_STATES } from './accounts.ts';
import type { Deps } from './app.ts';
import { parseOptionalLockPubkey } from './cashu/lock.ts';
import { PaymentError } from './cashu/wallet.ts';
import type { Config, Unit } from './config.ts';
import type { DB } from './db.ts';
import { LedgerError } from './ledger.ts';
import { errText, log } from './log.ts';
import { TINFOIL_ADMIN_KEY } from './secrets.ts';
import { displayPrice, MSUB_PER_UNIT } from './pricing.ts';
import { RateLimiter } from './ratelimit.ts';
import { ExportError, exportHistory, holdings, issueExport, oweExport, planExport, revenue } from './revenue.ts';
import { type UsageRow, usageSince, windowStart } from './usage.ts';

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function json(c: Context, status: number, body: unknown) {
  return c.json(body as any, status as any);
}

function fail(c: Context, status: number, code: string, message: string, extra: object = {}) {
  return json(c, status, { error: { code, message }, ...extra });
}

/** A funding in a mint-side state that has not moved for this long needs the operator. */
const STUCK_FUNDING_MS = 10 * 60_000;
/** How long a failed funding counts towards fundings_attention. */
const FAILED_ATTENTION_MS = 30 * 24 * 3600_000;

export function createAdminRouter(d: Deps): Hono {
  const { config, db, ledger, invites, wallet, rates, funding, discovery } = d;
  const env = config.env;
  const tokenHash = config.adminTokenHash;
  const limiter = new RateLimiter(env.BELLOWS_ADMIN_RATE_LIMIT_RPM, Math.max(20, Math.ceil(env.BELLOWS_ADMIN_RATE_LIMIT_RPM / 3)));
  const authFailures = new RateLimiter(10, 10);
  const markup = env.BELLOWS_MARKUP;
  const r = new Hono();

  const tokenOk = (c: Context): boolean => {
    if (!tokenHash) return false;
    let t = c.req.header('x-bellows-admin-token')?.trim();
    if (!t) {
      const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
      t = m?.[1]?.trim();
    }
    if (!t) return false;
    const a = Buffer.from(sha256hex(t), 'hex');
    const b = Buffer.from(tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header('origin');
    if (!origin || origin === 'null') return false;
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin') return false;
    const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
    if (env.BELLOWS_ADMIN_ORIGIN) return norm(origin) === norm(env.BELLOWS_ADMIN_ORIGIN);
    try {
      return new URL(origin).host.toLowerCase() === (c.req.header('host') ?? '').toLowerCase();
    } catch {
      return false;
    }
  };

  const audit = (action: string, fields: Record<string, string | number | boolean | null | undefined> = {}) => log.info('admin_action', { action, ...fields });

  r.onError((e, c) => {
    if (e instanceof PaymentError) return fail(c, e.status, e.code, e.message, e.extra ?? {});
    if (e instanceof ExportError || e instanceof LedgerError) return fail(c, e.status, e.code, e.message);
    log.error('admin_error', { path: c.req.path, err: errText(e) });
    return fail(c, 500, 'internal_error', 'internal error');
  });

  // Gate for the API. There is no admin page: anything under /admin outside /admin/api is 404.
  const gate = async (c: Context, next: () => Promise<void>) => {
    if (!tokenHash) return c.text('Not Found', 404);
    if (!c.req.path.startsWith('/admin/api/') && c.req.path !== '/admin/api') return c.text('Not Found', 404);
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    if (!tokenOk(c)) {
      const w = authFailures.take('failed');
      log.warn('admin_auth_failed', { path: c.req.path });
      if (w > 0) {
        c.header('Retry-After', String(w));
        return fail(c, 429, 'rate_limited', 'too many failed admin logins');
      }
      return fail(c, 401, 'unauthorized', 'admin token required');
    }
    const wait = limiter.take('operator');
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return fail(c, 429, 'rate_limited', 'too many admin requests');
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!sameOrigin(c)) {
        log.warn('admin_origin_rejected', { path: c.req.path });
        return fail(c, 403, 'bad_origin', 'admin changes must come from the admin origin');
      }
      if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return fail(c, 415, 'json_required', 'send Content-Type: application/json');
    }
    return next();
  };
  r.use('/admin', gate);
  r.use('/admin/*', gate);
  r.use('/admin/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 413, 'request_too_large', 'request too large') }));

  const body = async (c: Context): Promise<any> => {
    try {
      const b = await c.req.json();
      return b && typeof b === 'object' ? b : {};
    } catch {
      throw new ExportError('invalid_request', 'expected a JSON object');
    }
  };
  const unitOf = (v: unknown): Unit => {
    const u = String(v ?? '') as Unit;
    if (!env.BELLOWS_UNITS.includes(u)) throw new ExportError('wrong_unit', `unit must be one of ${env.BELLOWS_UNITS.join(', ')}`);
    return u;
  };
  const tierOf = (supplier: string) => config.catalog.suppliers[supplier]?.tier ?? 'unknown';

  // ---------------------------------------------------------------- mint health (GET /v1/info only)
  const mintHealth = new Map<string, { at: number; value: { mint: string; ok: boolean; name?: string; version?: string; latency_ms?: number; error?: string } }>();
  const checkMint = async (mint: string) => {
    const hit = mintHealth.get(mint);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const t0 = Date.now();
    let value;
    try {
      const res = await fetch(`${mint}/v1/info`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info: any = await res.json();
      value = { mint, ok: true, name: typeof info?.name === 'string' ? info.name : undefined, version: typeof info?.version === 'string' ? info.version : undefined, latency_ms: Date.now() - t0 };
    } catch (e) {
      value = { mint, ok: false, error: errText(e) };
    }
    mintHealth.set(mint, { at: Date.now(), value });
    return value;
  };

  // ---------------------------------------------------------------- Tinfoil credit (read-only admin API)
  // Tinfoil has no balance endpoint: remaining = opening credit + credits added - all-time spend.
  let tinfoilCache: { at: number; value: unknown } | undefined;
  const tinfoilBilling = async () => {
    const key = config.secrets.get(TINFOIL_ADMIN_KEY);
    if (!key) return null;
    if (tinfoilCache && Date.now() - tinfoilCache.at < 60_000) return tinfoilCache.value;
    const get = async (path: string) => {
      const res = await fetch(`${env.BELLOWS_TINFOIL_ADMIN_URL}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Tinfoil admin API ${path.split('?')[0]}: HTTP ${res.status}`);
      return (await res.json()) as any;
    };
    let value;
    try {
      const [all, d30, tx] = await Promise.all([get('/api/billing/usage'), get('/api/billing/usage?time=30d'), get('/api/billing/transactions')]);
      const transactions: any[] = Array.isArray(tx?.transactions) ? tx.transactions : [];
      // The transaction format is not documented and the list is empty so far: count positive amounts as credit added.
      const added = transactions.reduce((s, x) => {
        const v = Number(x?.amount_usd ?? x?.amount ?? 0);
        return Number.isFinite(v) && v > 0 ? s + v : s;
      }, 0);
      const spent = Number(all?.cost ?? 0);
      const opening = env.BELLOWS_TINFOIL_OPENING_CREDIT_USD;
      const remaining = opening + added - spent;
      value = {
        ok: true,
        opening_usd: opening,
        added_usd: added,
        transactions: transactions.length,
        spent_usd: spent,
        spent_30d_usd: Number(d30?.cost ?? 0),
        requests: Number(all?.requests ?? 0),
        requests_30d: Number(d30?.requests ?? 0),
        tokens: Number(all?.tokens ?? 0),
        remaining_usd: remaining,
        low: remaining < env.BELLOWS_TINFOIL_LOW_USD,
        low_threshold_usd: env.BELLOWS_TINFOIL_LOW_USD,
      };
    } catch (e) {
      value = { ok: false, error: errText(e) };
    }
    tinfoilCache = { at: Date.now(), value };
    return value;
  };

  // ---------------------------------------------------------------- Token Factory key (LiteLLM /key/info)
  // The inference key can read its own record: spend as Token Factory costs it, budget, limits, expiry.
  let tfCache: { at: number; value: unknown } | undefined;
  const tokenFactoryKey = async () => {
    const s = config.catalog.suppliers.tokenfactory;
    const key = s?.apiKeySecret ? config.secrets.get(s.apiKeySecret) : undefined;
    if (!s?.baseUrl || typeof key !== 'string' || !key) return null;
    if (tfCache && Date.now() - tfCache.at < 60_000) return tfCache.value;
    let value;
    try {
      const base = s.baseUrl.replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/key/info`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Token Factory /key/info: HTTP ${res.status}`);
      const info = ((await res.json()) as any)?.info ?? {};
      const spent = Number(info.spend ?? 0);
      const budget = info.max_budget == null ? null : Number(info.max_budget);
      value = {
        ok: true,
        alias: typeof info.key_alias === 'string' ? info.key_alias : null,
        spent_usd: spent,
        max_budget_usd: budget,
        remaining_usd: budget == null ? null : budget - spent,
        budget_duration: info.budget_duration ?? null,
        budget_reset_at: info.budget_reset_at ?? null,
        rpm_limit: info.rpm_limit ?? null,
        tpm_limit: info.tpm_limit ?? null,
        expires: info.expires ?? null,
        blocked: !!info.blocked,
      };
    } catch (e) {
      value = { ok: false, error: errText(e) };
    }
    tfCache = { at: Date.now(), value };
    return value;
  };

  // ---------------------------------------------------------------- stats
  type Money = Partial<Record<Unit, number>>;
  const add = (m: Money, unit: Unit, v: number) => (m[unit] = (m[unit] ?? 0) + v);
  const usdEquiv = (m: Money, rate: number | undefined): number | null => {
    let usd = (m.usd ?? 0) / MSUB_PER_UNIT / 100;
    if (m.sat) {
      if (!rate) return null;
      usd += (m.sat / MSUB_PER_UNIT / 1e8) * rate;
    }
    return Math.round(usd * 1e6) / 1e6;
  };

  /** Activity over the last `days` UTC days (today included), from the daily aggregates. */
  const windowStats = (days: number, rate: number | undefined) => {
    const { day, since } = windowStart(days);
    const rows = usageSince(db, day).map((u: UsageRow) => ({
      unit: u.unit as Unit,
      model: u.model,
      supplier: u.supplier,
      n: u.requests,
      ok: u.ok,
      failed: u.failed,
      enc: u.encrypted,
      tin: u.input_tokens,
      tout: u.output_tokens,
      rev: u.charged_msub,
    }));
    type Agg = { requests: number; ok: number; failed: number; encrypted: number; input_tokens: number; output_tokens: number; revenue_msub: Money };
    const blank = (): Agg => ({ requests: 0, ok: 0, failed: 0, encrypted: 0, input_tokens: 0, output_tokens: 0, revenue_msub: {} });
    const total = blank();
    const by = { model: new Map<string, Agg>(), tier: new Map<string, Agg>(), supplier: new Map<string, Agg>() };
    for (const row of rows) {
      const keys = { model: row.model, tier: tierOf(row.supplier), supplier: row.supplier };
      for (const agg of [total, ...(['model', 'tier', 'supplier'] as const).map((k) => by[k].get(keys[k]) ?? by[k].set(keys[k], blank()).get(keys[k])!)]) {
        agg.requests += row.n;
        agg.ok += row.ok;
        agg.failed += row.failed;
        agg.encrypted += row.enc;
        agg.input_tokens += row.tin;
        agg.output_tokens += row.tout;
        add(agg.revenue_msub, row.unit, row.rev);
      }
    }
    const withMoney = (key: string, a: Agg) => {
      // Catalog prices include BELLOWS_MARKUP, so supplier cost is estimated as revenue / markup.
      const cost: Money = {};
      const margin: Money = {};
      for (const [u, v] of Object.entries(a.revenue_msub) as Array<[Unit, number]>) {
        cost[u] = Math.round(v / markup);
        margin[u] = v - cost[u]!;
      }
      return { key, ...a, revenue_usd_equiv: usdEquiv(a.revenue_msub, rate), cost_msub: cost, margin_msub: margin, cost_usd_equiv: usdEquiv(cost, rate), margin_usd_equiv: usdEquiv(margin, rate) };
    };
    const list = (m: Map<string, Agg>) => [...m.entries()].map(([k, a]) => withMoney(k, a)).sort((x, y) => y.requests - x.requests);
    return { since, total: withMoney('total', total), by_model: list(by.model), by_tier: list(by.tier), by_supplier: list(by.supplier) };
  };

  const supplierStatus = () =>
    Object.entries(config.catalog.suppliers).map(([id, s]) => {
      // Served models only: loadConfig drops those of a supplier whose key is not in the secrets source, and
      // those whose price is unverified unless BELLOWS_SERVE_UNVERIFIED_PRICES is on. So the key is looked up
      // itself (presence only, never the value).
      const models = config.catalog.models.filter((m) => m.supplier === id).length;
      return { id, type: s.type, tier: s.tier, pricing: s.pricing, key_secret: s.apiKeySecret ?? null, key_present: s.apiKeySecret ? config.secrets.get(s.apiKeySecret) !== undefined : null, models };
    });

  // ---------------------------------------------------------------- routes

  r.get('/admin/api/session', (c) => json(c, 200, { ok: true }));

  r.get('/admin/api/overview', async (c) => {
    const rate = rates.current() ?? (env.BELLOWS_UNITS.includes('sat') ? await rates.get().catch(() => undefined) : undefined);
    const rs = rates.status();
    const t = Date.now();
    const collected = db
      .prepare('SELECT unit, COALESCE(SUM(charged_msub), 0) AS s, COALESCE(SUM(ok), 0) AS n FROM usage_daily GROUP BY unit')
      .all() as Array<{ unit: Unit; s: number; n: number }>;
    const exported = db
      .prepare("SELECT e.unit, COALESCE(SUM(e.amount), 0) AS s, COUNT(*) AS n FROM revenue_exports e JOIN outgoing o ON o.id = e.outgoing_id WHERE o.status = 'done' GROUP BY e.unit")
      .all() as Array<{ unit: Unit; s: number; n: number }>;
    const recovered = wallet.recovered();
    const units = env.BELLOWS_UNITS.map((u) => {
      const rv = revenue(d, u);
      const owedBy = db
        .prepare("SELECT purpose, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM outgoing WHERE unit = ? AND status IN ('owed', 'reserved', 'prepared') GROUP BY purpose")
        .all(u) as Array<{ purpose: string; n: number; s: number }>;
      return {
        unit: u,
        collected_msub: collected.find((x) => x.unit === u)?.s ?? 0,
        exported: exported.find((x) => x.unit === u)?.s ?? 0,
        wallet_trusted: rv.unspent,
        wallet_other_mints: rv.other_unspent,
        owed_payouts: rv.owed,
        owed_by_purpose: owedBy,
        customer_balances_msub: rv.liabilities_msub,
        customer_balances: rv.liabilities,
        reserved_msub: rv.reserved_msub,
        sweepable: rv.sweepable,
        // eCash a counter scan found after the database was lost, held aside: not in wallet_trusted, not
        // sweepable and owed to no balance (docs/OPERATE.md, Running without a volume).
        recovered: recovered.filter((x) => x.unit === u).reduce((sum, x) => sum + x.amount, 0),
        accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE unit = ?').get(u) as { n: number }).n,
        frozen_accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE unit = ? AND frozen_at IS NOT NULL').get(u) as { n: number }).n,
      };
    });
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    const openFundings = db.prepare(`SELECT state, COUNT(*) AS n FROM fundings WHERE state IN (${marks}) GROUP BY state`).all(...OPEN_FUNDING_STATES) as Array<{ state: string; n: number }>;
    const due = (db.prepare(`SELECT COUNT(*) AS n FROM fundings WHERE state IN (${marks}) AND next_check <= ?`).get(...OPEN_FUNDING_STATES, t) as { n: number }).n;
    // Same rule as fundingStatus().attention, counted in SQL. A failed funding counts for 30 days, so the
    // count can return to zero once the operator has dealt with it.
    const attention = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fundings WHERE
             (state = 'failed' AND updated_at >= ?)
             OR (state IN ('receiving', 'melting', 'minting') AND updated_at < ?)
             OR (error IS NOT NULL AND state IN (${marks}))`,
        )
        .get(t - FAILED_ATTENTION_MS, t - STUCK_FUNDING_MS, ...OPEN_FUNDING_STATES) as { n: number }
    ).n;
    const byMethod = db.prepare('SELECT method, state, COUNT(*) AS n FROM fundings GROUP BY method, state ORDER BY method, state').all() as Array<{ method: string; state: string; n: number }>;
    const mints = [...new Set([...wallet.trustedMints, funding.mint])];
    return json(c, 200, {
      at: t,
      markup,
      rate: rs ? { btc_usd: rs.rate, age_s: Math.round(rs.ageMs / 1000), sources: rs.sources, usable: rates.current() !== undefined } : null,
      units,
      holdings: holdings(d),
      recovered,
      mints_closed: wallet.closedMints,
      tinfoil: await tinfoilBilling(),
      tokenfactory: await tokenFactoryKey(),
      windows: {
        today: windowStats(1, rate),
        d7: windowStats(7, rate),
        d30: windowStats(30, rate),
      },
      health: {
        suppliers: supplierStatus(),
        mints: await Promise.all(mints.map(checkMint)),
        fund_mint: funding.mint,
        fundings_open: openFundings,
        fundings_due: due,
        fundings_attention: attention,
        fundings_by_method: byMethod,
        fundings_unlisted: (db.prepare("SELECT COUNT(*) AS n FROM fundings WHERE method = 'foreign' AND f_unlisted = 1").get() as { n: number }).n,
        quote_checks: funding.quoteCheckStatus(),
        exports_unfinished: (db.prepare("SELECT COUNT(*) AS n FROM revenue_exports e JOIN outgoing o ON o.id = e.outgoing_id WHERE o.status <> 'done'").get() as { n: number }).n,
      },
    });
  });

  // -------------------------------------------------------------- revenue export
  const planFrom = (b: any) => {
    const unit = unitOf(b.unit);
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? undefined : Number(b.amount);
    const mint = typeof b.mint === 'string' && b.mint ? b.mint : undefined;
    const lockPubkey = parseOptionalLockPubkey(b.pubkey);
    const plan = planExport(d, unit, { mint, amount });
    return { plan, lockPubkey };
  };

  r.post('/admin/api/export/preview', async (c) => {
    const { plan, lockPubkey } = planFrom(await body(c));
    return json(c, 200, { unit: plan.unit, mint: plan.mint, amount: plan.amount, max: plan.max, sweepable: plan.revenue.sweepable, locked_to: lockPubkey });
  });

  r.post('/admin/api/export', async (c) => {
    const b = await body(c);
    const { plan, lockPubkey } = planFrom(b);
    // The confirm step: the page sends back the exact amount, mint and key it showed.
    if (Number(b.confirm_amount) !== plan.amount || b.confirm_mint !== plan.mint || (b.confirm_pubkey ?? null) !== lockPubkey) {
      return fail(c, 409, 'confirm_mismatch', 'confirm the exact amount, mint and lock key shown in the preview');
    }
    const { id } = oweExport(d, { unit: plan.unit, mint: plan.mint, amount: plan.amount, lockPubkey, source: 'admin' });
    audit('revenue_export', { unit: plan.unit, amount: plan.amount, locked: !!lockPubkey, export_id: id });
    try {
      const token = await issueExport(d, id);
      return json(c, 200, { id, status: 'done', unit: plan.unit, mint: plan.mint, amount: plan.amount, locked_to: lockPubkey, token });
    } catch (e) {
      // The payout is owed and recorded; recovery or "Finish" completes it, never twice.
      log.warn('admin_export_deferred', { export_id: id, err: errText(e) });
      return json(c, 202, { id, status: 'owed', unit: plan.unit, mint: plan.mint, amount: plan.amount, locked_to: lockPubkey, token: null, error: errText(e) });
    }
  });

  r.get('/admin/api/exports', (c) => json(c, 200, { data: exportHistory(d) }));

  r.post('/admin/api/exports/:id/finish', async (c) => {
    const id = c.req.param('id');
    const row = exportHistory(d, 1000).find((x) => x.id === id);
    if (!row) return fail(c, 404, 'not_found', 'unknown export');
    // A token is handed out once. One that recovery finished after a crash was never delivered, so it may be.
    if (row.delivered_at) return fail(c, 409, 'already_delivered', 'this export was already delivered; its token is shown only once');
    const token = await issueExport(d, id);
    audit('revenue_export_finish', { export_id: id, unit: row.unit, amount: row.amount });
    return json(c, 200, { id, status: 'done', unit: row.unit, mint: row.mint, amount: row.amount, locked_to: row.lock_pubkey, token });
  });

  // -------------------------------------------------------------- invites
  r.get('/admin/api/invites', (c) => {
    // The operator's own invites; never which balance redeemed one.
    const rows = db.prepare('SELECT id, label, status, nut24_uses, created_at, redeemed_at FROM invites ORDER BY created_at DESC LIMIT 1000').all();
    return json(c, 200, { data: rows });
  });

  r.post('/admin/api/invites', async (c) => {
    const b = await body(c);
    const count = b.count === undefined ? 1 : Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) return fail(c, 400, 'invalid_count', 'count must be 1..100');
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 80) : undefined;
    const out = Array.from({ length: count }, () => invites.create(label));
    audit('invites_create', { count });
    return json(c, 200, { data: out });
  });

  r.post('/admin/api/invites/:id/revoke', (c) => {
    const id = c.req.param('id');
    const inv = db.prepare('SELECT status FROM invites WHERE id = ?').get(id) as { status: string } | undefined;
    if (!inv) return fail(c, 404, 'not_found', 'unknown invite');
    invites.revoke(id);
    audit('invite_revoke', { invite_id: id, was: inv.status });
    return json(c, 200, { ok: true, id, status: 'revoked' });
  });

  // -------------------------------------------------------------- balances
  // No listing: the overview has totals. A customer who wants spending stopped (a lost key) gives the
  // operator the balance id their client shows.
  r.post('/admin/api/accounts/:id/freeze', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    if (typeof b.frozen !== 'boolean') return fail(c, 400, 'invalid_request', 'send {"frozen": true|false}');
    if (!ledger.setFrozen(id, b.frozen)) return fail(c, 404, 'not_found', 'unknown account');
    // No balance id in the log: a log line naming the balance would tie it to a time and an operator action.
    audit(b.frozen ? 'account_freeze' : 'account_unfreeze', {});
    return json(c, 200, { id, frozen: b.frozen });
  });

  // -------------------------------------------------------------- fundings
  // One funding, for the recheck answer. No balance id.
  const fundingRow = (f: any) => ({
    id: f.id,
    method: f.method,
    unit: f.unit,
    amount: f.amount,
    credited: f.credited,
    state: f.state,
    error: f.error,
    created_at: f.created_at,
    updated_at: f.updated_at,
    expires_at: f.expires_at,
    next_check: f.next_check,
    foreign_mint: f.f_mint,
    foreign_amount: f.f_amount,
    unlisted: !!f.f_unlisted,
    open: (OPEN_FUNDING_STATES as readonly string[]).includes(f.state),
    ...fundingStatus(f),
  });

  /** A plain reading of a funding for the admin API, and whether it needs the operator. */
  const fundingStatus = (f: any): { status: string; detail: string; attention: boolean; paid: number | null } => {
    let obs: any = {};
    try {
      obs = f.observed ? JSON.parse(f.observed) : {};
    } catch {
      /* ignore */
    }
    const paid = f.method === 'onchain' && Number.isFinite(Number(obs.amount_paid)) ? Number(obs.amount_paid) : null;
    const stuck = ['receiving', 'melting', 'minting'].includes(f.state) && Date.now() - f.updated_at > STUCK_FUNDING_MS;
    const attention = f.state === 'failed' || stuck || (!!f.error && (OPEN_FUNDING_STATES as readonly string[]).includes(f.state));
    if (f.state === 'pending' && f.method === 'onchain')
      return f.credited > 0
        ? { status: 'credited', detail: 'Credited; the address stays watched for more deposits', attention, paid }
        : { status: 'awaiting deposit', detail: 'No deposit seen yet', attention, paid };
    if (f.state === 'pending') return { status: 'awaiting payment', detail: obs.state ? `Mint says ${obs.state}` : 'Invoice not paid yet', attention, paid };
    if (f.state === 'expired') return { status: 'expired', detail: 'Never paid; nothing to do', attention, paid };
    if (f.state === 'refunded') return { status: 'refunded', detail: 'Returned to the customer as eCash', attention, paid };
    return { status: f.state, detail: '', attention, paid };
  };

  r.post('/admin/api/fundings/:id/recheck', async (c) => {
    const id = c.req.param('id');
    const f = funding.get(id);
    if (!f) return fail(c, 404, 'not_found', 'unknown funding');
    if (!(OPEN_FUNDING_STATES as readonly string[]).includes(f.state)) return fail(c, 409, 'not_open', `funding is ${f.state}; only unfinished fundings can be re-checked`);
    const q = funding.quoteCheckStatus();
    if (f.state === 'pending' && !q.available) {
      const retry = q.cooldown_until ? Math.ceil((q.cooldown_until - Date.now()) / 1000) : 60;
      c.header('Retry-After', String(Math.max(1, retry)));
      return fail(c, 429, 'quote_budget', q.cooldown_until ? 'the mint asked us to slow down; quote checks are paused' : 'the shared quote-check budget for this minute is used up', {
        quote_checks: q,
      });
    }
    const after = await funding.advance(id);
    audit('funding_recheck', { funding_id: id, before: f.state, after: after?.state });
    return json(c, 200, { data: after ? fundingRow(after) : null, quote_checks: funding.quoteCheckStatus() });
  });

  // -------------------------------------------------------------- supplier costs and margin
  r.get('/admin/api/costs', (c) => json(c, 200, supplierCosts(db, config, Math.min(365, Math.max(1, Number(c.req.query('days')) || 30)))));

  // -------------------------------------------------------------- other-mint discovery (NIP-87)
  const discoveryView = () => {
    const accepted = funding.acceptedForeignMints();
    return {
      policy: env.BELLOWS_FOREIGN_POLICY,
      enabled: env.BELLOWS_FOREIGN_ENABLED,
      allow: env.BELLOWS_FOREIGN_ALLOW,
      deny: env.BELLOWS_FOREIGN_DENY,
      /** Mints added on this page (removable here); env BELLOWS_FOREIGN_ALLOW entries are not. */
      operator_mints: funding.operatorMints(),
      accepted: accepted.mints,
      unlisted: {
        enabled: env.BELLOWS_FOREIGN_UNLISTED,
        max: { sat: Math.min(env.BELLOWS_FOREIGN_UNLISTED_MAX_SAT, env.BELLOWS_FOREIGN_MAX_SAT), usd: Math.min(env.BELLOWS_FOREIGN_UNLISTED_MAX_USD, env.BELLOWS_FOREIGN_MAX_USD) },
      },
      discovery: discovery.status(),
    };
  };
  const REFRESH_EVERY_MS = 60_000;
  let lastManualRefresh = 0;

  r.get('/admin/api/mints/discovery', (c) => json(c, 200, discoveryView()));

  r.post('/admin/api/mints/discovery/refresh', async (c) => {
    if (!discovery.enabled) return fail(c, 409, 'discovery_off', 'no discovery relays are set (BELLOWS_FOREIGN_DISCOVERY_RELAYS)');
    const wait = lastManualRefresh + REFRESH_EVERY_MS - Date.now();
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return fail(c, 429, 'rate_limited', 'discovery was refreshed less than a minute ago');
    }
    lastManualRefresh = Date.now();
    await discovery.refresh();
    const view = discoveryView();
    audit('mint_discovery_refresh', { ok: view.discovery.last_refresh?.ok ?? false, accepted: view.discovery.mints.length });
    return json(c, 200, view);
  });

  // Operator-added mints: accepted like BELLOWS_FOREIGN_ALLOW. Adding one runs the URL safety check and the
  // live probe discovery uses; force adds a mint that failed the probe (the response says so).
  r.post('/admin/api/mints/allowed', async (c) => {
    const b = await body(c);
    if (typeof b.url !== 'string') return fail(c, 400, 'invalid_request', 'send {"url": "https://mint.example"}');
    if (b.note != null && typeof b.note !== 'string') return fail(c, 400, 'invalid_request', 'note must be a string');
    const out = await funding.addOperatorMint(b.url, b.note ?? null, b.force === true);
    audit('mint_allow_add', { url: out.mint.url, probe_ok: out.probe.ok, forced: out.forced, added: out.added });
    return json(c, 200, { ...out, view: discoveryView() });
  });

  const removeMint = (c: Context, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) return fail(c, 400, 'invalid_request', 'send the mint url');
    if (!funding.removeOperatorMint(url)) return fail(c, 404, 'not_found', 'that mint was not added through the admin API');
    audit('mint_allow_remove', { url: url.trim() });
    return json(c, 200, { ok: true, view: discoveryView() });
  };
  r.delete('/admin/api/mints/allowed', (c) => removeMint(c, c.req.query('url')));
  r.post('/admin/api/mints/allowed/remove', async (c) => removeMint(c, (await body(c)).url));

  // -------------------------------------------------------------- settings (read-only)
  r.get('/admin/api/settings', async (c) => {
    const rate = rates.current();
    let methods: unknown = null;
    try {
      methods = await funding.methods();
    } catch (e) {
      methods = { error: errText(e) };
    }
    return json(c, 200, {
      invite_only: env.BELLOWS_INVITE_ONLY,
      markup,
      units: env.BELLOWS_UNITS,
      default_unit: env.BELLOWS_DEFAULT_UNIT,
      trusted_mints: wallet.trustedMints,
      fund_mint: funding.mint,
      caps: {
        fund_max_sat: env.BELLOWS_FUND_MAX_SAT,
        fund_max_usd: env.BELLOWS_FUND_MAX_USD,
        foreign_max_sat: env.BELLOWS_FOREIGN_MAX_SAT,
        foreign_max_usd: env.BELLOWS_FOREIGN_MAX_USD,
        fund_max_pending: env.BELLOWS_FUND_MAX_PENDING,
        quote_checks_per_min: env.BELLOWS_MINT_QUOTE_CHECKS_PER_MIN,
        rate_limit_rpm: env.BELLOWS_RATE_LIMIT_RPM,
        anon_rate_limit_rpm: env.BELLOWS_ANON_RATE_LIMIT_RPM,
        pow_bits: env.BELLOWS_POW_BITS,
        max_body_bytes: env.BELLOWS_MAX_BODY_BYTES,
      },
      enabled: { lightning: env.BELLOWS_LIGHTNING_ENABLED, onchain: env.BELLOWS_ONCHAIN_ENABLED, foreign: env.BELLOWS_FOREIGN_ENABLED },
      foreign: {
        allow: env.BELLOWS_FOREIGN_ALLOW,
        deny: env.BELLOWS_FOREIGN_DENY,
        policy: env.BELLOWS_FOREIGN_POLICY,
        min_reviewers: env.BELLOWS_FOREIGN_MIN_REVIEWERS,
        unlisted: env.BELLOWS_FOREIGN_UNLISTED,
        unlisted_max_sat: env.BELLOWS_FOREIGN_UNLISTED_MAX_SAT,
        unlisted_max_usd: env.BELLOWS_FOREIGN_UNLISTED_MAX_USD,
      },
      methods,
      rate_sources: env.BELLOWS_RATE_SOURCES,
      btc_usd: rate ?? null,
      // Where state and secrets live. Names a source kind and a mount, never a secret.
      state: { mode: config.mode, secrets: config.secrets.kind, sealed_mount: config.sealedMount ?? null },
      suppliers: supplierStatus(),
      // Models withheld (or, with the operator setting on, served) although their price is not verified.
      unverified_prices: config.unverifiedPrices,
      models: config.catalog.models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        supplier: m.supplier,
        tier: tierOf(m.supplier),
        uncensored: m.uncensored,
        verified: m.price_verified,
        max_output_tokens: m.max_output_tokens,
        cost_usd_per_mtok: { input: m.input_usd_per_mtok, output: m.output_usd_per_mtok },
        price_usd_per_mtok: { input: displayPrice(m.input_usd_per_mtok, markup, 'usd'), output: displayPrice(m.output_usd_per_mtok, markup, 'usd') },
        price_sat_per_mtok: rate ? { input: displayPrice(m.input_usd_per_mtok, markup, 'sat', rate), output: displayPrice(m.output_usd_per_mtok, markup, 'sat', rate) } : null,
      })),
    });
  });

  r.all('/admin/api/*', (c) => fail(c, 404, 'not_found', 'no such admin endpoint'));

  return r;
}

export interface ModelCost {
  model: string;
  name: string | null;
  supplier: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** Customer price, nano-USD. */
  price_nusd: number;
  /** Our cost, nano-USD; supplier_reported of the requests used the supplier's own figure. */
  cost_nusd: number;
  supplier_reported: number;
  /** Our catalog cost per million tokens (before markup). */
  catalog: { input: number; output: number; verified: boolean };
  /** Per-million prices fitted to the supplier's reported costs, when there is enough data. */
  derived: { input: number; output: number; samples: number } | null;
  /** Fitted price differs from the catalog by more than 10% (either way). */
  drift: boolean;
}

/**
 * Supplier cost per model over a window of UTC days (today included): what customers paid (price_nusd), what
 * it cost us (the supplier's reported cost, else usage at catalog cost), and per-million prices fitted to the
 * reported costs by least squares (cost = a*input + b*output), to replace placeholder catalog prices. Reads the
 * daily aggregates; the fit uses the sums kept there.
 */
export function supplierCosts(db: DB, config: Config, days: number) {
  const { day, since } = windowStart(days);
  const rows = usageSince(db, day);
  const by = new Map<string, UsageRow[]>();
  for (const x of rows) if (x.ok > 0) by.set(x.model, [...(by.get(x.model) ?? []), x]);
  const models: ModelCost[] = [];
  for (const [id, rs] of by) {
    const m = config.catalog.models.find((x: { id: string }) => x.id === id);
    const sum = (k: keyof UsageRow) => rs.reduce((t, x) => t + Number(x[k]), 0);
    const n = sum('supplier_reported');
    let derived: ModelCost['derived'] = null;
    if (n >= 2) {
      const ii = sum('fit_ii'), io = sum('fit_io'), oo = sum('fit_oo'), ic = sum('fit_ic'), oc = sum('fit_oc');
      const det = ii * oo - io * io;
      // Needs requests with different input/output mixes to separate the two prices.
      if (det > 1e-9 * ii * oo) {
        const a = (ic * oo - oc * io) / det;
        const b = (oc * ii - ic * io) / det;
        if (a >= 0 && b >= 0) derived = { input: a / 1000, output: b / 1000, samples: n };
      }
    }
    const catalog = { input: m?.input_usd_per_mtok ?? 0, output: m?.output_usd_per_mtok ?? 0, verified: !!m?.price_verified };
    const off = (d: number, c: number) => (c === 0 ? d > 0 : Math.abs(d - c) / c > 0.1);
    models.push({
      model: id,
      name: m?.name ?? null,
      supplier: rs[0]!.supplier,
      requests: sum('ok'),
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      price_nusd: sum('price_nusd'),
      cost_nusd: sum('cost_nusd'),
      supplier_reported: n,
      catalog,
      derived,
      drift: !!derived && (off(derived.input, catalog.input) || off(derived.output, catalog.output)),
    });
  }
  models.sort((a, b) => b.price_nusd - a.price_nusd);
  const suppliers = [...new Set(models.map((x) => x.supplier))].map((id) => {
    const ms = models.filter((x) => x.supplier === id);
    return { supplier: id, requests: ms.reduce((t, x) => t + x.requests, 0), price_nusd: ms.reduce((t, x) => t + x.price_nusd, 0), cost_nusd: ms.reduce((t, x) => t + x.cost_nusd, 0) };
  });
  const total = { requests: models.reduce((t, x) => t + x.requests, 0), price_nusd: models.reduce((t, x) => t + x.price_nusd, 0), cost_nusd: models.reduce((t, x) => t + x.cost_nusd, 0) };
  return { days, since, markup: config.env.BELLOWS_MARKUP, total, suppliers, models };
}
