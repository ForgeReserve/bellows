/**
 * Bellows relay: the first hop of Oblivious HTTP (RFC 9458). It takes an encapsulated request from a client,
 * forwards the opaque bytes to one Bellows on its allowlist, and passes the encapsulated answer back.
 *
 * What it forwards: the body and its content type. Nothing else from the client reaches the Bellows: no
 * address, no cookies, no user agent, no forwarded-for or any other header. It writes no logs and keeps
 * nothing. It cannot read requests or answers: they are encrypted to a key held inside the Bellows.
 *
 * Routes:
 *   POST /relay/<host>   forward to the allowlisted Bellows whose gateway URL has this host
 *   GET  /healthz        200 "ok"
 *
 * Web APIs only (fetch, streams), so the same code runs as a Node server (server.ts) and as a Cloudflare
 * Worker (worker.ts).
 */

/** Set on every error the relay makes itself, so a client can tell them from the gateway's answers. */
export const RELAY_ERROR_HEADER = 'Bellows-Relay-Error';

const REQUEST_TYPES = new Set(['message/ohttp-req', 'message/ohttp-chunked-req']);
const RESPONSE_TYPES = new Set(['message/ohttp-res', 'message/ohttp-chunked-res']);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface RelayOptions {
  /**
   * Gateway URLs this relay forwards to, e.g. https://bellows.example/ohttp. A client reaches each one at
   * /relay/<host of the URL>. https only, except loopback addresses (for tests and local runs).
   */
  targets: readonly string[];
  /** Largest encapsulated request accepted, in bytes: a whole number of at least 1024 (default 2 MiB). */
  maxBodyBytes?: number;
  /** fetch to use (default: the global one). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export type RelayHandler = (request: Request) => Promise<Response>;

/** Parses the allowlist. Throws on a URL that is not https (or loopback http), or on a repeated host. */
export function parseTargets(targets: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of targets) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`relay target is not a URL: ${raw}`);
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
      throw new Error(`relay target must be https: ${raw}`);
    }
    if (u.username || u.password || u.hash || u.search) throw new Error(`relay target must be a plain URL: ${raw}`);
    if (out.has(u.host)) throw new Error(`two relay targets share the host ${u.host}`);
    out.set(u.host, u.href);
  }
  return out;
}

/** Reads a comma-separated target list, as BELLOWS_RELAY_TARGETS holds it. */
export function targetsFromList(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Smallest body limit the relay accepts: an encapsulated request is never smaller than its framing. */
export const MIN_BODY_BYTES = 1024;

function checkMaxBodyBytes(max: number, name: string): number {
  if (!Number.isSafeInteger(max) || max < MIN_BODY_BYTES) throw new Error(`${name} must be a whole number of at least ${MIN_BODY_BYTES}`);
  return max;
}

/** Reads BELLOWS_RELAY_MAX_BODY_BYTES. Unset or empty: undefined (the default). Anything but a whole number of at least 1024 throws. */
export function parseMaxBodyBytes(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim();
  return checkMaxBodyBytes(/^\d+$/.test(v) ? Number(v) : Number.NaN, 'BELLOWS_RELAY_MAX_BODY_BYTES');
}

/** Reads BELLOWS_RELAY_PORT. Unset or empty: undefined (the default). Anything but a whole number from 1 to 65535 throws. */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim();
  const port = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BELLOWS_RELAY_PORT must be a whole number from 1 to 65535');
  return port;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': RELAY_ERROR_HEADER,
};

function relayError(status: number, code: string): Response {
  return new Response(`${code}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', [RELAY_ERROR_HEADER]: code, ...CORS },
  });
}

class TooLarge extends Error {}

async function readLimited(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function createRelay(opts: RelayOptions): RelayHandler {
  const targets = parseTargets(opts.targets);
  // Checked here so every entry point refuses a limit that would let any body through (NaN compares false).
  const max = opts.maxBodyBytes === undefined ? 2 * 1024 * 1024 : checkMaxBodyBytes(opts.maxBodyBytes, 'maxBodyBytes');
  const doFetch = opts.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { ...CORS, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600' },
        });
      }
      if (url.pathname === '/healthz' && request.method === 'GET') {
        return new Response('ok\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      }
      const m = /^\/relay\/([^/]+)$/.exec(url.pathname);
      if (!m) return relayError(404, 'not_found');
      if (request.method !== 'POST') return relayError(405, 'method_not_allowed');
      let host: string;
      try {
        host = decodeURIComponent(m[1]!).toLowerCase();
      } catch {
        return relayError(404, 'unknown_target');
      }
      const target = targets.get(host);
      if (!target) return relayError(404, 'unknown_target');
      const type = request.headers.get('content-type')?.toLowerCase() ?? '';
      if (!REQUEST_TYPES.has(type)) return relayError(415, 'unsupported_media_type');
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > max) return relayError(413, 'too_large');
      if (!request.body) return relayError(400, 'empty');

      let body: Uint8Array<ArrayBuffer>;
      try {
        body = await readLimited(request.body, max);
      } catch (e) {
        return e instanceof TooLarge ? relayError(413, 'too_large') : relayError(400, 'unreadable');
      }

      // A fresh request: only the content type and the opaque body go on.
      let upstream: Response;
      try {
        upstream = await doFetch(target, {
          method: 'POST',
          headers: { 'content-type': type },
          body,
          // Only options every runtime supports (Workers rejects some RequestInit fields, such as credentials).
          redirect: 'manual',
          signal: request.signal,
        });
      } catch {
        return relayError(502, 'gateway_unreachable');
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => {});
        return relayError(502, 'gateway_redirected');
      }
      // Only the status, an OHTTP content type and the opaque body go back.
      const headers: Record<string, string> = { 'cache-control': 'no-store', ...CORS };
      const answerType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
      if (RESPONSE_TYPES.has(answerType)) headers['content-type'] = answerType;
      const passBody = upstream.status === 200 && RESPONSE_TYPES.has(answerType);
      if (!passBody) await upstream.body?.cancel().catch(() => {});
      return new Response(passBody ? upstream.body : null, { status: upstream.status, headers });
    } catch {
      return relayError(500, 'relay_error');
    }
  };
}
