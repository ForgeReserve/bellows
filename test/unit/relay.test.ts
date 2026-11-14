/**
 * The relay (relay/): forwards opaque OHTTP bodies to allowlisted gateways only, passes on nothing that
 * identifies the client, writes nothing, and runs both as a Node server and as a Worker.
 */
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_ERROR_HEADER as CLIENT_RELAY_ERROR_HEADER } from '../../client/ohttp.ts';
import { createRelay, parseMaxBodyBytes, parsePort, parseTargets, RELAY_ERROR_HEADER, targetsFromList } from '../../relay/relay.ts';
import { startRelay } from '../../relay/server.ts';
import worker from '../../relay/worker.ts';

const GW = 'https://bellows.example/ohttp';
const IDENTIFYING = {
  'x-forwarded-for': '198.51.100.7',
  'x-real-ip': '198.51.100.7',
  forwarded: 'for=198.51.100.7',
  'cf-connecting-ip': '198.51.100.7',
  'true-client-ip': '198.51.100.7',
  'user-agent': 'client-marker-agent',
  cookie: 'session=client-marker',
  authorization: 'Bearer client-marker',
  referer: 'https://client-marker.example/',
  origin: 'https://client-marker.example',
  'accept-language': 'xx-MARKER',
  via: '1.1 client-marker',
};
const MARKERS = /198\.51\.100\.7|client-marker|MARKER/;

