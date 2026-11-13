/**
 * Blind by default (docs/DESIGN.md, S2): nothing that identifies a client is stored, logged or shown.
 *
 * Every request below carries made-up client identifiers (forwarded-for and similar headers, a user agent,
 * a referrer) and comes from ::1. The test then looks for them in every log line, every response, every
 * database row and the raw bytes of the database files, and fails on any hit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { solvePow } from '../../client/pow.ts';
import { captureLogs, chatBody, type Gateway, MINT_A, mintToken, mintsUp, readSse, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();
const TOKEN = 'e2e-admin-token-' + randomBytes(8).toString('hex');

const CLIENT_HEADERS: Record<string, string> = {
  'x-forwarded-for': '203.0.113.77, 198.51.100.23',
  'x-real-ip': '192.0.2.44',
  forwarded: 'for=192.0.2.45;proto=https',
  'cf-connecting-ip': '192.0.2.46',
  'true-client-ip': '192.0.2.47',
  'user-agent': 'SentinelAgent/9.9 (blind-check)',
  referer: 'https://referrer.blind-check.test/page?from=campaign',
};
/** What must never appear: the values above, and the client's own address (::1). */
const SENTINELS = ['203.0.113.77', '198.51.100.23', '192.0.2.44', '192.0.2.45', '192.0.2.46', '192.0.2.47', 'SentinelAgent', 'blind-check', '::1'];

