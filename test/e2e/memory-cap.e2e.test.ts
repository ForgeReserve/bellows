/**
 * BELLOWS_STORAGE=memory: every restart loses every balance, so no balance may grow past
 * BELLOWS_MEMORY_MAX_BALANCE_USD / _SAT (docs/OPERATE.md, Running without a volume). Every way into a balance
 * is refused when it would pass the cap, before any eCash is taken: an eCash top-up, a Lightning quote and a
 * quote for eCash from another mint. An open funding holds its room until it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromBase64, utf8Decode } from '../../client/bytes.ts';
import { createInvite, type Gateway, MINT_A, MINT_C, mintToken, mintsUp, redeem, startGateway, userWallet } from './helpers.ts';

const up = (await mintsUp()) && (await fetch(`${MINT_C}/v1/info`).then((r) => r.ok).catch(() => false));
const j = (b: object) => JSON.stringify(b);
const MEMORY_ENV = {
  BELLOWS_STORAGE: 'memory',
  BELLOWS_MEMORY_MAX_BALANCE_USD: '100',
  BELLOWS_MEMORY_MAX_BALANCE_SAT: '1000',
  BELLOWS_FOREIGN_ALLOW_INSECURE: 'true',
};

async function post(g: Gateway, path: string, body: object, key?: string) {
  const res = await fetch(`${g.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: j(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function waitFor(g: Gateway, id: string, key: string) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${g.url}/v1/wallet/fund/${id}`, { headers: { authorization: `Bearer ${key}` } });
    const body = (await r.json()) as any;
    if (['done', 'expired', 'failed', 'refunded'].includes(body.state)) return body;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`funding ${id} did not finish`);
}

const balance = (g: Gateway, key: string) => g.deps.ledger.findByKey(key)!.balance_msub / 1000;

describe.skipIf(!up)('memory storage: the balance cap', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: MEMORY_ENV });
  });
  afterAll(() => g.close());

  it('refuses an eCash top-up above the cap and leaves the token and the invite with their owner', async () => {
    const invite = createInvite(g);
    const big = await mintToken(MINT_A, 'usd', 150);
    const r = await post(g, '/v1/wallet/topup', { token: big, invite });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('balance_limit');
    expect(r.body).toMatchObject({ unit: 'usd', balance_max: 100, room: 100 });
    // Nothing was received: the token is still good, and the invite still opens a balance.
    expect(await redeem(big)).toBe(150);
    const ok = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 60), invite });
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toBe(60);
  });

  it('credits up to the cap and refuses the top-up that would pass it', async () => {
    const first = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 60), invite: createInvite(g) });
    const key = first.body.key as string;
    const fill = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 40) }, key);
    expect(fill.status).toBe(200);
    expect(fill.body.balance).toBe(100);
    const over = await mintToken(MINT_A, 'usd', 1);
    const r = await post(g, '/v1/wallet/topup', { token: over }, key);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: 'balance_limit' }, room: 0 });
    expect(await redeem(over)).toBe(1);
    expect(balance(g, key)).toBe(100);
  });

  it('two top-ups at once never pass the cap together', async () => {
    const first = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 10), invite: createInvite(g) });
    const key = first.body.key as string;
    const tokens = [await mintToken(MINT_A, 'usd', 60), await mintToken(MINT_A, 'usd', 60)];
    const results = await Promise.all(tokens.map((token) => post(g, '/v1/wallet/topup', { token }, key)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const refused = tokens[results.findIndex((r) => r.status === 400)]!;
    expect(await redeem(refused)).toBe(60);
    expect(balance(g, key)).toBe(70);
  });

  it('Lightning: a quote past the room is refused up front, and an open quote holds its room', async () => {
    const over = await post(g, '/v1/wallet/fund/lightning', { amount: 101, unit: 'usd', invite: createInvite(g) });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('balance_limit');
    const r = await post(g, '/v1/wallet/fund/lightning', { amount: 60, unit: 'usd', invite: createInvite(g) });
    expect(r.status).toBe(200);
    const key = r.body.key as string;
    // Paid or not yet, the 60 is spoken for: 50 more does not fit, in a quote or as eCash.
    const second = await post(g, '/v1/wallet/fund/lightning', { amount: 50, unit: 'usd' }, key);
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ error: { code: 'balance_limit' }, room: 40 });
    const token = await mintToken(MINT_A, 'usd', 50);
    expect((await post(g, '/v1/wallet/topup', { token }, key)).body.error.code).toBe('balance_limit');
    expect(await redeem(token)).toBe(50);
    expect((await waitFor(g, r.body.id, key)).credited).toBe(60);
    const rest = await post(g, '/v1/wallet/fund/lightning', { amount: 40, unit: 'usd' }, key);
    expect(rest.status).toBe(200);
    expect((await waitFor(g, rest.body.id, key)).credited).toBe(40);
    expect(balance(g, key)).toBe(100);
  });

  it('eCash from another mint: a quote past the room is refused and nothing is taken', async () => {
    const token = await mintToken(MINT_C, 'sat', 1500);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat', invite: createInvite(g) });
    expect(q.status).toBe(400);
    expect(q.body).toMatchObject({ error: { code: 'balance_limit' }, unit: 'sat', balance_max: 1000 });
    expect(g.deps.db.prepare("SELECT COUNT(*) AS n FROM incoming WHERE purpose = 'foreign'").get()).toEqual({ n: 0 });
    // Every proof is still unspent at its mint (that mint charges an input fee, so redeeming would not show 1500).
    const w = await userWallet(MINT_C, 'sat');
    const states = await w.checkProofsStates(w.decodeToken(token).proofs);
    expect(states.map((x) => x.state)).toEqual(states.map(() => 'UNSPENT'));
    // A token that fits is quoted and credited as usual.
    const small = await mintToken(MINT_C, 'sat', 500);
    const ok = await post(g, '/v1/wallet/fund/foreign/quote', { token: small, unit: 'sat', invite: createInvite(g) });
    expect(ok.status).toBe(200);
    const key = ok.body.key as string;
    await post(g, '/v1/wallet/fund/foreign/confirm', { id: ok.body.id, token: small }, key);
    expect((await waitFor(g, ok.body.id, key)).credited).toBe(ok.body.foreign.credit);
  });

  it('says the cap where clients look: the funding methods and the attested statement', async () => {
    const m = (await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json()) as any;
    expect(m.storage).toBe('memory');
    expect(m.balance_max).toEqual({ usd: 100, sat: 1000 });
    expect(m.lightning.max).toEqual({ usd: 100, sat: 1000 });
    const doc = (await (await fetch(`${g.url}/.well-known/bellows`)).json()) as any;
    const statement = JSON.parse(utf8Decode(fromBase64(doc.statement)));
    expect(statement).toMatchObject({ storage: 'memory', balance_max: { usd: 100, sat: 1000 } });
  });
});

describe.skipIf(!up)('volume storage: no balance cap', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: { BELLOWS_MEMORY_MAX_BALANCE_USD: '100' } });
  });
  afterAll(() => g.close());

  it('credits past the memory cap and says there is none', async () => {
    const r = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 150), invite: createInvite(g) });
    expect(r.status).toBe(200);
    expect(r.body.balance).toBe(150);
    const m = (await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json()) as any;
    expect(m.storage).toBe('volume');
    expect(m.balance_max).toBeNull();
    const doc = (await (await fetch(`${g.url}/.well-known/bellows`)).json()) as any;
    expect(JSON.parse(utf8Decode(fromBase64(doc.statement))).balance_max).toBeUndefined();
  });
});

describe.skipIf(!up)('memory storage: a top-up whose outcome is unknown', () => {
  const faults = { afterReceiveSwap: true };
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: MEMORY_ENV, faults });
  });
  afterAll(() => g.close());

  it('keeps its room while unsettled, and its retry is credited, never refused', async () => {
    const token = await mintToken(MINT_A, 'usd', 30);
    const first = await post(g, '/v1/wallet/topup', { token, invite: createInvite(g) });
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe('topup_pending');
    const key = first.body.key as string;
    faults.afterReceiveSwap = false;
    // The mint has the 30; until it is credited, only 70 more fits.
    const other = await mintToken(MINT_A, 'usd', 80);
    const refused = await post(g, '/v1/wallet/topup', { token: other }, key);
    expect(refused.body).toMatchObject({ error: { code: 'balance_limit' }, room: 70 });
    expect(await redeem(other)).toBe(80);
    const retry = await post(g, '/v1/wallet/topup', { token }, key);
    expect(retry.status).toBe(200);
    expect(retry.body.balance).toBe(30);
    expect((await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 70) }, key)).body.balance).toBe(100);
  });
});