type Seen = { url: string; init: RequestInit; headers: Headers; body: Uint8Array };
function recordingFetch(answer: () => Response = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'message/ohttp-chunked-res', 'set-cookie': 'up=1', server: 'gateway' } })) {
  const seen: Seen[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const req = new Request(url, init);
    seen.push({ url, init: init ?? {}, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return answer();
  };
  return { fn, seen };
}

const relayReq = (path: string, init: RequestInit = {}) => new Request(`https://relay.example${path}`, { method: 'POST', headers: { 'content-type': 'message/ohttp-chunked-req' }, body: new Uint8Array([9, 9, 9]), ...init });

afterEach(() => vi.restoreAllMocks());

describe('allowlist', () => {
  it('accepts https gateways and loopback http, keyed by host', () => {
    const t = parseTargets([GW, 'http://127.0.0.1:8080/ohttp', 'http://[::1]:9/ohttp']);
    expect([...t.keys()]).toEqual(['bellows.example', '127.0.0.1:8080', '[::1]:9']);
    expect(t.get('bellows.example')).toBe(GW);
  });

  it('refuses plain http elsewhere, credentials, queries and two targets on one host', () => {
    expect(() => parseTargets(['http://bellows.example/ohttp'])).toThrow(/https/);
    expect(() => parseTargets(['https://u:p@bellows.example/ohttp'])).toThrow(/plain URL/);
    expect(() => parseTargets(['https://bellows.example/ohttp?x=1'])).toThrow(/plain URL/);
    expect(() => parseTargets([GW, 'https://bellows.example/other'])).toThrow(/share the host/);
    expect(() => parseTargets(['not a url'])).toThrow(/not a URL/);
  });

  it('reads a comma-separated list', () => {
    expect(targetsFromList(` ${GW} , https://b.example/ohttp ,`)).toEqual([GW, 'https://b.example/ohttp']);
    expect(targetsFromList(undefined)).toEqual([]);
  });

  it('uses the header name the client library reads', () => {
    expect(RELAY_ERROR_HEADER).toBe(CLIENT_RELAY_ERROR_HEADER);
  });
});

describe('forwarding', () => {
  it('forwards the body and content type only, and nothing that identifies the client', async () => {
    const { fn, seen } = recordingFetch();
    const relay = createRelay({ targets: [GW], fetch: fn });
    const res = await relay(relayReq('/relay/bellows.example', { headers: { 'content-type': 'message/ohttp-chunked-req', ...IDENTIFYING } }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(GW);
    expect([...seen[0]!.headers.entries()]).toEqual([['content-type', 'message/ohttp-chunked-req']]);
    expect([...seen[0]!.body]).toEqual([9, 9, 9]);
    expect(Object.keys(seen[0]!.init).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal']);
    expect(seen[0]!.init.redirect).toBe('manual');
  });

  it('passes back the status, the OHTTP content type and the body, and none of the gateway headers', async () => {
    const relay = createRelay({ targets: [GW], fetch: recordingFetch().fn });
    const res = await relay(relayReq('/relay/bellows.example'));
    expect(res.headers.get('content-type')).toBe('message/ohttp-chunked-res');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('passes a gateway refusal on as its status, without a body', async () => {
    const relay = createRelay({ targets: [GW], fetch: recordingFetch(() => new Response('detail', { status: 400 })).fn });
    const res = await relay(relayReq('/relay/bellows.example'));
    expect(res.status).toBe(400);
    expect(res.headers.get(RELAY_ERROR_HEADER)).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('passes on a busy gateway\'s Retry-After, and only a plain number of seconds on a 503', async () => {
    const answer = (status: number, retryAfter: string) => createRelay({ targets: [GW], fetch: recordingFetch(() => new Response(null, { status, headers: { 'retry-after': retryAfter } })).fn });
    const busy = await answer(503, '2')(relayReq('/relay/bellows.example'));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('2');
    expect(busy.headers.get('access-control-expose-headers')).toContain('Retry-After');
    expect(await busy.text()).toBe('');
    // A date, a long value or another status carries nothing back.
    expect((await answer(503, 'Wed, 21 Oct 2026 07:28:00 GMT')(relayReq('/relay/bellows.example'))).headers.get('retry-after')).toBeNull();
    expect((await answer(503, '1234567')(relayReq('/relay/bellows.example'))).headers.get('retry-after')).toBeNull();
    expect((await answer(429, '2')(relayReq('/relay/bellows.example'))).headers.get('retry-after')).toBeNull();
  });

  it('accepts plain OHTTP requests too', async () => {
    const { fn, seen } = recordingFetch();
    const relay = createRelay({ targets: [GW], fetch: fn });
    expect((await relay(relayReq('/relay/bellows.example', { headers: { 'content-type': 'message/ohttp-req' } }))).status).toBe(200);
    expect(seen[0]!.headers.get('content-type')).toBe('message/ohttp-req');
  });
});

describe('refusals', () => {
  const relay = (f = recordingFetch()) => ({ handler: createRelay({ targets: [GW], maxBodyBytes: 1024, fetch: f.fn }), seen: f.seen });

  it.each([
    ['an unknown gateway', relayReq('/relay/evil.example'), 404, 'unknown_target'],
    ['another path', relayReq('/ohttp'), 404, 'not_found'],
    ['a GET', new Request('https://relay.example/relay/bellows.example'), 405, 'method_not_allowed'],
    ['another content type', relayReq('/relay/bellows.example', { headers: { 'content-type': 'application/json' } }), 415, 'unsupported_media_type'],
    ['a body over the limit', relayReq('/relay/bellows.example', { body: new Uint8Array(2000) }), 413, 'too_large'],
    ['an empty body', relayReq('/relay/bellows.example', { body: undefined }), 400, 'empty'],
  ])('%s', async (_name, req, status, code) => {
    const r = relay();
    const res = await r.handler(req);
    expect(res.status).toBe(status);
    expect(res.headers.get(RELAY_ERROR_HEADER)).toBe(code);
    expect(r.seen).toHaveLength(0);
  });

  it('a streamed body over the limit (no content length)', async () => {
    const r = relay();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(800));
        c.enqueue(new Uint8Array(800));
        c.close();
      },
    });
    const res = await r.handler(relayReq('/relay/bellows.example', { body, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
    expect(r.seen).toHaveLength(0);
  });

  it('a gateway that redirects or cannot be reached is a 502 from the relay', async () => {
    const redirect = createRelay({ targets: [GW], fetch: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }) });
    const r1 = await redirect(relayReq('/relay/bellows.example'));
    expect([r1.status, r1.headers.get(RELAY_ERROR_HEADER)]).toEqual([502, 'gateway_redirected']);
    const down = createRelay({ targets: [GW], fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    const r2 = await down(relayReq('/relay/bellows.example'));
    expect([r2.status, r2.headers.get(RELAY_ERROR_HEADER)]).toEqual([502, 'gateway_unreachable']);
  });

  it('answers a CORS preflight, and exposes its error header to browsers', async () => {
    const res = await relay().handler(new Request('https://relay.example/relay/bellows.example', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
    const err = await relay().handler(relayReq('/relay/evil.example'));
    expect(err.headers.get('access-control-expose-headers')).toBe(`${RELAY_ERROR_HEADER}, Retry-After`);
  });
});

describe('no logs', () => {
  it('writes nothing to the console or to stdout and stderr while relaying, failing or refusing', async () => {
    const spies = [
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m)),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const ok = createRelay({ targets: [GW], fetch: recordingFetch().fn });
    const down = createRelay({ targets: [GW], fetch: async () => Promise.reject(new Error('down')) });
    await ok(relayReq('/relay/bellows.example', { headers: { 'content-type': 'message/ohttp-chunked-req', ...IDENTIFYING } }));
    await ok(relayReq('/relay/evil.example'));
    await down(relayReq('/relay/bellows.example'));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('limits from the environment', () => {
  it('reads a whole-number body size of at least 1024 and a port from 1 to 65535; unset or empty is the default', () => {
    expect(parseMaxBodyBytes(undefined)).toBeUndefined();
    expect(parseMaxBodyBytes('')).toBeUndefined();
    expect(parseMaxBodyBytes('1024')).toBe(1024);
    expect(parseMaxBodyBytes(' 2097152 ')).toBe(2097152);
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort('8788')).toBe(8788);
    expect(parsePort('65535')).toBe(65535);
  });

  it('refuses a size or port that is not a whole number in range, such as 2MB', () => {
    for (const bad of ['2MB', 'lots', '1023', '0', '-5', '1.5', '1e6', 'NaN', 'Infinity']) {
      expect(() => parseMaxBodyBytes(bad), bad).toThrow(/BELLOWS_RELAY_MAX_BODY_BYTES must be a whole number of at least 1024/);
    }
    for (const bad of ['0', '65536', '80a', 'http', '-1', '8.5']) {
      expect(() => parsePort(bad), bad).toThrow(/BELLOWS_RELAY_PORT must be a whole number from 1 to 65535/);
    }
  });

  it('createRelay refuses a body limit that would let any body through, so every entry point shares the check', () => {
    for (const bad of [Number.NaN, Number('2MB'), 0, 1023, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => createRelay({ targets: [GW], maxBodyBytes: bad }), String(bad)).toThrow(/whole number of at least 1024/);
    }
    expect(() => createRelay({ targets: [GW], maxBodyBytes: 1024 })).not.toThrow();
  });

  it('the Node server stops at startup on a bad size or port, with a message', () => {
    const server = fileURLToPath(new URL('../../relay/server.ts', import.meta.url));
    for (const [name, value] of [['BELLOWS_RELAY_MAX_BODY_BYTES', '2MB'], ['BELLOWS_RELAY_PORT', '99999']] as const) {
      const run = spawnSync(process.execPath, [server], { env: { PATH: process.env.PATH ?? '', BELLOWS_RELAY_TARGETS: GW, [name]: value }, encoding: 'utf8', timeout: 20_000 });
      expect(run.status, name).toBe(1);
      expect(run.stderr).toContain(`${name} must be a whole number`);
      expect(run.stdout).not.toMatch(/listening/);
    }
  });
});

describe('as a Cloudflare Worker', () => {
  it('reads its allowlist from the environment and relays with the global fetch', async () => {
    const { fn, seen } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    try {
      const env = { BELLOWS_RELAY_TARGETS: `${GW}, https://other.example/ohttp` };
      const ok = await worker.fetch(relayReq('/relay/other.example', { headers: { 'content-type': 'message/ohttp-req', ...IDENTIFYING } }), env);
      expect(ok.status).toBe(200);
      expect(seen[0]!.url).toBe('https://other.example/ohttp');
      expect([...seen[0]!.headers.entries()]).toEqual([['content-type', 'message/ohttp-req']]);
      expect((await worker.fetch(relayReq('/relay/evil.example'), env)).status).toBe(404);
      expect(() => worker.fetch(relayReq('/relay/bellows.example'), { ...env, BELLOWS_RELAY_MAX_BODY_BYTES: 'lots' })).toThrow(/whole number/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('as a Node server', () => {
  let upstream: Server | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    upstream = undefined;
    close = undefined;
  });

  it('the gateway sees the relay, not the client: another address and none of its headers', async () => {
    const seen: Array<{ address: string | undefined; headers: IncomingHttpHeaders; raw: string[] }> = [];
    upstream = createServer((req, res) => {
      seen.push({ address: req.socket.remoteAddress, headers: req.headers, raw: req.rawHeaders });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'message/ohttp-res' });
        res.end(Buffer.from([7]));
      });
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
    const gwPort = (upstream.address() as AddressInfo).port;
    // The client reaches the relay over IPv6 loopback; the relay reaches the gateway over IPv4 loopback.
    const relay = await startRelay({ targets: [`http://127.0.0.1:${gwPort}/ohttp`], port: 0, host: '::1' });
    close = relay.close;
    const res = await fetch(`http://[::1]:${relay.port}/relay/127.0.0.1:${gwPort}`, {
      method: 'POST',
      headers: { 'content-type': 'message/ohttp-req', ...IDENTIFYING },
      body: new Uint8Array([1, 2]),
    });
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([7]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.address).not.toMatch(/::1$/);
    expect(seen[0]!.raw.join('\n')).not.toMatch(MARKERS);
    expect(seen[0]!.headers['content-type']).toBe('message/ohttp-req');
  });
});
