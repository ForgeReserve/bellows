import { PaymentRequest } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chatBody,
  createInvite,
  expectedMsub,
  type Gateway,
  MINT_A,
  MINT_B,
  mintProofs,
  mintToken,
  mintsUp,
  readSse,
  redeem,
  startGateway,
  userWallet,
} from './helpers.ts';
import { getEncodedToken } from '@cashu/cashu-ts';

const up = await mintsUp();
if (!up) console.warn('Local mints not running: start them with `pnpm mint:up`. Skipping e2e.');

describe.skipIf(!up)('NUT-24 pay per request', () => {
  let g: Gateway;
  let invite: string;
  beforeAll(async () => {
    g = await startGateway();
    invite = createInvite(g);
  });
  afterAll(() => g.close());

  const post = (body: object, headers: Record<string, string> = {}) =>
    fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('requires an invite while invite-only', async () => {
    const res = await post(chatBody('mock-echo'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('invite_required');
  });

  it('402 carries a NUT-18 creqA request; paying returns the answer and exact change', async () => {
    const res = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite });
    expect(res.status).toBe(402);
    const creq = res.headers.get('x-cashu')!;
    expect(creq.startsWith('creqA')).toBe(true);
    const pr = PaymentRequest.fromEncodedRequest(creq);
    expect(pr.unit).toBe('usd');
    expect(pr.mints).toEqual([MINT_A]);
    const a = pr.amount!.toNumber();
    expect(a).toBeGreaterThan(0);

    const paid = a + 5; // overpay; change must come back
    const token = await mintToken(MINT_A, 'usd', paid);
    const ok = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.choices[0].message.content).toContain('Hello');
    const charged = Number(ok.headers.get('x-forge-charged-msub'));
    // 10 prompt tokens + 12 completion tokens at test prices = 1300 msub, rounded up to 2 cents.
    expect(expectedMsub(json.usage.prompt_tokens, json.usage.completion_tokens)).toBe(1300);
    expect(charged).toBe(2000);
    const change = ok.headers.get('x-cashu-change')!;
    expect(change.startsWith('cashuB')).toBe(true);
    expect(await redeem(change)).toBe(paid - 2);
    // The same change is re-deliverable by request id.
    const again = await (await fetch(`${g.url}/v1/change/${ok.headers.get('x-forge-request-id')}`)).json();
    expect(again.token).toBe(change);
  });

  it('rejects tokens from an untrusted mint with 400', async () => {
    const token = await mintToken(MINT_B, 'usd', 20);
    const res = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('untrusted_mint');
    expect(await redeem(token, MINT_B)).toBe(20); // untouched
  });

  it('rejects an insufficient token with 400 and leaves it unspent', async () => {
    const token = await mintToken(MINT_A, 'usd', 1);
    const res = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('insufficient_amount');
    expect(await redeem(token)).toBe(1);
  });

  it('rejects a double spend', async () => {
    const token = await mintToken(MINT_A, 'usd', 20);
    const first = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(first.status).toBe(200);
    const second = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe('token_spent');
  });

  it('rejects a token already spent at the mint', async () => {
    const proofs = await mintProofs(MINT_A, 'usd', 20);
    const token = getEncodedToken({ mint: MINT_A, unit: 'usd', proofs });
    const w = await userWallet(MINT_A, 'usd');
    await w.receive(token); // spend it elsewhere first
    const res = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('token_spent');
  });

  it('prices sat requests from the BTC/USD rate', async () => {
    const res = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Forge-Unit': 'sat' });
    expect(res.status).toBe(402);
    const pr = PaymentRequest.fromEncodedRequest(res.headers.get('x-cashu')!);
    expect(pr.unit).toBe('sat');
    const token = await mintToken(MINT_A, 'sat', pr.amount!.toNumber());
    const ok = await post(chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-forge-unit')).toBe('sat');
    // $0.013 at $100k/BTC = 13 sat = 13000 msat
    expect(Number(ok.headers.get('x-forge-charged-msub'))).toBe(13_000);
    expect(await redeem(ok.headers.get('x-cashu-change')!, MINT_A, 'sat')).toBe(pr.amount!.toNumber() - 13);
  });

  it('upstream failure charges nothing and returns all change', async () => {
    const token = await mintToken(MINT_A, 'usd', 30);
    const res = await post(chatBody('mock-fail'), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-forge-charged-msub')).toBe('0');
    expect(await redeem(res.headers.get('x-cashu-change')!)).toBe(30);
  });

  it('streams with change delivered in the final forge event', async () => {
    const token = await mintToken(MINT_A, 'usd', 20);
    const res = await post(chatBody('mock-echo', { stream: true }), { 'X-Forge-Invite': invite, 'X-Cashu': token });
    expect(res.status).toBe(200);
    const { data, forge } = await readSse(res);
    expect(data.length).toBeGreaterThan(1);
    expect(data.every((d) => d.choices.length > 0)).toBe(true); // usage-only chunk stripped (client did not ask)
    expect(forge.charged_msub).toBe(2000);
    expect(await redeem(forge.change)).toBe(18);
  });
});
