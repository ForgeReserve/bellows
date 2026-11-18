/**
 * Free models against the real test mints: eCash sent for one is refused and stays the payer's (unspent at
 * the mint), a balance key at 0 is served with nothing charged, plaintext and EHBP alike, and paid models on
 * the same balance charge exactly as before.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tx } from '../../src/db.ts';
import { newApiKey } from '../../src/ledger.ts';
import { chatBody, createInvite, expectedMsub, type Gateway, MINT_A, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();

describe.skipIf(!up)('free models', () => {
  let enclave: http.Server;
  let g: Gateway;
  let enclaveCalls = 0;
  const reply = Buffer.concat([Buffer.from([0, 0, 0, 8]), randomBytes(8)]);

  beforeAll(async () => {
    enclave = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        enclaveCalls++;
        // The enclave reports usage and a cost: a free model still charges nothing.
        res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': 'prompt=50,completion=7,total=57,model=enc-free,cost_usd=0.0001' });
        res.end(reply);
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    g = await startGateway({ enclavePort: (enclave.address() as AddressInfo).port });
  });
  afterAll(async () => {
    await g.close();
    enclave.close();
  });

  const zeroBalance = () => {
    const key = newApiKey();
    const a = tx(g.deps.db, () => g.deps.ledger.createAccountRaw(key, 'usd', null));
    return { key, id: a.id };
  };
  const chat = (model: string, headers: Record<string, string>) =>
    fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(chatBody(model)) });
  const encrypted = (headers: Record<string, string>) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ehbp-encapsulated-key': 'ee'.repeat(32), 'x-tinfoil-model': 'enc-free', 'x-tinfoil-max-output-tokens': '100', ...headers },
      body: new Uint8Array(randomBytes(64)),
    });

  it('refuses a NUT-24 payment for a free model without taking the token: it is still spendable', async () => {
    const token = await mintToken(MINT_A, 'usd', 20);
    const res = await chat('mock-free', { 'x-cashu': token, 'x-forge-invite': createInvite(g) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('balance_key_required');
    expect(res.headers.get('x-cashu-change')).toBeNull();
    expect(await redeem(token)).toBe(20);
  });

  it('serves a balance at 0 with nothing charged, and the same balance still cannot use a paid model', async () => {
    const a = zeroBalance();
    const res = await chat('mock-free', { authorization: `Bearer ${a.key}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-forge-charged-msub')).toBe('0');
    expect(res.headers.get('x-forge-balance-msub')).toBe('0');
    const paid = await chat('mock-echo', { authorization: `Bearer ${a.key}` });
    expect(paid.status).toBe(402);
    expect((await paid.json()).error.code).toBe('insufficient_balance');
  });

  it('EHBP: forwards to the enclave at 0 with a key; without one it is refused before the enclave is reached', async () => {
    const a = zeroBalance();
    const before = enclaveCalls;
    const res = await encrypted({ authorization: `Bearer ${a.key}` });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(reply)).toBe(true);
    expect(res.headers.get('x-forge-charged-msub')).toBe('0');
    expect(enclaveCalls).toBe(before + 1);
    const refused = await encrypted({});
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe('balance_key_required');
    expect(enclaveCalls).toBe(before + 1);
    expect(g.deps.ledger.get(a.id)!.balance_msub).toBe(0);
  });

  it('an invite alone opens a balance of 0 that uses free models, plaintext and EHBP', async () => {
    const res = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
    expect(res.status).toBe(200);
    const opened = await res.json();
    expect(opened).toMatchObject({ created: true, unit: 'usd', balance_msub: 0 });
    const auth = { authorization: `Bearer ${opened.key}` };
    const free = await chat('mock-free', auth);
    expect(free.status).toBe(200);
    expect(free.headers.get('x-forge-charged-msub')).toBe('0');
    expect((await encrypted(auth)).status).toBe(200);
    expect((await chat('mock-echo', auth)).status).toBe(402);
    expect(g.deps.ledger.get(opened.account_id)!.balance_msub).toBe(0);
  });

  it('a funded balance: free requests leave it untouched, paid ones charge as before', async () => {
    const top = await (
      await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite: createInvite(g) }) })
    ).json();
    const auth = { authorization: `Bearer ${top.key}` };
    const start = top.balance_msub as number;
    expect((await chat('mock-free', auth)).status).toBe(200);
    expect((await encrypted(auth)).status).toBe(200);
    expect(g.deps.ledger.get(top.account_id)!.balance_msub).toBe(start);
    const paid = await chat('mock-echo', auth);
    expect(paid.status).toBe(200);
    const charged = Number(paid.headers.get('x-forge-charged-msub'));
    expect(charged).toBeGreaterThan(0);
    expect(g.deps.ledger.get(top.account_id)!.balance_msub).toBe(start - charged);
    // The paid encrypted model still bills from the enclave's usage.
    const enc = await encrypted({ ...auth, 'x-tinfoil-model': 'enc-model' });
    expect(enc.status).toBe(200);
    expect(Number(enc.headers.get('x-forge-charged-msub'))).toBe(expectedMsub(50, 7));
  });
});
