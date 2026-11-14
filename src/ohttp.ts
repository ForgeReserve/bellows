/**
 * Oblivious HTTP gateway (RFC 9458, and chunked OHTTP, draft-ietf-ohai-chunked-ohttp-08) for Bellows' own
 * client API. POST /ohttp takes an encapsulated request for a client API path, runs it through the same
 * app as a direct request, and returns the encapsulated answer. The key is the attested HPKE key from
 * /.well-known/bellows (src/identity.ts), served for standard tooling at /ohttp-keys.
 *
 * Replays: RFC 9458 leaves replay protection to the gateway (section 6.5). Every request must carry a date
 * within BELLOWS_OHTTP_MAX_SKEW_SECONDS of this clock, and the encapsulated key (`enc`, new for every
 * request) of each accepted request is remembered until that date leaves the window. A request seen before
 * is refused before it runs; one dated outside the window is answered (encapsulated) with stale_request and
 * this gateway's date, so an honest client with a wrong clock can retry. The date, method and path are
 * checked before a key is remembered, so a request that runs nothing never takes a place in the cache.
 * New keys are admitted at a bounded rate for all clients together (BELLOWS_OHTTP_ADMIT_PER_SECOND), by
 * default the most the cache holds for a key's whole lifetime, so a flood cannot fill it.
 *
 * Streaming: a chunked answer is sealed piece by piece as the app produces it, so a streamed chat answer
 * reaches the client as it is written. The crypto (HPKE, chunk sealing and its nonces) is ohttp-ts; this
 * file only frames the sealed chunks (a QUIC varint length before each, 0 before the last), because the
 * library's own response stream holds every chunk until the next one exists and seals 16 KiB at a time.
 *
 * Limits: BELLOWS_OHTTP_MAX_MESSAGE_BYTES bounds every request, which anyone can send, and every plain RFC 9458
 * answer, which is buffered whole. A chunked answer comes from Bellows' own app and is bounded only by
 * DEFAULT_MAX_CHUNKED_ANSWER_BYTES (1 GiB, what the client accepts), so a long stream is never cut short.
 *
 * Nothing about the outer request (address, headers) reaches the app or the logs.
 */
import { createHash } from 'node:crypto';
import { BHttpDecoder, BHttpEncoder, decodeVli, encodeVli, MessageLimitExceededError, padmeWithFloor } from 'bhttp-ts';
import {
  type ChunkedServerRequestContext,
  ChunkedOHTTPServer,
  isOHTTPError,
  KeyConfig,
  type KeyConfigWithPrivate,
  MediaType,
  OHTTPError,
  OHTTPErrorCode,
  OHTTPServer,
} from 'ohttp-ts';
import { DEFAULT_MAX_CHUNKED_ANSWER_BYTES, OHTTP_DATE_HEADER, ohttpSuite, STALE_REQUEST } from '../client/ohttp.ts';
import { ohttpAdmitBurst } from './config.ts';
import type { Identity } from './identity.ts';
import { errText, log } from './log.ts';
import { RateLimiter } from './ratelimit.ts';

/** X25519 is the only KEM Bellows offers: 7 header bytes (key id, KEM, KDF, AEAD) then a 32-byte enc. */
const KEM_X25519 = 0x0020;
const HEADER_BYTES = 7 + 32;
/** The draft's plaintext chunk size; no sealed chunk is larger. */
const MAX_CHUNK = 16_384;
/** The same padding ohttp-ts applies by default: max(1 KiB, Padmé(size)), added at the end of the message. */
const PADDING = padmeWithFloor(1024);

/** Paths an encapsulated request may name: the client API, never the operator API or /ohttp itself. */
const EXACT_PATHS = new Set(['/healthz', '/.well-known/bellows', '/.well-known/hpke-keys', '/attestation']);
export function ohttpPathAllowed(path: string): boolean {
  return path.startsWith('/v1/') || EXACT_PATHS.has(path);
}
const METHODS = new Set(['GET', 'POST']);

/** Headers that describe a hop, not the request; dropped from the inner request. */
const HOP_HEADERS = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'trailer', 'content-length', 'proxy-authorization', 'proxy-connection'];

/** The origin inner requests are given. The app routes on the path only. */
const INNER_ORIGIN = 'http://ohttp.bellows.internal';

