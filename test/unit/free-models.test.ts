/**
 * Free models (`"pricing": "free"` in the catalog): served without BELLOWS_SERVE_UNVERIFIED_PRICES, only to a
 * known, unfrozen balance key at any balance (0 included), with nothing reserved or charged, markup or not.
 * No key, NUT-24 eCash or a 402 ask is refused before any token is looked at. Paid models are unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bellowsFetch } from '../../client/index.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { tx } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource, type RateSource } from '../../src/rates.ts';
import { memorySecrets, newWalletSecret } from '../../src/secrets.ts';

setLogSilent(true);
afterEach(() => {
  setLogSink(undefined);
  vi.restoreAllMocks();
});

const REASON = 'The supplier charges nothing during its beta';
const catalog = {
  suppliers: {
    mock: { type: 'mock', tier: 'standard' },
    flatmock: { type: 'mock', tier: 'standard', pricing: 'flat', flat: { buckets: [{ maxBytes: 1_000_000, usd: 1 }], output_usd_per_mtok: 1000 } },
  },
  models: [
    { id: 'paid-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1000, output_usd_per_mtok: 2000, price_verified: true },
    { id: 'free-echo', supplier: 'mock', upstream: 'mock-echo', pricing: 'free', free_reason: REASON },
    { id: 'free-slow', supplier: 'mock', upstream: 'mock-slow', pricing: 'free', free_reason: REASON },
    // Token prices left over from before the model went free: never charged.
    { id: 'free-leftover', supplier: 'mock', upstream: 'mock-echo', pricing: 'free', free_reason: REASON, input_usd_per_mtok: 1000, output_usd_per_mtok: 2000 },
    // A free model of a flat-priced supplier: the flat schedule does not apply either.
    { id: 'free-flat', supplier: 'flatmock', upstream: 'mock-echo', pricing: 'free', free_reason: REASON },
  ],
};
const base = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
const load = (env: Record<string, string> = {}, cat: unknown = catalog) => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv, cat);
const down: RateSource = {
  name: 'down',
  fetchBtcUsd: async () => {
    throw new Error('down');
  },
};

function setup(env: Record<string, string> = {}, rateSources: RateSource[] = [fixedRateSource('fixed', 100_000)]) {
  const deps = buildDeps(load(env), { rateSources });
  const app = createApp(deps);
  const open = (unit: 'usd' | 'sat', msub: number) => {
    const key = newApiKey();
    const account = tx(deps.db, () => {
      const a = deps.ledger.createAccountRaw(key, unit, null);
      if (msub > 0) deps.ledger.creditRaw(a.id, msub, 'topup', null);
      return a;
    });
    return { key, id: account.id };
  };
  const chat = (model: string, headers: Record<string, string> = {}, extra: object = {}) =>
    app.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, ...extra }),
    });
  const balance = (id: string) => deps.ledger.get(id)!.balance_msub;
  const reservations = () => (deps.db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number }).n;
  const usage = (model: string) =>
    deps.db.prepare('SELECT requests, ok, failed, nut24, estimated, charged_msub, price_nusd, cost_nusd, supplier_reported FROM usage_daily WHERE model = ?').get(model) as
      | Record<string, number>
      | undefined;
  return { deps, app, open, chat, balance, reservations, usage, close: () => deps.db.close() };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('the catalog', () => {
  it('serves free models without BELLOWS_SERVE_UNVERIFIED_PRICES: free is a checked price, not a placeholder', () => {
    const c = load();
    expect(c.env.BELLOWS_SERVE_UNVERIFIED_PRICES).toBe(false);
    expect(c.catalog.models.map((m) => m.id)).toEqual(['paid-echo', 'free-echo', 'free-slow', 'free-leftover', 'free-flat']);
    expect(c.unverifiedPrices.models).toEqual([]);
    const free = c.catalog.models.find((m) => m.id === 'free-echo')!;
    expect(free).toMatchObject({ free: true, free_reason: REASON, price_verified: true, input_usd_per_mtok: 0, output_usd_per_mtok: 0 });
    expect(c.catalog.models.find((m) => m.id === 'paid-echo')).toMatchObject({ free: false, free_reason: null, input_usd_per_mtok: 1000 });
  });

  it('drops token prices left on a free model, so they can never be charged', () => {
    const m = load().catalog.models.find((x) => x.id === 'free-leftover')!;
    expect(m).toMatchObject({ free: true, input_usd_per_mtok: 0, output_usd_per_mtok: 0 });
  });

  it('refuses a free model without a reason, a reason on a paid model, a free model marked unverified, and a paid model without prices', () => {
    const one = (m: object) => ({ suppliers: catalog.suppliers, models: [catalog.models[0], m] });
    const free = { id: 'x', supplier: 'mock', upstream: 'mock-echo', pricing: 'free', free_reason: REASON };
    expect(() => load({}, one({ ...free, free_reason: undefined }))).toThrow(/x: pricing free needs a free_reason/);
    expect(() => load({}, one({ ...free, free_reason: '  ' }))).toThrow(/invalid model catalog/);
    expect(() => load({}, one({ ...free, price_verified: false }))).toThrow(/x: a free model has no price to verify/);
    expect(() => load({}, one({ ...free, pricing: 'gratis' }))).toThrow(/invalid model catalog/);
    const paid = { id: 'x', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true };
    expect(() => load({}, one({ ...paid, free_reason: REASON }))).toThrow(/x: free_reason is only for pricing free/);
    expect(() => load({}, one({ ...paid, output_usd_per_mtok: undefined }))).toThrow(/x: needs input_usd_per_mtok and output_usd_per_mtok/);
  });
});

describe('the shipped catalogs', () => {
  const read = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../config', f), 'utf8')) as { models: Array<Record<string, unknown>> };
  const keys = () => ({ secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret(), TINFOIL_API_KEY: 'k', TOKENFACTORY_API_KEY: 'k' }) });

  it.each(['models.json', 'models.dev.json'])('%s: every Token Factory model is free, with a reason and no leftover price, and served without the unverified setting', (f) => {
    const shipped = read(f);
    const tf = shipped.models.filter((m) => m.supplier === 'tokenfactory');
    expect(tf.length).toBeGreaterThan(0);
    for (const m of tf) {
      expect(m, String(m.id)).toMatchObject({ pricing: 'free', free_reason: expect.stringMatching(/Token Factory/) });
      expect(m, String(m.id)).not.toHaveProperty('input_usd_per_mtok');
      expect(m, String(m.id)).not.toHaveProperty('output_usd_per_mtok');
      expect(m, String(m.id)).not.toHaveProperty('price_verified');
    }
    const c = loadConfig(base as NodeJS.ProcessEnv, shipped, keys());
    expect(c.unverifiedPrices.models).toEqual([]);
    const served = c.catalog.models.filter((m) => m.supplier === 'tokenfactory');
    expect(served.map((m) => m.id)).toEqual(tf.map((m) => m.id));
    expect(served.every((m) => m.free && m.input_usd_per_mtok === 0 && m.output_usd_per_mtok === 0)).toBe(true);
    // Paid models keep their prices.
    for (const m of c.catalog.models.filter((x) => x.supplier !== 'tokenfactory' && x.supplier !== 'mock')) expect(m.free, m.id).toBe(false);
  });

  it('models.json ships all 13 Token Factory models', () => {
    expect(read('models.json').models.filter((m) => m.supplier === 'tokenfactory')).toHaveLength(13);
  });
});

describe('GET /v1/models', () => {
  it('marks free models free, at 0 in both units, needing a balance key; paid models keep their fields', async () => {
    const s = setup();
    try {
      const list = (await (await s.app.request('http://gw.test/v1/models')).json()) as { data: Array<{ id: string; pricing: Record<string, unknown> }> };
      const by = Object.fromEntries(list.data.map((m) => [m.id, m.pricing]));
      expect(by['free-echo']).toEqual({
        mode: 'free',
        free: true,
        free_reason: REASON,
        requires_balance_key: true,
        usd_per_mtok: { input: 0, output: 0 },
        sat_per_mtok: { input: 0, output: 0 },
        verified: true,
      });
      expect(by['free-flat']).toMatchObject({ mode: 'free', usd_per_mtok: { input: 0, output: 0 } });
      expect(by['paid-echo']).toEqual({
        mode: 'metered',
        free: false,
        free_reason: null,
        requires_balance_key: false,
        usd_per_mtok: { input: 1250, output: 2500 },
        sat_per_mtok: { input: 1250000, output: 2500000 },
        verified: true,
      });
    } finally {
      s.close();
    }
  });
});

describe('a free model with a balance key', () => {
  it('is served at a balance of 0, charging and holding nothing; the same balance cannot use a paid model', async () => {
    const s = setup();
    try {
      const a = s.open('usd', 0);
      for (const model of ['free-echo', 'free-leftover', 'free-flat']) {
        const res = await s.chat(model, bearer(a.key));
        expect(res.status, model).toBe(200);
        expect(res.headers.get('x-forge-charged-msub'), model).toBe('0');
        expect(res.headers.get('x-forge-balance-msub'), model).toBe('0');
        expect(((await res.json()) as any).choices[0].message.content, model).toMatch(/^Hello/);
        expect(s.usage(model), model).toEqual({ requests: 1, ok: 1, failed: 0, nut24: 0, estimated: 0, charged_msub: 0, price_nusd: 0, cost_nusd: 0, supplier_reported: 0 });
      }
      expect(s.balance(a.id)).toBe(0);
      expect(s.reservations()).toBe(0);
      const paid = await s.chat('paid-echo', bearer(a.key));
      expect(paid.status).toBe(402);
      expect(await code(paid)).toBe('insufficient_balance');
    } finally {
      s.close();
    }
  });

  it('leaves a funded balance untouched and logs the request as charged 0 with cost_source free', async () => {
    const s = setup();
    const lines: Array<Record<string, unknown>> = [];
    setLogSink((l) => lines.push(JSON.parse(l)));
    try {
      const a = s.open('usd', 5_000_000);
      const res = await s.chat('free-echo', bearer(a.key));
      expect(res.status).toBe(200);
      expect(s.balance(a.id)).toBe(5_000_000);
      expect(res.headers.get('x-forge-balance-msub')).toBe('5000000');
      const req = lines.find((l) => l.msg === 'request')!;
      expect(req).toMatchObject({ model: 'free-echo', payment: 'free', status: 'ok', reserved_msub: 0, charged_msub: 0, cost_nusd: 0, cost_source: 'free' });
    } finally {
      s.close();
    }
  });

  it('streams with nothing reserved while it runs, and settles at 0', async () => {
    const s = setup();
    try {
      const a = s.open('usd', 0);
      const res = await s.chat('free-slow', bearer(a.key), { stream: true });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let raw = dec.decode((await reader.read()).value);
      // Mid-stream: no reservation exists.
      expect(s.reservations()).toBe(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value);
      }
      const forge = raw.split('\n\n').find((b) => b.startsWith('event: forge'))!;
      expect(JSON.parse(forge.split('\n')[1]!.slice(5))).toMatchObject({ unit: 'usd', charged_msub: 0, balance_msub: 0 });
      expect(s.balance(a.id)).toBe(0);
      expect(s.usage('free-slow')).toMatchObject({ ok: 1, charged_msub: 0, price_nusd: 0 });
    } finally {
      s.close();
    }
  });

  it('works for a sat balance at 0 even when no BTC/USD rate is known (nothing to convert)', async () => {
    const s = setup({}, [down]);
    try {
      const a = s.open('sat', 0);
      const res = await s.chat('free-echo', bearer(a.key));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-forge-unit')).toBe('sat');
      expect(res.headers.get('x-forge-charged-msub')).toBe('0');
      // A paid model still needs the rate.
      const b = s.open('sat', 1_000_000);
      expect(await code(await s.chat('paid-echo', bearer(b.key)))).toBe('rate_unavailable');
    } finally {
      s.close();
    }
  });

  it('is refused for a frozen balance', async () => {
    const s = setup();
    try {
      const a = s.open('usd', 0);
      s.deps.ledger.setFrozen(a.id, true);
      const res = await s.chat('free-echo', bearer(a.key));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('account_frozen');
      expect(s.usage('free-echo')).toBeUndefined();
    } finally {
      s.close();
    }
  });

  it('keeps the per-balance rate limit', async () => {
    const s = setup({ BELLOWS_RATE_LIMIT_RPM: '1' });
    try {
      const a = s.open('usd', 0);
      // The bucket's burst is at least 5.
      for (let i = 0; i < 5; i++) expect((await s.chat('free-echo', bearer(a.key))).status).toBe(200);
      const res = await s.chat('free-echo', bearer(a.key));
      expect(res.status).toBe(429);
      expect(await code(res)).toBe('rate_limited');
    } finally {
      s.close();
    }
  });
});

describe('a free model without a balance key', () => {
  it('is refused with balance_key_required: no 402 ask, and NUT-24 eCash is never looked at or taken', async () => {
    const s = setup();
    const inspect = vi.spyOn(s.deps.wallet, 'inspect');
    const receive = vi.spyOn(s.deps.wallet, 'receive');
    try {
      for (const headers of [{}, { 'x-cashu': 'cashuBnotatoken' }, { 'x-forge-unit': 'sat' }, { 'x-forge-invite': 'inv-x' }] as Array<Record<string, string>>) {
        const res = await s.chat('free-echo', headers);
        expect(res.status, JSON.stringify(headers)).toBe(401);
        expect(res.headers.get('x-cashu'), JSON.stringify(headers)).toBeNull();
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('balance_key_required');
        expect(body.error.message).toMatch(/balance key/);
      }
      expect(inspect).not.toHaveBeenCalled();
      expect(receive).not.toHaveBeenCalled();
      expect(s.usage('free-echo')).toBeUndefined();
      // An unknown key is refused as before.
      expect(await code(await s.chat('free-echo', bearer(newApiKey())))).toBe('invalid_key');
    } finally {
      s.close();
    }
  });

  it('leaves paid models as they were: no key gets the 402 payment request', async () => {
    const s = setup();
    try {
      const res = await s.chat('paid-echo');
      expect(res.status).toBe(402);
      expect(res.headers.get('x-cashu')).toMatch(/^creq/);
      expect(await code(res)).toBe('payment_required');
    } finally {
      s.close();
    }
  });
});

describe('paid models', () => {
  it('reserve and charge from the balance exactly as before', async () => {
    const s = setup();
    try {
      const a = s.open('usd', 10_000_000);
      const res = await s.chat('paid-echo', bearer(a.key));
      expect(res.status).toBe(200);
      const charged = Number(res.headers.get('x-forge-charged-msub'));
      expect(charged).toBeGreaterThan(0);
      expect(s.balance(a.id)).toBe(10_000_000 - charged);
      expect(Number(res.headers.get('x-forge-balance-msub'))).toBe(10_000_000 - charged);
      expect(s.reservations()).toBe(0);
      expect(s.usage('paid-echo')).toMatchObject({ ok: 1, charged_msub: charged, cost_nusd: expect.any(Number) });
      expect(s.usage('paid-echo')!.price_nusd).toBeGreaterThan(0);
    } finally {
      s.close();
    }
  });
});

describe('through Oblivious HTTP', () => {
  it('a free model behaves the same: served at 0 with a key, refused without one', async () => {
    const s = setup();
    try {
      const operator = { origin: 'http://gw.test', keyConfig: s.deps.identity.keyConfig };
      const fetchApp = async (url: string, init?: RequestInit) => s.app.fetch(new Request(url, init));
      const a = s.open('usd', 0);
      const body = JSON.stringify({ model: 'free-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
      const ok = await bellowsFetch(operator, '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(a.key) }, body }, { fetch: fetchApp });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-forge-charged-msub')).toBe('0');
      expect(s.balance(a.id)).toBe(0);
      const refused = await bellowsFetch(operator, '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cashu': 'cashuBx' }, body }, { fetch: fetchApp });
      expect(refused.status).toBe(401);
      expect(await code(refused)).toBe('balance_key_required');
    } finally {
      s.close();
    }
  });
});
