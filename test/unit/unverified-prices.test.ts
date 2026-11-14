import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { announceUnverifiedPrices, loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { memorySecrets, newWalletSecret } from '../../src/secrets.ts';

setLogSilent(true);

// A keyed supplier (like Token Factory) with one checked price and one placeholder, beside a keyless mock.
const catalog = {
  suppliers: {
    mock: { type: 'mock', tier: 'standard' },
    paid: { type: 'openai', tier: 'standard', baseUrl: 'http://127.0.0.1:1/v1', apiKeySecret: 'PAID_API_KEY' },
  },
  models: [
    { id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true },
    { id: 'paid-checked', supplier: 'paid', upstream: 'a', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true },
    { id: 'paid-placeholder', supplier: 'paid', upstream: 'b', input_usd_per_mtok: 1, output_usd_per_mtok: 4, price_verified: false },
    // No price_verified at all: the schema default (false) applies.
    { id: 'paid-unmarked', supplier: 'paid', upstream: 'c', input_usd_per_mtok: 1, output_usd_per_mtok: 4 },
  ],
};
const base = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
const withKey = () => ({ secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret(), PAID_API_KEY: 'sk-paid' }) });
const load = (env: Record<string, string> = {}, cat: unknown = catalog) => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv, cat, withKey());

afterEach(() => setLogSink(undefined));

describe('models whose price is not verified', () => {
  it('are not served by default, even with the supplier key present', () => {
    const c = load();
    expect(c.catalog.models.map((m) => m.id)).toEqual(['mock-echo', 'paid-checked']);
    expect(c.unverifiedPrices).toEqual({ served: false, models: ['paid-placeholder', 'paid-unmarked'] });
  });

  it('a supplier left with no verified model is not served at all; startup refuses a catalog with nothing verified', () => {
    const only = { suppliers: { paid: catalog.suppliers.paid }, models: catalog.models.filter((m) => m.id === 'paid-placeholder') };
    expect(() => load({}, only)).toThrow(/no models left.*price_verified/);
    expect(load({ BELLOWS_SERVE_UNVERIFIED_PRICES: 'true' }, only).catalog.models.map((m) => m.id)).toEqual(['paid-placeholder']);
  });

  it('are served only when the operator sets BELLOWS_SERVE_UNVERIFIED_PRICES, which is off by default', () => {
    expect(load().env.BELLOWS_SERVE_UNVERIFIED_PRICES).toBe(false);
    expect(load({ BELLOWS_SERVE_UNVERIFIED_PRICES: 'false' }).catalog.models.map((m) => m.id)).toEqual(['mock-echo', 'paid-checked']);
    const c = load({ BELLOWS_SERVE_UNVERIFIED_PRICES: 'true' });
    expect(c.catalog.models.map((m) => m.id)).toEqual(['mock-echo', 'paid-checked', 'paid-placeholder', 'paid-unmarked']);
    expect(c.unverifiedPrices).toEqual({ served: true, models: ['paid-placeholder', 'paid-unmarked'] });
    expect(() => load({ BELLOWS_SERVE_UNVERIFIED_PRICES: 'maybe' })).toThrow(/invalid environment/);
  });

  it('a keyless supplier stays left out and is not reported as unverified', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv, catalog, { secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret() }) });
    expect(c.catalog.models.map((m) => m.id)).toEqual(['mock-echo']);
    expect(c.unverifiedPrices.models).toEqual([]);
  });

  it('startup logs the withheld models, and logs serving them at error level so no log level hides it', () => {
    const lines: Array<Record<string, unknown>> = [];
    setLogSink((l) => lines.push(JSON.parse(l)));
    announceUnverifiedPrices(load());
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', msg: 'unverified_prices_withheld', models: 'paid-placeholder,paid-unmarked', count: 2 })]);
    lines.length = 0;
    announceUnverifiedPrices(load({ BELLOWS_SERVE_UNVERIFIED_PRICES: 'true' }));
    expect(lines).toEqual([
      expect.objectContaining({ level: 'error', msg: 'unverified_prices_served', models: 'paid-placeholder,paid-unmarked', count: 2, setting: 'BELLOWS_SERVE_UNVERIFIED_PRICES' }),
    ]);
    lines.length = 0;
    announceUnverifiedPrices(load({}, { ...catalog, models: catalog.models.slice(0, 2) }));
    expect(lines).toEqual([]);
  });
});

