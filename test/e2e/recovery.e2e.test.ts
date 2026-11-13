import { describe, expect, it } from 'vitest';
import { createInvite, MINT_A, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();
const j = (b: object) => JSON.stringify(b);

describe.skipIf(!up)('crash safety', () => {
  it.each([
    ['NUT-19 replay', false],
    ['NUT-09 restore', true],
  ])('receive: mint swap succeeded, DB write lost -> recovered exactly once via %s', async (_name, noReplay) => {
    const faulty = await startGateway({ faults: { afterReceiveSwap: true } });
    const invite = createInvite(faulty);
    const token = await mintToken(MINT_A, 'usd', 40);
    const res = await fetch(`${faulty.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token, invite }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('topup_pending');
    const key = body.key as string;
    expect(key).toMatch(/^sk-forge-/);
    const row: any = faulty.deps.db.prepare('SELECT status FROM incoming').get();
    expect(row.status).toBe('prepared');
    await faulty.close();

    // Restart on the same database: startup recovery restores the signatures and credits once.
    const g = await startGateway({ dbPath: faulty.dbPath, faults: { noReplayOnRecovery: noReplay } });
    try {
      const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
      expect(w.balance_msub).toBe(40_000);
      // Client retries the same token with the key it was given: idempotent, no double credit.
      const again = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: j({ token }) });
      const ab = await again.json();
      expect(ab.replay).toBe(true);
      expect(ab.balance_msub).toBe(40_000);
      expect(g.deps.wallet.holdings().find((h) => h.unit === 'usd')!.unspent).toBe(40);
    } finally {
      await g.close();
    }
  });

  it('send: refund swap succeeded, DB write lost -> recovered via NUT-09 restore', async () => {
    const g1 = await startGateway();
    const invite = createInvite(g1);
    const { key } = await (
      await fetch(`${g1.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token: await mintToken(MINT_A, 'usd', 37), invite }) })
    ).json();
    await g1.close();

    const faulty = await startGateway({ dbPath: g1.dbPath, faults: { afterSendSwap: true } });
    const res = await fetch(`${faulty.url}/v1/wallet/refund`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: j({ amount: 25 }) });
    expect(res.status).toBe(202);
    const rb = await res.json();
    expect(rb.status).toBe('owed');
    const out: any = faulty.deps.db.prepare('SELECT status FROM outgoing WHERE id = ?').get(rb.id);
    expect(out.status).toBe('prepared');
    await faulty.close();

    // Skip the NUT-19 replay so recovery must use NUT-09 restore of the persisted counter range
    // (the path a mint without a response cache, or with an evicted entry, forces).
    const g = await startGateway({ dbPath: g1.dbPath, faults: { noReplayOnRecovery: true } });
    try {
      const list = await (await fetch(`${g.url}/v1/wallet/refunds`, { headers: { authorization: `Bearer ${key}` } })).json();
      const r = list.data.find((x: any) => x.id === rb.id);
      expect(r.status).toBe('done');
      expect(await redeem(r.token)).toBe(25);
      const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
      expect(w.balance_msub).toBe(12_000);
      // Wallet keeps the swap's change: 37 received - 25 sent.
      const h = g.deps.wallet.holdings().find((x) => x.unit === 'usd')!;
      expect(h.unspent).toBe(12);
      expect(h.reserved).toBe(0);
    } finally {
      await g.close();
    }
  });

  it('a NUT-24 request whose payment never arrived is counted as failed and forgotten on restart', async () => {
    const g1 = await startGateway();
    g1.deps.db
      .prepare("INSERT INTO requests (id, payment, unit, model, supplier, status, created_at) VALUES ('req_unpaid', 'nut24', 'usd', 'mock-echo', 'mock', 'new', ?)")
      .run(Date.now());
    await g1.close();
    const g = await startGateway({ dbPath: g1.dbPath });
    try {
      expect(g.deps.db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
      expect(g.deps.db.prepare("SELECT failed, nut24 FROM usage_daily WHERE model = 'mock-echo'").get()).toEqual({ failed: 1, nut24: 1 });
      expect((await fetch(`${g.url}/v1/change/req_unpaid`)).status).toBe(404);
    } finally {
      await g.close();
    }
  });

  it('NUT-24 request interrupted after payment -> full change owed on restart', async () => {
    const g1 = await startGateway();
    const invite = createInvite(g1);
    // Simulate: payment received, process died before the upstream call finished.
    const reqId = 'req_interrupted';
    g1.deps.db
      .prepare("INSERT INTO requests (id, payment, unit, model, supplier, status, created_at) VALUES (?, 'nut24', 'usd', 'mock-echo', 'mock', 'new', ?)")
      .run(reqId, Date.now());
    await g1.deps.wallet.receive(await mintToken(MINT_A, 'usd', 9), {
      purpose: 'nut24',
      requestId: reqId,
      onFinalize: (a) => g1.deps.db.prepare("UPDATE requests SET status = 'running', paid_units = ? WHERE id = ?").run(a, reqId),
    });
    void invite;
    await g1.close();
    const g = await startGateway({ dbPath: g1.dbPath });
    try {
      const ch = await (await fetch(`${g.url}/v1/change/${reqId}`)).json();
      expect(await redeem(ch.token)).toBe(9);
      // The request leaves no row of its own, only the change owed to it and a failed count in the aggregates.
      expect(g.deps.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(reqId)).toBeUndefined();
      expect(g.deps.db.prepare("SELECT failed FROM usage_daily WHERE model = 'mock-echo'").get()).toEqual({ failed: 1 });
    } finally {
      await g.close();
    }
  });
});
