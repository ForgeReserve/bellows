// Cached input (docs/how-it-works/payments.md, Cached input): input tokens the supplier served from its prompt
// cache are charged at the model's cached_input_usd_per_mtok, the rest of the input at the input price. The
// hold stays at the full input price. A missing or wrong cached count charges as before.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supplierCosts } from '../../src/admin-api.ts';
import { CatalogSchema, loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { usageFromJson } from '../../src/meter.ts';
import { cachedInputTokens, costNanoUsd, nanoUsdToMsub, type Usage } from '../../src/pricing.ts';
import { parseUsageMetrics } from '../../src/suppliers/tinfoil.ts';
import { recordUsageRaw, type SettledUsage, usageSince } from '../../src/usage.ts';

// DeepSeek V4.1 Flash on Tinfoil's rate card, 2026-11-20: 0.60 in, 0.01 cached in, 1.45 out per million.
const flash = { input_usd_per_mtok: 0.6, cached_input_usd_per_mtok: 0.01, output_usd_per_mtok: 1.45 };
const noCache = { input_usd_per_mtok: 0.6, output_usd_per_mtok: 1.45 };
const env = { BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1' };

describe('cached input: the charge', () => {
  it('with no cached tokens, charges exactly as before, whether or not the model has a cached price', () => {
    for (const markup of [1, 1.25]) {
      const before = 1000 * Math.ceil(0.6 * markup * 1000 - 1e-9) + 500 * Math.ceil(1.45 * markup * 1000 - 1e-9);
      for (const u of [{ inputTokens: 1000, outputTokens: 500 }, { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }]) {
        expect(costNanoUsd(flash, u, markup)).toBe(before);
        expect(costNanoUsd(noCache, u, markup)).toBe(before);
      }
    }
  });

  it('charges cached tokens at the cached price and the rest at the input price', () => {
    // markup 1: 600 and 10 nano-USD per input token, 1450 per output token.
    expect(costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1)).toBe(200 * 600 + 800 * 10 + 500 * 1450);
    // all cached
    expect(costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 }, 1)).toBe(1000 * 10);
    // markup 1.25: 750, 12.5 rounded up to 13, and 1812.5 rounded up to 1813.
    expect(costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1.25)).toBe(200 * 750 + 800 * 13 + 500 * 1813);
  });

  it('a model with no cached price charges cached tokens at the input price', () => {
    expect(costNanoUsd(noCache, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1)).toBe(1000 * 600 + 500 * 1450);
  });

  it('bounds the cached count: a wrong or hostile figure never lowers the charge below the cached price, nor raises it above the full price', () => {
    const full = costNanoUsd(flash, { inputTokens: 1000, outputTokens: 500 }, 1);
    const allCached = costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 500 }, 1);
    for (const bad of [-1, -1e9, 0.5, 799.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, '800', null, {}, true]) {
      const u = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: bad as unknown as number };
      expect(cachedInputTokens(u), String(bad)).toBe(0);
      expect(costNanoUsd(flash, u, 1)).toBe(full);
    }
    // Above the input tokens: all of them, never more.
    for (const above of [1001, 5000, Number.MAX_SAFE_INTEGER]) {
      expect(cachedInputTokens({ inputTokens: 1000, cachedInputTokens: above })).toBe(1000);
      expect(costNanoUsd(flash, { inputTokens: 1000, outputTokens: 500, cachedInputTokens: above }, 1)).toBe(allCached);
    }
    expect(cachedInputTokens({ inputTokens: 0, cachedInputTokens: 10 })).toBe(0);
    expect(cachedInputTokens({ inputTokens: -5, cachedInputTokens: 10 })).toBe(0);
    expect(cachedInputTokens({ inputTokens: 10 })).toBe(0);
  });

  it('never charges more than without the cache, and never a negative amount', () => {
    for (const markup of [1, 1.1, 1.25, 2]) {
      for (const input of [0, 1, 7, 1000, 123_457]) {
        for (const cached of [0, 1, Math.floor(input / 3), input, input + 10, -3]) {
          const u: Usage = { inputTokens: input, cachedInputTokens: cached, outputTokens: 33 };
          const n = costNanoUsd(flash, u, markup);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(costNanoUsd(flash, { inputTokens: input, outputTokens: 33 }, markup));
          // Never below every input token at the cached price.
          expect(n).toBeGreaterThanOrEqual(costNanoUsd(flash, { inputTokens: input, cachedInputTokens: input, outputTokens: 33 }, markup));
        }
      }
    }
  });

  it('converts to usd and sat msub, rounding up once', () => {
    const n = costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1); // 853,000 nano-USD
    expect(n).toBe(853_000);
    expect(nanoUsdToMsub(n, 'usd')).toBe(86); // 85.3 milli-cents, rounded up
    expect(nanoUsdToMsub(n, 'sat', 100_000)).toBe(853); // 853 msat at 100,000 USD per bitcoin
    expect(nanoUsdToMsub(n, 'sat', 65_008.12)).toBe(Math.ceil((853_000 * 100) / 65_008.12));
  });

  it('a usage with no cached count, as the hold and the estimates are priced, costs the full input price', () => {
    // The hold (src/app.ts, step 3) and the estimates for answers without usage pass no cached count.
    for (const markup of [1, 1.25]) {
      expect(costNanoUsd(flash, { inputTokens: 2000, outputTokens: 64 }, markup)).toBe(costNanoUsd(noCache, { inputTokens: 2000, outputTokens: 64 }, markup));
    }
  });
});

