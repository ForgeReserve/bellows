import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.ts';
import { sqliteStore } from '../../src/mint-discovery.ts';
import { chatBody, createInvite, type Gateway, MINT_A, MINT_B, MINT_C, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';
import { type OnchainMock, startOnchainMock } from './onchain-mock.ts';

const up = (await mintsUp()) && (await fetch(`${MINT_C}/v1/info`).then((r) => r.ok).catch(() => false));
const j = (b: object) => JSON.stringify(b);
const FOREIGN_ENV = { BELLOWS_FOREIGN_ALLOW_INSECURE: 'true' };

async function post(g: Gateway, path: string, body: object, key?: string) {
  const res = await fetch(`${g.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: j(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function get(g: Gateway, path: string, key: string) {
  const res = await fetch(`${g.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as any };
}

/** Polls the status endpoint (which also drives progress) until the funding leaves the given states. */
async function waitFor(g: Gateway, id: string, key: string, until: string[] = ['done', 'expired', 'failed', 'refunded']) {
  for (let i = 0; i < 100; i++) {
    const r = await get(g, `/v1/wallet/fund/${id}`, key);
    if (until.includes(r.body.state)) return r.body;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`funding ${id} did not finish`);
}

const topupRows = (g: Gateway, accountId: string) =>
  (g.deps.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account_id = ? AND kind = 'topup'").get(accountId) as { n: number }).n;

describe.skipIf(!up)('funding: Lightning (NUT-04 bolt11 at the funding mint)', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: FOREIGN_ENV });
  });
  afterAll(() => g.close());

  it('lists the methods the mint supports', async () => {
    const m = await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json();
    expect(m.lightning.enabled).toBe(true);
    expect(m.lightning.units.sort()).toEqual(['sat', 'usd']);
    expect(m.onchain.enabled).toBe(false);
    expect(m.foreign.enabled).toBe(true);
    expect(m.invite_only).toBe(true);
  });

  it('invite gating: a new balance needs an open invite', async () => {
    const none = await post(g, '/v1/wallet/fund/lightning', { amount: 10, unit: 'usd' });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('invite_required');
    const invite = createInvite(g);
    const first = await post(g, '/v1/wallet/fund/lightning', { amount: 10, unit: 'usd', invite });
    expect(first.status).toBe(200);
    const again = await post(g, '/v1/wallet/fund/lightning', { amount: 10, unit: 'usd', invite });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('invite_used');
  });

  it('quote -> paid -> minted -> credited, then the key pays for a request', async () => {
    const invite = createInvite(g);
    const r = await post(g, '/v1/wallet/fund/lightning', { amount: 25, unit: 'usd', invite });
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(/^sk-forge-/);
    expect(r.body.request).toMatch(/^lnbc/);
    expect(r.body.state).toBe('pending');
    const key = r.body.key as string;
    // The key is stored hashed only.
    expect(JSON.stringify(g.deps.db.prepare('SELECT * FROM accounts').all())).not.toContain(key);
    expect(JSON.stringify(g.deps.db.prepare('SELECT * FROM fundings').all())).not.toContain(key);
    const done = await waitFor(g, r.body.id, key);
    expect(done.state).toBe('done');
    expect(done.credited).toBe(25);
    expect(done.balance_msub).toBe(25_000);
    expect(done.key).toBeUndefined();
    const w = await get(g, '/v1/wallet', key);
    expect(w.body.balance_msub).toBe(25_000);
    const chat = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: j(chatBody('mock-echo')),
    });
    expect(chat.status).toBe(200);
    // A second funding on the same key, listed under the key.
    const r2 = await post(g, '/v1/wallet/fund/lightning', { amount: 5, unit: 'usd' }, key);
    expect(r2.body.key).toBeUndefined();
    await waitFor(g, r2.body.id, key);
    const list = await get(g, '/v1/wallet/fund', key);
    expect(list.body.data.map((x: any) => x.credited).sort()).toEqual([25, 5].sort());
    expect(topupRows(g, done.account_id)).toBe(2);
  });

  it('rejects a unit that differs from the balance, and bad amounts', async () => {
    const invite = createInvite(g);
    const r = await post(g, '/v1/wallet/fund/lightning', { amount: 100, unit: 'sat', invite });
    const key = r.body.key as string;
    await waitFor(g, r.body.id, key);
    const wrong = await post(g, '/v1/wallet/fund/lightning', { amount: 5, unit: 'usd' }, key);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('wrong_unit');
    const bad = await post(g, '/v1/wallet/fund/lightning', { amount: 2_000_000, unit: 'sat' }, key);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_amount');
  });

  it('double-credit prevention: concurrent polls and the poller credit once', async () => {
    const invite = createInvite(g);
    const r = await post(g, '/v1/wallet/fund/lightning', { amount: 9, unit: 'usd', invite });
    const key = r.body.key as string;
    await new Promise((res) => setTimeout(res, 300));
    await Promise.all([
      ...Array.from({ length: 8 }, () => get(g, `/v1/wallet/fund/${r.body.id}`, key)),
      g.deps.funding.tick(),
      g.deps.funding.advance(r.body.id),
      g.deps.funding.advance(r.body.id),
    ]);
    const done = await waitFor(g, r.body.id, key);
    expect(done.credited).toBe(9);
    expect(done.balance_msub).toBe(9_000);
    expect(topupRows(g, done.account_id)).toBe(1);
    // Advancing a finished funding again changes nothing.
    await g.deps.funding.advance(r.body.id);
    expect(g.deps.ledger.get(done.account_id)!.balance_msub).toBe(9_000);
  });
});

