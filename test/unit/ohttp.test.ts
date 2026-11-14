/**
 * Oblivious HTTP gateway (src/ohttp.ts) and client (client/ohttp.ts), in process: the key is the attested
 * one, requests run through the same app, and tampered, replayed, stale or misdirected requests are refused.
 */
import { ChunkedOHTTPClient, KeyConfig, MediaType, OHTTPClient } from 'ohttp-ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BellowsFetchError,
  bellowsFetch,
  DEFAULT_MAX_MESSAGE_BYTES,
  OHTTP_DATE_HEADER,
  OHTTP_KEYS_PATH,
  OHTTP_PATH,
  ohttpSuite,
  RELAY_ERROR_HEADER,
  STALE_REQUEST,
} from '../../client/index.ts';
import { toHex } from '../../client/bytes.ts';
import { devAttester, devMeasurement } from '../../src/attest/dev.ts';
import { createApp, type Deps } from '../../src/app.ts';
import { BELLOWS_VERSION, EnvSchema, loadConfig, ohttpAdmitPerSecond } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { generateHpkeKeyPair, Identity } from '../../src/identity.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { OhttpGateway, ohttpPathAllowed, ReplayGuard } from '../../src/ohttp.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

function bellows(env: Record<string, string> = {}) {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps: Deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
  const app = createApp(deps);
  const sent: Array<{ url: string; body: Uint8Array; headers: Headers }> = [];
  /** fetch into the app, recording each encapsulated request as it went out. */
  const fetchApp = async (url: string, init?: RequestInit): Promise<Response> => {
    const req = new Request(url, init);
    const body = new Uint8Array(await req.clone().arrayBuffer());
    sent.push({ url, body, headers: req.headers });
    return app.fetch(req);
  };
  const operator = { origin: 'http://gw.test', keyConfig: deps.identity.keyConfig };
  return { app, deps, operator, fetchApp, sent };
}

const post = (body: Uint8Array, type: string = MediaType.CHUNKED_REQUEST) =>
  new Request(`http://gw.test${OHTTP_PATH}`, { method: 'POST', headers: { 'content-type': type }, body: body as BodyInit });

function devIdentity() {
  return new Identity({ attester: devAttester({ measurement: devMeasurement() }), version: BELLOWS_VERSION, measurement: devMeasurement(), relays: [], operator: null, refreshMs: 60_000 });
}

/** An encapsulated request made with the library directly, for requests bellowsFetch would not send. */
async function encapsulate(keyConfig: Uint8Array, req: Request, chunked = true) {
  const key = KeyConfig.parse(keyConfig);
  const client = chunked ? new ChunkedOHTTPClient(ohttpSuite(), key) : new OHTTPClient(ohttpSuite(), key);
  const { init, context } = await client.encapsulateRequest(req);
  return { bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), context, type: chunked ? MediaType.CHUNKED_REQUEST : MediaType.REQUEST };
}

const dated = (path: string, init: RequestInit = {}, at = Date.now()) => {
  const r = new Request(`http://gw.test${path}`, init);
  r.headers.set(OHTTP_DATE_HEADER, new Date(at).toUTCString());
  return r;
};

