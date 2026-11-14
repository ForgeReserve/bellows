/**
 * NUT-13 counter recovery after a lost database (memory storage, a lost volume): the same wallet secret
 * and a fresh database must never reuse a counter the mint has signed. Against the local mints.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { revenue } from '../../src/revenue.ts';
import { newWalletSecret } from '../../src/secrets.ts';
import { getEncodedToken } from '@cashu/cashu-ts';
import { captureLogs, freePort, type Gateway, MINT_A, MINT_B, mintProofs, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();
const freshDb = () => join(mkdtempSync(join(tmpdir(), 'bellows-counters-')), 'bellows.db');
const j = (body: object) => JSON.stringify(body);
const ADMIN = 'counter-recovery-admin-0001';

async function topup(g: Gateway, token: string) {
  const res = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ token }) });
  return { status: res.status, body: (await res.json()) as any };
}

async function refund(g: Gateway, key: string, amount: number) {
  const res = await fetch(`${g.url}/v1/wallet/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: j({ amount }) });
  return { status: res.status, body: (await res.json()) as any };
}

const counters = (g: Gateway) =>
  Object.fromEntries((g.deps.db.prepare('SELECT keyset_id, next FROM counters WHERE mint = ?').all(MINT_A) as Array<{ keyset_id: string; next: number }>).map((r) => [r.keyset_id, r.next]));

describe.skipIf(!up)('counter recovery on a fresh database', () => {
  it('the first top-up and a withdrawal after the restart succeed, and what the first gateway held is recovered, held aside', async () => {
    const secret = newWalletSecret();
    const env = { BELLOWS_WALLET_SECRET: secret, BELLOWS_ADMIN_TOKEN: ADMIN };

    // The first life: a top-up, a withdrawal the person redeems, and a second top-up.
    const g1 = await startGateway({ dbPath: freshDb(), env, inviteOnly: false, counterScan: {} });
    const a = await topup(g1, await mintToken(MINT_A, 'usd', 100));
    expect(a.status).toBe(200);
    const r1 = await refund(g1, a.body.key, 30);
    expect(r1.status).toBe(200);
    expect(await redeem(r1.body.token)).toBe(30);
    expect((await topup(g1, await mintToken(MINT_A, 'usd', 25))).status).toBe(200);
    const held = g1.deps.wallet.holdings().find((h) => h.mint === MINT_A && h.unit === 'usd')!;
    expect(held.unspent).toBe(95);
    const before = counters(g1);
    expect(Object.values(before).some((n) => n > 0)).toBe(true);
    await g1.close();

    // The second life: same secret, new database.
    const logs = captureLogs();
    let g2: Gateway | undefined;
    try {
      // The production scan settings ({}), not the suite's short ones.
      g2 = await startGateway({ dbPath: freshDb(), env, inviteOnly: false, counterScan: {} });
      const boot = logs.entries().filter((e) => e.msg === 'counter_recovery');
      expect(boot).toHaveLength(1);
      expect(boot[0]).toMatchObject({ pending: 0, recovered_usd: 95 });
      expect(boot[0].batches).toBeGreaterThan(0);
      expect(logs.lines.join('\n')).not.toMatch(/counters_behind/);
    } finally {
      logs.stop();
    }
    try {
      // Every counter is at least where the first life left it.
      const after = counters(g2!);
      for (const [ks, n] of Object.entries(before)) expect(after[ks], ks).toBeGreaterThanOrEqual(n);
      // Recovered: exactly what the first gateway held, held aside and owed to nobody.
      expect(g2!.deps.wallet.recovered()).toEqual([{ mint: MINT_A, unit: 'usd', proofs: expect.any(Number), amount: 95 }]);
      expect(revenue(g2!.deps, 'usd')).toMatchObject({ unspent: 0, liabilities: 0, sweepable: 0 });
      // The admin overview shows it next to the totals, as an aggregate only.
      const o = (await (await fetch(`${g2!.url}/admin/api/overview`, { headers: { 'X-Bellows-Admin-Token': ADMIN } })).json()) as any;
      expect(o.recovered).toEqual([{ mint: MINT_A, unit: 'usd', proofs: expect.any(Number), amount: 95 }]);
      expect(o.units.find((u: any) => u.unit === 'usd')).toMatchObject({ recovered: 95, wallet_trusted: 0, customer_balances: 0, sweepable: 0 });
      expect(o.mints_closed).toEqual([]);

      // The first top-up of the new life, then a withdrawal from it.
      const b = await topup(g2!, await mintToken(MINT_A, 'usd', 100));
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      const r2 = await refund(g2!, b.body.key, 40);
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(await redeem(r2.body.token)).toBe(40);
      // The recovered funds are neither spent nor counted as the wallet's or as a balance.
      expect(g2!.deps.wallet.recovered()[0]!.amount).toBe(95);
      expect(revenue(g2!.deps, 'usd')).toMatchObject({ unspent: 60, liabilities: 60, sweepable: 0 });
    } finally {
      await g2!.close();
    }
  }, 60_000);

  it('does not scan on a restart with the same database', async () => {
    const dbPath = freshDb();
    const g1 = await startGateway({ dbPath, inviteOnly: false });
    expect((await topup(g1, await mintToken(MINT_A, 'usd', 10))).status).toBe(200);
    await g1.close();
    const logs = captureLogs();
    try {
      const g2 = await startGateway({ dbPath, inviteOnly: false });
      expect(g2.deps.wallet.needsCounterScan).toBe(false);
      expect(logs.entries().filter((e) => e.msg === 'counter_recovery')).toEqual([]);
      expect((await topup(g2, await mintToken(MINT_A, 'usd', 10))).status).toBe(200);
      await g2.close();
    } finally {
      logs.stop();
    }
  }, 30_000);

  it('a missed collision is caught when it happens: scan forward, then the swap goes through', async () => {
    const secret = newWalletSecret();
    const env = { BELLOWS_WALLET_SECRET: secret };
    const g1 = await startGateway({ dbPath: freshDb(), env, inviteOnly: false });
    expect((await topup(g1, await mintToken(MINT_A, 'usd', 100))).status).toBe(200);
    await g1.close();
    // Skip the boot scan: the database keeps its counters at 0, as a scan that stopped at a gap would.
    const g2 = await startGateway({ dbPath: freshDb(), env, inviteOnly: false, recover: false });
    const logs = captureLogs();
    try {
      const b = await topup(g2, await mintToken(MINT_A, 'usd', 100));
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      expect(logs.entries().find((e) => e.msg === 'counters_behind')).toMatchObject({ complete: true });
      expect(g2.deps.wallet.recovered()).toEqual([{ mint: MINT_A, unit: 'usd', proofs: expect.any(Number), amount: 100 }]);
    } finally {
      logs.stop();
      await g2.close();
    }
  }, 30_000);
});

describe.skipIf(!up)('a mint that cannot be scanned at boot', () => {
  /** A plain HTTP forwarder to mint B that starts listening only when asked. */
  let server: Server | undefined;
  afterAll(() => server?.close());

  it('stays closed (503 for funding there, healthz counts it) until a retry scans it, then works', async () => {
    const port = await freePort();
    const proxied = `http://127.0.0.1:${port}`;
    const g = await startGateway({
      dbPath: freshDb(),
      inviteOnly: false,
      env: { BELLOWS_TRUSTED_MINTS: `${MINT_A},${proxied}` },
      counterScan: { retryBaseMs: 300, retryMaxMs: 1000, timeoutMs: 5000 },
    });
    try {
      expect(g.deps.wallet.closedMints).toEqual([proxied]);
      expect((await (await fetch(`${g.url}/healthz`)).json()).mints_closed).toBe(1);
      // Mint A was scanned and is open.
      expect((await topup(g, await mintToken(MINT_A, 'usd', 5))).status).toBe(200);

      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const r = await fetch(MINT_B + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
      });
      const token = await (async () => {
        await new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
        return mintToken(proxied, 'usd', 7);
      })();
      // Closed until its scan completes. The scan may already have run once the forwarder listens.
      const until = Date.now() + 10_000;
      while (g.deps.wallet.closedMints.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(g.deps.wallet.closedMints).toEqual([]);
      expect((await (await fetch(`${g.url}/healthz`)).json()).mints_closed).toBe(0);
      const ok = await topup(g, token);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    } finally {
      await g.close();
    }
  }, 30_000);

  it('refuses a token from the closed mint with 503 while it is closed', async () => {
    const port = await freePort();
    const proxied = `http://127.0.0.1:${port}`;
    const g = await startGateway({ dbPath: freshDb(), inviteOnly: false, env: { BELLOWS_TRUSTED_MINTS: `${MINT_A},${proxied}` }, counterScan: { retryBaseMs: 60_000 } });
    try {
      expect(g.deps.wallet.closedMints).toEqual([proxied]);
      // A token naming the closed mint (its proofs are never looked at: the mint is refused first).
      const proofs = await mintProofs(MINT_B, 'usd', 3);
      const res = await topup(g, getEncodedToken({ mint: proxied, unit: 'usd', proofs }));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('mint_unavailable');
      expect(res.body.error.message).toMatch(/not open yet/);
      expect(await redeem(getEncodedToken({ mint: MINT_B, unit: 'usd', proofs }), MINT_B)).toBe(3);
    } finally {
      await g.close();
    }
  }, 30_000);
});