describe('the API serves only verified prices', () => {
  const app = (env: Record<string, string> = {}) => {
    const config = load(env);
    const d = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
    return { a: createApp(d), close: () => d.db.close() };
  };
  const chat = (model: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });

  it('/v1/models lists only served models, and a request for a withheld model is refused before payment', async () => {
    const { a, close } = app();
    try {
      const list = (await (await a.request('http://gw.test/v1/models')).json()) as { data: Array<{ id: string; pricing: { verified: boolean } }> };
      expect(list.data.map((m) => m.id)).toEqual(['mock-echo', 'paid-checked']);
      expect(list.data.every((m) => m.pricing.verified)).toBe(true);
      for (const id of ['paid-placeholder', 'paid-unmarked']) {
        const res = await a.request('http://gw.test/v1/chat/completions', chat(id));
        expect(res.status, id).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code, id).toBe('model_not_found');
      }
      // A served model still asks for payment as before.
      expect((await a.request('http://gw.test/v1/chat/completions', chat('paid-checked'))).status).toBe(402);
    } finally {
      close();
    }
  });

  it('with the operator setting on, the unverified models are listed and still say verified: false', async () => {
    const { a, close } = app({ BELLOWS_SERVE_UNVERIFIED_PRICES: 'true' });
    try {
      const list = (await (await a.request('http://gw.test/v1/models')).json()) as { data: Array<{ id: string; pricing: { verified: boolean } }> };
      expect(Object.fromEntries(list.data.map((m) => [m.id, m.pricing.verified]))).toEqual({
        'mock-echo': true,
        'paid-checked': true,
        'paid-placeholder': false,
        'paid-unmarked': false,
      });
      expect((await a.request('http://gw.test/v1/chat/completions', chat('paid-placeholder'))).status).toBe(402);
    } finally {
      close();
    }
  });
});

describe('admin settings', () => {
  it('report a present key even when all its models are withheld, and name the withheld models', async () => {
    const token = 'admin-test-token-0123456789abcdef';
    const only = { suppliers: catalog.suppliers, models: catalog.models.filter((m) => m.id !== 'paid-checked') };
    const hash = createHash('sha256').update(token).digest('hex');
    const config = loadConfig({ ...base, BELLOWS_ADMIN_RATE_LIMIT_RPM: '100000' } as NodeJS.ProcessEnv, only, {
      secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret(), PAID_API_KEY: 'sk-paid', BELLOWS_ADMIN_TOKEN_HASH: hash }),
    });
    const d = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
    try {
      const res = await createApp(d).request('http://gw.test/admin/api/settings', { headers: { host: 'gw.test', 'x-bellows-admin-token': token } });
      expect(res.status).toBe(200);
      const s = (await res.json()) as any;
      expect(s.suppliers.find((x: any) => x.id === 'paid')).toMatchObject({ key_present: true, models: 0 });
      expect(s.unverified_prices).toEqual({ served: false, models: ['paid-placeholder', 'paid-unmarked'] });
      expect(s.models.map((m: any) => m.id)).toEqual(['mock-echo']);
      expect(JSON.stringify(s)).not.toContain('sk-paid');
    } finally {
      d.db.close();
    }
  });
});

describe('the shipped catalog', () => {
  const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '../../config/models.json'), 'utf8')) as typeof catalog;
  const keys = () => ({ secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret(), TINFOIL_API_KEY: 'k', TOKENFACTORY_API_KEY: 'k' }) });

  it('with every supplier key present, serves no model whose price is unverified', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv, shipped, keys());
    expect(c.catalog.models.length).toBeGreaterThan(0);
    expect(c.catalog.models.filter((m) => !m.price_verified)).toEqual([]);
    const placeholders = shipped.models.filter((m) => m.price_verified !== true).map((m) => m.id);
    expect(c.unverifiedPrices.models).toEqual(placeholders);
    for (const id of placeholders) expect(c.catalog.models.map((m) => m.id)).not.toContain(id);
  });
});
