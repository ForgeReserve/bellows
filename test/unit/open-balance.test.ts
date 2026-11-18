/**
 * POST /v1/wallet/open: an empty balance (0) opened with an invite and no eCash, so a new person can use
 * free models without funding anything. The invite is spent as a funded topup spends it, the same proof of
 * work and rate limits apply, and the balance is kept: a later funding that expires does not release it.
 * With invite-only off, proof of work is the bound; with neither, the endpoint is off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bellowsFetch } from '../../client/index.ts';
import { solvePow } from '../../client/pow.ts';
import { releaseIfEmpty } from '../../src/accounts.ts';
import { createApp, OPENS_BALANCE } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [
    { id: 'paid-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1000, output_usd_per_mtok: 2000, price_verified: true },
    { id: 'free-echo', supplier: 'mock', upstream: 'mock-echo', pricing: 'free', free_reason: 'Free in tests' },
  ],
};

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function setup(env: Record<string, string> = {}) {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', BELLOWS_INVITE_ONLY: 'true', BELLOWS_POW_BITS: '0', ...env };
  const deps = buildDeps(loadConfig(e as NodeJS.ProcessEnv, catalog), { rateSources: [fixedRateSource('fixed', 100_000)] });
  closers.push(() => deps.db.close());
  const app = createApp(deps);
  const open = (body: object | undefined = {}, headers: Record<string, string> = {}) =>
    app.request('http://gw.test/v1/wallet/open', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const chat = (model: string, key: string) =>
    app.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    });
  const invite = () => deps.invites.create('test').code;
  return { deps, app, open, chat, invite };
}

const json = async (res: Response) => (await res.json()) as any;

describe('POST /v1/wallet/open with invite-only on', () => {
  it('opens a balance of 0 from an invite alone and returns its key once; the key uses free models and nothing else', async () => {
    const s = setup();
    const res = await s.open({ invite: s.invite() });
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b).toMatchObject({ created: true, unit: 'usd', balance_msub: 0, balance: 0 });
    expect(b.key).toMatch(/^sk-forge-/);
    expect(s.deps.ledger.findByKey(b.key)!.id).toBe(b.account_id);
    const free = await s.chat('free-echo', b.key);
    expect(free.status).toBe(200);
    expect(free.headers.get('x-forge-charged-msub')).toBe('0');
    const paid = await s.chat('paid-echo', b.key);
    expect(paid.status).toBe(402);
    expect((await json(paid)).error.code).toBe('insufficient_balance');
    const w = await json(await s.app.request('http://gw.test/v1/wallet', { headers: { authorization: `Bearer ${b.key}` } }));
    expect(w).toMatchObject({ balance_msub: 0, available_msub: 0, refundable: 0 });
  });

  it('spends the invite as a funded topup does: once, and unlinked from the balance', async () => {
    const s = setup();
    const code = s.invite();
    const b = await json(await s.open({ invite: code }));
    const inv = s.deps.db.prepare('SELECT status, account_id FROM invites').get() as { status: string; account_id: string | null };
    expect(inv).toEqual({ status: 'redeemed', account_id: null });
    expect((s.deps.db.prepare('SELECT invite_id FROM accounts WHERE id = ?').get(b.account_id) as { invite_id: string | null }).invite_id).toBeNull();
    const again = await s.open({ invite: code });
    expect(again.status).toBe(403);
    expect((await json(again)).error.code).toBe('invite_used');
    // The same invite cannot then open a balance by topup or funding either.
    const topup = await s.app.request('http://gw.test/v1/wallet/fund/lightning', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1, unit: 'usd', invite: code }) });
    expect((await json(topup)).error.code).toBe('invite_used');
  });

  it('refuses no invite, an unknown one and a revoked one, opening nothing', async () => {
    const s = setup();
    expect((await json(await s.open({}))).error.code).toBe('invite_required');
    expect((await json(await s.open(undefined))).error.code).toBe('invite_required');
    expect((await json(await s.open({ invite: 'inv-nope' }))).error.code).toBe('invite_required');
    const code = s.invite();
    s.deps.invites.revoke(code);
    const res = await s.open({ invite: code });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('invite_invalid');
    expect((s.deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0);
  });

  it('takes the unit as a funding does: the default unit unless one is named, which must be offered', async () => {
    const s = setup({ BELLOWS_DEFAULT_UNIT: 'sat' });
    expect((await json(await s.open({ invite: s.invite() }))).unit).toBe('sat');
    expect((await json(await s.open({ invite: s.invite(), unit: 'usd' }))).unit).toBe('usd');
    const bad = await s.open({ invite: s.invite(), unit: 'eur' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe('wrong_unit');
    const only = setup({ BELLOWS_UNITS: 'usd' });
    expect((await json(await only.open({ invite: only.invite(), unit: 'sat' }))).error.code).toBe('wrong_unit');
  });

  it('keeps the balance: a later funding that fails or expires does not release it or reopen the invite', async () => {
    const s = setup();
    const b = await json(await s.open({ invite: s.invite() }));
    expect(releaseIfEmpty(s.deps.db, b.account_id)).toBe(false);
    expect(s.deps.ledger.findByKey(b.key)).toBeDefined();
    expect((s.deps.db.prepare('SELECT status FROM invites').get() as { status: string }).status).toBe('redeemed');
  });

  it('opens under a key the client chose (not returned), and with a known key opens nothing', async () => {
    const s = setup();
    const mine = newApiKey();
    const b = await json(await s.open({ invite: s.invite() }, { authorization: `Bearer ${mine}` }));
    expect(b).toMatchObject({ created: true, balance_msub: 0 });
    expect(b.key).toBeUndefined();
    expect(s.deps.ledger.findByKey(mine)!.id).toBe(b.account_id);
    // Known key: the existing balance, no invite needed, nothing created.
    const known = await s.open({}, { authorization: `Bearer ${mine}` });
    expect(known.status).toBe(200);
    expect(await json(known)).toMatchObject({ created: false, account_id: b.account_id, unit: 'usd' });
    expect((s.deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(1);
    expect((await json(await s.open({}, { authorization: 'Bearer not-a-key' }))).error.code).toBe('invalid_key');
  });

  it('needs proof of work like every path that opens a balance, and keeps the anonymous rate limit', async () => {
    expect(OPENS_BALANCE.has('/v1/wallet/open')).toBe(true);
    const s = setup({ BELLOWS_POW_BITS: '8' });
    const code = s.invite();
    const ask = await s.open({ invite: code });
    expect(ask.status).toBe(428);
    const { pow } = await json(ask);
    expect((await s.open({ invite: code }, { 'x-bellows-pow': await solvePow(pow.challenge, pow.bits) })).status).toBe(200);
    // Without proof of work, requests that open balances share the anonymous budget (burst of at least 5).
    const r = setup({ BELLOWS_ANON_RATE_LIMIT_RPM: '1' });
    for (let i = 0; i < 5; i++) expect((await r.open({ invite: r.invite() })).status).toBe(200);
    expect((await json(await r.open({ invite: r.invite() }))).error.code).toBe('rate_limited');
  });

  it('works through Oblivious HTTP', async () => {
    const s = setup();
    const res = await bellowsFetch(
      { origin: 'http://gw.test', keyConfig: s.deps.identity.keyConfig },
      '/v1/wallet/open',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: s.invite() }) },
      { fetch: async (u, i) => s.app.fetch(new Request(u, i)) },
    );
    expect(res.status).toBe(200);
    expect((await json(res)).key).toMatch(/^sk-forge-/);
  });
});

describe('POST /v1/wallet/open with invite-only off', () => {
  it('opens a balance of 0 behind proof of work alone, ignoring any invite', async () => {
    const s = setup({ BELLOWS_INVITE_ONLY: 'false', BELLOWS_POW_BITS: '8' });
    const ask = await s.open({});
    expect(ask.status).toBe(428);
    const { pow } = await json(ask);
    const res = await s.open({}, { 'x-bellows-pow': await solvePow(pow.challenge, pow.bits) });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ created: true, balance_msub: 0 });
  });

  it('is off when neither an invite nor proof of work bounds it, and says so in the funding methods', async () => {
    const s = setup({ BELLOWS_INVITE_ONLY: 'false', BELLOWS_POW_BITS: '0' });
    const res = await s.open({});
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('open_disabled');
    expect((s.deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0);
    const methods = async (x: ReturnType<typeof setup>) => (await json(await x.app.request('http://gw.test/v1/wallet/fund/methods'))).open_empty;
    expect(await methods(s)).toEqual({ enabled: false, needs_invite: false, pow_bits: 0 });
    expect(await methods(setup())).toEqual({ enabled: true, needs_invite: true, pow_bits: 0 });
    expect(await methods(setup({ BELLOWS_INVITE_ONLY: 'false', BELLOWS_POW_BITS: '8' }))).toEqual({ enabled: true, needs_invite: false, pow_bits: 8 });
    // A known key still answers: nothing is opened.
    const key = newApiKey();
    s.deps.ledger.createAccountRaw(key, 'usd', null);
    expect((await s.open({}, { authorization: `Bearer ${key}` })).status).toBe(200);
  });
});