describe('cached input: what the supplier reports', () => {
  it('reads usage.prompt_tokens_details.cached_tokens (and input_tokens_details on the Responses API)', () => {
    expect(usageFromJson({ usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 800 } } })).toEqual({
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 800,
    });
    expect(usageFromJson({ usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } } })!.cachedInputTokens).toBe(64);
    // The final chunk of a stream has the same usage object.
    expect(usageFromJson({ choices: [], usage: { prompt_tokens: 69, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } } })!.cachedInputTokens).toBe(64);
  });

  it('a missing or unreadable cached count is no cached tokens, never a failure', () => {
    for (const details of [undefined, null, {}, { cached_tokens: null }, { cached_tokens: '800' }, { cached_tokens: NaN }, 'x', 5]) {
      const u = usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: details } });
      expect(u).toEqual({ inputTokens: 10, outputTokens: 2 });
      expect(cachedInputTokens(u!)).toBe(0);
    }
    // A negative or oversized one is kept as sent and bounded where it is charged.
    expect(cachedInputTokens(usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -4 } } })!)).toBe(0);
    expect(cachedInputTokens(usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 99 } } })!)).toBe(10);
  });

  it("reads cached_prompt_tokens from Tinfoil's usage metrics (header or trailer)", () => {
    // The shapes in Tinfoil's router tests (confidential-model-router manager/usage_writer_test.go).
    expect(parseUsageMetrics('prompt=69,completion=20,total=89,cached_prompt_tokens=64,uncached_prompt_tokens=5,model=kimi-k2-6')).toEqual({
      inputTokens: 69,
      outputTokens: 20,
      costUsd: undefined,
      cachedInputTokens: 64,
    });
    expect(parseUsageMetrics('prompt=100,completion=50,total=150,cached_prompt_tokens=40,uncached_prompt_tokens=60,model=priced-model,cost_usd=0.000045')).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.000045,
      cachedInputTokens: 40,
    });
    // Without caching, or with a value that is not a number: no cached tokens, the rest as before.
    expect(parseUsageMetrics('prompt=67,completion=42,total=109,model=gpt-oss-120b,cost_usd=0.000042')!.cachedInputTokens).toBeUndefined();
    expect(parseUsageMetrics('prompt=67,completion=42,cached_prompt_tokens=abc')).toEqual({ inputTokens: 67, outputTokens: 42, costUsd: undefined });
    expect(parseUsageMetrics('prompt=67,completion=42,cached_prompt_tokens=-1')!.cachedInputTokens).toBeUndefined();
  });
});

