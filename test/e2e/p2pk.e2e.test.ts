import { randomBytes } from 'node:crypto';
import { getPubKeyFromPrivKey, OutputData, PaymentRequest } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/cashu/wallet.ts';
import { chatBody, createInvite, type Gateway, MINT_A, MINT_C, mintToken, mintsUp, redeem, startGateway, userWallet } from './helpers.ts';

const up = (await mintsUp()) && (await fetch(`${MINT_C}/v1/info`).then((r) => r.ok).catch(() => false));
const j = (b: object) => JSON.stringify(b);

/** A customer's wallet key: 32 random bytes and its compressed public key. */
function keypair() {
  const priv = randomBytes(32);
  return { priv: priv.toString('hex'), pub: Buffer.from(getPubKeyFromPrivKey(priv)).toString('hex') };
}

/** Every proof of the token is P2PK-locked to exactly `pub` (NUT-10 secret ["P2PK", {data}]). */
async function lockedTo(token: string, mint: string, unit: 'usd' | 'sat'): Promise<string[]> {
  const w = await userWallet(mint, unit);
  return w.decodeToken(token).proofs.map((p) => {
    try {
      const s = JSON.parse(p.secret);
      return s[0] === 'P2PK' ? (s[1].data as string) : 'unlocked';
    } catch {
      return 'unlocked';
    }
  });
}

/**
 * The full check of a locked token: a plain wallet cannot redeem it, the gateway's own wallet
 * cannot, and the holder of the private key can, for exactly `amount`.
 */
async function expectLocked(g: Gateway, token: string, k: { priv: string; pub: string }, amount: number, mint = MINT_A, unit: 'usd' | 'sat' = 'usd') {
  expect(new Set(await lockedTo(token, mint, unit))).toEqual(new Set([k.pub]));
  const w = await userWallet(mint, unit);
  const proofs = w.decodeToken(token).proofs;
  const fees = w.getFeesForProofs(proofs).toNumber();
  // At the mint itself: a swap of the locked proofs without a NUT-11 witness is refused.
  const outs = OutputData.createRandomData(amount - fees, w.getKeyset());
  await expect(w.mint.swap({ inputs: proofs, outputs: outs.map((o) => o.blindedMessage) })).rejects.toThrow();
  await expect(w.receive(token)).rejects.toThrow();
  if (g.deps.wallet.isTrusted(mint)) {
    await expect(g.deps.wallet.receive(token, { purpose: 'topup', accountId: 'acct_thief' })).rejects.toBeInstanceOf(PaymentError);
  }
  const got = await w.receive(token, { privkey: k.priv });
  expect(got.reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(amount - fees);
}

async function topup(g: Gateway, amount: number): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/topup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: j({ token: await mintToken(MINT_A, 'usd', amount), invite: createInvite(g) }),
  });
  return ((await r.json()) as any).key;
}

const refund = (g: Gateway, key: string, body: object) =>
  fetch(`${g.url}/v1/wallet/refund`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: j(body) });