describe('key configuration', () => {
  it('/ohttp-keys serves the attested HPKE key as application/ohttp-keys', async () => {
    const { app, deps } = bellows();
    const res = await app.request(`http://gw.test${OHTTP_KEYS_PATH}`, { headers: { origin: 'https://app.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/ohttp-keys');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const configs = KeyConfig.parseMultiple(new Uint8Array(await res.arrayBuffer()));
    expect(configs).toHaveLength(1);
    expect(toHex(KeyConfig.serialize(configs[0]!))).toBe(toHex(deps.identity.keyConfig));
    const pre = await app.request(`http://gw.test${OHTTP_PATH}`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/content-type/i);
    // The same bytes the attested statement carries.
    expect(deps.identity.statement.hpke.key_config).toBe(Buffer.from(deps.identity.keyConfig).toString('base64'));
  });
});

describe('round trips', () => {
  it.each([true, false])('chunked=%s: a GET answers as it would directly', async (chunked) => {
    const { app, operator, fetchApp } = bellows();
    const res = await bellowsFetch(operator, '/v1/models', {}, { fetch: fetchApp, chunked });
    expect(res.status).toBe(200);
    const direct = await (await app.request('http://gw.test/v1/models')).json();
    expect(await res.json()).toEqual(direct);
  });

  it.each([true, false])('chunked=%s: a POST keeps its body and the answer keeps its status and headers', async (chunked) => {
    const { operator, fetchApp } = bellows();
    const res = await bellowsFetch(
      operator,
      '/v1/chat/completions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }) },
      { fetch: fetchApp, chunked },
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('x-cashu')).toMatch(/^creq/);
    expect(((await res.json()) as any).error.code).toBe('payment_required');
  });

  it('sends only ciphertext with an OHTTP content type to /ohttp', async () => {
    const { operator, fetchApp, sent } = bellows();
    await bellowsFetch(operator, '/v1/wallet', { headers: { authorization: 'Bearer sk-forge-marker-key' } }, { fetch: fetchApp });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`http://gw.test${OHTTP_PATH}`);
    expect([...sent[0]!.headers.keys()]).toEqual(['content-type']);
    expect(sent[0]!.headers.get('content-type')).toBe(MediaType.CHUNKED_REQUEST);
    expect(Buffer.from(sent[0]!.body).toString('latin1')).not.toContain('sk-forge-marker-key');
    expect(Buffer.from(sent[0]!.body).toString('latin1')).not.toContain('/v1/wallet');
  });

  it('sends to the relay when one is given, and straight to the Bellows with relay null', async () => {
    const { operator, fetchApp, sent } = bellows();
    const viaRelay = async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://relay.example/relay/gw.test');
      return fetchApp(`http://gw.test${OHTTP_PATH}`, init);
    };
    expect((await bellowsFetch({ ...operator, relay: 'https://relay.example/relay/gw.test' }, '/healthz', {}, { fetch: viaRelay })).status).toBe(200);
    expect((await bellowsFetch({ ...operator, relay: 'https://relay.example/relay/gw.test' }, '/healthz', {}, { fetch: fetchApp, relay: null })).status).toBe(200);
    expect(sent.map((s) => s.url)).toEqual([`http://gw.test${OHTTP_PATH}`, `http://gw.test${OHTTP_PATH}`]);
  });

  it('streams a chunked answer: each piece arrives as the app writes it', async () => {
    const identity = devIdentity();
    let finish!: () => void;
    const ended = new Promise<void>((r) => (finish = r));
    const gw = new OhttpGateway({
      identity,
      maxSkewMs: 60_000,
      replayCacheMax: 100,
      maxMessageBytes: 1 << 20,
      dispatch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode('data: first\n\n'));
              await ended;
              ctrl.enqueue(new Uint8Array(40_000).fill(97));
              ctrl.enqueue(new TextEncoder().encode('data: last\n\n'));
              ctrl.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const res = await bellowsFetch({ origin: 'http://gw.test', keyConfig: identity.keyConfig }, '/v1/chat/completions', { method: 'POST', body: '{}' }, { fetch: (u, i) => gw.handle(new Request(u, i)) });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    finish();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value, { stream: true });
    }
    expect(rest).toHaveLength(40_000 + 'data: last\n\n'.length);
    expect(rest.endsWith('data: last\n\n')).toBe(true);
  });

  it('a request body larger than one chunk arrives whole, and a request cut short is refused', async () => {
    const identity = devIdentity();
    const gw = new OhttpGateway({ identity, maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: 1 << 20, dispatch: async (r) => new Response(await r.arrayBuffer()) });
    const big = 'x'.repeat(40_000);
    const res = await bellowsFetch({ origin: 'http://gw.test', keyConfig: identity.keyConfig }, '/v1/chat/completions', { method: 'POST', body: big }, { fetch: (u, i) => gw.handle(new Request(u, i)) });
    expect(await res.text()).toBe(big);
    const { bytes } = await encapsulate(identity.keyConfig, dated('/v1/chat/completions', { method: 'POST', body: big }));
    expect((await gw.handle(post(bytes.subarray(0, 20_000)))).status).toBe(400);
  });

  it('a buffered (plain RFC 9458) answer arrives whole', async () => {
    const { operator, fetchApp } = bellows();
    const res = await bellowsFetch(operator, '/healthz', {}, { fetch: fetchApp, chunked: false });
    expect(((await res.json()) as any).ok).toBe(true);
  });

  it('a plain answer over 1 MiB, within the gateway default, opens with its headers', async () => {
    // The client must accept every answer the gateway sends: by then the request has run and been charged.
    expect(EnvSchema.shape.BELLOWS_OHTTP_MAX_MESSAGE_BYTES.parse(undefined)).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(8 * 1024 * 1024);
    const identity = devIdentity();
    let ran = 0;
    const big = 'y'.repeat(1_200_000);
    const gw = new OhttpGateway({
      identity,
      maxSkewMs: 60_000,
      replayCacheMax: 100,
      maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
      dispatch: () => (ran++, new Response(big, { headers: { 'content-type': 'text/event-stream', 'x-forge-request-id': 'req-1', 'x-forge-change-url': '/v1/change/req-1' } })),
    });
    const res = await bellowsFetch({ origin: 'http://gw.test', keyConfig: identity.keyConfig }, '/v1/chat/completions', { method: 'POST', body: '{}' }, { fetch: (u, i) => gw.handle(new Request(u, i)), chunked: false });
    expect(ran).toBe(1);
    expect(res.headers.get('x-forge-request-id')).toBe('req-1');
    expect(res.headers.get('x-forge-change-url')).toBe('/v1/change/req-1');
    expect(await res.text()).toBe(big);
  });

  it('a client limit below the answer fails as bad_response, and a limit below 1 KiB or not an integer is refused', async () => {
    const { operator, fetchApp } = bellows();
    await expect(bellowsFetch(operator, '/v1/models', {}, { fetch: fetchApp, chunked: false, maxMessageBytes: 64 })).rejects.toMatchObject({ code: 'bad_request' });
    const identity = devIdentity();
    const gw = new OhttpGateway({ identity, maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES, dispatch: () => new Response('z'.repeat(100_000)) });
    const op = { origin: 'http://gw.test', keyConfig: identity.keyConfig };
    const via = (u: string, i?: RequestInit) => gw.handle(new Request(u, i));
    await expect(bellowsFetch(op, '/healthz', {}, { fetch: via, chunked: false, maxMessageBytes: 65_536 })).rejects.toMatchObject({ code: 'bad_response' });
    for (const bad of [0, -1, 1023, 1024.5, Number.NaN]) {
      await expect(bellowsFetch(op, '/healthz', {}, { fetch: via, maxMessageBytes: bad })).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('a chunked answer is not held to the request limit: a 200 KB stream passes a 64 KiB gateway to the end', async () => {
    const identity = devIdentity();
    const piece = new Uint8Array(1_000).fill(98);
    const gw = new OhttpGateway({
      identity,
      maxSkewMs: 60_000,
      replayCacheMax: 100,
      maxMessageBytes: 65_536,
      dispatch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              for (let i = 0; i < 200; i++) ctrl.enqueue(piece);
              ctrl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              ctrl.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const res = await bellowsFetch({ origin: 'http://gw.test', keyConfig: identity.keyConfig }, '/v1/chat/completions', { method: 'POST', body: '{}' }, { fetch: (u, i) => gw.handle(new Request(u, i)) });
    const text = await res.text();
    expect(text).toHaveLength(200_000 + 'data: [DONE]\n\n'.length);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('refusals', () => {
  it('a tampered request is refused with a plain 400 and never runs', async () => {
    const { app, deps } = bellows();
    for (const at of [10, 60]) {
      const { bytes } = await encapsulate(deps.identity.keyConfig, dated('/healthz'));
      bytes[at]! ^= 1; // 10: inside enc; 60: inside the ciphertext
      const res = await app.fetch(post(bytes));
      expect(res.status, `byte ${at}`).toBe(400);
      expect(await res.text()).toBe('');
    }
  });

  it('a replayed request is refused, whether replayed whole or as plain OHTTP', async () => {
    const { app, deps } = bellows();
    for (const chunked of [true, false]) {
      const { bytes, context, type } = await encapsulate(deps.identity.keyConfig, dated('/healthz'), chunked);
      const first = await app.fetch(post(bytes, type));
      expect(first.status).toBe(200);
      expect((await context.decapsulateResponse(first)).status).toBe(200);
      const again = await app.fetch(post(bytes, type));
      expect(again.status).toBe(400);
    }
  });

  it('a replayed topup cannot run twice', async () => {
    // The replay is refused before the inner request is decoded, so it never reaches the wallet.
    const { app, deps } = bellows();
    let topups = 0;
    const inner = dated('/v1/wallet/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'cashuBnot-a-token' }) });
    const { bytes } = await encapsulate(deps.identity.keyConfig, inner);
    const orig = app.fetch.bind(app);
    const counting = async (r: Request) => {
      const res = await orig(r);
      if (r.url.endsWith('/v1/wallet/topup')) topups++;
      return res;
    };
    const gw = new OhttpGateway({ identity: deps.identity, dispatch: counting, maxSkewMs: 300_000, replayCacheMax: 1000, maxMessageBytes: 1 << 20 });
    expect((await gw.handle(post(bytes))).status).toBe(200);
    expect((await gw.handle(post(bytes))).status).toBe(400);
    expect(topups).toBe(1);
  });

  it('a request dated outside the window gets stale_request with the gateway clock, and is not run', async () => {
    const identity = devIdentity();
    let ran = 0;
    const now = Date.parse('2026-11-12T12:00:00Z');
    const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('ok')), maxSkewMs: 300_000, replayCacheMax: 100, maxMessageBytes: 1 << 20, now: () => now });
    const { bytes, context } = await encapsulate(identity.keyConfig, dated('/healthz', {}, now - 301_000));
    const res = await context.decapsulateResponse(await gw.handle(post(bytes)));
    expect(res.status).toBe(400);
    expect(res.headers.get(OHTTP_DATE_HEADER)).toBe(new Date(now).toUTCString());
    expect(((await res.json()) as any).error.code).toBe(STALE_REQUEST);
    expect(ran).toBe(0);
  });

  it('bellowsFetch retries once on the gateway clock when its own clock is wrong', async () => {
    const { operator, fetchApp, sent } = bellows();
    const res = await bellowsFetch(operator, '/healthz', {}, { fetch: fetchApp, now: () => Date.now() - 3_600_000 });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it('a request with no date is refused (encapsulated) and not run', async () => {
    const { app, deps } = bellows();
    const { bytes, context } = await encapsulate(deps.identity.keyConfig, new Request('http://gw.test/healthz'));
    const res = await context.decapsulateResponse(await app.fetch(post(bytes)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('date_required');
  });

  it('accepts the standard Date header from other OHTTP clients', async () => {
    const { app, deps } = bellows();
    const r = new Request('http://gw.test/healthz', { headers: { date: new Date().toUTCString() } });
    const { bytes, context } = await encapsulate(deps.identity.keyConfig, r);
    expect((await context.decapsulateResponse(await app.fetch(post(bytes)))).status).toBe(200);
  });

  it('only client API paths and GET or POST go through', async () => {
    expect(['/v1/models', '/v1/wallet/topup', '/healthz', '/.well-known/bellows', '/.well-known/hpke-keys', '/attestation'].every(ohttpPathAllowed)).toBe(true);
    expect(['/', '/ohttp', '/ohttp-keys', '/admin/api/overview', '/admin/api/session', '/v1', '/healthz/x'].some(ohttpPathAllowed)).toBe(false);
    const { operator, fetchApp } = bellows();
    for (const path of ['/admin/api/overview', '/v1/../admin/api/overview', '/v1/%2e%2e/admin/api/overview', '/ohttp-keys', '/ohttp']) {
      const res = await bellowsFetch(operator, path, {}, { fetch: fetchApp });
      expect(res.status, path).toBe(404);
      const err = ((await res.json()) as any).error;
      expect(err.code, path).toBe('not_found');
      expect(err.message, path).toMatch(/not available through Oblivious HTTP/);
    }
    const put = await bellowsFetch(operator, '/v1/wallet', { method: 'PUT', body: '{}' }, { fetch: fetchApp });
    expect(put.status).toBe(405);
  });

  it('refuses another content type (415), a key it does not hold (400) and garbage (400)', async () => {
    const { app } = bellows();
    expect((await app.fetch(post(new Uint8Array(64), 'application/json'))).status).toBe(415);
    const other = generateHpkeKeyPair(9).keyConfig;
    const { bytes, type } = await encapsulate(other, dated('/healthz'));
    expect((await app.fetch(post(bytes, type))).status).toBe(400);
    expect((await app.fetch(post(new Uint8Array(10)))).status).toBe(400);
    expect((await app.fetch(post(new Uint8Array(500), MediaType.REQUEST))).status).toBe(400);
  });

  it('an outer body over the read bound answers 413 with no body, and nothing runs', async () => {
    const identity = devIdentity();
    let ran = 0;
    const max = 65_536;
    const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('ok')), maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: max });
    for (const type of [MediaType.CHUNKED_REQUEST, MediaType.REQUEST]) {
      const res = await gw.handle(post(new Uint8Array(max + Math.ceil(max / 1024) + 4097), type));
      expect(res.status, type).toBe(413);
      expect(await res.text()).toBe('');
    }
    expect(ran).toBe(0);
  });

  it.each([true, false])('chunked=%s: an encapsulated request whose Binary HTTP is over the limit answers 413 and does not run', async (chunked) => {
    const identity = devIdentity();
    let ran = 0;
    const max = 65_536;
    const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('ok')), maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: max });
    const { bytes, type } = await encapsulate(identity.keyConfig, dated('/v1/chat/completions', { method: 'POST', body: 'x'.repeat(max) }), chunked);
    // Within the outer read bound, so the refusal is the message limit itself.
    expect(bytes.length).toBeLessThanOrEqual(max + Math.ceil(max / 1024) + 4096);
    const res = await gw.handle(post(bytes, type));
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('');
    expect(ran).toBe(0);
  });

  it('answers 503 when the replay cache is full of live keys, and frees keys whose window has passed', async () => {
    const identity = devIdentity();
    let now = Date.now();
    const gw = new OhttpGateway({ identity, dispatch: () => new Response('ok'), maxSkewMs: 60_000, replayCacheMax: 2, maxMessageBytes: 1 << 20, now: () => now });
    const send = async () => gw.handle(post((await encapsulate(identity.keyConfig, dated('/healthz', {}, now))).bytes));
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(503);
    now += 62_000;
    expect((await send()).status).toBe(200);
    expect(gw.replayCacheSize).toBe(1);
  });

  it('a request refused for its method or path never takes a replay-cache slot', async () => {
    const identity = devIdentity();
    let ran = 0;
    const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('ok')), maxSkewMs: 60_000, replayCacheMax: 2, maxMessageBytes: 1 << 20 });
    const refused: Array<[Request, number]> = [
      [dated('/v1/wallet', { method: 'PUT', body: '{}' }), 405],
      [dated('/v1/wallet', { method: 'DELETE' }), 405],
      [dated('/admin/api/overview'), 404],
      [dated('/ohttp', { method: 'POST', body: 'x' }), 404],
      [dated('/'), 404],
    ];
    for (const [req, status] of refused) {
      const { bytes, context, type } = await encapsulate(identity.keyConfig, req);
      const res = await context.decapsulateResponse(await gw.handle(post(bytes, type)));
      expect(res.status, `${req.method} ${new URL(req.url).pathname}`).toBe(status);
    }
    expect(gw.replayCacheSize).toBe(0);
    expect(ran).toBe(0);
  });

  it('a full cache cannot be filled by refused requests: admitted ones still go through', async () => {
    const identity = devIdentity();
    const gw = new OhttpGateway({ identity, dispatch: () => new Response('ok'), maxSkewMs: 60_000, replayCacheMax: 2, maxMessageBytes: 1 << 20 });
    for (let i = 0; i < 20; i++) {
      const { bytes, context } = await encapsulate(identity.keyConfig, dated(i % 2 ? '/admin/api/overview' : '/v1/wallet', i % 2 ? {} : { method: 'PATCH', body: '{}' }));
      const outer = await gw.handle(post(bytes));
      expect(outer.status, `refused request ${i}`).toBe(200);
      expect([404, 405]).toContain((await context.decapsulateResponse(outer)).status);
    }
    // Undated and stale requests are refused before the cache too.
    for (const req of [new Request('http://gw.test/healthz'), dated('/healthz', {}, Date.now() - 120_000)]) {
      const { bytes, context } = await encapsulate(identity.keyConfig, req);
      expect((await context.decapsulateResponse(await gw.handle(post(bytes)))).status).toBe(400);
    }
    expect(gw.replayCacheSize).toBe(0);
    for (let i = 0; i < 2; i++) {
      const { bytes, context } = await encapsulate(identity.keyConfig, dated('/healthz'));
      expect((await context.decapsulateResponse(await gw.handle(post(bytes)))).status).toBe(200);
    }
    expect(gw.replayCacheSize).toBe(2);
  });

  it('a replayed refused request is refused again and runs nothing; a replayed admitted one is still a replay', async () => {
    const identity = devIdentity();
    let ran = 0;
    const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('ok')), maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: 1 << 20 });
    const bad = await encapsulate(identity.keyConfig, dated('/admin/api/overview'));
    for (let i = 0; i < 2; i++) expect((await bad.context.decapsulateResponse(await gw.handle(post(bad.bytes)))).status).toBe(404);
    const good = await encapsulate(identity.keyConfig, dated('/v1/models'));
    expect((await gw.handle(post(good.bytes))).status).toBe(200);
    expect((await gw.handle(post(good.bytes))).status).toBe(400);
    expect(ran).toBe(1);
    expect(gw.replayCacheSize).toBe(1);
  });

  it('admits at most admitPerSecond new requests: past it 503 with Retry-After, and refused or replayed requests use none', async () => {
    const identity = devIdentity();
    let now = Date.now();
    let ran = 0;
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('ok')), maxSkewMs: 60_000, replayCacheMax: 1000, admitPerSecond: 2, maxMessageBytes: 1 << 20, now: () => now });
      const make = (path = '/healthz', init: RequestInit = {}) => encapsulate(identity.keyConfig, dated(path, init, now));
      // Refused for path, method or date, they take nothing from the bound.
      for (let i = 0; i < 5; i++) {
        const { bytes, context } = await make(i % 2 ? '/admin/api/overview' : '/v1/wallet', i % 2 ? {} : { method: 'PUT', body: '{}' });
        expect((await gw.handle(post(bytes))).status).toBe(200);
        expect([404, 405]).toContain((await context.decapsulateResponse(await gw.handle(post(bytes)))).status);
      }
      const first = await make();
      expect((await gw.handle(post(first.bytes))).status).toBe(200);
      // A replay is refused as a replay and uses none either.
      for (let i = 0; i < 3; i++) expect((await gw.handle(post(first.bytes))).status).toBe(400);
      expect((await gw.handle(post((await make()).bytes))).status).toBe(200);
      const over = await gw.handle(post((await make()).bytes));
      expect(over.status).toBe(503);
      expect(over.headers.get('retry-after')).toBe('1');
      expect(await over.text()).toBe('');
      expect(lines.some((l) => l.includes('"ohttp_refused"') && l.includes('"busy"'))).toBe(true);
      // Turned away by the bound, it took no cache slot, so it can be sent again once there is room.
      expect(gw.replayCacheSize).toBe(2);
      now += 1000;
      expect((await gw.handle(post((await make()).bytes))).status).toBe(200);
      expect(ran).toBe(3);
    } finally {
      setLogSink(undefined);
    }
  });

  it('a clock that steps back does not shut new requests out of the bound', async () => {
    const identity = devIdentity();
    let now = Date.now();
    const gw = new OhttpGateway({ identity, dispatch: () => new Response('ok'), maxSkewMs: 60_000, replayCacheMax: 1000, admitPerSecond: 2, maxMessageBytes: 1 << 20, now: () => now });
    const send = async () => gw.handle(post((await encapsulate(identity.keyConfig, dated('/healthz', {}, now))).bytes));
    expect((await send()).status).toBe(200);
    now -= 600_000;
    expect((await send()).status).toBe(200);
  });

  it('at the default bound a flood longer than a key lifetime never fills the cache', async () => {
    const identity = devIdentity();
    const skew = 5;
    const max = 50;
    let now = Date.now();
    const reasons: string[] = [];
    setLogSink((l) => reasons.push(JSON.parse(l).reason));
    try {
      const admitPerSecond = ohttpAdmitPerSecond({ BELLOWS_OHTTP_MAX_SKEW_SECONDS: skew, BELLOWS_OHTTP_REPLAY_CACHE_MAX: max, BELLOWS_OHTTP_ADMIT_PER_SECOND: undefined });
      const gw = new OhttpGateway({ identity, dispatch: () => new Response('ok'), maxSkewMs: skew * 1000, replayCacheMax: max, admitPerSecond, maxMessageBytes: 1 << 20, now: () => now });
      let admitted = 0;
      // Every quarter second for 30 s (almost three key lifetimes), send until turned away, each dated at the
      // far edge of the window so its key is kept as long as possible.
      for (let t = 0; t < 120; t++, now += 250) {
        for (;;) {
          const res = await gw.handle(post((await encapsulate(identity.keyConfig, dated('/healthz', {}, now + skew * 1000 - 500))).bytes));
          if (res.status !== 200) {
            expect(res.status).toBe(503);
            break;
          }
          admitted++;
        }
        expect(gw.replayCacheSize).toBeLessThanOrEqual(max);
      }
      expect(admitted).toBeGreaterThan(100);
      expect(reasons).not.toContain('replay_cache_full');
      expect(reasons).toContain('busy');
    } finally {
      setLogSink(undefined);
    }
  });

  it('the app bounds admission by BELLOWS_OHTTP_ADMIT_PER_SECOND', async () => {
    const { app, deps } = bellows({ BELLOWS_OHTTP_ADMIT_PER_SECOND: '1' });
    const send = async () => app.fetch(post((await encapsulate(deps.identity.keyConfig, dated('/healthz'))).bytes));
    expect((await send()).status).toBe(200);
    const over = await send();
    expect(over.status).toBe(503);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('ReplayGuard forgets a key only after its time', () => {
    const g = new ReplayGuard(10);
    expect(g.remember('a', 100, 0)).toBe(true);
    expect(g.seen('a', 100)).toBe(true);
    expect(g.seen('a', 101)).toBe(false);
    g.prune(101);
    expect(g.size).toBe(0);
  });
});

