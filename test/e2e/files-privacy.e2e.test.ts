import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLogLevel, setLogSilent } from '../../src/log.ts';
import { createInvite, type Gateway, MINT_A, mintToken, mintsUp, readSse, startGateway } from './helpers.ts';

// Client apps read file attachments on the device and send their text inside the message, as
// <file name="..." pages="...">...</file> blocks before the typed text. The gateway relays that text
// (or, encrypted, ciphertext it cannot read) and never writes it to its logs or its database.
type FileAttachment = { name: string; text: string; pages?: number };
function withFiles(text: string, files: FileAttachment[]) {
  const blocks = files.map((f) => `<file name="${f.name}"${f.pages ? ` pages="${f.pages}"` : ''}>\n${f.text}\n</file>`);
  return [{ role: 'user', content: [...blocks, text].join('\n\n') }];
}
const up = await mintsUp();

describe.skipIf(!up)('file text is relayed, never logged or stored', () => {
  let enclave: http.Server;
  let g: Gateway;
  let key: string;
  const seen: Buffer[] = [];
  const logs: string[] = [];
  const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };

  beforeAll(async () => {
    enclave = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push(Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': 'prompt=40,completion=5' });
        res.end(Buffer.from('opaque-ciphertext-reply'));
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    g = await startGateway({ enclavePort: (enclave.address() as AddressInfo).port });
    const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 200), invite: createInvite(g) }) });
    key = (await r.json()).key;
    // Capture every log line the gateway writes from here on, at the most verbose level.
    setLogSilent(false);
    setLogLevel('debug');
    process.stdout.write = ((s: any) => (logs.push(String(s)), true)) as any;
    process.stderr.write = ((s: any) => (logs.push(String(s)), true)) as any;
  });
  afterAll(async () => {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
    setLogSilent(process.env.BELLOWS_TEST_LOGS !== '1');
    setLogLevel('info');
    await g.close();
    enclave.close();
  });

  const stored = () => [g.dbPath, g.dbPath + '-wal'].filter(existsSync).map((p) => readFileSync(p).toString('latin1')).join('');

  it('plaintext: the file block reaches the supplier; logs and DB hold no file text', async () => {
    const marker = 'PLAIN-FILE-' + Math.random().toString(36).slice(2);
    const messages = withFiles('Summarize', [{ name: 'notes.txt', text: `quarterly numbers ${marker}` }]);
    const supplier: any = g.deps.suppliers.get('mock');
    const orig = supplier.chat.bind(supplier);
    let upstreamBody = '';
    supplier.chat = (call: any) => ((upstreamBody = JSON.stringify(call.body)), orig(call));
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-echo', messages, stream: true, stream_options: { include_usage: true }, max_tokens: 32 }),
    });
    supplier.chat = orig;
    expect(res.status).toBe(200);
    const sse = await readSse(res);
    expect(sse.forge?.charged_msub).toBeGreaterThan(0);
    expect(upstreamBody).toContain(`<file name=\\"notes.txt\\">`);
    expect(upstreamBody).toContain(marker);
    expect(logs.some((l) => l.includes('"msg":"request"'))).toBe(true);
    expect(logs.join('')).not.toContain(marker);
    expect(logs.join('')).not.toContain('notes.txt');
    expect(stored()).not.toContain(marker);
  });

  it('encrypted: the body is forwarded byte for byte; logs and DB hold none of it', async () => {
    // Stands in for the HPKE ciphertext the Tinfoil SDK produces from a body containing the file text.
    const marker = 'ENC-FILE-' + Math.random().toString(36).slice(2);
    const body = Buffer.from(JSON.stringify({ model: 'enc-model', messages: withFiles('Hi', [{ name: 'r.pdf', pages: 2, text: marker }]) }));
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'ehbp-encapsulated-key': 'ee'.repeat(32), 'x-tinfoil-model': 'enc-model', 'x-tinfoil-max-output-tokens': '64' },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-forge-privacy')).toBe('enclave-encrypted');
    await res.arrayBuffer();
    expect(seen.at(-1)!.equals(body)).toBe(true);
    expect(logs.join('')).not.toContain(marker);
    expect(stored()).not.toContain(marker);
  });
});
