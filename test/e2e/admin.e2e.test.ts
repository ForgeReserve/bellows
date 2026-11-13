import { createHash, randomBytes } from 'node:crypto';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revenue } from '../../src/revenue.ts';
import { chatBody, createInvite, type Gateway, MINT_A, mintToken, mintsUp, startGateway, userWallet } from './helpers.ts';

const up = await mintsUp();
const TOKEN = 'e2e-admin-token-' + randomBytes(8).toString('hex');
const ADMIN_ENV = {
  BELLOWS_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'),
  BELLOWS_ADMIN_RATE_LIMIT_RPM: '100000',
  BELLOWS_MARKUP: '1.25',
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const j = (b: object) => JSON.stringify(b);

function admin(g: Gateway) {
  return async (path: string, init: { method?: string; body?: object } = {}) => {
    const res = await fetch(`${g.url}/admin/api${path}`, {
      method: init.method ?? 'GET',
      headers: { 'x-bellows-admin-token': TOKEN, ...(init.method && init.method !== 'GET' ? { origin: g.url, 'content-type': 'application/json' } : {}) },
      body: init.body ? j(init.body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
}

async function topup(g: Gateway, amount: number, invite = createInvite(g)) {
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token: await mintToken(MINT_A, 'usd', amount), invite }) });
  return { status: r.status, body: (await r.json()) as any };
}
const chat = (g: Gateway, key: string, body = chatBody('mock-echo')) =>
  fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: j(body) });

function keypair() {
  const priv = randomBytes(32);
  return { priv: priv.toString('hex'), pub: Buffer.from(getPubKeyFromPrivKey(priv)).toString('hex') };
}

describe.skipIf(!up)('admin: revenue export', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: ADMIN_ENV });
  });
  afterAll(() => g.close());

  it('exports only sweepable revenue, locked or not, with a history row and no token stored', async () => {
    const a = admin(g);
    // Nothing earned yet: customer money is never exportable.
    const t = await topup(g, 100);
    expect(t.status).toBe(200);
    const none = await a('/export/preview', { method: 'POST', body: { unit: 'usd' } });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('nothing_sweepable');

    // Spend enough to earn several cents.
    for (let i = 0; i < 4; i++) expect((await chat(g, t.body.key)).status).toBe(200);
    const r = revenue(g.deps, 'usd');
    expect(r.sweepable).toBeGreaterThanOrEqual(3);
    expect(r.sweepable).toBe(r.unspent - r.owed - Math.ceil(g.deps.ledger.liabilities().usd! / 1000));

    const pv = await a('/export/preview', { method: 'POST', body: { unit: 'usd' } });
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ unit: 'usd', mint: MINT_A, amount: r.sweepable, max: r.sweepable });
    const over = await a('/export/preview', { method: 'POST', body: { unit: 'usd', amount: r.sweepable + 1 } });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('invalid_amount');

    // The confirm step must echo the previewed amount and lock.
    const mismatch = await a('/export', { method: 'POST', body: { unit: 'usd', amount: 1, confirm_amount: 2, confirm_mint: MINT_A } });
    expect(mismatch.status).toBe(409);

    // Locked export of 1 cent: only the key holder can redeem it.
    const k = keypair();
    const locked = await a('/export', { method: 'POST', body: { unit: 'usd', amount: 1, pubkey: k.pub, confirm_amount: 1, confirm_mint: MINT_A, confirm_pubkey: k.pub } });
    expect(locked.status).toBe(200);
    expect(locked.body.locked_to).toBe(k.pub);
    const w = await userWallet(MINT_A, 'usd');
    const proofs = w.decodeToken(locked.body.token).proofs;
    expect(proofs.every((p) => JSON.parse(p.secret)[0] === 'P2PK' && JSON.parse(p.secret)[1].data === k.pub)).toBe(true);
    await expect(w.receive(locked.body.token)).rejects.toThrow();
    const got = await w.receive(locked.body.token, { privkey: k.priv });
    expect(got.reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(1);

    // The rest, unlocked.
    const rest = r.sweepable - 1;
    const plain = await a('/export', { method: 'POST', body: { unit: 'usd', confirm_amount: rest, confirm_mint: MINT_A } });
    expect(plain.status).toBe(200);
    expect(plain.body.amount).toBe(rest);
    expect((await w.receive(plain.body.token)).reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(rest);

    // Nothing left to sweep, and the customer can still withdraw every whole cent of their balance.
    expect(revenue(g.deps, 'usd').sweepable).toBe(0);
    expect((await a('/export/preview', { method: 'POST', body: { unit: 'usd' } })).status).toBe(400);
    const refund = await fetch(`${g.url}/v1/wallet/refund`, { method: 'POST', headers: { authorization: `Bearer ${t.body.key}`, 'content-type': 'application/json' }, body: '{}' });
    expect(refund.status).toBe(200);

    const hist = await a('/exports');
    expect(hist.body.data).toHaveLength(2);
    const [second, first] = hist.body.data;
    expect(first).toMatchObject({ unit: 'usd', amount: 1, locked: true, status: 'done', token_hash: sha(locked.body.token), source: 'admin' });
    expect(second).toMatchObject({ amount: rest, locked: false, status: 'done', token_hash: sha(plain.body.token) });
    const stored = JSON.stringify(g.deps.db.prepare('SELECT * FROM revenue_exports').all());
    expect(stored).not.toContain(plain.body.token);
    expect(stored).not.toContain(locked.body.token);
    // A delivered token is not shown again.
    expect((await a(`/exports/${first.id}/finish`, { method: 'POST', body: {} })).status).toBe(409);
  });
});