export interface OhttpGatewayOptions {
  identity: Identity;
  /** Runs one inner request through the app. */
  dispatch: (req: Request) => Response | Promise<Response>;
  maxSkewMs: number;
  replayCacheMax: number;
  /**
   * Most new requests admitted per second, for all clients together (anonymous requests carry no identity to
   * limit by), with a burst of ohttpAdmitBurst. Only a request that would take a replay-cache slot uses one;
   * past the bound it gets 503 with Retry-After. The app sets it from config (ohttpAdmitPerSecond) so the cache
   * cannot fill. Omitted, only the cache bounds admission.
   */
  admitPerSecond?: number;
  /** Largest Binary HTTP request, and largest plain (not chunked) answer, padding included. */
  maxMessageBytes: number;
  now?: () => number;
}

/** Encapsulated keys of accepted requests, each kept until its request's date leaves the window. */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  get size(): number {
    return this.#seen.size;
  }
  seen(key: string, now: number): boolean {
    const until = this.#seen.get(key);
    return until !== undefined && until >= now;
  }
  /** Records the key; false when the cache is full of live keys (the caller refuses the request). */
  remember(key: string, until: number, now: number): boolean {
    if (this.#seen.size >= this.#max) this.prune(now);
    if (this.#seen.size >= this.#max) return false;
    this.#seen.set(key, until);
    return true;
  }
  prune(now: number): void {
    for (const [k, until] of this.#seen) if (until < now) this.#seen.delete(k);
  }
}

type Refusal = { status: number; reason: string; retryAfter?: number };
type Encapsulate = (r: Response) => Promise<Response>;

export class OhttpGateway {
  readonly #identity: Identity;
  readonly #dispatch: OhttpGatewayOptions['dispatch'];
  readonly #maxSkewMs: number;
  readonly #maxMessageBytes: number;
  readonly #now: () => number;
  readonly #replays: ReplayGuard;
  readonly #admit?: RateLimiter;
  readonly keysBody: Uint8Array<ArrayBuffer>;
  #servers?: Promise<{ plain: OHTTPServer; chunked: ChunkedOHTTPServer }>;
  #inserts = 0;

  constructor(o: OhttpGatewayOptions) {
    this.#identity = o.identity;
    this.#dispatch = o.dispatch;
    this.#maxSkewMs = o.maxSkewMs;
    this.#maxMessageBytes = o.maxMessageBytes;
    this.#now = o.now ?? Date.now;
    this.#replays = new ReplayGuard(o.replayCacheMax);
    if (o.admitPerSecond !== undefined) this.#admit = new RateLimiter(o.admitPerSecond * 60, ohttpAdmitBurst(o.admitPerSecond));
    // application/ohttp-keys: each configuration with a two-byte length (RFC 9458 section 3.2).
    this.keysBody = KeyConfig.serializeMultiple([KeyConfig.parse(o.identity.keyConfig)]);
  }

  /** Remembered encapsulated keys (for tests and health). */
  get replayCacheSize(): number {
    return this.#replays.size;
  }

  #serversReady() {
    return (this.#servers ??= (async () => {
      const keyConfig = await importIdentityKey(this.#identity);
      return {
        plain: new OHTTPServer([keyConfig], { maxMessageSize: this.#maxMessageBytes }),
        // The library applies one limit to a chunked request and its answer. Answers get the chunked default;
        // openChunked holds requests to maxMessageBytes.
        chunked: new ChunkedOHTTPServer([keyConfig], { maxMessageSize: DEFAULT_MAX_CHUNKED_ANSWER_BYTES }),
      };
    })());
  }

  /** The /ohttp-keys answer. */
  keys(): Response {
    return new Response(this.keysBody, { status: 200, headers: { 'content-type': MediaType.KEYS, 'cache-control': 'no-cache' } });
  }

  /** POST /ohttp. Answers a refused outer request with a plain status and no body, as RFC 9458 asks. */
  async handle(outer: Request): Promise<Response> {
    const type = outer.headers.get('content-type')?.toLowerCase() ?? '';
    const chunked = type === MediaType.CHUNKED_REQUEST;
    if (!chunked && type !== MediaType.REQUEST) return this.#refuse({ status: 415, reason: 'content_type' });
    if (!outer.body) return this.#refuse({ status: 400, reason: 'empty' });

    // Requests are small and arrive whole (the client and the relay send bytes), so read the body first. The
    // bound leaves room for chunk framing and tags on top of the message limit.
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await readLimited(outer.body, this.#maxMessageBytes + Math.ceil(this.#maxMessageBytes / 1024) + 4096);
    } catch (e) {
      if (e instanceof TooLarge) return this.#refuse({ status: 413, reason: 'too_large' });
      return this.#refuse({ status: 400, reason: 'unreadable' });
    }
    if (bytes.length < HEADER_BYTES || ((bytes[1]! << 8) | bytes[2]!) !== KEM_X25519) return this.#refuse({ status: 400, reason: 'bad_header' });
    const replayKey = createHash('sha256').update(bytes.subarray(0, HEADER_BYTES)).digest('hex');
    if (this.#replays.seen(replayKey, this.#now())) return this.#refuse({ status: 400, reason: 'replay' });

    const servers = await this.#serversReady();
    let inner: Request;
    let encapsulate: Encapsulate;
    try {
      if (chunked) {
        const d = await openChunked(servers.chunked, bytes, this.#maxMessageBytes);
        inner = d.request;
        encapsulate = (r) => sealChunked(d.context, r);
      } else {
        const d = await servers.plain.decapsulateRequest(new Request(`${INNER_ORIGIN}/ohttp`, { method: 'POST', headers: { 'content-type': type }, body: bytes }));
        inner = d.request;
        encapsulate = (r) => d.context.encapsulateResponse(r);
      }
    } catch (e) {
      if (isOHTTPError(e)) return this.#refuse({ status: e.code === OHTTPErrorCode.MessageTooLarge ? 413 : 400, reason: e.code.toLowerCase() });
      throw e;
    }

    // Only now is the request known to be well formed: check its date, then that it is new.
    const now = this.#now();
    const date = Date.parse(inner.headers.get(OHTTP_DATE_HEADER) ?? inner.headers.get('date') ?? '');
    if (!Number.isFinite(date)) {
      return this.#answer(encapsulate, innerError(400, 'date_required', `an encapsulated request must carry ${OHTTP_DATE_HEADER} (or Date) with the time it was made`, now), 'date_required');
    }
    if (Math.abs(now - date) > this.#maxSkewMs) {
      const s = Math.round(this.#maxSkewMs / 1000);
      return this.#answer(encapsulate, innerError(400, STALE_REQUEST, `the request is dated more than ${s} s from this gateway's clock; resend it dated by ${OHTTP_DATE_HEADER} in this answer`, now), STALE_REQUEST);
    }
    // A request that would be refused runs nothing, so it is answered without taking a replay-cache slot:
    // only a request that will reach the app is remembered. Replaying a refused one gets the same refusal.
    const url = new URL(inner.url);
    if (!METHODS.has(inner.method)) return this.#answer(encapsulate, innerError(405, 'method_not_allowed', 'only GET and POST are available through Oblivious HTTP', now), 'method');
    if (!ohttpPathAllowed(url.pathname)) return this.#answer(encapsulate, innerError(404, 'not_found', `${url.pathname} is not available through Oblivious HTTP`, now), 'path');

    if (this.#replays.seen(replayKey, now)) return this.#refuse({ status: 400, reason: 'replay' });
    const wait = this.#admit?.take('ohttp', now) ?? 0;
    if (wait > 0) return this.#refuse({ status: 503, reason: 'busy', retryAfter: wait });
    // Kept until the request's date has left the window, plus the second an HTTP date rounds away.
    if (!this.#replays.remember(replayKey, date + this.#maxSkewMs + 1000, now)) return this.#refuse({ status: 503, reason: 'replay_cache_full' });
    if (++this.#inserts % 1024 === 0) this.#replays.prune(now);

    const headers = new Headers(inner.headers);
    for (const h of HOP_HEADERS) headers.delete(h);
    headers.delete(OHTTP_DATE_HEADER);
    headers.delete('date');
    const body = inner.method === 'GET' ? undefined : await inner.arrayBuffer();
    const req = new Request(INNER_ORIGIN + url.pathname + url.search, { method: inner.method, headers, body, signal: outer.signal });
    return this.#answer(encapsulate, await this.#dispatch(req));
  }

  async #answer(encapsulate: Encapsulate, res: Response, refused?: string): Promise<Response> {
    if (refused) log.info('ohttp_refused', { reason: refused });
    try {
      const out = await encapsulate(res);
      out.headers.set('cache-control', 'no-store');
      return out;
    } catch (e) {
      await res.body?.cancel().catch(() => {});
      log.warn('ohttp_answer_failed', { reason: isOHTTPError(e) ? e.code.toLowerCase() : errText(e) });
      return new Response(null, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
  }

  #refuse(r: Refusal): Response {
    log.info('ohttp_refused', { reason: r.reason });
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (r.retryAfter) headers['retry-after'] = String(r.retryAfter);
    return new Response(null, { status: r.status, headers });
  }
}

function innerError(status: number, code: string, message: string, now: number): Response {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status,
    headers: { 'content-type': 'application/json', [OHTTP_DATE_HEADER]: new Date(now).toUTCString() },
  });
}

/** The attested key pair as an ohttp-ts key configuration. The private key stays in this process. */
export async function importIdentityKey(identity: Identity): Promise<KeyConfigWithPrivate> {
  const pub = KeyConfig.parse(identity.keyConfig);
  const d = identity.hpkePrivateKey().export({ format: 'jwk' }).d;
  if (!d) throw new Error('HPKE private key export failed');
  const priv = new Uint8Array(Buffer.from(d, 'base64url'));
  try {
    return await KeyConfig.import(ohttpSuite(), pub.keyId, pub.publicKey, priv);
  } finally {
    priv.fill(0);
  }
}

const bhttpDecoder = new BHttpDecoder();
const bhttpEncoder = new BHttpEncoder();
const invalid = () => new OHTTPError(OHTTPErrorCode.InvalidMessage);

/**
 * Opens a whole chunked request: the header, then each framed chunk, the last one marked by length 0. Refuses
 * (MessageTooLarge) a request whose Binary HTTP is over maxRequestBytes.
 */
export async function openChunked(server: ChunkedOHTTPServer, bytes: Uint8Array, maxRequestBytes: number): Promise<{ request: Request; context: ChunkedServerRequestContext }> {
  const context = await server.createRequestContext(bytes.subarray(0, HEADER_BYTES));
  const parts: Uint8Array[] = [];
  let size = 0;
  const take = (p: Uint8Array) => {
    size += p.length;
    if (size > maxRequestBytes) throw new OHTTPError(OHTTPErrorCode.MessageTooLarge);
    parts.push(p);
  };
  let off = HEADER_BYTES;
  for (;;) {
    const v = decodeVli(bytes, off);
    if (!v) throw invalid();
    off += v.bytesRead;
    if (v.value === 0) {
      take(await context.openFinalChunk(bytes.subarray(off)));
      break;
    }
    if (off + v.value > bytes.length) throw invalid();
    take(await context.openChunk(bytes.subarray(off, off + v.value)));
    off += v.value;
  }
  try {
    return { request: bhttpDecoder.decodeRequest(concat(parts)), context };
  } catch {
    throw invalid();
  }
}

/**
 * Seals a response as chunked OHTTP: the response nonce, then each piece of the Binary HTTP stream as soon
 * as the app writes it (pieces that arrive together are sealed together, never more than 16 KiB), then an
 * empty final chunk. Padding goes at the end of the message. The answer is Bellows' own, so its only bound is
 * what the client accepts (DEFAULT_MAX_CHUNKED_ANSWER_BYTES); the request limit does not apply to it.
 */
export async function sealChunked(context: ChunkedServerRequestContext, res: Response, maxAnswerBytes: number = DEFAULT_MAX_CHUNKED_ANSWER_BYTES): Promise<Response> {
  const rc = await context.createResponseContext();
  const src = bhttpEncoder.encodeResponseStream(res, { padding: PADDING, maxMessageSize: maxAnswerBytes }).getReader();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let ended = false;
  const read = () => (pending ??= src.read());
  const TICK = Symbol('tick');
  const tick = () => new Promise<typeof TICK>((r) => setTimeout(() => r(TICK), 0));

  /** The next piece: one read, plus whatever else is already waiting, up to one chunk. null at the end. */
  const nextPiece = async (): Promise<Uint8Array | null> => {
    if (ended) return null;
    const first = await read();
    pending = undefined;
    if (first.done) return null;
    const parts = [first.value];
    let size = first.value.length;
    while (size < MAX_CHUNK) {
      const r = await Promise.race([read(), tick()]);
      if (r === TICK) break;
      pending = undefined;
      if (r.done) {
        ended = true;
        break;
      }
      parts.push(r.value);
      size += r.value.length;
    }
    return concat(parts);
  };
  const frame = (ct: Uint8Array, final: boolean) => concat([encodeVli(final ? 0 : ct.length), ct]);

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(rc.responseNonce);
    },
    async pull(c) {
      try {
        const piece = await nextPiece();
        if (piece === null) {
          c.enqueue(frame(await rc.sealFinalChunk(new Uint8Array(0)), true));
          c.close();
          return;
        }
        for (let o = 0; o < piece.length; o += MAX_CHUNK) {
          const part = piece.subarray(o, o + MAX_CHUNK);
          if (part.length) c.enqueue(frame(await rc.sealChunk(part), false));
        }
      } catch (e) {
        await src.cancel(e).catch(() => {});
        c.error(e instanceof MessageLimitExceededError ? new OHTTPError(OHTTPErrorCode.MessageTooLarge) : e);
      }
    },
    cancel(reason) {
      return src.cancel(reason);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': MediaType.CHUNKED_RESPONSE } });
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
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
  return concat(parts);
}
