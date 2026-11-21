import { decodePaymentRequest } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { openDb } from '../../src/db.ts';
import { loadConfig, type Unit } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import type { FundingRow } from '../../src/funding.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource, type RateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true }],
};

function app(env: Record<string, string> = {}, rateSources: RateSource[] = [fixedRateSource('fixed', 100_000)]) {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  return createApp(buildDeps(config, { rateSources }));
}

describe('engine only: no web app', () => {
  it('serves no page, service worker, manifest or static files', async () => {
    const a = app();
    for (const path of ['/', '/index.html', '/app.js', '/sw.js', '/manifest.webmanifest', '/offline.html', '/js/files.js', '/vendor/tinfoil.js', '/icons/icon-192.png']) {
      const res = await a.request(`http://gw.test${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('x-forge-sw-version'), path).toBeNull();
    }
  });

  it('still serves the client API', async () => {
    const a = app();
    expect((await a.request('http://gw.test/healthz')).status).toBe(200);
    const models = await a.request('http://gw.test/v1/models');
    expect(models.status).toBe(200);
    expect(((await models.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['mock-echo']);
  });
});

describe('no beta waitlist', () => {
  it('has no signup route or page', async () => {
    const a = app();
    const post = await a.request('http://gw.test/v1/beta/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact: 'a@example.org' }) });
    expect(post.status).toBe(404);
    expect((await a.request('http://gw.test/beta')).status).toBe(404);
    expect((await a.request('http://gw.test/beta/')).status).toBe(404);
  });

  it('creates no table for contacts', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).not.toContain('beta_signups');
    expect(tables).toContain('accounts');
  });
});

describe('NUT-18 payment requests', () => {
  const chat = (a: ReturnType<typeof app>, headers: Record<string, string> = {}) =>
    a.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    });
  const ask = async (a: ReturnType<typeof app>, headers: Record<string, string> = {}) => {
    const res = await chat(a, headers);
    expect(res.status).toBe(402);
    return decodePaymentRequest(res.headers.get('x-cashu')!);
  };

  it('ask in sat when the client names no unit, and in usd when it sends X-Forge-Unit: usd', async () => {
    const a = app();
    expect((await ask(a)).unit).toBe('sat');
    expect((await ask(a, { 'x-forge-unit': 'sat' })).unit).toBe('sat');
    expect((await ask(a, { 'x-forge-unit': 'usd' })).unit).toBe('usd');
  });

  it('follow BELLOWS_DEFAULT_UNIT when the client names no unit', async () => {
    expect((await ask(app({ BELLOWS_DEFAULT_UNIT: 'usd' }))).unit).toBe('usd');
    expect((await ask(app({ BELLOWS_UNITS: 'usd', BELLOWS_DEFAULT_UNIT: 'usd' }))).unit).toBe('usd');
  });

  it('without a BTC/USD rate, refuse a sat quote and still ask in usd', async () => {
    const a = app({}, [{ name: 'down', fetchBtcUsd: async () => Promise.reject(new Error('down')) }]);
    const res = await chat(a);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe('rate_unavailable');
    expect((await ask(a, { 'x-forge-unit': 'usd' })).unit).toBe('usd');
  });

  it('name the service Bellows by default, with no invite needed', async () => {
    const pr = await ask(app());
    expect(pr.description).toBe('Bellows: mock-echo');
    expect(pr.mints).toEqual(['http://127.0.0.1:1']);
  });

  it('use BELLOWS_SERVICE_NAME when set', async () => {
    expect((await ask(app({ BELLOWS_SERVICE_NAME: 'Example AI' }))).description).toBe('Example AI: mock-echo');
  });
});

describe('the unit of a funding that names none', () => {
  // The routes resolve the unit and open the balance; the funding service is replaced by a recorder, so these
  // tests see the unit and amount each route hands it. test/e2e/funding.e2e.test.ts runs the same rule against mints.
  function rig(env: Record<string, string> = {}) {
    const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', BELLOWS_POW_BITS: '0', ...env };
    const deps = buildDeps(loadConfig(e as NodeJS.ProcessEnv, catalog), { rateSources: [fixedRateSource('fixed', 100_000)] });
    const calls: Array<{ method: string; accountId: string; unit: Unit; amount?: number }> = [];
    const row = (method: 'lightning' | 'foreign', accountId: string, unit: Unit, amount: number | null) =>
      ({ id: 'fund_test', method, account_id: accountId, unit, mint: 'http://127.0.0.1:1', request: 'lnbc1', amount, expires_at: 0, state: method === 'foreign' ? 'quoted' : 'pending', credited: 0, observed: null, error: null, created_at: 0 }) as unknown as FundingRow;
    deps.funding.createLightning = async (accountId, unit, amount) => {
      calls.push({ method: 'lightning', accountId, unit, amount });
      return row('lightning', accountId, unit, amount);
    };
    deps.funding.quoteForeign = async (accountId, unit) => {
      calls.push({ method: 'foreign', accountId, unit });
      return row('foreign', accountId, unit, 100);
    };
    const a = createApp(deps);
    const balance = (unit: Unit) => {
      const key = newApiKey();
      return { key, id: deps.ledger.createAccountRaw(key, unit, null).id };
    };
    const fund = async (path: string, body: object, key?: string) => {
      const res = await a.request(`http://gw.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { deps, calls, balance, fund };
  }
  const routes: Array<[string, string, object]> = [
    ['Lightning', '/v1/wallet/fund/lightning', { amount: 500 }],
    ['other-mint quote', '/v1/wallet/fund/foreign/quote', { token: 'cashuBtest' }],
  ];

  it.each(routes)('%s: a usd balance is funded in usd, and a sat balance in sat', async (_n, path, body) => {
    const r = rig();
    for (const unit of ['usd', 'sat'] as const) {
      const b = r.balance(unit);
      const res = await r.fund(path, body, b.key);
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe(unit);
      expect(res.body.account_id).toBe(b.id);
      expect(res.body.key).toBeUndefined();
      expect(r.calls.at(-1)).toMatchObject({ accountId: b.id, unit });
    }
  });

  it('Lightning: the amount is read in the balance unit (500 with a usd balance is 500 cents)', async () => {
    const r = rig();
    const b = r.balance('usd');
    await r.fund('/v1/wallet/fund/lightning', { amount: 500 }, b.key);
    expect(r.calls).toEqual([{ method: 'lightning', accountId: b.id, unit: 'usd', amount: 500 }]);
  });

  it.each(routes)('%s: without a key, a new balance opens in the default unit', async (_n, path, body) => {
    for (const [env, unit] of [[{}, 'sat'], [{ BELLOWS_DEFAULT_UNIT: 'usd' }, 'usd']] as const) {
      const r = rig(env);
      const res = await r.fund(path, body);
      expect(res.status).toBe(200);
      expect(res.body.unit).toBe(unit);
      expect(res.body.key).toMatch(/^sk-forge-/);
      expect(r.deps.ledger.findByKey(res.body.key)!.unit).toBe(unit);
      expect(r.calls.at(-1)!.unit).toBe(unit);
    }
  });

  it.each(routes)('%s: a unit the call names is used as given, and one that differs from the balance is wrong_unit', async (_n, path, body) => {
    const r = rig();
    const b = r.balance('usd');
    const same = await r.fund(path, { ...body, unit: 'usd' }, b.key);
    expect(same.status).toBe(200);
    expect(same.body.unit).toBe('usd');
    const n = r.calls.length;
    const other = await r.fund(path, { ...body, unit: 'sat' }, b.key);
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('wrong_unit');
    expect(other.body.error.message).toBe('this balance is in usd; this funding is in sat');
    expect(r.calls.length).toBe(n);
  });

  it.each(routes)('%s: an invalid key is refused as before; a well-formed unknown key opens a balance in the default unit', async (_n, path, body) => {
    const r = rig();
    const bad = await r.fund(path, body, 'not-a-key');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_key');
    expect(r.calls).toEqual([]);
    const chosen = newApiKey();
    const fresh = await r.fund(path, body, chosen);
    expect(fresh.status).toBe(200);
    expect(fresh.body.unit).toBe('sat');
    expect(fresh.body.key).toBeUndefined();
    expect(r.deps.ledger.findByKey(chosen)!.unit).toBe('sat');
  });

  it('Lightning: the cap of the balance unit applies (BELLOWS_FUND_MAX_USD for a usd balance)', async () => {
    const r = rig({ BELLOWS_FUND_MAX_USD: '400', BELLOWS_FUND_MAX_SAT: '1000' });
    // The real createLightning, with the mint's methods fixed so the caps come only from the configuration.
    r.deps.funding.methods = async () => ({ lightning: { enabled: true, units: ['sat', 'usd'], min: { sat: 1, usd: 1 }, max: { sat: 1000, usd: 400 } } }) as any;
    delete (r.deps.funding as any).createLightning;
    const usd = r.balance('usd');
    const over = await r.fund('/v1/wallet/fund/lightning', { amount: 500 }, usd.key);
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('invalid_amount');
    expect(over.body.error.message).toBe('amount must be 1..400 usd');
    const sat = r.balance('sat');
    const tooMuchSat = await r.fund('/v1/wallet/fund/lightning', { amount: 1001 }, sat.key);
    expect(tooMuchSat.body.error.message).toBe('amount must be 1..1000 sat');
  });
});

describe('client API surface (unchanged from Forge AI)', () => {
  // Every client route answers with JSON from its own handler, never the router's plain-text 404.
  const routes: Array<[string, string]> = [
    ['GET', '/healthz'],
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/wallet/topup'],
    ['GET', '/v1/wallet'],
    ['GET', '/v1/wallet/refunds'],
    ['POST', '/v1/wallet/refund'],
    ['GET', '/v1/wallet/fund/methods'],
    ['GET', '/v1/wallet/fund/mints'],
    ['POST', '/v1/wallet/fund/lightning'],
    ['POST', '/v1/wallet/fund/onchain'],
    ['POST', '/v1/wallet/fund/foreign/quote'],
    ['POST', '/v1/wallet/fund/foreign/confirm'],
    ['GET', '/v1/wallet/fund'],
    ['GET', '/v1/wallet/fund/fund_x'],
    ['GET', '/v1/change/req_x'],
    ['GET', '/attestation'],
    ['GET', '/.well-known/hpke-keys'],
    // Added by S4 (attested identity); new, not part of the Forge AI surface.
    ['GET', '/.well-known/bellows'],
  ];
  it('an unknown route is the router\'s plain 404 (the check below can tell them apart)', async () => {
    const res = await app().request('http://gw.test/v1/no-such-route', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/application\/json/);
  });

  it.each(routes)('%s %s exists', async (method, path) => {
    const res = await app().request(`http://gw.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
  });

  it('keeps the X-Forge-* header names clients read', async () => {
    const res = await app().request('http://gw.test/v1/models', { headers: { origin: 'https://app.example' } });
    const pre = await app().request('http://gw.test/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Forge-Request-Id');
    expect(pre.headers.get('access-control-allow-headers')).toContain('X-Forge-Invite');
  });
});