describe.skipIf(!up)('admin: export crash safety', () => {
  it('a crash after the swap leaves the export owed; recovery finishes it once and it is delivered once', async () => {
    const g1 = await startGateway({ env: ADMIN_ENV, faults: { afterSendSwap: true } });
    const t = await topup(g1, 50);
    for (let i = 0; i < 3; i++) expect((await chat(g1, t.body.key)).status).toBe(200);
    const sweep = revenue(g1.deps, 'usd').sweepable;
    expect(sweep).toBeGreaterThanOrEqual(2);
    const a1 = admin(g1);
    const res = await a1('/export', { method: 'POST', body: { unit: 'usd', confirm_amount: sweep, confirm_mint: MINT_A } });
    expect(res.status).toBe(202);
    expect(res.body.token).toBeNull();
    // While it is unfinished it counts as owed: nothing more can be exported.
    expect(revenue(g1.deps, 'usd').sweepable).toBe(0);
    const dbPath = g1.dbPath;
    await g1.close();

    const g2 = await startGateway({ env: ADMIN_ENV, dbPath });
    try {
      const a2 = admin(g2);
      const hist = (await a2('/exports')).body.data;
      expect(hist).toHaveLength(1);
      expect(hist[0].status).toBe('done');
      expect(hist[0].delivered_at).toBeNull();
      const fin = await a2(`/exports/${hist[0].id}/finish`, { method: 'POST', body: {} });
      expect(fin.status).toBe(200);
      expect(sha(fin.body.token)).toBe(hist[0].token_hash);
      const w = await userWallet(MINT_A, 'usd');
      expect((await w.receive(fin.body.token)).reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(sweep);
      expect((await a2(`/exports/${hist[0].id}/finish`, { method: 'POST', body: {} })).status).toBe(409);
      expect(revenue(g2.deps, 'usd').sweepable).toBe(0);
      // The customer's balance is untouched and fully refundable.
      const refund = await fetch(`${g2.url}/v1/wallet/refund`, { method: 'POST', headers: { authorization: `Bearer ${t.body.key}`, 'content-type': 'application/json' }, body: '{}' });
      expect(refund.status).toBe(200);
    } finally {
      await g2.close();
    }
  });
});

describe.skipIf(!up)('admin: accounts, invites, waitlist and overview', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: ADMIN_ENV });
  });
  afterAll(() => g.close());

  it('freeze blocks spending but not refunds', async () => {
    const a = admin(g);
    const t = await topup(g, 20);
    const id = t.body.account_id;
    expect((await a(`/accounts/${id}/freeze`, { method: 'POST', body: { frozen: true } })).status).toBe(200);
    const blocked = await chat(g, t.body.key);
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as any).error.code).toBe('account_frozen');
    // No per-balance listing; the overview counts frozen balances.
    expect((await a(`/accounts?q=${id}`)).status).toBe(404);
    expect((await a('/overview')).body.units.find((u: any) => u.unit === 'usd').frozen_accounts).toBe(1);
    const refund = await fetch(`${g.url}/v1/wallet/refund`, { method: 'POST', headers: { authorization: `Bearer ${t.body.key}`, 'content-type': 'application/json' }, body: j({ amount: 5 }) });
    expect(refund.status).toBe(200);
    expect(((await refund.json()) as any).token).toMatch(/^cashuB/);
    expect((await a(`/accounts/${id}/freeze`, { method: 'POST', body: { frozen: false } })).status).toBe(200);
    expect((await chat(g, t.body.key)).status).toBe(200);
  });

  it('a revoked invite cannot open a balance or pay per request', async () => {
    const a = admin(g);
    const created = (await a('/invites', { method: 'POST', body: { count: 1, label: 'revoke-me' } })).body.data[0];
    expect((await a(`/invites/${created.id}/revoke`, { method: 'POST', body: {} })).status).toBe(200);
    const t = await topup(g, 5, created.code);
    expect(t.status).toBe(403);
    expect(t.body.error.code).toBe('invite_invalid');
    const nut24 = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-invite': created.code },
      body: j(chatBody('mock-echo')),
    });
    expect(nut24.status).toBe(403);
    const listed = (await a('/invites')).body.data.find((i: any) => i.id === created.id);
    expect(listed.status).toBe('revoked');
  });

  it('overview numbers match the ledger after a known set of requests', async () => {
    const a = admin(g);
    const before = (await a('/overview')).body;
    const t = await topup(g, 100);
    const N = 5;
    for (let i = 0; i < N; i++) expect((await chat(g, t.body.key)).status).toBe(200);
    expect((await chat(g, t.body.key, chatBody('mock-fail'))).status).toBeGreaterThanOrEqual(500);
    const o = (await a('/overview')).body;

    // Charges leave no row per request: what the balance lost is what was charged.
    const charges = t.body.balance_msub - g.deps.ledger.get(t.body.account_id)!.balance_msub;
    expect(charges).toBeGreaterThan(0);
    const today = o.windows.today;
    const delta = (k: string) => today.total[k] - before.windows.today.total[k];
    expect(delta('requests')).toBe(N + 1);
    expect(delta('ok')).toBe(N);
    expect(delta('failed')).toBe(1);
    expect(today.total.revenue_msub.usd - (before.windows.today.total.revenue_msub.usd ?? 0)).toBe(charges);
    const sums = g.deps.db.prepare('SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(charged_msub) AS c, SUM(requests) AS n FROM usage_daily').get() as any;
    expect(o.windows.d30.total).toMatchObject({ input_tokens: sums.i, output_tokens: sums.o, requests: sums.n });
    expect(o.windows.d30.total.revenue_msub.usd).toBe(sums.c);
    const echo = o.windows.d30.by_model.find((m: any) => m.key === 'mock-echo');
    expect(echo.cost_msub.usd).toBe(Math.round(echo.revenue_msub.usd / 1.25));
    expect(echo.margin_msub.usd).toBe(echo.revenue_msub.usd - echo.cost_msub.usd);
    expect(o.windows.d30.by_tier.find((x: any) => x.key === 'standard').requests).toBe(sums.n);

    const usd = o.units.find((u: any) => u.unit === 'usd');
    const r = revenue(g.deps, 'usd');
    expect(usd.customer_balances_msub).toBe(g.deps.ledger.liabilities().usd);
    expect(usd.sweepable).toBe(r.sweepable);
    expect(usd.wallet_trusted).toBe(r.unspent);
    expect(usd.collected_msub).toBe(sums.c);
    expect(o.holdings.find((h: any) => h.mint === MINT_A && h.unit === 'usd')).toMatchObject({ trusted: true, unspent: r.unspent });
    expect(o.rate.btc_usd).toBe(100_000);
    expect(o.health.mints.find((m: any) => m.mint === MINT_A).ok).toBe(true);
    expect(o.health.quote_checks.budget).toBe(100000);

    // Blind by default: no per-request log in the admin API or the database, only the aggregates.
    expect((await a('/requests?limit=3')).status).toBe(404);
    expect(g.deps.db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
    const fail = o.windows.d30.by_model.find((m: any) => m.key === 'mock-fail');
    expect(fail).toMatchObject({ requests: 1, ok: 0, failed: 1, encrypted: 0 });
    expect(JSON.stringify(o)).not.toContain(t.body.account_id);
  });

  it('counts fundings without listing them, and re-checks one by id within the shared budget', async () => {
    const a = admin(g);
    const t = await topup(g, 5);
    const f = await fetch(`${g.url}/v1/wallet/fund/lightning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.body.key}` },
      body: j({ amount: 7, unit: 'usd' }),
    });
    expect(f.status).toBe(200);
    const fid = ((await f.json()) as any).id;
    // No listing; the overview has counts by method and state.
    expect((await a('/fundings')).status).toBe(404);
    expect((await a('/fundings?state=all')).status).toBe(404);
    const health = (await a('/overview')).body.health;
    expect(health.fundings_by_method.filter((x: any) => x.method === 'lightning').reduce((n: number, x: any) => n + x.n, 0)).toBeGreaterThanOrEqual(1);
    expect(typeof health.fundings_attention).toBe('number');
    expect(JSON.stringify(health)).not.toContain(fid);
    // FakeWallet pays quotes at once, so the poller or the status call may already have finished it.
    const open = ['quoted', 'receiving', 'melting', 'pending', 'minting'].includes(g.deps.funding.get(fid)!.state);
    const re = await a(`/fundings/${fid}/recheck`, { method: 'POST', body: {} });
    if (open) {
      expect(re.status).toBe(200);
      expect(['pending', 'done']).toContain(re.body.data.state);
      expect(re.body.data).toMatchObject({ method: 'lightning', unit: 'usd', amount: 7 });
      expect(JSON.stringify(re.body)).not.toContain('account_id');
      expect(JSON.stringify(re.body)).not.toContain('lock_key');
    } else {
      expect(re.status).toBe(409);
    }
  });
});
