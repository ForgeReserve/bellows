import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs, chatBody, createInvite, expectedMsub, type Gateway, MINT_A, mintToken, mintsUp, readSse, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();

const j = (body: object) => JSON.stringify(body);

describe.skipIf(!up)('prepaid balance keys', () => {
  let g: Gateway;
  let logs: ReturnType<typeof captureLogs>;
  beforeAll(async () => {
    logs = captureLogs();
    g = await startGateway();
  });
  afterAll(async () => {
    logs.stop();
    await g.close();
  });

  const topup = (token: string, opts: { key?: string; invite?: string } = {}) =>
    fetch(`${g.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
      body: j({ token, invite: opts.invite }),
    });
  const chat = (key: string, body: object) =>
    fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: j(body) });
  const wallet = async (key: string) => (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();

  it('topup needs an unused invite; invites are single use', async () => {
    const t = await mintToken(MINT_A, 'usd', 10);
    const noInvite = await topup(t);
    expect(noInvite.status).toBe(403);
    const invite = createInvite(g);
    const ok = await topup(t, { invite });
    expect(ok.status).toBe(200);
    const t2 = await mintToken(MINT_A, 'usd', 10);
    const reuse = await topup(t2, { invite });
    expect(reuse.status).toBe(403);
    expect((await reuse.json()).error.code).toBe('invite_used');
    expect(await redeem(t2)).toBe(10);
  });

  it('a failed topup does not burn the invite', async () => {
    const invite = createInvite(g);
    const spent = await mintToken(MINT_A, 'usd', 5);
    await redeem(spent);
    const bad = await topup(spent, { invite });
    expect(bad.status).toBe(400);
    const good = await topup(await mintToken(MINT_A, 'usd', 5), { invite });
    expect(good.status).toBe(200);
  });

  it('topup, spend (non-stream and stream), refund', async () => {
    const invite = createInvite(g);
    const res = await topup(await mintToken(MINT_A, 'usd', 100), { invite });
    const body = await res.json();
    expect(body.key).toMatch(/^sk-forge-/);
    expect(body.balance_msub).toBe(100_000);
    const key = body.key as string;

    // Topping up the same key again with another token adds to it.
    const more = await topup(await mintToken(MINT_A, 'usd', 20), { key });
    expect((await more.json()).balance_msub).toBe(120_000);

    const r1 = await chat(key, chatBody('mock-echo'));
    expect(r1.status).toBe(200);
    const c1 = await r1.json();
    const cost1 = expectedMsub(c1.usage.prompt_tokens, c1.usage.completion_tokens);
    expect(Number(r1.headers.get('x-forge-charged-msub'))).toBe(cost1); // sub-cent precision on balances
    expect(Number(r1.headers.get('x-forge-balance-msub'))).toBe(120_000 - cost1);

    const r2 = await chat(key, chatBody('mock-echo', { stream: true, stream_options: { include_usage: true } }));
    const s2 = await readSse(r2);
    expect(s2.data.some((d) => d.usage)).toBe(true); // client asked for usage: kept
    const cost2 = expectedMsub(s2.data.find((d) => d.usage).usage.prompt_tokens, s2.data.find((d) => d.usage).usage.completion_tokens);
    expect(s2.forge.charged_msub).toBe(cost2);
    const w = await wallet(key);
    expect(w.balance_msub).toBe(120_000 - cost1 - cost2);
    expect(w.available_msub).toBe(w.balance_msub);

    const refund = await fetch(`${g.url}/v1/wallet/refund`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
    expect(refund.status).toBe(200);
    const rb = await refund.json();
    expect(rb.amount).toBe(Math.floor(w.balance_msub / 1000));
    expect(await redeem(rb.token)).toBe(rb.amount);
    const after = await wallet(key);
    expect(after.balance_msub).toBe(w.balance_msub - rb.amount * 1000);
    expect(after.balance_msub).toBeLessThan(1000);
    const list = await (await fetch(`${g.url}/v1/wallet/refunds`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(list.data[0].token).toBe(rb.token);
  });

  it('client-chosen key: a lost topup response is safe to replay', async () => {
    const key = 'sk-forge-' + 'a'.repeat(32);
    const invite = createInvite(g);
    const token = await mintToken(MINT_A, 'usd', 15);
    const first = await (await topup(token, { key, invite })).json();
    const again = await topup(token, { key });
    expect(again.status).toBe(200);
    const ab = await again.json();
    expect(ab.replay).toBe(true);
    expect(ab.balance_msub).toBe(first.balance_msub);
    expect(ab.balance_msub).toBe(15_000);
  });

  it('wrong unit for a balance is rejected', async () => {
    const invite = createInvite(g);
    const key = (await (await topup(await mintToken(MINT_A, 'usd', 5), { invite })).json()).key;
    const sat = await mintToken(MINT_A, 'sat', 50);
    const res = await topup(sat, { key });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('wrong_unit');
  });

  it('insufficient balance returns 402 without calling upstream', async () => {
    const invite = createInvite(g);
    const key = (await (await topup(await mintToken(MINT_A, 'usd', 1), { invite })).json()).key;
    const res = await chat(key, chatBody('mock-echo'));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe('insufficient_balance');
  });

  it('client disconnect mid-stream settles on what was produced', async () => {
    const invite = createInvite(g);
    const key = (await (await topup(await mintToken(MINT_A, 'usd', 100), { invite })).json()).key;
    const ac = new AbortController();
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: j(chatBody('mock-slow', { stream: true, max_tokens: 256 })),
      signal: ac.signal,
    });
    const reqId = res.headers.get('x-forge-request-id')!;
    const reader = res.body!.getReader();
    let seen = 0;
    while (seen < 10) {
      const { value } = await reader.read();
      seen += (new TextDecoder().decode(value).match(/data: /g) ?? []).length;
    }
    ac.abort();
    // Settlement details are in the request log line; nothing about the request stays in the database.
    const row = await logs.waitForRequest(reqId);
    expect(['ok', 'partial']).toContain(row.status);
    expect(g.deps.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(reqId)).toBeUndefined();
    expect(row.usage_source).toBe('estimate');
    expect(row.output_tokens).toBeGreaterThanOrEqual(10);
    expect(row.output_tokens).toBeLessThan(200);
    const w = await wallet(key);
    expect(w.balance_msub).toBe(100_000 - row.charged_msub);
    expect(row.charged_msub).toBe(expectedMsub(row.input_tokens, row.output_tokens));
    expect(w.available_msub).toBe(w.balance_msub); // reservation released
  });

  it('retries a flaky upstream', async () => {
    const invite = createInvite(g);
    const key = (await (await topup(await mintToken(MINT_A, 'usd', 20), { invite })).json()).key;
    const res = await chat(key, chatBody('mock-flaky'));
    expect(res.status).toBe(200);
  });

  it('flat pricing charges the schedule, not usage', async () => {
    const invite = createInvite(g);
    const key = (await (await topup(await mintToken(MINT_A, 'usd', 20), { invite })).json()).key;
    const res = await chat(key, chatBody('flat-echo'));
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(3000); // $0.03 bucket
  });

  it('missing usage falls back to an estimate', async () => {
    const invite = createInvite(g);
    const key = (await (await topup(await mintToken(MINT_A, 'usd', 50), { invite })).json()).key;
    const res = await chat(key, chatBody('mock-nousage', { stream: true }));
    const s = await readSse(res);
    expect(s.forge.charged_msub).toBeGreaterThan(0);
    const row = await logs.waitForRequest(s.forge.request_id);
    expect(row.usage_source).toBe('estimate');
    expect(row.output_tokens).toBe(15); // max(12 chunks, 60 chars / 4)
  });

  it('rejects oversized bodies and bad max_tokens', async () => {
    const big = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1_100_000) });
    expect(big.status).toBe(413);
    const res = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j(chatBody('mock-echo', { max_tokens: 100000 })) });
    expect(res.status).toBe(400);
  });

  it('lists models with tier, prices and the uncensored flag', async () => {
    // The previous test aborts a stream, which can leave a dead pooled socket behind: retry once on a reset.
    const res = await fetch(`${g.url}/v1/models`).catch(() => fetch(`${g.url}/v1/models`));
    const m = await res.json();
    const echo = m.data.find((x: any) => x.id === 'mock-echo');
    expect(echo.tier).toBe('standard');
    expect(echo.pricing.usd_per_mtok).toEqual({ input: 100, output: 1000 });
    expect(echo.pricing.sat_per_mtok.input).toBe(100_000); // $100 at $100k/BTC = 0.001 BTC
    expect(m.data.find((x: any) => x.id === 'mock-uncensored').uncensored).toBe(true);
    expect(m.data.find((x: any) => x.id === 'tinfoil/enc-model').tier).toBe('enclave');
  });
});

describe.skipIf(!up)('invites off (the default)', () => {
  it('topup, NUT-24 and Lightning funding work without invites', async () => {
    const g = await startGateway({ inviteOnly: false });
    try {
      expect(g.deps.config.env.BELLOWS_INVITE_ONLY).toBe(false);
      expect((await (await fetch(`${g.url}/healthz`)).json()).invite_only).toBe(false);
      const res = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token: await mintToken(MINT_A, 'usd', 5) }) });
      expect(res.status).toBe(200);
      expect((await res.json()).key).toMatch(/^sk-forge-/);
      const r402 = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j(chatBody('mock-echo')) });
      expect(r402.status).toBe(402);
      const paid = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Cashu': await mintToken(MINT_A, 'usd', 20) }, body: j(chatBody('mock-echo')) });
      expect(paid.status).toBe(200);
      const fund = await fetch(`${g.url}/v1/wallet/fund/lightning`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ amount: 10, unit: 'usd' }) });
      expect(fund.status).toBe(200);
      expect((await fund.json()).key).toMatch(/^sk-forge-/);
    } finally {
      await g.close();
    }
  });

  it('revoked invites stop NUT-24 access', async () => {
    const g = await startGateway();
    try {
      const inv = g.deps.invites.create();
      const ok = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forge-Invite': inv.code }, body: j(chatBody('mock-echo')) });
      expect(ok.status).toBe(402);
      g.deps.invites.revoke(inv.id);
      const no = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forge-Invite': inv.code }, body: j(chatBody('mock-echo')) });
      expect(no.status).toBe(403);
    } finally {
      await g.close();
    }
  });
});
