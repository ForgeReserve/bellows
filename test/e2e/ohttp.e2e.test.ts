/**
 * Oblivious HTTP end to end (docs/DESIGN.md, S5): client -> relay -> Bellows, against the local test mints.
 *
 * The client reaches the relay over IPv6 loopback (::1) with made-up identifying headers; the relay reaches
 * the Bellows over IPv4 loopback. The Bellows listens on both, so a direct request from the client would
 * arrive from ::1 (checked first, so the instrument is known to work). The test then funds a balance, chats
 * (plain and streamed), pays one request with eCash, refunds, and checks that:
 *   - the relay only ever held ciphertext: none of the requests' or answers' content is in its bytes;
 *   - the Bellows never received the client's address or headers, and its logs hold neither;
 *   - a replayed request (the topup) and a tampered one are refused, and the replay credits nothing.
 */
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BellowsOperator, BellowsFetchError, bellowsFetch, devVerifier, verifyBellows } from '../../client/index.ts';
import { createRelay } from '../../relay/relay.ts';
import { devMeasurement } from '../../src/attest/dev.ts';
import { BELLOWS_VERSION } from '../../src/config.ts';
import { captureLogs, chatBody, type Gateway, MINT_A, mintToken, mintsUp, readSse, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();
const devBuilds = { format: 'bellows-builds/v1', builds: [{ version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement() }] };

/** Identifying headers the client's outer requests carry, as a browser or a proxy might add them. */
const CLIENT_HEADERS: Record<string, string> = {
  'x-forwarded-for': '203.0.113.91',
  forwarded: 'for=203.0.113.91',
  'x-real-ip': '203.0.113.91',
  'user-agent': 'OhttpSentinel/1.0',
  cookie: 'sentinel=ohttp-client',
  referer: 'https://sentinel.ohttp-check.test/',
};
const CLIENT_SENTINELS = ['203.0.113.91', 'OhttpSentinel', 'sentinel=ohttp-client', 'ohttp-check'];

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe.skipIf(!up)('Oblivious HTTP: client -> relay -> Bellows (S5)', () => {
  let g: Gateway;
  let logs: ReturnType<typeof captureLogs>;
  let relayServer: ServerType;
  let relayUrl: string;
  let v4: string;
  let v6: string;
  let operator: BellowsOperator;
  /** Every byte the relay handled, both directions. */
  const relayBytes: Uint8Array[] = [];
  /** Each encapsulated request body the relay forwarded, in order. */
  const relayedRequests: Uint8Array[] = [];
  /** Peer address and raw headers of every request the Bellows received. */
  const bellowsPeers: string[] = [];
  const bellowsHeaders: string[] = [];
  /** Plaintext that must never be in the relay's bytes. */
  const secrets: string[] = ['mock-echo', 'Say hello', 'Hello word', '/v1/wallet', 'balance_msub', 'cashuB', 'sk-forge-'];

  const clientFetch = (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...CLIENT_HEADERS } });
  const call = (path: string, init: RequestInit = {}) => bellowsFetch(operator, path, init, { fetch: clientFetch });
  const json = (body: unknown, key?: string, extra: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  const sendRaw = (bytes: Uint8Array) => fetch(operator.relay!, { method: 'POST', headers: { 'content-type': 'message/ohttp-chunked-req' }, body: bytes as BodyInit });

  let key: string;
  let balanceAfterTopup: number;

  beforeAll(async () => {
    logs = captureLogs();
    g = await startGateway({ inviteOnly: false, host: '::' });
    const port = (g.server.address() as AddressInfo).port;
    v4 = `http://127.0.0.1:${port}`;
    v6 = `http://[::1]:${port}`;
    g.server.on('request', (req) => {
      bellowsPeers.push(String(req.socket.remoteAddress));
      bellowsHeaders.push(req.rawHeaders.join('\n'));
    });

    const recording = async (url: string, init?: RequestInit) => {
      const body = init?.body as Uint8Array;
      relayBytes.push(body);
      relayedRequests.push(body);
      const res = await fetch(url, init);
      if (!res.body) return res;
      const [mine, theirs] = res.body.tee();
      void (async () => {
        const r = mine.getReader();
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          relayBytes.push(value);
        }
      })();
      return new Response(theirs, { status: res.status, headers: res.headers });
    };
    const handler = createRelay({ targets: [`${v4}/ohttp`], fetch: recording });
    relayServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: handler, port: 0, hostname: '::1' }, () => resolve(s));
    });
    relayUrl = `http://[::1]:${(relayServer.address() as AddressInfo).port}`;

    const verified = await verifyBellows(v4, { approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true });
    operator = { ...verified, relay: `${relayUrl}/relay/127.0.0.1:${port}` };
  });

  afterAll(async () => {
    logs?.stop();
    await new Promise<void>((r) => (relayServer ? relayServer.close(() => r()) : r()));
    await g?.close();
  });

  it('control: a direct request from the client arrives from ::1 with its headers', async () => {
    const res = await fetch(`${v6}/healthz`, { headers: CLIENT_HEADERS });
    expect(res.status).toBe(200);
    expect(bellowsPeers.at(-1)).toBe('::1');
    expect(bellowsHeaders.at(-1)).toContain('OhttpSentinel');
    // From here on, only what the OHTTP calls bring counts.
    bellowsPeers.length = 0;
    bellowsHeaders.length = 0;
  });

  it('lists models through the relay', async () => {
    const res = await call('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain('mock-echo');
  });

  it('funds a balance with eCash through the relay', async () => {
    const token = await mintToken(MINT_A, 'usd', 100);
    secrets.push(token.slice(0, 60));
    const res = await call('/v1/wallet/topup', json({ token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; credited: number; balance_msub: number };
    expect(body.credited).toBe(100);
    key = body.key;
    secrets.push(key);
    balanceAfterTopup = body.balance_msub;
  });

  it('a replay of the topup is refused and credits nothing', async () => {
    const topupBytes = relayedRequests.at(-1)!;
    const res = await sendRaw(topupBytes);
    expect(res.status).toBe(400);
    const p = bellowsFetch(operator, '/v1/wallet', { headers: { authorization: `Bearer ${key}` } });
    const wallet = (await (await p).json()) as { balance_msub: number };
    expect(wallet.balance_msub).toBe(balanceAfterTopup);
  });

  it('a tampered request is refused', async () => {
    await call('/healthz');
    const bytes = new Uint8Array(relayedRequests.at(-1)!);
    bytes[bytes.length - 5]! ^= 0x40;
    const tampered = await sendRaw(bytes);
    expect(tampered.status).toBe(400);
    // And bellowsFetch reports the gateway's refusal as such.
    const refuse = (u: string, i?: RequestInit) => fetch(u, { ...i, body: bytes });
    await expect(bellowsFetch(operator, '/healthz', {}, { fetch: refuse })).rejects.toMatchObject({ code: 'gateway_refused', status: 400 });
  });

  it('chats on the balance through the relay', async () => {
    const res = await call('/v1/chat/completions', json(chatBody('mock-echo'), key));
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBeGreaterThan(0);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toMatch(/^Hello word/);
  });

  it('streams a chat answer through the relay, with the settlement event at the end', async () => {
    const res = await call('/v1/chat/completions', json(chatBody('mock-echo', { stream: true }), key));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const { data, forge } = await readSse(res);
    expect(data.length).toBeGreaterThan(1);
    expect(forge.charged_msub).toBeGreaterThan(0);
    expect(forge.balance_msub).toBeLessThan(balanceAfterTopup);
  });

  it('pays one request with eCash (NUT-24) through the relay and gets change', async () => {
    const ask = await call('/v1/chat/completions', json(chatBody('mock-echo')));
    expect(ask.status).toBe(402);
    expect(ask.headers.get('x-cashu')).toMatch(/^creq/);
    const token = await mintToken(MINT_A, 'usd', 20);
    secrets.push(token.slice(0, 60));
    const res = await call('/v1/chat/completions', json(chatBody('mock-echo'), undefined, { 'x-cashu': token }));
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(2000);
    expect(await redeem(res.headers.get('x-cashu-change')!)).toBe(18);
  });

  it('refunds the balance as eCash through the relay', async () => {
    const res = await call('/v1/wallet/refund', json({}, key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; amount: number };
    expect(body.amount).toBeGreaterThan(0);
    expect(await redeem(body.token)).toBe(body.amount);
  });

  it('the relay only ever held ciphertext', async () => {
    await new Promise((r) => setTimeout(r, 50)); // let the response tees finish
    expect(relayedRequests.length).toBeGreaterThanOrEqual(8);
    const all = relayBytes.map(latin1).join('');
    for (const s of secrets) expect(all.includes(s), `relay saw ${s.slice(0, 20)}`).toBe(false);
  });

  it('the Bellows never received the client address or its headers, and logged neither', () => {
    expect(bellowsPeers.length).toBeGreaterThanOrEqual(relayedRequests.length);
    for (const a of bellowsPeers) expect(a).not.toBe('::1');
    const headers = bellowsHeaders.join('\n');
    for (const s of CLIENT_SENTINELS) expect(headers).not.toContain(s);
    const lines = logs.lines.join('\n');
    for (const s of [...CLIENT_SENTINELS, '::1']) expect(lines).not.toContain(s);
  });

  it('an unknown gateway at the relay is the relay\'s own error', async () => {
    const p = bellowsFetch({ ...operator, relay: `${relayUrl}/relay/evil.example` }, '/healthz');
    await expect(p).rejects.toBeInstanceOf(BellowsFetchError);
    await expect(p).rejects.toMatchObject({ code: 'relay_error', status: 404 });
  });
});