describe('cached input: the catalog', () => {
  const cat = (extra: object) => ({
    suppliers: { s: { type: 'mock', tier: 'standard' } },
    models: [{ id: 'x', supplier: 's', upstream: 'x', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true, ...extra }],
  });

  it('takes an optional cached price, not negative and not above the input price', () => {
    expect(loadConfig(env, cat({})).catalog.models[0]!.cached_input_usd_per_mtok).toBeUndefined();
    expect(loadConfig(env, cat({ cached_input_usd_per_mtok: 0.25 })).catalog.models[0]!.cached_input_usd_per_mtok).toBe(0.25);
    expect(loadConfig(env, cat({ cached_input_usd_per_mtok: 1 })).catalog.models[0]!.cached_input_usd_per_mtok).toBe(1);
    expect(loadConfig(env, cat({ cached_input_usd_per_mtok: 0 })).catalog.models[0]!.cached_input_usd_per_mtok).toBe(0);
    expect(() => loadConfig(env, cat({ cached_input_usd_per_mtok: 1.01 }))).toThrow(/cached_input_usd_per_mtok must not be above input_usd_per_mtok/);
    expect(() => loadConfig(env, cat({ cached_input_usd_per_mtok: -0.1 }))).toThrow();
    expect(() => loadConfig(env, cat({ cached_input_usd_per_mtok: '0.1' }))).toThrow();
    // A model priced at 0 takes no cached price above 0.
    expect(() => loadConfig(env, cat({ input_usd_per_mtok: 0, cached_input_usd_per_mtok: 0.01 }))).toThrow(/must not be above/);
  });

  it("the shipped catalogs set it for exactly the Tinfoil models whose cached price Tinfoil's rate card listed on 2026-11-20", () => {
    for (const file of ['models.json', 'models.dev.json']) {
      const raw = JSON.parse(readFileSync(new URL(`../../config/${file}`, import.meta.url), 'utf8'));
      const parsed = CatalogSchema.parse(raw);
      const set = Object.fromEntries(parsed.models.filter((m) => m.cached_input_usd_per_mtok !== undefined).map((m) => [m.id, [m.cached_input_usd_per_mtok, m.input_usd_per_mtok, parsed.suppliers[m.supplier]!.type]]));
      expect(set, file).toEqual({ 'tinfoil/deepseek-v4-1-flash': [0.01, 0.6, 'tinfoil'], 'tinfoil/glm-5-3': [0.45, 1.8, 'tinfoil'], 'tinfoil/kimi-k3-1-pro': [0.4, 4, 'tinfoil'] });
    }
    const raw = JSON.parse(readFileSync(new URL('../../config/models.json', import.meta.url), 'utf8'));
    expect(raw._comment).toContain('cachedInputTokenPricePer1M');
    expect(raw._comment).toContain('2026-11-20');
  });
});

/** A settled request whose cost the supplier reported, added to the daily aggregates as the gateway does. */
const settled = (db: ReturnType<typeof openDb>, u: Partial<SettledUsage>) =>
  recordUsageRaw(db, {
    at: Date.now(),
    unit: 'usd',
    model: 'm1',
    supplier: 'tf',
    ok: true,
    encrypted: false,
    nut24: false,
    estimated: false,
    inputTokens: 0,
    outputTokens: 0,
    chargedMsub: 0,
    priceNusd: 0,
    costNusd: 0,
    supplierReported: true,
    ...u,
  });

describe('cached input: admin costs', () => {
  const catalog = {
    suppliers: { tf: { type: 'mock', tier: 'standard' } },
    models: [{ id: 'm1', supplier: 'tf', upstream: 'm1', input_usd_per_mtok: 1, cached_input_usd_per_mtok: 0.1, output_usd_per_mtok: 2, price_verified: true }],
  };

  it('fits prices with the cached input taken out at the cached price, so cache hits are no drift', () => {
    const config = loadConfig(env, catalog);
    const db = openDb(':memory:');
    // 1,000 nano-USD per uncached input token, 100 per cached one, 2,000 per output token: the supplier's figure.
    const mix = [[1000, 800, 100], [2000, 0, 800], [5000, 4000, 50], [300, 300, 10]] as const;
    for (const [i, k, o] of mix) {
      const cost = (i - k) * 1000 + k * 100 + o * 2000;
      settled(db, { inputTokens: i, cachedInputTokens: k, outputTokens: o, priceNusd: cost, costNusd: cost });
    }
    const m = supplierCosts(db, config, 30).models[0]!;
    expect(m.cached_input_tokens).toBe(5100);
    expect(m.input_tokens).toBe(8300);
    expect(m.catalog.cached_input).toBe(0.1);
    expect(m.derived!.input).toBeCloseTo(1, 6);
    expect(m.derived!.output).toBeCloseTo(2, 6);
    expect(m.drift).toBe(false);
    expect(m.cost_nusd).toBe(m.price_nusd);
  });

  it('a model without a cached price takes cached input out at the input price', () => {
    const config = loadConfig(env, { ...catalog, models: [{ ...catalog.models[0]!, cached_input_usd_per_mtok: undefined }] });
    const db = openDb(':memory:');
    const mix = [[1000, 800, 100], [2000, 0, 800], [5000, 4000, 50]] as const;
    for (const [i, k, o] of mix) settled(db, { inputTokens: i, cachedInputTokens: k, outputTokens: o, priceNusd: 1, costNusd: i * 1000 + o * 2000 });
    const m = supplierCosts(db, config, 30).models[0]!;
    expect(m.catalog.cached_input).toBeNull();
    expect(m.derived!.input).toBeCloseTo(1, 6);
    expect(m.derived!.output).toBeCloseTo(2, 6);
  });

  it('reads aggregates from before the columns (no cached count) as no cached tokens', () => {
    const config = loadConfig(env, catalog);
    const db = openDb(':memory:');
    for (const [i, o] of [[1000, 100], [200, 800]] as const) settled(db, { inputTokens: i, outputTokens: o, priceNusd: 1, costNusd: i * 1000 + o * 2000 });
    const m = supplierCosts(db, config, 30).models[0]!;
    expect(m.cached_input_tokens).toBe(0);
    expect(m.derived!.input).toBeCloseTo(1, 6);
  });
});