describe.skipIf(!up)('P2PK-locked change and refunds (NUT-11)', () => {
  let g: Gateway;
  let invite: string;
  beforeAll(async () => {
    g = await startGateway({ env: { BELLOWS_FOREIGN_ALLOW_INSECURE: 'true' } });
    invite = createInvite(g);
  });
  afterAll(() => g.close());

  const chat = (headers: Record<string, string>) =>
    fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forge-Invite': invite, ...headers }, body: j(chatBody('mock-echo')) });

  it('NUT-24 change with X-Cashu-Pubkey is locked: no key fails, the gateway fails, the key redeems', async () => {
    const k = keypair();
    const pr = PaymentRequest.fromEncodedRequest((await chat({ 'X-Cashu-Pubkey': k.pub })).headers.get('x-cashu')!);
    const paid = pr.amount!.toNumber() + 7;
    const ok = await chat({ 'X-Cashu': await mintToken(MINT_A, 'usd', paid), 'X-Cashu-Pubkey': k.pub });
    expect(ok.status).toBe(200);
    const change = ok.headers.get('x-cashu-change')!;
    const changeUnits = paid - Number(ok.headers.get('x-forge-charged-msub')) / 1000;
    expect(changeUnits).toBeGreaterThan(0);
    // Re-delivery returns the same locked token.
    const again = await (await fetch(`${g.url}/v1/change/${ok.headers.get('x-forge-request-id')}`)).json();
    expect(again.token).toBe(change);
    expect(again.data[0].locked_to).toBe(k.pub);
    await expectLocked(g, change, k, changeUnits);
    // The lock key stays with the change owed (so a payout after a crash is still locked); the request itself
    // leaves no row once settled.
    const reqId = ok.headers.get('x-forge-request-id')!;
    const owed = g.deps.db.prepare("SELECT lock_pubkey FROM outgoing WHERE request_id = ? AND purpose = 'change'").all(reqId) as Array<{ lock_pubkey: string }>;
    expect(owed.map((r) => r.lock_pubkey)).toEqual([k.pub]);
    expect(g.deps.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(reqId)).toBeUndefined();
  });

  it('accepts an npub and an x-only key as "02" + x', async () => {
    // NIP-19 test vector.
    const npub = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
    const x = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
    for (const form of [npub, x, '02' + x]) {
      const r = await chat({ 'X-Cashu-Pubkey': form });
      expect(r.status).toBe(402);
    }
  });

  it('invalid pubkeys are a 400 everywhere, before any eCash moves', async () => {
    const bad = ['zz', '04' + 'ab'.repeat(64), '02' + '00'.repeat(32), '05' + '11'.repeat(32), 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjpth'];
    const token = await mintToken(MINT_A, 'usd', 30);
    for (const pk of bad) {
      const r = await chat({ 'X-Cashu': token, 'X-Cashu-Pubkey': pk });
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe('invalid_pubkey');
    }
    expect(await redeem(token)).toBe(30); // untouched
    const key = await topup(g, 10);
    const r = await refund(g, key, { pubkey: 'not-a-key' });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('invalid_pubkey');
    const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(w.balance_msub).toBe(10_000);
    const q = await fetch(`${g.url}/v1/wallet/fund/foreign/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: j({ token: await mintToken(MINT_C, 'sat', 300), unit: 'sat', invite: createInvite(g), pubkey: '03' + 'ff'.repeat(32) }),
    });
    expect(q.status).toBe(400);
    expect((await q.json()).error.code).toBe('invalid_pubkey');
  });

  it('refund with {pubkey} is locked: no key fails, the gateway fails, the key redeems', async () => {
    const k = keypair();
    const key = await topup(g, 40);
    const r = await refund(g, key, { amount: 15, pubkey: k.pub });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.locked_to).toBe(k.pub);
    expect(body.refunds.find((x: any) => x.id === body.id).locked_to).toBe(k.pub);
    await expectLocked(g, body.token, k, 15);
  });

  it('without a pubkey nothing changes: plain NUT-13 tokens anyone holding them can redeem', async () => {
    const key = await topup(g, 20);
    const body = await (await refund(g, key, { amount: 8 })).json();
    expect(body.locked_to).toBeNull();
    expect(new Set(await lockedTo(body.token, MINT_A, 'usd'))).toEqual(new Set(['unlocked']));
    expect(await redeem(body.token)).toBe(8);
    const pr = PaymentRequest.fromEncodedRequest((await chat({})).headers.get('x-cashu')!);
    const ok = await chat({ 'X-Cashu': await mintToken(MINT_A, 'usd', pr.amount!.toNumber() + 3) });
    expect(new Set(await lockedTo(ok.headers.get('x-cashu-change')!, MINT_A, 'usd'))).toEqual(new Set(['unlocked']));
  });

  it('other-mint funding: change from the melt is locked to the key', async () => {
    const k = keypair();
    const token = await mintToken(MINT_C, 'sat', 1000);
    const q = await (
      await fetch(`${g.url}/v1/wallet/fund/foreign/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token, unit: 'sat', invite: createInvite(g), pubkey: k.pub }) })
    ).json();
    expect(q.foreign.locked_to).toBe(k.pub);
    const c = await (
      await fetch(`${g.url}/v1/wallet/fund/foreign/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${q.key}` }, body: j({ id: q.id, token }) })
    ).json();
    let done = c;
    for (let i = 0; i < 100 && (done.state !== 'done' || !done.foreign.change_token); i++) {
      await new Promise((r) => setTimeout(r, 200));
      done = await (await fetch(`${g.url}/v1/wallet/fund/${q.id}`, { headers: { authorization: `Bearer ${q.key}` } })).json();
    }
    expect(done.state).toBe('done');
    expect(done.foreign.payout_pending).toBe(false);
    const out = g.deps.wallet.listOutgoing({ requestId: q.id });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('done');
    await expectLocked(g, done.foreign.change_token, k, out[0]!.amount, MINT_C, 'sat');
    expect(q.foreign.credit + out[0]!.amount).toBeLessThanOrEqual(1000);
    // Nothing stays behind as gateway eCash at the other mint.
    expect(g.deps.wallet.holdings().find((h) => h.mint === MINT_C)?.unspent ?? 0).toBe(0);
  });

  it('other-mint funding: a refunded token comes back locked to the key (given at confirm)', async () => {
    const k = keypair();
    const token = await mintToken(MINT_C, 'sat', 600);
    const q = await (
      await fetch(`${g.url}/v1/wallet/fund/foreign/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token, unit: 'sat', invite: createInvite(g) }) })
    ).json();
    const fundMint = await userWallet(MINT_A, 'sat');
    const big = await fundMint.createMintQuoteBolt11(5000);
    const mq = await (await userWallet(MINT_C, 'sat')).createMeltQuoteBolt11(big.request);
    g.deps.db.prepare('UPDATE fundings SET request = ?, f_melt_quote = ? WHERE id = ?').run(big.request, mq.quote, q.id);
    const c = await (
      await fetch(`${g.url}/v1/wallet/fund/foreign/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${q.key}` },
        body: j({ id: q.id, token, pubkey: k.pub }),
      })
    ).json();
    expect(c.state).toBe('refunded');
    expect(c.foreign.locked_to).toBe(k.pub);
    const out = g.deps.wallet.listOutgoing({ requestId: q.id });
    expect(out).toHaveLength(1);
    expect(out[0]!.purpose).toBe('refund');
    expect(c.foreign.refund_token).toBe(out[0]!.token);
    await expectLocked(g, c.foreign.refund_token, k, out[0]!.amount, MINT_C, 'sat');
    expect(out[0]!.amount).toBeGreaterThan(580);
  });
});

describe.skipIf(!up)('P2PK crash safety: locked outputs have random secrets, NUT-13 cannot find them', () => {
  /** Tops up 37, then a refund of 25 locked to k crashes after the mint swap, before the DB write. */
  async function crashedLockedRefund(k: { pub: string }) {
    const g1 = await startGateway();
    const key = await topup(g1, 37);
    await g1.close();
    const faulty = await startGateway({ dbPath: g1.dbPath, faults: { afterSendSwap: true } });
    const res = await refund(faulty, key, { amount: 25, pubkey: k.pub });
    expect(res.status).toBe(202);
    const rb = await res.json();
    const row: any = faulty.deps.db.prepare('SELECT status, preview, lock_pubkey FROM outgoing WHERE id = ?').get(rb.id);
    expect(row.status).toBe('prepared');
    expect(row.lock_pubkey).toBe(k.pub);
    // The stored preview holds the locked secrets and blinding factors needed to rebuild the proofs.
    const pv = JSON.parse(row.preview);
    expect(pv.sendOutputs.length).toBeGreaterThan(0);
    await faulty.close();
    return { dbPath: g1.dbPath, key, id: rb.id as string };
  }

  async function expectPaidOnce(g: Gateway, key: string, id: string, k: { priv: string; pub: string }) {
    const list = await (await fetch(`${g.url}/v1/wallet/refunds`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(list.data).toHaveLength(1);
    const r = list.data[0];
    expect(r.id).toBe(id);
    expect(r.status).toBe('done');
    await expectLocked(g, r.token, k, 25);
    const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(w.balance_msub).toBe(12_000);
    const h = g.deps.wallet.holdings().find((x) => x.unit === 'usd')!;
    // 37 in, 25 out once: the wallet keeps 12 and owes nothing.
    expect(h).toMatchObject({ unspent: 12, reserved: 0, owed: 0 });
  }

  it('recovers by NUT-19 replay of the stored request and pays exactly once', async () => {
    const k = keypair();
    const c = await crashedLockedRefund(k);
    const g = await startGateway({ dbPath: c.dbPath });
    try {
      await expectPaidOnce(g, c.key, c.id, k);
    } finally {
      await g.close();
    }
  });

  it('replay refused: NUT-09 restore of the stored blinded messages rebuilds the locked proofs once', async () => {
    const k = keypair();
    const c = await crashedLockedRefund(k);
    const g = await startGateway({ dbPath: c.dbPath, faults: { noReplayOnRecovery: true } });
    try {
      await expectPaidOnce(g, c.key, c.id, k);
    } finally {
      await g.close();
    }
  });

  it('neither replay nor restore: outcome unknown, stays owed, never paid twice; settles once the mint answers', async () => {
    const k = keypair();
    const c = await crashedLockedRefund(k);
    const g1 = await startGateway({ dbPath: c.dbPath, faults: { noReplayOnRecovery: true, noRestoreOnRecovery: true } });
    try {
      const row: any = g1.deps.db.prepare('SELECT status, error FROM outgoing WHERE id = ?').get(c.id);
      expect(row.status).toBe('prepared');
      expect(row.error).toMatch(/outcome unknown/);
      await expect(g1.deps.wallet.issue(c.id)).rejects.toMatchObject({ code: 'payout_unknown' });
      // A new refund request retries the unknown payout first and does not issue it a second time.
      const r = await refund(g1, c.key, { amount: 13 });
      expect(r.status).toBe(400); // 12 refundable: the 25 stay debited and owed
      expect(g1.deps.db.prepare('SELECT COUNT(*) AS n FROM outgoing').get()).toEqual({ n: 1 });
      expect(g1.deps.wallet.holdings().find((x) => x.unit === 'usd')).toMatchObject({ owed: 25 });
    } finally {
      await g1.close();
    }
    const g = await startGateway({ dbPath: c.dbPath });
    try {
      await expectPaidOnce(g, c.key, c.id, k);
    } finally {
      await g.close();
    }
  });
});
