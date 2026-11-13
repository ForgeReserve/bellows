/**
 * The small part of Nostr (NIP-01) the operator list needs: event ids, BIP-340 signatures, and reading and
 * publishing events on relays over WebSocket. Web APIs and audited pure-JS crypto only, so it runs in
 * browsers and in Node 22+.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8Encode } from './bytes.ts';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Pick<NostrEvent, 'created_at' | 'kind' | 'tags' | 'content'>;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** True when `ev` has the NIP-01 event shape. Says nothing about the signature. */
export function isEventShape(ev: unknown): ev is NostrEvent {
  if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) return false;
  const e = ev as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    HEX64.test(e.id) &&
    typeof e.pubkey === 'string' &&
    HEX64.test(e.pubkey) &&
    typeof e.sig === 'string' &&
    HEX128.test(e.sig) &&
    Number.isSafeInteger(e.created_at) &&
    (e.created_at as number) >= 0 &&
    Number.isSafeInteger(e.kind) &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  );
}

/** NIP-01: SHA-256 of [0, pubkey, created_at, kind, tags, content] serialized as JSON, hex. */
export function eventId(e: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>): string {
  return toHex(sha256(utf8Encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

/** The x-only public key (hex) of a 32-byte secret key. */
export function publicKeyOf(secretKey: Uint8Array): string {
  return toHex(schnorr.getPublicKey(secretKey));
}

/** Signs an event with a 32-byte secret key (BIP-340). */
export function signEvent(t: UnsignedEvent, secretKey: Uint8Array): NostrEvent {
  const pubkey = publicKeyOf(secretKey);
  const tags = t.tags.map((x) => [...x]);
  const id = eventId({ pubkey, created_at: t.created_at, kind: t.kind, tags, content: t.content });
  const sig = toHex(schnorr.sign(fromHex(id), secretKey));
  return { id, pubkey, created_at: t.created_at, kind: t.kind, tags, content: t.content, sig };
}

/** True only for a well-formed event whose id matches its content and whose signature is valid. Never throws. */
export function verifyEvent(ev: unknown): ev is NostrEvent {
  try {
    if (!isEventShape(ev)) return false;
    if (eventId(ev) !== ev.id) return false;
    return schnorr.verify(fromHex(ev.sig), fromHex(ev.id), fromHex(ev.pubkey));
  } catch {
    return false;
  }
}

// ── relays ─────────────────────────────────────────────────────────────────

/** The part of a WebSocket used here (browsers and Node 22+ alike). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}

/** Opens a connected socket to a Nostr relay, or throws. */
export type SocketConnect = (relay: string) => Promise<SocketLike>;

/** The global WebSocket, resolved once open. */
export const webSocketConnect: SocketConnect = (relay) =>
  new Promise((resolve, reject) => {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike & { addEventListener(type: 'open', fn: () => void): void } }).WebSocket;
    if (!Ctor) {
      reject(new Error('no WebSocket in this runtime'));
      return;
    }
    let ws: SocketLike & { addEventListener(type: 'open', fn: () => void): void };
    try {
      ws = new Ctor(relay);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error(`could not connect to ${relay}`)));
    ws.addEventListener('close', () => reject(new Error(`${relay} closed the connection`)));
  });

export interface RelayOptions {
  connect?: SocketConnect;
  /** Per relay, in ms (default 6000). */
  timeoutMs?: number;
}

/** Largest relay frame read; a bigger one is ignored. */
const MAX_FRAME = 256 * 1024;
/** Most events kept from one relay. */
const MAX_EVENTS_PER_RELAY = 1000;

const closeQuietly = (ws: SocketLike | undefined) => {
  try {
    ws?.close(1000, 'done');
  } catch {
    /* already gone */
  }
};

/** Opens a socket, gives it to `run`, and always closes it. `run` resolves when it is done; the timeout ends it early. */
function withSocket<T>(relay: string, opts: RelayOptions, onTimeout: () => T, run: (ws: SocketLike, finish: (v: T) => void) => void): Promise<T> {
  const connect = opts.connect ?? webSocketConnect;
  return new Promise<T>((resolve) => {
    let done = false;
    let socket: SocketLike | undefined;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeQuietly(socket);
      resolve(v);
    };
    const timer = setTimeout(() => finish(onTimeout()), opts.timeoutMs ?? 6000);
    connect(relay).then(
      (ws) => {
        socket = ws;
        if (done) {
          closeQuietly(ws);
          return;
        }
        ws.addEventListener('close', () => finish(onTimeout()));
        ws.addEventListener('error', () => finish(onTimeout()));
        run(ws, finish);
      },
      () => finish(onTimeout()),
    );
  });
}

/**
 * Reads the events matching `filters` from each relay (REQ until EOSE, CLOSED or the timeout) and returns
 * them all, each event id once. Events are returned unverified; the caller checks each one. Never throws.
 */
export async function queryRelays(relays: readonly string[], filters: readonly Record<string, unknown>[], opts: RelayOptions = {}): Promise<unknown[]> {
  const perRelay = await Promise.all(
    relays.map((relay) => {
      const events: unknown[] = [];
      const subId = `bellows-${Math.random().toString(36).slice(2, 10)}`;
      return withSocket<unknown[]>(
        relay,
        opts,
        () => events,
        (ws, finish) => {
          ws.addEventListener('message', (e) => {
            if (typeof e.data !== 'string' || e.data.length > MAX_FRAME) return;
            let msg: unknown;
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            if (!Array.isArray(msg) || msg[1] !== subId) return;
            if (msg[0] === 'EVENT') {
              events.push(msg[2]);
              if (events.length >= MAX_EVENTS_PER_RELAY) finish(events);
            } else if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') {
              try {
                ws.send(JSON.stringify(['CLOSE', subId]));
              } catch {
                /* closing anyway */
              }
              finish(events);
            }
          });
          ws.send(JSON.stringify(['REQ', subId, ...filters]));
        },
      );
    }),
  );
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const ev of perRelay.flat()) {
    const id = (ev as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(ev);
  }
  return out;
}

export interface PublishResult {
  relay: string;
  /** True when the relay answered OK true for this event. */
  ok: boolean;
  /** The relay's message, or why there was no answer. */
  message: string;
}

/** Sends the event to each relay and waits for its OK (NIP-01). Never throws. */
export function publishEvent(relays: readonly string[], event: NostrEvent, opts: RelayOptions = {}): Promise<PublishResult[]> {
  return Promise.all(
    relays.map((relay) =>
      withSocket<PublishResult>(
        relay,
        opts,
        () => ({ relay, ok: false, message: 'no answer from the relay' }),
        (ws, finish) => {
          ws.addEventListener('message', (e) => {
            if (typeof e.data !== 'string' || e.data.length > MAX_FRAME) return;
            let msg: unknown;
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
              finish({ relay, ok: msg[2] === true, message: typeof msg[3] === 'string' ? msg[3] : '' });
            }
          });
          ws.send(JSON.stringify(['EVENT', event]));
        },
      ),
    ),
  );
}