describe.skipIf(!up)('funding: crash safety', () => {
  it('restart mid-quote: the new process resumes the pending quote and credits once', async () => {
    const g1 = await startGateway();
    const invite = createInvite(g1);
    const r = await post(g1, '/v1/wallet/fund/lightning', { amount: 12, unit: 'usd', invite });
    const key = r.body.key as string;
    await g1.close(); // never polled in this process

    const g2 = await startGateway({ dbPath: g1.dbPath });
    try {
      await new Promise((res) => setTimeout(res, 300));
      await g2.deps.funding.tick(); // background poller
      const done = await waitFor(g2, r.body.id, key);
      expect(done.credited).toBe(12);
      expect(done.balance_msub).toBe(12_000);
      expect(topupRows(g2, done.account_id)).toBe(1);
    } finally {
      await g2.close();
    }
  });

  it.each([
    ['NUT-19 replay', false],
    ['NUT-09 restore', true],
  ])('mint signed, DB write lost -> recovered exactly once via %s', async (_n, noReplay) => {
    const g1 = await startGateway({ fundingFaults: { afterMint: true } });
    const invite = createInvite(g1);
    const r = await post(g1, '/v1/wallet/fund/lightning', { amount: 21, unit: 'sat', invite });
    const key = r.body.key as string;
    await new Promise((res) => setTimeout(res, 300));
    await g1.deps.funding.advance(r.body.id);
    const row = g1.deps.funding.get(r.body.id)!;
    expect(row.state).toBe('minting');
    expect(row.mint_op).toBeTruthy();
    expect(g1.deps.ledger.get(row.account_id)!.balance_msub).toBe(0);
    await g1.close();

    const g2 = await startGateway({ dbPath: g1.dbPath, fundingFaults: { noReplay } });
    try {
      await g2.deps.funding.tick();
      const done = await waitFor(g2, r.body.id, key);
      expect(done.state).toBe('done');
      expect(done.credited).toBe(21);
      expect(done.balance_msub).toBe(21_000);
      expect(topupRows(g2, row.account_id)).toBe(1);
      // Finalizing the same mint operation again (a racing poller, a second recovery) credits nothing.
      const fake = [{ id: JSON.parse(row.mint_op!).keysetId, amount: 21, secret: 'replayed-secret', C: '02' + '11'.repeat(32) }];
      (g2.deps.funding as any).finalizeMint(row.id, JSON.parse(row.mint_op!), fake);
      expect(g2.deps.ledger.get(row.account_id)!.balance_msub).toBe(21_000);
      // The minted proofs are real: the wallet can pay them out.
      const refund = await post(g2, '/v1/wallet/refund', { amount: 21 }, key);
      expect(refund.status).toBe(200);
      expect(await redeem(refund.body.token, MINT_A, 'sat')).toBe(21);
    } finally {
      await g2.close();
    }
  });
});