describe('what the app receives', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    setLogSink((l) => lines.push(l));
  });
  afterEach(() => setLogSink(undefined));

  it('the inner request carries none of the outer headers, and no date', async () => {
    const identity = devIdentity();
    const seen: Request[] = [];
    const gw = new OhttpGateway({ identity, dispatch: (r) => (seen.push(r), new Response('ok')), maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: 1 << 20 });
    const { bytes, type } = await encapsulate(identity.keyConfig, dated('/v1/models', { headers: { 'x-cashu-pubkey': 'inner-value' } }));
    const outer = new Request(`http://gw.test${OHTTP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': type, 'x-forwarded-for': '198.51.100.7', forwarded: 'for=198.51.100.7', 'user-agent': 'outer-agent', cookie: 'c=outer', referer: 'https://outer.example/' },
      body: bytes,
    });
    expect((await gw.handle(outer)).status).toBe(200);
    expect(seen).toHaveLength(1);
    const h = [...seen[0]!.headers.entries()];
    expect(h).toEqual([['x-cashu-pubkey', 'inner-value']]);
    expect(new URL(seen[0]!.url).pathname).toBe('/v1/models');
    expect(lines.join('\n')).not.toMatch(/198\.51\.100\.7|outer-agent|outer\.example|c=outer/);
  });

  it('an answer that cannot be encapsulated returns 500 with no body, logged with its reason only', async () => {
    const identity = devIdentity();
    let ran = 0;
    // A plain answer over the limit cannot be sealed.
    const gw = new OhttpGateway({ identity, dispatch: () => (ran++, new Response('secret-answer-'.repeat(10_000))), maxSkewMs: 60_000, replayCacheMax: 100, maxMessageBytes: 65_536 });
    const { bytes, type } = await encapsulate(identity.keyConfig, dated('/healthz'), false);
    const res = await gw.handle(post(bytes, type));
    expect(ran).toBe(1);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    const failed = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'ohttp_answer_failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]).sort()).toEqual(['level', 'msg', 'reason', 'ts']);
    expect(lines.join('\n')).not.toMatch(/secret-answer/);
  });

  it('a refusal is logged with its reason only', async () => {
    const { app } = bellows();
    await app.fetch(post(new Uint8Array(100)));
    const refused = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'ohttp_refused');
    expect(refused).toHaveLength(1);
    expect(Object.keys(refused[0]).sort()).toEqual(['level', 'msg', 'reason', 'ts']);
  });
});

describe('client errors', () => {
  const operator = () => bellows().operator;

  it('a bad path is refused before anything is sent', async () => {
    for (const p of ['v1/models', '//evil.example/x', 'https://evil.example/']) {
      await expect(bellowsFetch(operator(), p, {}, { fetch: () => Promise.reject(new Error('sent')) })).rejects.toMatchObject({ code: 'bad_path' });
    }
  });

  it('names relay errors, gateway refusals and network failures', async () => {
    const relayErr = () => Promise.resolve(new Response('unknown_target\n', { status: 404, headers: { [RELAY_ERROR_HEADER]: 'unknown_target' } }));
    await expect(bellowsFetch(operator(), '/healthz', {}, { fetch: relayErr })).rejects.toMatchObject({ code: 'relay_error', status: 404 });
    await expect(bellowsFetch(operator(), '/healthz', {}, { fetch: () => Promise.resolve(new Response(null, { status: 400 })) })).rejects.toMatchObject({ code: 'gateway_refused', status: 400 });
    const busy = () => Promise.resolve(new Response(null, { status: 503, headers: { 'retry-after': '3' } }));
    await expect(bellowsFetch(operator(), '/healthz', {}, { fetch: busy })).rejects.toMatchObject({ code: 'gateway_refused', status: 503, retryAfter: 3 });
    const refused = await bellowsFetch(operator(), '/healthz', {}, { fetch: () => Promise.resolve(new Response(null, { status: 400, headers: { 'retry-after': '3' } })) }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'gateway_refused', status: 400 });
    expect((refused as { retryAfter?: number }).retryAfter).toBeUndefined();
    await expect(bellowsFetch(operator(), '/healthz', {}, { fetch: () => Promise.reject(new TypeError('fetch failed')) })).rejects.toMatchObject({ code: 'network' });
    const garbage = () => Promise.resolve(new Response(new Uint8Array(80), { status: 200, headers: { 'content-type': MediaType.CHUNKED_RESPONSE } }));
    const p = bellowsFetch(operator(), '/healthz', {}, { fetch: garbage });
    await expect(p).rejects.toBeInstanceOf(BellowsFetchError);
    await expect(p).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses a key configuration it cannot use', async () => {
    await expect(bellowsFetch({ origin: 'http://gw.test', keyConfig: new Uint8Array(5) }, '/healthz')).rejects.toMatchObject({ code: 'bad_key_config' });
  });
});
