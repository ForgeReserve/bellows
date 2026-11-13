import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchWithRetry } from '../../src/suppliers/openai.ts';

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((r) => {
      if (!server) return r();
      server.closeAllConnections();
      server.close(() => r());
    }),
);

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server!.address() as any).port}/`)));
}

describe('fetchWithRetry', () => {
  it('does not resend a request whose headers timed out', async () => {
    let hits = 0;
    const url = await listen(() => void hits++); // never responds
    const err = await fetchWithRetry(url, { method: 'POST' }, new AbortController().signal, { retries: 2, timeoutMs: 200 }).catch((e) => e);
    expect(err.status).toBe(504);
    expect(hits).toBe(1);
  });

  it('retries a retryable status', async () => {
    let hits = 0;
    const url = await listen((_req, res) => {
      hits++;
      res.statusCode = hits === 1 ? 503 : 200;
      res.end('ok');
    });
    const res = await fetchWithRetry(url, { method: 'POST' }, new AbortController().signal, { retries: 2, timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });
});
