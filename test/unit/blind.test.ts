import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, OPENS_BALANCE } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb, tx } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { solvePow } from '../../client/pow.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

function gateway(env: Record<string, string> = {}) {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
  const app = createApp(deps);
  const post = (path: string, headers: Record<string, string> = {}, body: unknown = {}) =>
    app.request(`http://gw.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { deps, app, post };
}

const chat = { model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('blind by default: the code reads nothing that identifies a client', () => {
  it('no source file reads a client address, user agent, referrer or forwarded-for header', () => {
    const banned = [
      /getConnInfo/,
      /conninfo/i,
      /remoteAddress/,
      /header\(\s*['"](x-forwarded-for|x-real-ip|forwarded|cf-connecting-ip|true-client-ip|user-agent|referer|referrer)['"]/i,
      /TRUST_PROXY/,
    ];
    const hits: string[] = [];
    for (const file of sourceFiles(join(import.meta.dirname, '../../src'))) {
      const text = readFileSync(file, 'utf8');
      for (const re of banned) if (re.test(text)) hits.push(`${file}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it('the database has no column for an address, user agent or referrer, and requests carry no balance id', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(/(^|_)(ip|addr|address|agent|user_agent|referr?er|forwarded)(_|$)/i);
    }
    const reqCols = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(reqCols).not.toContain('account_id');
    expect(tables).toContain('usage_daily');
  });
});

describe('rate limits never key on an address', () => {
  it('requests without a known key share one budget, whatever address or key they claim', async () => {
    const { post } = gateway({ BELLOWS_ANON_RATE_LIMIT_RPM: '5', BELLOWS_RATE_LIMIT_RPM: '5' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post('/v1/chat/completions', { 'x-forwarded-for': `203.0.113.${i}` }, chat)).status);
    expect(codes.every((c) => c === 402)).toBe(true);
    // A new forwarded-for value, or a made-up balance key, does not get a fresh allowance.
    expect((await post('/v1/chat/completions', { 'x-forwarded-for': '203.0.113.99' }, chat)).status).toBe(429);
    expect((await post('/v1/chat/completions', { authorization: `Bearer ${newApiKey()}` }, chat)).status).toBe(429);
  });

  it('a known balance key has its own budget', async () => {
    const { post, deps } = gateway({ BELLOWS_ANON_RATE_LIMIT_RPM: '5', BELLOWS_RATE_LIMIT_RPM: '5' });
    const key = newApiKey();
    const other = newApiKey();
    tx(deps.db, () => {
      deps.ledger.createAccountRaw(key, 'usd', null);
      deps.ledger.createAccountRaw(other, 'usd', null);
    });
    for (let i = 0; i < 6; i++) await post('/v1/chat/completions', {}, chat);
    expect((await post('/v1/chat/completions', {}, chat)).status).toBe(429);
    const mine: number[] = [];
    for (let i = 0; i < 6; i++) mine.push((await post('/v1/chat/completions', { authorization: `Bearer ${key}` }, chat)).status);
    expect(mine.slice(0, 5).every((c) => c !== 429)).toBe(true);
    expect(mine[5]).toBe(429);
    expect((await post('/v1/chat/completions', { authorization: `Bearer ${other}` }, chat)).status).not.toBe(429);
  });
});

describe('proof of work for requests that open a balance', () => {
  it('asks for it on every funding path without a known key, with a challenge to solve', async () => {
    const { post } = gateway({ BELLOWS_POW_BITS: '8' });
    for (const path of OPENS_BALANCE) {
      const res = await post(path);
      expect(res.status, path).toBe(428);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe('pow_required');
      expect(body.pow).toMatchObject({ bits: 8, header: 'X-Bellows-Pow' });
      expect(res.headers.get('x-bellows-pow-challenge')).toBe(body.pow.challenge);
    }
  });

  it('lets a solved request through once, and never limits it by address', async () => {
    const { post } = gateway({ BELLOWS_POW_BITS: '8', BELLOWS_ANON_RATE_LIMIT_RPM: '1' });
    const first = (await (await post('/v1/wallet/fund/lightning', {}, { amount: 1 })).json()) as any;
    const sol = await solvePow(first.pow.challenge, first.pow.bits);
    // Past the proof of work the request reaches its handler (which then fails on the unreachable test mint).
    const ok = await post('/v1/wallet/fund/lightning', { 'x-bellows-pow': sol }, { amount: 1 });
    expect(ok.status).not.toBe(428);
    expect(ok.status).not.toBe(429);
    const again = await post('/v1/wallet/fund/lightning', { 'x-bellows-pow': sol }, { amount: 1 });
    expect(again.status).toBe(428);
    expect(((await again.json()) as any).error.message).toMatch(/reused/);
    // Many solved requests in a row are not held to the anonymous budget of 1 a minute.
    for (let i = 0; i < 3; i++) {
      const ch = (await (await post('/v1/wallet/fund/lightning', {}, { amount: 1 })).json()) as any;
      expect((await post('/v1/wallet/fund/lightning', { 'x-bellows-pow': await solvePow(ch.pow.challenge, 8) }, { amount: 1 })).status).not.toBe(429);
    }
  });

  it('is not needed with a known balance key, and GET /v1/pow hands out a challenge', async () => {
    const { post, app, deps } = gateway({ BELLOWS_POW_BITS: '8' });
    const key = newApiKey();
    tx(deps.db, () => deps.ledger.createAccountRaw(key, 'usd', null));
    expect((await post('/v1/wallet/fund/lightning', { authorization: `Bearer ${key}` }, { amount: 1 })).status).not.toBe(428);
    // A key that does not exist yet opens a new balance, so it needs the proof of work.
    expect((await post('/v1/wallet/fund/lightning', { authorization: `Bearer ${newApiKey()}` }, { amount: 1 })).status).toBe(428);
    const ch = (await (await app.request('http://gw.test/v1/pow')).json()) as any;
    expect(ch).toMatchObject({ bits: 8, header: 'X-Bellows-Pow' });
    expect(ch.paths).toContain('/v1/wallet/topup');
  });

  it('BELLOWS_POW_BITS=0 turns it off: those requests share the anonymous budget', async () => {
    const { post, app } = gateway({ BELLOWS_POW_BITS: '0', BELLOWS_ANON_RATE_LIMIT_RPM: '5' });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post('/v1/wallet/fund/lightning', {}, { amount: 1 })).status);
    expect(codes.slice(0, 5)).not.toContain(428);
    expect(codes[5]).toBe(429);
    expect(((await (await app.request('http://gw.test/v1/pow')).json()) as any).bits).toBe(0);
  });

  it('is on by default', () => {
    expect(loadConfig({ BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv, catalog).env.BELLOWS_POW_BITS).toBe(16);
  });
});
