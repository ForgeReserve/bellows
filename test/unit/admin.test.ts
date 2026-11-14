import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { tx } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { Ledger, LedgerError, newApiKey } from '../../src/ledger.ts';
import { openDb } from '../../src/db.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { memorySecrets, newWalletSecret } from '../../src/secrets.ts';

setLogSilent(true);
const TOKEN = 'admin-test-token-0123456789abcdef';
const HASH = createHash('sha256').update(TOKEN).digest('hex');
const HOST = 'gw.test';
/** The admin token hash is a secret: it comes from the secrets source, never the environment. */
const secrets = (hash = HASH) => ({ secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret(), BELLOWS_ADMIN_TOKEN_HASH: hash }) });
const ORIGIN = `http://${HOST}`;

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' }, paid: { type: 'openai', tier: 'standard', baseUrl: 'http://127.0.0.1:1/v1', apiKeySecret: 'NOT_SET_KEY' } },
  models: [
    { id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true },
    { id: 'paid-model', supplier: 'paid', upstream: 'x', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true },
  ],
};

function gateway(env: Record<string, string> = {}, hash = HASH) {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_ADMIN_RATE_LIMIT_RPM: '100000', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog, secrets(hash));
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
  const app = createApp(deps);
  const call = (path: string, init: { method?: string; body?: unknown; token?: string | null; origin?: string | null; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: HOST, ...init.headers };
    if (init.token !== null) headers['x-bellows-admin-token'] = init.token ?? TOKEN;
    if (init.method && init.method !== 'GET') {
      if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
      headers['content-type'] ??= 'application/json';
    }
    return app.request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  return { deps, app, call };
}