describe.skipIf(!up)('funding: eCash from another mint (receive, melt, mint at the funding mint)', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: FOREIGN_ENV });
  });
  afterAll(() => g.close());

  it('quote shows the exact credit and fees; confirm credits exactly that and returns change', async () => {
    const invite = createInvite(g);
    const token = await mintToken(MINT_C, 'sat', 1000);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite });
    expect(q.status).toBe(200);
    expect(q.body.state).toBe('quoted');
    expect(q.body.request).toBeNull();
    const f = q.body.foreign;
    expect(f.mint).toBe(MINT_C);
    expect(f.unit).toBe('sat');
    expect(f.token_amount).toBe(1000);
    expect(f.credit).toBeGreaterThan(950);
    expect(f.credit + f.fee_max).toBeLessThanOrEqual(1000);
    expect(f.fee_max).toBeGreaterThan(0);
    const key = q.body.key as string;
    // Nothing is spent before confirm.
    expect(g.deps.db.prepare("SELECT COUNT(*) AS n FROM incoming WHERE purpose = 'foreign'").get()).toEqual({ n: 0 });

    const c = await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    expect(c.status).toBe(200);
    const done = c.body.state === 'done' ? c.body : await waitFor(g, q.body.id, key);
    expect(done.state).toBe('done');
    expect(done.credited).toBe(f.credit);
    expect(done.balance_msub).toBe(f.credit * 1000);
    // Unused fee reserve and leftover come back as eCash from the token's mint.
    const change = done.foreign.change_token as string;
    expect(change).toMatch(/^cashuB/);
    const back = await redeem(change, MINT_C, 'sat');
    expect(back).toBeGreaterThan(0);
    expect(f.credit + back).toBeLessThanOrEqual(1000);
    // Foreign proofs are spent, never counted as gateway holdings.
    expect(g.deps.wallet.holdings().find((h) => h.mint === MINT_C)?.unspent ?? 0).toBe(0);
    // A second confirm is a no-op.
    const again = await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    expect(again.body.state).toBe('done');
    expect(g.deps.ledger.get(done.account_id)!.balance_msub).toBe(f.credit * 1000);
  });

  it('crosses units: a sat token funds a usd balance', async () => {
    const invite = createInvite(g);
    const token = await mintToken(MINT_C, 'sat', 5000);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd', invite });
    expect(q.status).toBe(200);
    expect(q.body.unit).toBe('usd');
    const credit = q.body.foreign.credit as number;
    expect(credit).toBeGreaterThan(0);
    const key = q.body.key as string;
    await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    const done = await waitFor(g, q.body.id, key);
    expect(done.credited).toBe(credit);
    expect(done.balance_msub).toBe(credit * 1000);
  });

  it('policy: accepted-mint tokens go to topup, wrong token, deny list, max, invite', async () => {
    const own = await mintToken(MINT_A, 'usd', 5);
    const r1 = await post(g, '/v1/wallet/fund/foreign/quote', { token: own, unit: 'usd', invite: createInvite(g) });
    expect(r1.body.error.code).toBe('use_topup');

    const noInvite = await post(g, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_C, 'sat', 200), unit: 'sat' });
    expect(noInvite.status).toBe(403);

    const big = await post(g, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_C, 'sat', 100_001), unit: 'sat', invite: createInvite(g) });
    expect(big.body.error.code).toBe('amount_too_large');

    const invite = createInvite(g);
    const token = await mintToken(MINT_C, 'sat', 300);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite });
    const other = await mintToken(MINT_C, 'sat', 300);
    const mismatch = await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token: other }, q.body.key);
    expect(mismatch.body.error.code).toBe('token_mismatch');
  });

  it('a melt that no longer fits is refunded to the user as eCash from their mint', async () => {
    const invite = createInvite(g);
    const token = await mintToken(MINT_C, 'sat', 600);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite });
    const key = q.body.key as string;
    // Fees "rise" between quote and confirm: point the melt at an invoice the token cannot cover.
    const { userWallet } = await import('./helpers.ts');
    const fundMint = await userWallet(MINT_A, 'sat');
    const big = await fundMint.createMintQuoteBolt11(5000);
    const foreign = await userWallet(MINT_C, 'sat');
    const mq = await foreign.createMeltQuoteBolt11(big.request);
    g.deps.db.prepare('UPDATE fundings SET request = ?, f_melt_quote = ? WHERE id = ?').run(big.request, mq.quote, q.body.id);
    const c = await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    expect(c.body.state).toBe('refunded');
    expect(c.body.credited).toBe(0);
    const back = await redeem(c.body.foreign.refund_token, MINT_C, 'sat');
    expect(back).toBeGreaterThan(590);
    expect(back).toBeLessThanOrEqual(600);
    // The empty balance is released and the invite can be used again.
    expect(g.deps.ledger.get(q.body.account_id)).toBeUndefined();
    expect(g.deps.invites.lookup(invite)!.status).toBe('open');
  });

  it('an unconfirmed quote expires and frees the invite', async () => {
    const invite = createInvite(g);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_C, 'sat', 400), unit: 'sat', invite });
    g.deps.db.prepare('UPDATE fundings SET expires_at = ?, next_check = 0 WHERE id = ?').run(Date.now() - 1000, q.body.id);
    await g.deps.funding.tick();
    expect(g.deps.funding.get(q.body.id)!.state).toBe('expired');
    expect(g.deps.ledger.get(q.body.account_id)).toBeUndefined();
    expect(g.deps.invites.lookup(invite)!.status).toBe('open');
  });

  it('deny list and plain-http mints are refused', async () => {
    const strict = await startGateway({ env: { BELLOWS_FOREIGN_DENY: MINT_C, BELLOWS_FOREIGN_ALLOW_INSECURE: 'true' } });
    const plain = await startGateway();
    try {
      const token = await mintToken(MINT_C, 'sat', 200);
      const d = await post(strict, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite: createInvite(strict) });
      expect(d.body.error.code).toBe('mint_not_allowed');
      const p = await post(plain, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite: createInvite(plain) });
      expect(p.body.error.code).toBe('mint_not_allowed');
    } finally {
      await strict.close();
      await plain.close();
    }
  });

  it("under 'discovered', a discovered mint is accepted and an unlisted one is refused", async () => {
    // Seed the stored discovery snapshot (relays stay off in tests), then start on that database.
    const dir = mkdtempSync(join(tmpdir(), 'bellows-e2e-disc-'));
    const dbPath = join(dir, 'bellows.db');
    const seed = openDb(dbPath);
    sqliteStore(seed).save({ v: 1, at: Date.now(), mints: [{ url: MINT_C, reviewers: 4, name: 'Test mint C', units: ['sat'], probed_at: Date.now() }] });
    seed.close();
    const d = await startGateway({ dbPath, env: { BELLOWS_FOREIGN_POLICY: 'discovered', BELLOWS_FOREIGN_ALLOW_INSECURE: 'true', BELLOWS_FOREIGN_UNLISTED: 'false' } });
    try {
      const list = (await (await fetch(`${d.url}/v1/wallet/fund/mints`)).json()) as any;
      expect(list.policy).toBe('discovered');
      expect(list.mints).toEqual([{ url: MINT_C, name: 'Test mint C', reviewers: 4, source: 'discovered' }]);
      expect(list.updated_at).toBeGreaterThan(0);
      const methods = (await (await fetch(`${d.url}/v1/wallet/fund/methods`)).json()) as any;
      expect(methods.foreign).toMatchObject({ policy: 'discovered', mints: [MINT_C], mints_url: '/v1/wallet/fund/mints' });

      const ok = await post(d, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_C, 'sat', 300), unit: 'sat', invite: createInvite(d) });
      expect(ok.status).toBe(200);
      expect(ok.body.foreign.mint).toBe(MINT_C);
      const refused = await post(d, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_B, 'sat', 300), unit: 'sat', invite: createInvite(d) });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('mint_not_allowed');
      expect(refused.body.error.message).toMatch(/\/v1\/wallet\/fund\/mints/);
    } finally {
      await d.close();
    }
  });

  it("under 'discovered' with no discovered mints: an unlisted mint needs accept_unlisted and the lower cap; an admin-added mint does not", async () => {
    const adminToken = 'e2e-admin-token-0123456789';
    const d = await startGateway({
      env: {
        BELLOWS_FOREIGN_POLICY: 'discovered',
        BELLOWS_FOREIGN_ALLOW_INSECURE: 'true',
        BELLOWS_FOREIGN_UNLISTED_MAX_SAT: '1000',
        BELLOWS_ADMIN_TOKEN_HASH: createHash('sha256').update(adminToken).digest('hex'),
      },
    });
    const admin = async (path: string, method = 'GET', body?: object) => {
      const res = await fetch(`${d.url}/admin/api${path}`, {
        method,
        headers: { 'x-bellows-admin-token': adminToken, ...(method === 'GET' ? {} : { origin: d.url, 'content-type': 'application/json' }) },
        body: body ? j(body) : undefined,
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    try {
      expect(((await (await fetch(`${d.url}/v1/wallet/fund/mints`)).json()) as any).mints).toEqual([]);
      const methods = (await (await fetch(`${d.url}/v1/wallet/fund/methods`)).json()) as any;
      expect(methods.foreign.unlisted).toEqual({ enabled: true, max: { sat: 1000, usd: 500 } });

      const token = await mintToken(MINT_B, 'sat', 300);
      const invite = createInvite(d);
      const asked = await post(d, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite });
      expect(asked.status).toBe(409);
      expect(asked.body.error.code).toBe('mint_unlisted');
      expect(asked.body.error.message).toMatch(/not on this gateway's recommended list/);
      expect(asked.body.unlisted).toEqual({ mint: MINT_B, max: { sat: 1000, usd: 500 } });
      // The refused quote left no balance behind, so the invite is still open.
      expect(d.deps.invites.lookup(invite)!.status).toBe('open');

      const q = await post(d, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite, accept_unlisted: true });
      expect(q.status).toBe(200);
      expect(q.body.foreign).toMatchObject({ mint: MINT_B, unlisted: true });
      const key = q.body.key as string;
      const c = await post(d, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
      expect(c.status).toBe(200);
      const done = c.body.state === 'done' ? c.body : await waitFor(d, q.body.id, key);
      expect(done.state).toBe('done');
      expect(done.credited).toBe(q.body.foreign.credit);
      expect(d.deps.funding.get(q.body.id)!.f_unlisted).toBe(1);
      // The operator sees how many fundings used an unlisted mint, never a list of them.
      expect((await admin('/fundings?state=all')).status).toBe(404);
      expect((await admin('/overview')).body.health.fundings_unlisted).toBe(1);

      const big = await post(d, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_B, 'sat', 1200), unit: 'sat', accept_unlisted: true }, key);
      expect(big.status).toBe(400);
      expect(big.body.error.code).toBe('amount_too_large');
      expect(big.body.error.message).toMatch(/not on this gateway's list are limited to 1000 sat/);

      // The operator adds mint B (live probe against the local mint); it then funds without the flag.
      const added = await admin('/mints/allowed', 'POST', { url: MINT_B, note: 'e2e' });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ forced: false, probe: { ok: true }, mint: { url: MINT_B } });
      const list = (await (await fetch(`${d.url}/v1/wallet/fund/mints`)).json()) as any;
      expect(list.mints.map((m: any) => [m.url, m.source])).toEqual([[MINT_B, 'operator']]);
      const listed = await post(d, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_B, 'sat', 1200), unit: 'sat' }, key);
      expect(listed.status).toBe(200);
      expect(listed.body.foreign.unlisted).toBe(false);
      expect(d.deps.funding.get(listed.body.id)!.f_unlisted).toBe(0);
    } finally {
      await d.close();
    }
  });

  it('swap at the token mint succeeded but the DB write was lost: the poller finishes it in-process', async () => {
    const g1 = await startGateway({ env: FOREIGN_ENV, faults: { afterReceiveSwap: true } });
    try {
      const invite = createInvite(g1);
      const token = await mintToken(MINT_C, 'sat', 700);
      const q = await post(g1, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite });
      const key = q.body.key as string;
      const c = await post(g1, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
      expect(c.body.state).toBe('receiving');
      await g1.deps.funding.tick();
      const done = await waitFor(g1, q.body.id, key);
      expect(done.state).toBe('done');
      expect(done.credited).toBe(q.body.foreign.credit);
      expect(topupRows(g1, done.account_id)).toBe(1);
    } finally {
      await g1.close();
    }
  });

  it('crash after the melt: restart recovers the change, mints and credits once', async () => {
    const g1 = await startGateway({ env: FOREIGN_ENV, fundingFaults: { afterMelt: true } });
    const invite = createInvite(g1);
    const token = await mintToken(MINT_C, 'sat', 800);
    const q = await post(g1, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite });
    const key = q.body.key as string;
    const c = await post(g1, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    expect(c.status).toBe(500);
    expect(g1.deps.funding.get(q.body.id)!.state).toBe('melting');
    await g1.close();

    const g2 = await startGateway({ dbPath: g1.dbPath, env: FOREIGN_ENV });
    try {
      await g2.deps.funding.tick();
      const done = await waitFor(g2, q.body.id, key);
      expect(done.state).toBe('done');
      expect(done.credited).toBe(q.body.foreign.credit);
      expect(topupRows(g2, done.account_id)).toBe(1);
      expect(done.foreign.change_token).toMatch(/^cashuB/);
      expect(await redeem(done.foreign.change_token, MINT_C, 'sat')).toBeGreaterThan(0);
    } finally {
      await g2.close();
    }
  });
});

