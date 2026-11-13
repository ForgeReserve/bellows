import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs, createInvite, expectedMsub, type Gateway, MINT_A, mintToken, mintsUp, startGateway } from './helpers.ts';

const up = await mintsUp();

/** Builds an EHBP-shaped body: [4-byte BE length][bytes] frames. Content is random (stands in for ciphertext). */
function frames(n: number, size = 40): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(size);
    parts.push(len, randomBytes(size));
  }
  return Buffer.concat(parts);
}

interface Seen {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

describe.skipIf(!up)('EHBP encrypted pass-through (fake enclave)', () => {
  let enclave: http.Server;
  let g: Gateway;
  let key: string;
  const seen: Seen[] = [];
  let reply: Buffer;
  let logs: ReturnType<typeof captureLogs>;

  beforeAll(async () => {
    logs = captureLogs();
    enclave = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
        const usage = 'prompt=50,completion=7,total=57,model=enc-model,cost_usd=0.0001';
        if (String(req.headers.accept).includes('text/event-stream')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'ehbp-response-nonce': 'ab'.repeat(32), trailer: 'X-Tinfoil-Usage-Metrics' });
          let i = 0;
          const tick = () => {
            if (i < 7) {
              res.write(reply.subarray(i * 44, (i + 1) * 44));
              i++;
              setTimeout(tick, 5);
            } else {
              res.addTrailers({ 'X-Tinfoil-Usage-Metrics': usage });
              res.end();
            }
          };
          tick();
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': usage });
          res.end(reply);
        }
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    const port = (enclave.address() as AddressInfo).port;
    g = await startGateway({ enclavePort: port });
    const invite = createInvite(g);
    key = (
      await (
        await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite }) })
      ).json()
    ).key;
  });
  afterAll(async () => {
    logs.stop();
    await g.close();
    enclave.close();
  });

  const send = (body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'ehbp-encapsulated-key': 'ee'.repeat(32),
        'x-tinfoil-model': 'enc-model',
        'x-tinfoil-max-output-tokens': '100',
        ...extra,
      },
      body: new Uint8Array(body),
    });

  it('forwards ciphertext untouched and bills from the usage header', async () => {
    reply = frames(3);
    const reqBody = frames(5);
    const res = await send(reqBody);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(reply)).toBe(true);
    expect(res.headers.get('ehbp-response-nonce')).toBe('cd'.repeat(32));
    expect(res.headers.get('x-forge-privacy')).toBe('enclave-encrypted');
    const s = seen.at(-1)!;
    expect(s.body.equals(reqBody)).toBe(true);
    expect(s.headers.authorization).toBe('Bearer test-enclave-key'); // client's balance key is not forwarded
    expect(s.headers['x-tinfoil-request-usage-metrics']).toBe('true');
    expect(s.headers['ehbp-encapsulated-key']).toBe('ee'.repeat(32));
    expect(s.headers['x-tinfoil-model']).toBe('enc-model');
    expect(s.headers['x-tinfoil-max-output-tokens']).toBe('100');
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(expectedMsub(50, 7));
  });

  it('streams ciphertext and bills from the HTTP trailer', async () => {
    reply = frames(7);
    const res = await send(frames(2), { accept: 'text/event-stream' });
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(reply)).toBe(true);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-forge-charged-msub')).toBeNull(); // streamed: settled after the trailer
    const reqId = res.headers.get('x-forge-request-id')!;
    const row = await logs.waitForRequest(reqId);
    expect(row.status).toBe('ok');
    expect(row.usage_source).toBe('tinfoil-metrics');
    expect(row.charged_msub).toBe(expectedMsub(50, 7));
  });

  it('refuses enclave URLs outside the allowlist', async () => {
    const res = await send(frames(1), { 'x-tinfoil-enclave-url': 'https://evil.example.com' });
    expect(res.status).toBe(400);
  });

  it('refuses max output above the model cap', async () => {
    const res = await send(frames(1), { 'x-tinfoil-max-output-tokens': '100000' });
    expect(res.status).toBe(400);
  });
});