describe('admin access control', () => {
  it('is 404 everywhere under /admin when no token hash is configured', async () => {
    const { call } = gateway({}, '');
    expect((await call('/admin/api/session')).status).toBe(404);
    expect((await call('/admin/api/invites', { method: 'POST', body: {} })).status).toBe(404);
    expect((await call('/admin/', { token: null })).status).toBe(404);
    expect((await call('/admin', { token: null })).status).toBe(404);
  });

  it('rejects a missing or wrong token with 401 and accepts the right one', async () => {
    const { call } = gateway();
    expect((await call('/admin/api/session', { token: null })).status).toBe(401);
    expect((await call('/admin/api/session', { token: 'wrong' })).status).toBe(401);
    expect((await call('/admin/api/session')).status).toBe(200);
    // Bearer works too when no proxy auth uses the Authorization header.
    expect((await call('/admin/api/session', { token: null, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await call('/admin/api/session', { token: null, headers: { authorization: 'Basic YWRtaW46eA==' } })).status).toBe(401);
    // The header is X-Bellows-Admin-Token; the old X-Forge-Admin-Token name is not read.
    expect((await call('/admin/api/session', { token: null, headers: { 'x-forge-admin-token': TOKEN } })).status).toBe(401);
  });

  it('limits failed logins', async () => {
    const { call } = gateway();
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await call('/admin/api/session', { token: 'bad' + i })).status);
    expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('failed logins never use up the operator budget, and no limit keys on an address', async () => {
    const { call } = gateway({ BELLOWS_ADMIN_RATE_LIMIT_RPM: '20' });
    for (let i = 0; i < 30; i++) await call('/admin/api/session', { token: 'bad' + i, headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    // Failed logins share one budget whatever address they claim; the right token still gets in.
    expect((await call('/admin/api/session', { token: 'bad-again', headers: { 'x-forwarded-for': '198.51.100.200' } })).status).toBe(429);
    expect((await call('/admin/api/session')).status).toBe(200);
  });

  it('requires a same-origin Origin and JSON on changes (CSRF)', async () => {
    const { call } = gateway();
    expect((await call('/admin/api/invites', { method: 'POST', body: { count: 1 }, origin: null })).status).toBe(403);
    expect((await call('/admin/api/invites', { method: 'POST', body: { count: 1 }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/admin/api/invites', { method: 'POST', body: { count: 1 }, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call('/admin/api/invites', { method: 'POST', body: { count: 1 }, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call('/admin/api/invites', { method: 'POST', body: { count: 1 } })).status).toBe(200);
  });

  it('honours BELLOWS_ADMIN_ORIGIN when set', async () => {
    const { call } = gateway({ BELLOWS_ADMIN_ORIGIN: 'https://ai.example.com' });
    expect((await call('/admin/api/invites', { method: 'POST', body: {} })).status).toBe(403);
    expect((await call('/admin/api/invites', { method: 'POST', body: {}, origin: 'https://ai.example.com' })).status).toBe(200);
  });

  it('never answers with CORS headers', async () => {
    const { call } = gateway();
    const pre = await call('/admin/api/overview', { method: 'OPTIONS', token: null, origin: 'https://evil.example', headers: { 'access-control-request-method': 'GET' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const get = await call('/admin/api/session', { headers: { origin: 'https://evil.example' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    // The public API still has CORS.
    const pub = await call('/v1/models', { token: null, headers: { origin: 'https://evil.example' } });
    expect(pub.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves no admin page: only /admin/api exists, even with a valid token', async () => {
    const { call } = gateway();
    for (const path of ['/admin', '/admin/', '/admin/index.html', '/admin/admin.js']) {
      expect((await call(path, { token: null })).status).toBe(404);
      expect((await call(path)).status).toBe(404);
    }
    const api = await call('/admin/api/session');
    expect(api.status).toBe(200);
    expect(api.headers.get('cache-control')).toBe('no-store');
  });
});

describe('admin invites', () => {
  it('creates invites shown once, lists them without codes, revokes them', async () => {
    const { call, deps } = gateway();
    const created = (await (await call('/admin/api/invites', { method: 'POST', body: { count: 3, label: 'friends' } })).json()) as any;
    expect(created.data).toHaveLength(3);
    const code = created.data[0].code as string;
    expect(code).toMatch(/^inv-/);
    const list = await (await call('/admin/api/invites')).text();
    expect(list).not.toContain(code);
    expect(JSON.parse(list).data.filter((i: any) => i.label === 'friends')).toHaveLength(3);
    expect((await call(`/admin/api/invites/${created.data[0].id}/revoke`, { method: 'POST', body: {} })).status).toBe(200);
    expect(deps.invites.lookup(code)?.status).toBe('revoked');
    expect(deps.invites.checkForNut24(code)).toBe(false);
    expect((await call('/admin/api/invites/invite_nope/revoke', { method: 'POST', body: {} })).status).toBe(404);
  });

  it('has no waitlist endpoints', async () => {
    const { call } = gateway();
    expect((await call('/admin/api/waitlist')).status).toBe(404);
    expect((await call('/admin/api/waitlist/beta_x/invite', { method: 'POST', body: {} })).status).toBe(404);
  });
});

describe('admin settings and accounts', () => {
  it('shows settings read-only and which suppliers have keys', async () => {
    const { call } = gateway();
    const s = (await (await call('/admin/api/settings')).json()) as any;
    expect(s.invite_only).toBe(false);
    expect(s.markup).toBe(1.25);
    expect(s.models.map((m: any) => m.id)).toEqual(['mock-echo']);
    expect(s.models[0].price_usd_per_mtok.input).toBeCloseTo(1.25);
    expect(s.suppliers.find((x: any) => x.id === 'paid').key_present).toBe(false);
    expect(s.suppliers.find((x: any) => x.id === 'mock').key_present).toBeNull();
    expect(s.suppliers.find((x: any) => x.id === 'paid').key_secret).toBe('NOT_SET_KEY');
    // Where state and secrets live, never a secret itself.
    expect(s.state).toEqual({ mode: 'development', secrets: 'memory', sealed_mount: null });
    expect(JSON.stringify(s)).not.toContain(HASH);
    expect((await call('/admin/api/settings', { method: 'POST', body: {} })).status).toBe(404);
  });

  it('lists no balances (totals only) and freezes one by the id its owner gives', async () => {
    const { call, deps } = gateway();
    const key = newApiKey();
    const a = tx(deps.db, () => {
      const a = deps.ledger.createAccountRaw(key, 'usd', null);
      deps.ledger.creditRaw(a.id, 5000, 'topup', null);
      return a;
    });
    // Blind by default: no per-balance listing or search.
    expect((await call(`/admin/api/accounts?q=${a.id.slice(5, 13)}`)).status).toBe(404);
    expect((await call('/admin/api/accounts')).status).toBe(404);
    expect((await call(`/admin/api/accounts/${a.id}/freeze`, { method: 'POST', body: { frozen: true } })).status).toBe(200);
    expect(() => deps.ledger.reserve(a.id, 1)).toThrow(LedgerError);
    expect((await call(`/admin/api/accounts/${a.id}/freeze`, { method: 'POST', body: { frozen: false } })).status).toBe(200);
    expect(deps.ledger.reserve(a.id, 1)).toMatch(/^res_/);
    expect((await call('/admin/api/accounts/acct_missing/freeze', { method: 'POST', body: { frozen: true } })).status).toBe(404);
  });

  it('logs a freeze and an unfreeze without the balance id', async () => {
    const { call, deps } = gateway();
    const a = tx(deps.db, () => deps.ledger.createAccountRaw(newApiKey(), 'usd', null));
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      for (const frozen of [true, false]) expect((await call(`/admin/api/accounts/${a.id}/freeze`, { method: 'POST', body: { frozen } })).status).toBe(200);
    } finally {
      setLogSink(undefined);
    }
    const actions = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'admin_action');
    expect(actions.map((e) => e.action)).toEqual(['account_freeze', 'account_unfreeze']);
    expect(lines.join('\n')).not.toContain(a.id);
  });

  it('counts fundings that need the operator in SQL, by the same rule as a funding status', async () => {
    const { call, deps } = gateway();
    const t = Date.now();
    const day = 24 * 3600_000;
    const ins = deps.db.prepare('INSERT INTO fundings (id, method, account_id, unit, mint, quote, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const add = (id: string, state: string, updatedAt: number, error: string | null = null) => ins.run(id, 'lightning', 'acct_x', 'usd', 'http://127.0.0.1:1', id, state, error, updatedAt, updatedAt);
    const count = async () => ((await (await call('/admin/api/overview')).json()) as any).health.fundings_attention;
    expect(await count()).toBe(0);
    // Counted: a recent failure, a mint-side state stuck for over 10 minutes, an open funding with an error.
    add('f1', 'failed', t - day);
    add('f2', 'melting', t - 11 * 60_000);
    add('f3', 'pending', t, 'mint unreachable');
    // Not counted: an old failure, a mint-side state that just moved, a quiet open one, finished ones.
    add('f4', 'failed', t - 31 * day);
    add('f5', 'minting', t - 60_000);
    add('f6', 'quoted', t - 11 * 60_000);
    add('f7', 'done', t - 11 * 60_000, 'old error');
    add('f8', 'expired', t - day);
    expect(await count()).toBe(3);
  });

  it('has no per-funding or per-request listings', async () => {
    const { call } = gateway();
    for (const path of ['/admin/api/fundings', '/admin/api/fundings?state=all', '/admin/api/requests', '/admin/api/requests?limit=3']) {
      expect((await call(path)).status, path).toBe(404);
    }
  });

  it('shows no balance id or key anywhere in the operator API', async () => {
    const { call, deps } = gateway();
    const key = newApiKey();
    const a = tx(deps.db, () => {
      const a = deps.ledger.createAccountRaw(key, 'usd', null);
      deps.ledger.creditRaw(a.id, 5000, 'topup', null);
      return a;
    });
    for (const path of ['/admin/api/overview', '/admin/api/invites', '/admin/api/settings', '/admin/api/costs', '/admin/api/exports']) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain(a.id);
      expect(text, path).not.toContain(key);
      expect(text, path).not.toContain('account_id');
    }
  });
});

describe('ledger freeze', () => {
  it('blocks spending but not refunds or credits', () => {
    const db = openDb(':memory:');
    const ledger = new Ledger(db);
    const a = tx(db, () => {
      const a = ledger.createAccountRaw(newApiKey(), 'usd', null);
      ledger.creditRaw(a.id, 10_000, 'topup', null);
      return a;
    });
    expect(ledger.setFrozen(a.id, true)).toBe(true);
    expect(ledger.isFrozen(a.id)).toBe(true);
    try {
      ledger.reserve(a.id, 100);
      expect.unreachable();
    } catch (e) {
      expect((e as LedgerError).code).toBe('account_frozen');
      expect((e as LedgerError).status).toBe(403);
    }
    tx(db, () => ledger.debitRaw(a.id, 3000, 'refund', 'r1'));
    tx(db, () => ledger.creditRaw(a.id, 1000, 'topup', null));
    expect(ledger.get(a.id)!.balance_msub).toBe(8000);
    ledger.setFrozen(a.id, false);
    expect(ledger.reserve(a.id, 100)).toMatch(/^res_/);
    expect(ledger.setFrozen('acct_missing', true)).toBe(false);
  });
});

describe('admin other-mint discovery', () => {
  it('shows the snapshot and policy, and refreshes on demand at most once a minute', async () => {
    const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_ADMIN_RATE_LIMIT_RPM: '100000', BELLOWS_FOREIGN_DISCOVERY_RELAYS: 'wss://relay.test' };
    const config = loadConfig(e as NodeJS.ProcessEnv, catalog, secrets());
    let queries = 0;
    // An announcement with no reviewers: seen, never accepted.
    const deps = buildDeps(config, {
      rateSources: [fixedRateSource('fixed', 100_000)],
      discovery: {
        query: async () => {
          queries++;
          return { answered: true, events: [] };
        },
        probe: async (url) => ({ url, ok: true, units: ['sat'] }),
      },
    });
    const app = createApp(deps);
    const call = (path: string, method = 'GET') =>
      app.request(`${ORIGIN}${path}`, { method, headers: { host: HOST, 'x-bellows-admin-token': TOKEN, ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }) }, body: method === 'GET' ? undefined : '{}' });
    const view = await (await call('/admin/api/mints/discovery')).json();
    expect(view).toMatchObject({ policy: 'discovered', accepted: [], discovery: { enabled: true, min_reviewers: 2, require_announcement: false, relays: ['wss://relay.test'] } });
    const r1 = await call('/admin/api/mints/discovery/refresh', 'POST');
    expect(r1.status).toBe(200);
    expect((await r1.json()).discovery.last_refresh).toMatchObject({ ok: true, accepted: 0 });
    const before = queries;
    const r2 = await call('/admin/api/mints/discovery/refresh', 'POST');
    expect(r2.status).toBe(429);
    expect(r2.headers.get('retry-after')).toBeTruthy();
    expect(queries).toBe(before);
    expect((await app.request(`${ORIGIN}/admin/api/mints/discovery/refresh`, { method: 'POST', headers: { host: HOST, 'x-bellows-admin-token': TOKEN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });
});

describe('admin operator mints', () => {
  const MINT = 'https://added.example';
  function withProbe(probe: (url: string) => Promise<{ url: string; ok: boolean; reason?: string; units?: string[]; name?: string }>, env: Record<string, string> = {}) {
    const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_ADMIN_RATE_LIMIT_RPM: '100000', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', BELLOWS_FOREIGN_ALLOW_INSECURE: 'true', ...env };
    const config = loadConfig(e as NodeJS.ProcessEnv, catalog, secrets());
    const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], discovery: { probe } });
    const app = createApp(deps);
    const call = (path: string, method = 'GET', body?: unknown, origin: string | null = ORIGIN) =>
      app.request(`${ORIGIN}${path}`, {
        method,
        headers: { host: HOST, 'x-bellows-admin-token': TOKEN, ...(method === 'GET' ? {} : { ...(origin ? { origin } : {}), 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { call, deps };
  }

  it('adds a mint after the probe, lists it as operator in the public list, and removes it', async () => {
    let probes = 0;
    const { call } = withProbe(async (url) => {
      probes++;
      return { url, ok: true, units: ['sat'], name: 'Added Mint' };
    });
    const add = await call('/admin/api/mints/allowed', 'POST', { url: MINT + '/', note: 'ok by me' });
    expect(add.status).toBe(200);
    const a = await add.json();
    expect(a).toMatchObject({ forced: false, added: true, probe: { ok: true }, mint: { url: MINT, name: 'Added Mint', note: 'ok by me' } });
    expect(a.view.operator_mints).toHaveLength(1);
    expect(probes).toBe(1);
    const view = await (await call('/admin/api/mints/discovery')).json();
    expect(view.operator_mints.map((m: { url: string }) => m.url)).toEqual([MINT]);
    expect(view.accepted).toEqual([{ url: MINT, name: 'Added Mint', source: 'operator' }]);
    expect(view.unlisted).toEqual({ enabled: true, max: { sat: 5000, usd: 500 } });
    const pub = await (await call('/v1/wallet/fund/mints')).json();
    expect(pub.mints).toEqual([{ url: MINT, name: 'Added Mint', source: 'operator' }]);
    // CSRF gate applies.
    expect((await call('/admin/api/mints/allowed', 'POST', { url: MINT }, null)).status).toBe(403);
    const del = await call(`/admin/api/mints/allowed?url=${encodeURIComponent(MINT)}`, 'DELETE');
    expect(del.status).toBe(200);
    expect((await call(`/admin/api/mints/allowed?url=${encodeURIComponent(MINT)}`, 'DELETE')).status).toBe(404);
    await call('/admin/api/mints/allowed', 'POST', { url: MINT });
    expect((await call('/admin/api/mints/allowed/remove', 'POST', { url: MINT })).status).toBe(200);
    expect((await (await call('/admin/api/mints/discovery')).json()).operator_mints).toEqual([]);
  });

  it('refuses a failed probe with the reason, and a forced add is flagged', async () => {
    const { call } = withProbe(async (url) => ({ url, ok: false, reason: 'info: no NUT-05 melt' }));
    const r = await call('/admin/api/mints/allowed', 'POST', { url: MINT });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b).toMatchObject({ error: { code: 'mint_check_failed' }, probe: { ok: false, reason: 'info: no NUT-05 melt' } });
    expect(b.error.message).toMatch(/no NUT-05 melt/);
    const f = await call('/admin/api/mints/allowed', 'POST', { url: MINT, force: true });
    expect(f.status).toBe(200);
    expect(await f.json()).toMatchObject({ forced: true, mint: { url: MINT } });
  });

  it("refuses the gateway's own and denied mints and bad bodies", async () => {
    const { call } = withProbe(async (url) => ({ url, ok: true, units: ['sat'] }), { BELLOWS_FOREIGN_DENY: MINT });
    expect((await (await call('/admin/api/mints/allowed', 'POST', { url: 'http://127.0.0.1:1/' })).json()).error.code).toBe('own_mint');
    expect((await (await call('/admin/api/mints/allowed', 'POST', { url: MINT })).json()).error.code).toBe('mint_denied');
    expect((await call('/admin/api/mints/allowed', 'POST', { note: 'x' })).status).toBe(400);
    expect((await call('/admin/api/mints/allowed', 'POST', { url: MINT + '2', note: 5 })).status).toBe(400);
  });
});