describe.skipIf(!up)('funding: on-chain (NUT-30, mocked mint)', () => {
  let mock: OnchainMock;
  beforeAll(async () => {
    mock = await startOnchainMock(MINT_A);
  });
  afterAll(() => mock.close());

  const start = (extra: object = {}) =>
    startGateway({ env: { BELLOWS_TRUSTED_MINTS: mock.url, BELLOWS_ONCHAIN_ENABLED: 'true' }, ...extra });

  it('is off unless enabled', async () => {
    const g = await startGateway({ env: { BELLOWS_TRUSTED_MINTS: mock.url } });
    try {
      const m = await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json();
      expect(m.onchain.enabled).toBe(false);
      const r = await post(g, '/v1/wallet/fund/onchain', { invite: createInvite(g) });
      expect(r.body.error.code).toBe('method_unavailable');
    } finally {
      await g.close();
    }
  });

  it('address -> deposit -> minted with a NUT-20 signature -> credited; a second deposit adds to it', async () => {
    const g = await start();
    try {
      const m = await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json();
      expect(m.onchain).toMatchObject({ enabled: true, unit: 'sat', min_amount: 1000, confirmations: 3 });
      const r = await post(g, '/v1/wallet/fund/onchain', { invite: createInvite(g) });
      expect(r.status).toBe(200);
      expect(r.body.request).toMatch(/^bcrt1q/);
      expect(r.body.unit).toBe('sat');
      const key = r.body.key as string;
      const row = g.deps.funding.get(r.body.id)!;
      expect(mock.quotes.get(row.quote!)!.pubkey).toMatch(/^0[23]/);

      await g.deps.funding.advance(r.body.id);
      expect(g.deps.funding.get(r.body.id)!.state).toBe('pending');
      mock.pay(row.quote!, 20_000);
      await g.deps.funding.advance(r.body.id);
      let s = (await get(g, `/v1/wallet/fund/${r.body.id}`, key)).body;
      expect(s.credited).toBe(20_000);
      expect(s.balance_msub).toBe(20_000_000);
      expect(s.state).toBe('pending'); // still watching the address
      mock.pay(row.quote!, 5_000);
      await g.deps.funding.advance(r.body.id);
      s = (await get(g, `/v1/wallet/fund/${r.body.id}`, key)).body;
      expect(s.credited).toBe(25_000);
      expect(s.onchain.paid_sat).toBe(25_000);
      expect(topupRows(g, row.account_id)).toBe(2);
      // The watch window closes with what was credited.
      g.deps.db.prepare('UPDATE fundings SET expires_at = ?, next_check = 0 WHERE id = ?').run(Date.now() - 1, r.body.id);
      await g.deps.funding.advance(r.body.id);
      expect(g.deps.funding.get(r.body.id)!.state).toBe('done');
    } finally {
      await g.close();
    }
  });

  it('crash after the mint: restart restores the signatures and credits once', async () => {
    const g1 = await start({ fundingFaults: { afterMint: true } });
    const r = await post(g1, '/v1/wallet/fund/onchain', { invite: createInvite(g1) });
    const key = r.body.key as string;
    const quote = g1.deps.funding.get(r.body.id)!.quote!;
    mock.pay(quote, 15_000);
    await g1.deps.funding.advance(r.body.id);
    expect(g1.deps.funding.get(r.body.id)!.state).toBe('minting');
    await g1.close();

    const g2 = await start({ dbPath: g1.dbPath });
    try {
      await g2.deps.funding.tick();
      const s = (await get(g2, `/v1/wallet/fund/${r.body.id}`, key)).body;
      expect(s.credited).toBe(15_000);
      expect(s.balance_msub).toBe(15_000_000);
      expect(topupRows(g2, s.account_id)).toBe(1);
      expect(mock.quotes.get(quote)!.issued).toBe(15_000);
    } finally {
      await g2.close();
    }
  });
});
