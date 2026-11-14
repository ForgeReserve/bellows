import { describe, expect, it, vi } from 'vitest';
import { chatBody, createInvite, type Gateway, MINT_A, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';

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

/**
 * A NUT-24 payment whose outcome was unknown when the request failed (the mint swap went through, the
 * database write did not), recovered in the same process: no restart anywhere in these tests.
 */
describe.skipIf(!up)('NUT-24 payment interrupted in the same process', () => {
  const PAID = 20;
  const post = (g: Gateway, invite: string, token: string) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forge-Invite': invite, 'X-Cashu': token },
      body: j(chatBody('mock-echo')),
    });
  /** The first attempt: the swap reaches the mint, the write after it fails, so the request fails. */
  const interrupted = async () => {
    const g = await startGateway({ faults: { afterReceiveSwap: true } });
    const invite = createInvite(g);
    const token = await mintToken(MINT_A, 'usd', PAID);
    const first = await post(g, invite, token);
    expect(first.status).toBeGreaterThanOrEqual(500);
    const firstId = first.headers.get('x-forge-request-id')!;
    expect(firstId).toMatch(/^req_/);
    expect(g.deps.db.prepare('SELECT status FROM incoming').get()).toEqual({ status: 'prepared' });
    expect(g.deps.db.prepare('SELECT status FROM requests WHERE id = ?').get(firstId)).toEqual({ status: 'failed' });
    return { g, invite, token, firstId };
  };
  const requestRows = (g: Gateway) => g.deps.db.prepare('SELECT COUNT(*) AS n FROM requests').get();
  const changeRows = (g: Gateway) => g.deps.db.prepare("SELECT request_id, amount, status FROM outgoing WHERE purpose = 'change' ORDER BY created_at").all();

  it('a retry with the same token is served once from the recovered payment, with change', async () => {
    const { g, invite, token, firstId } = await interrupted();
    try {
      const retry = await post(g, invite, token);
      expect(retry.status).toBe(200);
      const json = await retry.json();
      expect(json.choices[0].message.content).toContain('Hello');
      const retryId = retry.headers.get('x-forge-request-id')!;
      expect(retryId).not.toBe(firstId);
      const charged = Number(retry.headers.get('x-forge-charged-msub'));
      expect(charged).toBe(2000);
      const change = retry.headers.get('x-cashu-change')!;
      expect(await redeem(change)).toBe(PAID - 2);

      // The payment moved to the retry: the first request owes nothing and leaves no row.
      expect((await fetch(`${g.url}/v1/change/${firstId}`)).status).toBe(404);
      expect(requestRows(g)).toEqual({ n: 0 });
      expect(changeRows(g)).toEqual([{ request_id: retryId, amount: PAID - 2, status: 'done' }]);
      expect(g.deps.db.prepare('SELECT request_id, status FROM incoming').get()).toEqual({ request_id: retryId, status: 'done' });

      // Exactly once: the same token a third time is refused and owes nothing more.
      const third = await post(g, invite, token);
      expect(third.status).toBe(400);
      expect((await third.json()).error.code).toBe('token_spent');
      expect(changeRows(g)).toHaveLength(1);
      expect(requestRows(g)).toEqual({ n: 0 });
      // The gateway kept exactly what it charged.
      expect(g.deps.wallet.holdings().find((h) => h.unit === 'usd')!.unspent).toBe(2);
    } finally {
      await g.close();
    }
  });

  it('a retry while the mint is still unreachable is 503 and leaves the payment recoverable for a later retry', async () => {
    const { g, invite, token, firstId } = await interrupted();
    try {
      vi.spyOn(g.deps.wallet as any, 'recoverIncoming').mockRejectedValueOnce(new TypeError('fetch failed'));
      const flaky = await post(g, invite, token);
      expect(flaky.status).toBe(503);
      expect((await flaky.json()).error.code).toBe('mint_unavailable');
      // Nothing settled: the receive is still prepared, the first request still failed and recoverable,
      // and the flaky retry left no request row of its own.
      expect(g.deps.db.prepare('SELECT status FROM incoming').get()).toEqual({ status: 'prepared' });
      expect(g.deps.db.prepare('SELECT status FROM requests WHERE id = ?').get(firstId)).toEqual({ status: 'failed' });
      expect(requestRows(g)).toEqual({ n: 1 });

      // Once the mint answers, a later retry is served once, with change.
      const retry = await post(g, invite, token);
      expect(retry.status).toBe(200);
      const retryId = retry.headers.get('x-forge-request-id')!;
      expect(await redeem(retry.headers.get('x-cashu-change')!)).toBe(PAID - 2);
      expect(changeRows(g)).toEqual([{ request_id: retryId, amount: PAID - 2, status: 'done' }]);
    } finally {
      vi.restoreAllMocks();
      await g.close();
    }
  });

  it('polling the change of the failed request recovers the payment and returns it in full', async () => {
    const { g, invite, token, firstId } = await interrupted();
    try {
      const res = await fetch(`${g.url}/v1/change/${firstId}`);
      expect(res.status).toBe(200);
      const ch = await res.json();
      expect(await redeem(ch.token)).toBe(PAID);
      // Re-deliverable, and paid once: a second poll returns the same token.
      const again = await (await fetch(`${g.url}/v1/change/${firstId}`)).json();
      expect(again.token).toBe(ch.token);
      expect(changeRows(g)).toEqual([{ request_id: firstId, amount: PAID, status: 'done' }]);
      expect(requestRows(g)).toEqual({ n: 0 });
      expect(g.deps.db.prepare("SELECT failed, nut24 FROM usage_daily WHERE model = 'mock-echo'").get()).toEqual({ failed: 1, nut24: 1 });

      // The payment went back as change, so the token cannot also pay for a request.
      const retry = await post(g, invite, token);
      expect(retry.status).toBe(400);
      expect((await retry.json()).error.code).toBe('token_spent');
      expect(changeRows(g)).toHaveLength(1);
    } finally {
      await g.close();
    }
  });

  it('a retry that recovers the payment and then fails upstream still returns it as change', async () => {
    const { g, invite, token, firstId } = await interrupted();
    try {
      // The retry asks for a model the gateway serves but whose upstream errors: the payment it took over
      // is settled with no charge, so it all comes back as change on the retry's own request id.
      const retry = await fetch(`${g.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Forge-Invite': invite, 'X-Cashu': token },
        body: j(chatBody('mock-fail')),
      });
      expect(retry.status).toBe(502);
      const retryId = retry.headers.get('x-forge-request-id')!;
      expect(Number(retry.headers.get('x-forge-charged-msub'))).toBe(0);
      expect(await redeem(retry.headers.get('x-cashu-change')!)).toBe(PAID);
      expect((await fetch(`${g.url}/v1/change/${firstId}`)).status).toBe(404);
      expect(changeRows(g)).toEqual([{ request_id: retryId, amount: PAID, status: 'done' }]);
      expect(requestRows(g)).toEqual({ n: 0 });
    } finally {
      await g.close();
    }
  });
});

/**
 * A paid NUT-24 request whose handler ends without settling, in the same process: the payment is never
 * left behind a request marked running. No restart anywhere in these tests.
 */
describe.skipIf(!up)('NUT-24 request whose handler ends unsettled', () => {
  const PAID = 20;
  const post = (g: Gateway, invite: string, token: string, extra: object = {}) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forge-Invite': invite, 'X-Cashu': token },
      body: j(chatBody('mock-echo', extra)),
    });
  const requestRows = (g: Gateway) => g.deps.db.prepare('SELECT COUNT(*) AS n FROM requests').get();
  const changeRows = (g: Gateway) => g.deps.db.prepare("SELECT request_id, amount, status FROM outgoing WHERE purpose = 'change' ORDER BY created_at").all();
  const paid = async () => {
    const g = await startGateway();
    return { g, invite: createInvite(g), token: await mintToken(MINT_A, 'usd', PAID), mock: g.deps.suppliers.get('mock')! };
  };
  /** The whole payment comes back once at GET /v1/change, and the token cannot pay again. */
  const expectWholeChange = async (g: Gateway, invite: string, token: string, id: string) => {
    const res = await fetch(`${g.url}/v1/change/${id}`);
    expect(res.status).toBe(200);
    const ch = await res.json();
    expect(await redeem(ch.token)).toBe(PAID);
    expect((await (await fetch(`${g.url}/v1/change/${id}`)).json()).token).toBe(ch.token);
    expect(changeRows(g)).toEqual([{ request_id: id, amount: PAID, status: 'done' }]);
    expect(requestRows(g)).toEqual({ n: 0 });
    const again = await post(g, invite, token);
    expect(again.status).toBe(400);
    expect((await again.json()).error.code).toBe('token_spent');
    expect(changeRows(g)).toHaveLength(1);
  };

  it('an upstream body that breaks after the headers charges nothing and returns all of the payment', async () => {
    const { g, invite, token, mock } = await paid();
    try {
      mock.chat = async () =>
        new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.error(new Error('connection reset'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      const res = await post(g, invite, token);
      expect(res.status).toBe(502);
      expect((await res.json()).error.code).toBe('upstream_error');
      expect(res.headers.get('x-forge-charged-msub')).toBe('0');
      const id = res.headers.get('x-forge-request-id')!;
      expect(res.headers.get('x-forge-change-url')).toBe(`/v1/change/${id}`);
      expect(await redeem(res.headers.get('x-cashu-change')!)).toBe(PAID);
      expect(changeRows(g)).toEqual([{ request_id: id, amount: PAID, status: 'done' }]);
      expect(requestRows(g)).toEqual({ n: 0 });
    } finally {
      await g.close();
    }
  });

  it('an error that escapes the handler after payment leaves the whole payment as change, with no restart', async () => {
    const { g, invite, token, mock } = await paid();
    try {
      // A stream answer with no body: reading it throws in the handler, after the payment and before settlement.
      mock.chat = async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const res = await post(g, invite, token, { stream: true });
      expect(res.status).toBe(500);
      const id = res.headers.get('x-forge-request-id')!;
      expect(id).toMatch(/^req_/);
      // Not running any more: no handler serves it.
      expect(g.deps.db.prepare('SELECT status, paid_units FROM requests WHERE id = ?').get(id)).toEqual({ status: 'paid', paid_units: PAID });
      await expectWholeChange(g, invite, token, id);
    } finally {
      await g.close();
    }
  });

  it('a retry with the same token takes over the payment of a handler that ended unsettled, once', async () => {
    const { g, invite, token, mock } = await paid();
    const realChat = mock.chat.bind(mock);
    try {
      mock.chat = async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const first = await post(g, invite, token, { stream: true });
      expect(first.status).toBe(500);
      const firstId = first.headers.get('x-forge-request-id')!;
      mock.chat = realChat;
      const retry = await post(g, invite, token);
      expect(retry.status).toBe(200);
      const retryId = retry.headers.get('x-forge-request-id')!;
      expect(Number(retry.headers.get('x-forge-charged-msub'))).toBe(2000);
      expect(await redeem(retry.headers.get('x-cashu-change')!)).toBe(PAID - 2);
      expect((await fetch(`${g.url}/v1/change/${firstId}`)).status).toBe(404);
      expect(changeRows(g)).toEqual([{ request_id: retryId, amount: PAID - 2, status: 'done' }]);
      expect(requestRows(g)).toEqual({ n: 0 });
    } finally {
      await g.close();
    }
  });

  it('a stream whose settlement write fails leaves the whole payment as change, with no restart', async () => {
    const { g, invite, token } = await paid();
    try {
      vi.spyOn(g.deps.wallet, 'oweRaw').mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });
      const res = await post(g, invite, token, { stream: true });
      expect(res.status).toBe(200);
      const id = res.headers.get('x-forge-request-id')!;
      const raw = await res.text();
      expect(raw).toContain('settlement failed');
      expect(raw).not.toContain('event: forge');
      expect(g.deps.db.prepare('SELECT status FROM requests WHERE id = ?').get(id)).toEqual({ status: 'paid' });
      await expectWholeChange(g, invite, token, id);
    } finally {
      vi.restoreAllMocks();
      await g.close();
    }
  });
});