describe.skipIf(!up)('blind by default (S2)', () => {
  let g: Gateway;
  let logs: ReturnType<typeof captureLogs>;
  const seen: string[] = [];
  const accountIds: string[] = [];
  const keys: string[] = [];

  /** Sends with the client identifiers attached and keeps everything that came back. */
  const call = async (path: string, init: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...CLIENT_HEADERS, ...init.headers };
    if (init.body !== undefined) headers['content-type'] ??= 'application/json';
    if (init.key) headers.authorization = `Bearer ${init.key}`;
    const res = await fetch(`${g.url}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body) });
    const text = await res.text();
    seen.push(text, JSON.stringify([...res.headers.entries()]));
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  };

  /** A request that opens a balance: first answer is 428 with a challenge, the resend carries the solution. */
  const withPow = async (path: string, body: unknown) => {
    const ask = await call(path, { body });
    expect(ask.status).toBe(428);
    expect(ask.json.error.code).toBe('pow_required');
    expect(ask.json.pow.bits).toBe(16);
    return call(path, { body, headers: { 'x-bellows-pow': await solvePow(ask.json.pow.challenge, ask.json.pow.bits) } });
  };

  beforeAll(async () => {
    logs = captureLogs();
    g = await startGateway({
      host: '::1',
      inviteOnly: false,
      // The default difficulty (16 bits), not the suite's 0.
      env: { BELLOWS_POW_BITS: '16', BELLOWS_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'), BELLOWS_ADMIN_RATE_LIMIT_RPM: '100000' },
    });
  });
  afterAll(async () => {
    logs.stop();
    await g.close();
  });

  it('runs every client path with identifying headers attached', async () => {
    // Lightning funding that opens a balance (proof of work), then credited.
    const f = await withPow('/v1/wallet/fund/lightning', { amount: 30, unit: 'usd' });
    expect(f.status).toBe(200);
    const key = f.json.key as string;
    keys.push(key);
    let state = f.json.state;
    let accountId = '';
    for (let i = 0; i < 100 && state !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const s = await call(`/v1/wallet/fund/${f.json.id}`, { key });
      state = s.json.state;
      accountId = s.json.account_id ?? accountId;
    }
    expect(state).toBe('done');
    const w = await call('/v1/wallet', { key });
    accountIds.push(w.json.account_id);
    expect(w.json.balance_msub).toBe(30_000);

    // A topup on the known key needs no proof of work; a topup that opens a balance does.
    expect((await call('/v1/wallet/topup', { key, body: { token: await mintToken(MINT_A, 'usd', 20) } })).status).toBe(200);
    const t2 = await withPow('/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 10) });
    expect(t2.status).toBe(200);
    keys.push(t2.json.key);
    accountIds.push(t2.json.account_id);

    // Balance requests: plain, streamed, and one the supplier fails.
    expect((await call('/v1/chat/completions', { key, body: chatBody('mock-echo') })).status).toBe(200);
    const streamed = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(chatBody('mock-echo', { stream: true })),
    });
    const sse = await readSse(streamed);
    seen.push(sse.raw);
    expect(sse.forge.charged_msub).toBeGreaterThan(0);
    expect((await call('/v1/chat/completions', { key, body: chatBody('mock-fail') })).status).toBeGreaterThanOrEqual(500);

    // NUT-24: asked to pay, pays, change re-delivered.
    const ask = await call('/v1/chat/completions', { body: chatBody('mock-echo') });
    expect(ask.status).toBe(402);
    const paid = await call('/v1/chat/completions', { body: chatBody('mock-echo'), headers: { 'x-cashu': await mintToken(MINT_A, 'usd', ask.json.amount + 3) } });
    expect(paid.status).toBe(200);
    const reqId = paid.headers.get('x-forge-request-id')!;
    const change = await call(`/v1/change/${reqId}`);
    expect(change.status).toBe(200);
    expect(await redeem(change.json.token)).toBeGreaterThan(0);

    // Refund, and the error paths.
    expect((await call('/v1/wallet/refund', { key, body: { amount: 1 } })).status).toBe(200);
    expect((await call('/v1/wallet/refunds', { key })).status).toBe(200);
    expect((await call('/v1/chat/completions', { key: 'sk-forge-' + 'x'.repeat(32), body: chatBody('mock-echo') })).status).toBe(401);
    expect((await call('/v1/wallet/topup', { key, body: '{not json' })).status).toBe(400);
    expect((await call('/v1/wallet', { key: 'nope' })).status).toBe(401);
    expect((await call('/v1/chat/completions', { key, body: chatBody('no-such-model') })).status).toBe(404);
    expect((await call('/v1/wallet/fund/fund_unknown', { key })).status).toBe(404);

    // Operator API, with the right token and with a wrong one.
    for (const p of ['/admin/api/overview', '/admin/api/costs', '/admin/api/invites', '/admin/api/settings']) {
      expect((await call(p, { headers: { 'x-bellows-admin-token': TOKEN } })).status, p).toBe(200);
    }
    expect((await call('/admin/api/overview', { headers: { 'x-bellows-admin-token': 'wrong' } })).status).toBe(401);
    // Freeze and unfreeze a balance (a customer with a lost key): the audit line must not name the balance.
    const admin = { 'x-bellows-admin-token': TOKEN, origin: g.url };
    for (const frozen of [true, false]) {
      expect((await call(`/admin/api/accounts/${accountIds[0]}/freeze`, { body: { frozen }, headers: admin })).status).toBe(200);
    }
  });

  it('no log line, response, database row or database file holds a client identifier', () => {
    expect(logs.lines.length).toBeGreaterThan(5);
    const tables = (g.deps.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    const rows = tables.map((t) => `${t}: ${JSON.stringify(g.deps.db.prepare(`SELECT * FROM "${t}"`).all())}`).join('\n');
    const files = [g.dbPath, `${g.dbPath}-wal`].filter(existsSync).map((p) => readFileSync(p).toString('latin1')).join('\n');
    const places = { logs: logs.lines.join('\n'), responses: seen.join('\n'), database: rows, 'database files': files };
    const hits: string[] = [];
    for (const [where, text] of Object.entries(places)) for (const s of SENTINELS) if (text.includes(s)) hits.push(`${s} in ${where}`);
    expect(hits).toEqual([]);
  });

  it('logs no balance id or key', () => {
    const text = logs.lines.join('\n');
    expect(accountIds).toHaveLength(2);
    for (const id of [...accountIds, ...keys]) expect(text).not.toContain(id);
    // The freeze and unfreeze above were logged, so this check covers them.
    const actions = logs.entries().filter((e) => e.msg === 'admin_action').map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['account_freeze', 'account_unfreeze']));
  });

  it('keeps no row per request: only daily aggregates per model and supplier', () => {
    const db = g.deps.db;
    expect(db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'charge'").get()).toEqual({ n: 0 });
    const echo = db.prepare("SELECT * FROM usage_daily WHERE model = 'mock-echo'").all() as any[];
    expect(echo).toHaveLength(1);
    expect(echo[0]).toMatchObject({ unit: 'usd', supplier: 'mock', requests: 3, ok: 3, failed: 0, nut24: 1 });
    expect(echo[0].charged_msub).toBeGreaterThan(0);
    expect(echo[0].input_tokens).toBeGreaterThan(0);
    const fail = db.prepare("SELECT * FROM usage_daily WHERE model = 'mock-fail'").get() as any;
    expect(fail).toMatchObject({ requests: 1, ok: 0, failed: 1, charged_msub: 0 });
    // Each settled request is still logged once (model, tokens, cost), with no balance id.
    const settled = logs.entries().filter((e) => e.msg === 'request');
    expect(settled).toHaveLength(4);
    for (const e of settled) expect(Object.keys(e)).not.toContain('account');
  });
});
