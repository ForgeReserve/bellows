import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, MINT_A, mintsUp, startGateway } from './helpers.ts';

const up = await mintsUp();

/**
 * A proxy over the local mint that counts bolt11 mint quote checks and can hold quotes UNPAID or
 * answer them with 429, as Nutshell's per-IP limiter does.
 */
interface CountingMint {
  url: string;
  checks: number;
  mode: 'pass' | 'unpaid' | '429';
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function startCountingMint(backing: string): Promise<CountingMint> {
  const m: CountingMint = { url: '', checks: 0, mode: 'pass', close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const isCheck = req.method === 'GET' && /^\/v1\/mint\/quote\/bolt11\/[^/]+$/.test(req.url ?? '');
    if (isCheck) {
      m.checks++;
      if (m.mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Rate limit exceeded' }));
        return;
      }
    }
    const body = await readBody(req);
    const upstream = await fetch(backing + req.url, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
    });
    let out = Buffer.from(await upstream.arrayBuffer());
    if (isCheck && m.mode === 'unpaid' && upstream.ok) {
      const q = JSON.parse(out.toString('utf8'));
      q.state = 'UNPAID';
      out = Buffer.from(JSON.stringify(q));
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(out);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return m;
}

const j = JSON.stringify;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!up)('funding: mint quote checks are throttled', () => {
  let g: Gateway;
  let mint: CountingMint;
  beforeAll(async () => {
    mint = await startCountingMint(MINT_A);
    g = await startGateway({ env: { BELLOWS_TRUSTED_MINTS: mint.url, BELLOWS_MINT_QUOTE_CHECKS_PER_MIN: '3' } });
  });
  afterAll(async () => {
    await g.close();
    await mint.close();
  });

  async function openFunding(): Promise<{ id: string; key: string }> {
    const res = await fetch(`${g.url}/v1/wallet/fund/lightning`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: j({ amount: 10, unit: 'usd', invite: createInvite(g) }),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    return { id: body.id, key: body.key };
  }

  const poll = (id: string, key: string) => fetch(`${g.url}/v1/wallet/fund/${id}`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json() as Promise<any>);

  it('a browser polling fast does not make the gateway poll the mint fast', async () => {
    mint.mode = 'unpaid';
    const { id, key } = await openFunding();
    const before = mint.checks;
    // 30 polls over about 3 s: the quote falls due once (2 s after it was created); the next check is 5 s later.
    for (let i = 0; i < 30; i++) {
      expect((await poll(id, key)).state).toBe('pending');
      await sleep(100);
    }
    expect(mint.checks - before).toBe(1);
  });

  it('a 429 from the mint pauses every quote check', async () => {
    mint.mode = '429';
    const a = await openFunding();
    const b = await openFunding();
    const before = mint.checks;
    await sleep(2100); // both fall due
    await poll(a.id, a.key); // checked, gets 429
    for (let i = 0; i < 20; i++) {
      await poll(a.id, a.key);
      await poll(b.id, b.key);
    }
    expect(mint.checks - before).toBe(1);
    const row = g.deps.db.prepare('SELECT next_check FROM fundings WHERE id = ?').get(b.id) as { next_check: number };
    expect(row.next_check).toBeGreaterThan(Date.now() + 50_000);
  });
});