describe('cached input: the database', () => {
  it('adds usage_daily.cached_input_tokens, fit_ik and fit_ok to a database from before them; old rows read as 0', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bellows-cached-')), 'bellows.db');
    // A database as the previous release left it: usage_daily without the columns, with a row.
    let db = openDb(path);
    for (const c of ['cached_input_tokens', 'fit_ik', 'fit_ok']) db.exec(`ALTER TABLE usage_daily DROP COLUMN ${c}`);
    db.prepare("INSERT INTO usage_daily (day, unit, model, supplier, requests, ok, input_tokens, output_tokens) VALUES ('2026-11-19', 'usd', 'm1', 'tf', 1, 1, 10, 2)").run();
    const cols = () => (db.prepare('PRAGMA table_info(usage_daily)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols()).not.toContain('cached_input_tokens');
    db.close();
    db = openDb(path);
    expect(cols()).toEqual(expect.arrayContaining(['cached_input_tokens', 'fit_ik', 'fit_ok']));
    expect(db.prepare("SELECT input_tokens, cached_input_tokens, fit_ik, fit_ok FROM usage_daily WHERE day = '2026-11-19'").get()).toEqual({ input_tokens: 10, cached_input_tokens: 0, fit_ik: 0, fit_ok: 0 });
    // A new request adds to the new columns; opening again changes nothing.
    settled(db, { at: Date.parse('2026-11-19T12:00:00Z'), inputTokens: 100, cachedInputTokens: 60, outputTokens: 5, costNusd: 7 });
    db.close();
    db = openDb(path);
    expect(db.prepare("SELECT input_tokens, cached_input_tokens, fit_ii, fit_ik, fit_ok FROM usage_daily WHERE day = '2026-11-19'").get()).toEqual({
      input_tokens: 110,
      cached_input_tokens: 60,
      fit_ii: 40 * 40,
      fit_ik: 40 * 60,
      fit_ok: 5 * 60,
    });
    db.close();
  });

  it('adds a bounded cached count to the day, on settled requests only', () => {
    const db = openDb(':memory:');
    const at = Date.parse('2026-11-20T10:00:00Z');
    settled(db, { at, inputTokens: 100, cachedInputTokens: 500, outputTokens: 1 });
    settled(db, { at, inputTokens: 100, cachedInputTokens: -5, outputTokens: 1 });
    settled(db, { at, inputTokens: 100, cachedInputTokens: 40.5, outputTokens: 1 });
    settled(db, { at, inputTokens: 100, outputTokens: 1 });
    settled(db, { at, ok: false, inputTokens: 100, cachedInputTokens: 90, outputTokens: 1 });
    expect(usageSince(db, '2026-11-20')[0]).toMatchObject({ requests: 5, ok: 4, input_tokens: 400, cached_input_tokens: 100 });
  });

  it('folds the cached count of Forge AI request rows into the aggregates and drops the column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bellows-cached-mig-')), 'bellows.db');
    let db = openDb(path);
    // A Forge AI requests table from a release that counted cached input.
    db.exec(`DROP TABLE requests;
      CREATE TABLE requests (id TEXT PRIMARY KEY, account_id TEXT, payment TEXT NOT NULL, unit TEXT NOT NULL, model TEXT NOT NULL, supplier TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, usage_source TEXT,
        reserved_msub INTEGER, charged_msub INTEGER, paid_units INTEGER, change_units INTEGER, latency_ms INTEGER, lock_pubkey TEXT, price_nusd INTEGER,
        supplier_cost_nusd INTEGER, cost_source TEXT, created_at INTEGER NOT NULL);`);
    const ins = db.prepare(
      `INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, cached_input_tokens, output_tokens, usage_source, charged_msub, price_nusd, supplier_cost_nusd, cost_source, created_at)
       VALUES (?, 'nut24', 'usd', 'm1', 's1', 'settled', ?, ?, ?, 'upstream', 1, 1, 1, 'supplier', ?)`,
    );
    const at = Date.parse('2026-11-18T12:00:00Z');
    ins.run('req_a', 1000, 800, 10, at);
    ins.run('req_b', 1000, null, 10, at);
    db.close();
    db = openDb(path);
    expect((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('cached_input_tokens');
    expect(usageSince(db, '2026-11-18')[0]).toMatchObject({ requests: 2, input_tokens: 2000, cached_input_tokens: 800 });
    db.close();
  });
});
