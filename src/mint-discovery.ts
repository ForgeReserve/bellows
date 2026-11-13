/**
 * NIP-87 discovery of other Cashu mints whose eCash the gateway accepts for funding, the way
 * wallet.cashu.me finds mints: kind 38172 mint announcements and kind 38000 reviews (#k=38172) from
 * public relays, grouped by mint URL. A discovered mint is accepted only with at least `minReviewers`
 * distinct verified reviewers (and, when requireAnnouncement is set, its own verified announcement), and only after it passes the probe below
 * (an active keyset in a unit the gateway uses and NUT-05 bolt11 melt in that unit, since the gateway melts there).
 *
 * Ported from cashucard/cashucard ops/src/discovery.ts @ b5ffe8a: the event
 * validation limits, signature checks, review age window, relay caps, candidate ranking and the
 * last-good snapshot with TTLs are kept. Node changes: storage is the sqlite `meta` table (read
 * synchronously at construction, so the first request after a restart serves the stored set),
 * a timer drives refreshes in place of a request kicking ctx.waitUntil, the reviewer floor and caps
 * are settings, and the probe also requires NUT-05 bolt11 melt.
 *
 * A request never waits on a relay: snapshot() returns the last-good set synchronously and, once
 * that set is past its TTL, starts one background refresh.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { DB } from './db.ts';

/** The relays wallet.cashu.me reads (cashubtc/cashu.me mintRecommendations.ts). */
export const DISCOVERY_RELAYS: readonly string[] = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export const MIN_CANDIDATES = 15;
export const DISCOVERY_TTL_FAIL_MS = 60_000;
export const PROBE_POOL = 3;
export const PROBE_TIMEOUT_MS = 5000;
export const STORAGE_KEY = 'mint-discovery';

const MINT_ANNOUNCEMENT = 38172;
const RECOMMENDATION = 38000;
const FUTURE_SLACK_S = 600;
const REVIEW_MAX_AGE_S = 730 * 86_400; // 24 months
const MAX_URL_TAGS = 5;
const MAX_URLS = 2000;
const MAX_FRAME = 256 * 1024;
const MAX_EVENTS_PER_RELAY = 2000;
/** Retained event JSON per relay. */
const MAX_BYTES_PER_RELAY = 2 * 1024 * 1024;
/** A NIP-87 event is small; a bigger one is dropped before it is kept. */
const MAX_CONTENT = 4096;
const MAX_TAGS = 64;
const RELAY_TIMEOUT_MS = 6000;
const RELAY_DEADLINE_MS = 8000;
/** The longest mint name passed on. */
export const MINT_NAME_MAX = 40;
/** Rejected candidates kept for the admin view. */
const MAX_REJECTED = 50;

export interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function isEventShape(ev: unknown): ev is NostrEvent {
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
    Number.isSafeInteger(e.kind) &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  );
}

/** NIP-01: sha256 of the canonical array, as hex. */
function computeId(ev: NostrEvent): string {
  const canonical = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/** NIP-01: the id is sha256 of the canonical array; the sig is BIP-340. Never throws. */
export function verifyEvent(ev: unknown): ev is NostrEvent {
  try {
    if (!isEventShape(ev)) return false;
    if (computeId(ev) !== ev.id) return false;
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

// ── URLs and names ───────────────────────────────────────────────────────

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.onion'];

/**
 * The one shape a discovered mint URL may take: https, at most 200 characters, no userinfo, query or
 * fragment, port 443 or none, a dotted DNS name that is not an IP literal (URL canonicalises decimal
 * and hex IPv4 forms, so they are caught too) or an internal name. The host is lowercased and one
 * trailing slash is dropped. Returns undefined otherwise.
 *
 * allowInsecure (tests only, BELLOWS_FOREIGN_ALLOW_INSECURE) also takes http, ports, IPs and local names,
 * so a stored test snapshot can name a mint on 127.0.0.1. Relay events are always read strictly.
 */
export function normalizeDiscoveryUrl(raw: unknown, allowInsecure = false): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return undefined;
  if (raw.includes('?') || raw.includes('#') || /\s/.test(raw)) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.username || u.password || u.search || u.hash) return undefined;
  let path = u.pathname;
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path.endsWith('/')) return undefined;
  if (allowInsecure) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const out = `${u.protocol}//${u.host.toLowerCase()}${path}`;
    return out.length > 200 ? undefined : out;
  }
  if (u.protocol !== 'https:') return undefined;
  if (u.port !== '') return undefined; // URL drops an explicit :443
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || host.startsWith('[')) return undefined;
  if (/^[\d.]+$/.test(host)) return undefined;
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return undefined;
  const out = `https://${host}${path}`;
  return out.length > 200 ? undefined : out;
}

/**
 * A mint's self-reported name is untrusted text: drop C0/C1 controls (which include newlines), line
 * and paragraph separators and the bidi embedding, override and isolate controls, trim, and cut to
 * MINT_NAME_MAX code points. Returns undefined when nothing printable is left.
 */
export function sanitizeMintName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const name = Array.from(cleaned).slice(0, MINT_NAME_MAX).join('').trim();
  return name === '' ? undefined : name;
}

// ── grouping ─────────────────────────────────────────────────────────────

export interface MintEvidence {
  announced: boolean;
  readonly reviewers: Set<string>;
  /** Latest review per reviewer that carries a "[n/5]" rating. */
  readonly ratings: Map<string, { at: number; rating: number }>;
}

function tagValues(ev: NostrEvent, name: string): string[] {
  return ev.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]!);
}

/** A NIP-87 review's rating, from its content ("[4/5] text") or a `rating` tag. */
function ratingOf(ev: NostrEvent): number | undefined {
  const m = /^\s*\[([0-5])\/5\]/.exec(ev.content);
  if (m) return Number(m[1]);
  const t = tagValues(ev, 'rating')[0];
  const n = t === undefined ? NaN : Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : undefined;
}

/**
 * Group NIP-87 events by normalized mint URL. Pure apart from the signature check. Cheap filters run
 * before verification, so a malformed, stale or off-topic event costs no curve work. A copy whose
 * content does not hash to its id is dropped before it can be remembered, and the rest are
 * deduplicated on id and sig together: the id fixes the content, so equal keys are the same event and
 * need one signature check, while one relay's altered or bad-sig copy of an id never shadows the
 * genuine copy another relay returns.
 */
export function parseNip87(events: readonly unknown[], nowMs: number, verify: (ev: unknown) => ev is NostrEvent = verifyEvent): Map<string, MintEvidence> {
  const nowS = Math.floor(nowMs / 1000);
  const out = new Map<string, MintEvidence>();
  const seen = new Set<string>();
  for (const raw of events) {
    if (!isEventShape(raw)) continue;
    const ev = raw;
    const copy = `${ev.id}:${ev.sig}`;
    if (seen.has(copy)) continue;
    if (ev.created_at > nowS + FUTURE_SLACK_S) continue;
    let review: boolean;
    if (ev.kind === MINT_ANNOUNCEMENT) {
      if (tagValues(ev, 'n').some((n) => n !== 'mainnet')) continue;
      review = false;
    } else if (ev.kind === RECOMMENDATION) {
      if (!tagValues(ev, 'k').includes(String(MINT_ANNOUNCEMENT))) continue;
      if (ev.created_at < nowS - REVIEW_MAX_AGE_S) continue;
      review = true;
    } else continue;
    const urls = new Set<string>();
    for (const u of tagValues(ev, 'u').slice(0, MAX_URL_TAGS)) {
      const n = normalizeDiscoveryUrl(u);
      if (n) urls.add(n);
    }
    if (urls.size === 0) continue;
    try {
      if (computeId(ev) !== ev.id) continue;
    } catch {
      continue;
    }
    seen.add(copy);
    if (!verify(ev)) continue;
    const rating = review ? ratingOf(ev) : undefined;
    for (const url of urls) {
      let entry = out.get(url);
      if (!entry) {
        if (out.size >= MAX_URLS) continue;
        entry = { announced: false, reviewers: new Set(), ratings: new Map() };
        out.set(url, entry);
      }
      if (review) {
        entry.reviewers.add(ev.pubkey);
        const prev = entry.ratings.get(ev.pubkey);
        if (rating !== undefined && (!prev || prev.at < ev.created_at)) entry.ratings.set(ev.pubkey, { at: ev.created_at, rating });
      } else entry.announced = true;
    }
  }
  return out;
}

function averageRating(e: MintEvidence): number | undefined {
  if (e.ratings.size === 0) return undefined;
  let sum = 0;
  for (const r of e.ratings.values()) sum += r.rating;
  return Math.round((sum / e.ratings.size) * 10) / 10;
}

// ── relay transport ──────────────────────────────────────────────────────

/** The part of a WebSocket the query uses (DOM and Node 22+ alike). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}

/** Opens an already-connected socket, or throws. */
export type SocketConnect = (relay: string) => Promise<SocketLike>;

export interface RelayAnswer {
  /** True when the relay sent EOSE, CLOSED or at least one event. */
  readonly answered: boolean;
  readonly events: readonly unknown[];
}

/** Queries one relay for the NIP-87 events. Never throws. */
export type RelayQuery = (relay: string) => Promise<RelayAnswer>;

export const NIP87_FILTERS = [
  { kinds: [MINT_ANNOUNCEMENT], limit: 500 },
  { kinds: [RECOMMENDATION], '#k': [String(MINT_ANNOUNCEMENT)], limit: 500 },
] as const;

/** Node 22+: the global WebSocket, resolved once open. */
export const globalSocketConnect: SocketConnect = (relay) =>
  new Promise((resolve, reject) => {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => SocketLike & { addEventListener(type: 'open', fn: () => void): void } }).WebSocket;
    if (!Ctor) {
      reject(new Error('no WebSocket'));
      return;
    }
    const ws = new Ctor(relay);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('socket error')));
    ws.addEventListener('close', () => reject(new Error('socket closed')));
  });

export function createRelayQuery(connect: SocketConnect = globalSocketConnect, timeoutMs = RELAY_TIMEOUT_MS): RelayQuery {
  return (relay) =>
    new Promise<RelayAnswer>((resolve) => {
      const subId = `nip87-${Math.random().toString(36).slice(2, 10)}`;
      const events: unknown[] = [];
      let bytes = 0;
      let answered = false;
      let done = false;
      let socket: SocketLike | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (socket) {
          try {
            socket.send(JSON.stringify(['CLOSE', subId]));
          } catch {
            /* the socket may already be gone */
          }
          try {
            socket.close(1000, 'done');
          } catch {
            /* ignore */
          }
        }
        resolve({ answered: answered || events.length > 0, events });
      };
      const timer = setTimeout(finish, timeoutMs);
      connect(relay).then(
        (ws) => {
          socket = ws;
          if (done) {
            try {
              ws.close(1000, 'done'); // too late; close what opened
            } catch {
              /* ignore */
            }
            return;
          }
          ws.addEventListener('message', (e) => {
            if (done) return;
            if (typeof e.data !== 'string' || e.data.length > MAX_FRAME) return;
            // Every frame counts, kept or not: a flood ends the query early.
            bytes += e.data.length;
            if (bytes > MAX_BYTES_PER_RELAY) {
              finish();
              return;
            }
            let msg: unknown;
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            if (!Array.isArray(msg) || msg[1] !== subId) return;
            if (msg[0] === 'EVENT') {
              const ev = msg[2] as { content?: unknown; tags?: unknown } | null;
              if (typeof ev !== 'object' || ev === null || typeof ev.content !== 'string' || ev.content.length > MAX_CONTENT || !Array.isArray(ev.tags) || ev.tags.length > MAX_TAGS) return;
              events.push(ev);
              if (events.length >= MAX_EVENTS_PER_RELAY) finish();
            } else if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') {
              answered = true;
              finish();
            }
          });
          ws.addEventListener('close', finish);
          ws.addEventListener('error', finish);
          try {
            ws.send(JSON.stringify(['REQ', subId, ...NIP87_FILTERS]));
          } catch {
            finish();
          }
        },
        () => finish(),
      );
    });
}

// ── probe ────────────────────────────────────────────────────────────────

export interface MintProbe {
  readonly url: string;
  readonly ok: boolean;
  /** A status code or an error name; never a response body. */
  readonly reason?: string;
  /** The mint's `/v1/info` name, sanitized; untrusted. */
  readonly name?: string;
  /** Units with an active keyset and NUT-05 bolt11 melt. */
  readonly units?: readonly string[];
}

export type FetchFn = (input: string, init?: { signal?: AbortSignal; redirect?: 'manual' }) => Promise<Response>;

/** The body as text, or undefined once it passes maxBytes (then cancelled). */
async function readCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function getJson(fetchFn: FetchFn, url: string, timeoutMs: number, maxBytes = 65536): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (res.status !== 200) {
      await (res.body ? res.body.cancel() : res.text()).catch(() => {});
      return { ok: false, reason: `http ${res.status}` };
    }
    // A mint document is a few KB: a declared oversize body is refused unread, an undeclared one is
    // read as a stream and cancelled the moment it passes the cap.
    const declared = Number(res.headers?.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await (res.body ? res.body.cancel() : Promise.resolve()).catch(() => {});
      return { ok: false, reason: 'too large' };
    }
    const text = await readCapped(res, maxBytes);
    if (text === undefined || text.length > maxBytes) return { ok: false, reason: 'too large' };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, reason: 'not json' };
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name ? e.name : 'fetch failed' };
  }
}

/**
 * Probe one mint: `/v1/info` must be a JSON object and `/v1/keysets` a non-empty `keysets` array, both
 * a plain 200 of at most 64 KiB (redirects are not followed). At least one of `units` must have an
 * active keyset and an enabled NUT-05 bolt11 melt method, since the gateway melts the eCash there. Never throws.
 */
export async function probeMint(url: string, units: readonly string[], fetchFn: FetchFn = (i, init) => fetch(i, init), timeoutMs = PROBE_TIMEOUT_MS): Promise<MintProbe> {
  const [info, keysets] = await Promise.all([getJson(fetchFn, `${url}/v1/info`, timeoutMs), getJson(fetchFn, `${url}/v1/keysets`, timeoutMs)]);
  if (!info.ok) return { url, ok: false, reason: `info: ${info.reason}` };
  if (typeof info.body !== 'object' || info.body === null || Array.isArray(info.body)) return { url, ok: false, reason: 'info: not an object' };
  if (!keysets.ok) return { url, ok: false, reason: `keysets: ${keysets.reason}` };
  const list = (keysets.body as { keysets?: unknown } | null)?.keysets;
  if (!Array.isArray(list) || list.length === 0) return { url, ok: false, reason: 'keysets: empty' };
  const active = new Set(
    list
      .filter((k) => typeof k === 'object' && k !== null && (k as { active?: unknown }).active !== false)
      .map((k) => (k as { unit?: unknown }).unit)
      .filter((u): u is string => typeof u === 'string' && units.includes(u)),
  );
  if (active.size === 0) return { url, ok: false, reason: `keysets: no active ${units.join('/')}` };
  const nut5 = (info.body as { nuts?: Record<string, unknown> }).nuts?.['5'] as { disabled?: unknown; methods?: unknown } | undefined;
  if (!nut5 || nut5.disabled === true || !Array.isArray(nut5.methods)) return { url, ok: false, reason: 'info: no NUT-05 melt' };
  const melt = new Set(
    nut5.methods
      .filter((m) => typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'bolt11')
      .map((m) => (m as { unit?: unknown }).unit)
      .filter((u): u is string => typeof u === 'string'),
  );
  const ok = [...active].filter((u) => melt.has(u)).sort();
  if (ok.length === 0) return { url, ok: false, reason: 'info: no bolt11 melt in an active unit' };
  const name = sanitizeMintName((info.body as { name?: unknown }).name);
  return name === undefined ? { url, ok: true, units: ok } : { url, ok: true, units: ok, name };
}

// ── discovery ────────────────────────────────────────────────────────────

export interface DiscoveredMint {
  readonly url: string;
  readonly reviewers: number;
  readonly name?: string;
  readonly avg_rating?: number;
  readonly units: readonly string[];
  readonly probed_at: number;
}

export interface RejectedMint {
  readonly url: string;
  readonly reviewers: number;
  readonly reason: string;
}

export interface DiscoveryDeps {
  readonly query: RelayQuery;
  readonly relays: readonly string[];
  readonly minReviewers: number;
  /** Also require the mint's own verified announcement (kind 38172). Off by default: reviews only. */
  readonly requireAnnouncement?: boolean;
  readonly maxDiscovered: number;
  /** Units a mint must support (BELLOWS_UNITS). */
  readonly units: readonly string[];
  /** URLs never offered as discovered (the gateway's own mints, the deny list). */
  readonly excluded?: readonly string[];
  readonly probe?: (url: string) => Promise<MintProbe>;
  readonly now?: () => number;
  readonly log?: (msg: string, fields?: Record<string, string | number | boolean>) => void;
}

export interface DiscoveryResult {
  /** False when no relay answered: the caller keeps its old set. */
  readonly answered: boolean;
  readonly mints: readonly DiscoveredMint[];
  readonly relays: readonly { relay: string; answered: boolean; events: number }[];
  /** Announced mints with at least one reviewer that were not accepted, and why. */
  readonly rejected: readonly RejectedMint[];
  /** Mints with a verified announcement or review (all of them, before any rule). */
  readonly seen: number;
  readonly candidates: number;
}

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function normalizedSet(list: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const n = normalizeDiscoveryUrl(raw);
    if (n) out.add(n);
  }
  return out;
}

/** Ranks the grouped evidence the way the refresh does: reviewers desc, then URL. */
export function rankCandidates(map: Map<string, MintEvidence>, minReviewers: number, excluded: Set<string> = new Set(), requireAnnouncement = true) {
  return [...map]
    .filter(([url, e]) => (e.announced || !requireAnnouncement) && e.reviewers.size >= minReviewers && !excluded.has(url))
    .map(([url, e]) => {
      const avg = averageRating(e);
      return avg === undefined ? { url, reviewers: e.reviewers.size } : { url, reviewers: e.reviewers.size, avg_rating: avg };
    })
    .sort((a, b) => (b.reviewers !== a.reviewers ? b.reviewers - a.reviewers : a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** Fetches every relay's NIP-87 events, merged. */
export async function fetchNip87(query: RelayQuery, relays: readonly string[]): Promise<{ answered: boolean; events: unknown[]; relays: { relay: string; answered: boolean; events: number }[] }> {
  const answers = await withDeadline(Promise.allSettled(relays.map((r) => query(r))), RELAY_DEADLINE_MS, [] as PromiseSettledResult<RelayAnswer>[]);
  const events: unknown[] = [];
  let answered = false;
  const report = relays.map((relay, i) => {
    const a = answers[i];
    if (a?.status === 'fulfilled' && a.value.answered) {
      answered = true;
      events.push(...a.value.events);
      return { relay, answered: true, events: a.value.events.length };
    }
    return { relay, answered: false, events: 0 };
  });
  return { answered, events, relays: report };
}

/** The single refresh path. Never throws. */
export async function discoverMints(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const probe = deps.probe ?? ((url: string) => probeMint(url, deps.units));
  const fetched = await fetchNip87(deps.query, deps.relays);
  for (const r of fetched.relays) if (!r.answered) log('mint_discovery_relay_silent', { relay: r.relay });
  if (!fetched.answered) return { answered: false, mints: [], relays: fetched.relays, rejected: [], seen: 0, candidates: 0 };

  const excluded = normalizedSet(deps.excluded);
  const requireAnn = deps.requireAnnouncement ?? true;
  const map = parseNip87(fetched.events, now());
  const rejected: RejectedMint[] = [];
  const reject = (r: RejectedMint) => {
    if (rejected.length < MAX_REJECTED) rejected.push(r);
  };
  // Announced but under the floor, best first: the ones an operator might want to know about.
  for (const [url, e] of [...map].filter(([, e]) => (e.announced || !requireAnn) && e.reviewers.size > 0 && e.reviewers.size < deps.minReviewers).sort((a, b) => b[1].reviewers.size - a[1].reviewers.size)) {
    reject({ url, reviewers: e.reviewers.size, reason: `${e.reviewers.size} of ${deps.minReviewers} reviewers` });
  }
  const maxCandidates = Math.max(MIN_CANDIDATES, Math.ceil(deps.maxDiscovered * 1.5));
  const ranked = rankCandidates(map, deps.minReviewers, excluded, requireAnn).slice(0, maxCandidates);

  const results: (MintProbe | undefined)[] = new Array(ranked.length);
  let next = 0;
  const worker = async () => {
    while (next < ranked.length) {
      const i = next++;
      try {
        results[i] = await probe(ranked[i]!.url);
      } catch {
        results[i] = { url: ranked[i]!.url, ok: false, reason: 'probe threw' };
      }
    }
  };
  await Promise.all(Array.from({ length: PROBE_POOL }, worker));

  const mints: DiscoveredMint[] = [];
  const at = now();
  ranked.forEach((c, i) => {
    const r = results[i];
    if (!r || !r.ok) {
      reject({ url: c.url, reviewers: c.reviewers, reason: `probe: ${r?.reason ?? 'not probed'}` });
      log('mint_discovery_dropped', { url: c.url, reason: r?.reason ?? 'not probed' });
      return;
    }
    if (mints.length >= deps.maxDiscovered) {
      reject({ url: c.url, reviewers: c.reviewers, reason: 'over the list cap' });
      return;
    }
    mints.push({ ...c, ...(r.name ? { name: r.name } : {}), units: r.units ?? [], probed_at: at });
  });
  return { answered: true, mints, relays: fetched.relays, rejected, seen: map.size, candidates: ranked.length };
}

// ── the cached set ───────────────────────────────────────────────────────

/** Durable storage for the last-good set. Synchronous: node:sqlite. */
export interface DiscoveryStore {
  load(): unknown;
  save(value: unknown): void;
}

export function sqliteStore(db: DB, key = STORAGE_KEY): DiscoveryStore {
  return {
    load() {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    },
    save(value) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    },
  };
}

interface Stored {
  readonly v: 1;
  readonly at: number;
  readonly mints: readonly DiscoveredMint[];
}

/** Re-validates a stored snapshot; anything unexpected is discarded. */
export function parseStored(raw: unknown, maxDiscovered: number, allowInsecure = false): Stored | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const s = raw as { v?: unknown; at?: unknown; mints?: unknown };
  if (s.v !== 1 || !Number.isSafeInteger(s.at) || !Array.isArray(s.mints)) return undefined;
  const mints: DiscoveredMint[] = [];
  for (const m of s.mints.slice(0, maxDiscovered)) {
    if (typeof m !== 'object' || m === null) return undefined;
    const { url, reviewers, name, avg_rating, units, probed_at } = m as Record<string, unknown>;
    if (typeof url !== 'string' || normalizeDiscoveryUrl(url, allowInsecure) !== url) return undefined;
    if (!Number.isSafeInteger(reviewers) || (reviewers as number) < 0) return undefined;
    if (!Number.isSafeInteger(probed_at)) return undefined;
    if (!Array.isArray(units) || !units.every((u) => typeof u === 'string' && u.length <= 16)) return undefined;
    if (avg_rating !== undefined && (typeof avg_rating !== 'number' || !(avg_rating >= 0 && avg_rating <= 5))) return undefined;
    const clean = sanitizeMintName(name);
    if (name !== undefined && clean !== name) return undefined;
    mints.push({
      url,
      reviewers: reviewers as number,
      ...(clean ? { name: clean } : {}),
      ...(avg_rating !== undefined ? { avg_rating: avg_rating as number } : {}),
      units: units as string[],
      probed_at: probed_at as number,
    });
  }
  return { v: 1, at: s.at as number, mints };
}

export interface DiscoveryOptions extends DiscoveryDeps {
  readonly store?: DiscoveryStore;
  readonly ttlOkMs: number;
  readonly ttlFailMs?: number;
  /** Tests only: a stored snapshot may name http and loopback mints. */
  readonly allowInsecure?: boolean;
}

export interface DiscoveryStatus {
  readonly enabled: boolean;
  readonly relays: readonly string[];
  readonly min_reviewers: number;
  readonly max_discovered: number;
  readonly ttl_minutes: number;
  /** When the served set was fetched (ms), or null. */
  readonly updated_at: number | null;
  /** When the next background refresh is due (ms). */
  readonly next_refresh_at: number | null;
  readonly refreshing: boolean;
  readonly mints: readonly DiscoveredMint[];
  readonly last_refresh: {
    readonly at: number;
    readonly ok: boolean;
    readonly error?: string;
    readonly relays: DiscoveryResult['relays'];
    readonly seen: number;
    readonly candidates: number;
    readonly accepted: number;
    readonly rejected: readonly RejectedMint[];
  } | null;
}

export interface MintDiscovery {
  /** The last-good set, now; starts a coalesced background refresh when stale. */
  snapshot(): readonly DiscoveredMint[];
  /** Runs a refresh now (admin and tests), coalesced with one in flight. Never throws. */
  refresh(): Promise<void>;
  /** Refreshes once now if the stored set is missing or stale, then keeps it fresh on a timer. */
  start(): void;
  stop(): void;
  /** When the served set was fetched (ms), or null. */
  updatedAt(): number | null;
  status(): DiscoveryStatus;
  readonly enabled: boolean;
}

export function createDiscovery(options: DiscoveryOptions): MintDiscovery {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const ttlOkMs = options.ttlOkMs;
  const ttlFailMs = options.ttlFailMs ?? DISCOVERY_TTL_FAIL_MS;
  const enabled = options.relays.length > 0;
  let mints: readonly DiscoveredMint[] = [];
  let until = 0;
  let committedAt: number | null = null;
  let started = 0;
  let committed = 0;
  let inFlight: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let last: DiscoveryStatus['last_refresh'] = null;

  // node:sqlite is synchronous, so the stored set is served from the first request on.
  if (options.store) {
    try {
      const stored = parseStored(options.store.load(), options.maxDiscovered, options.allowInsecure);
      if (stored) {
        mints = stored.mints;
        committedAt = stored.at;
        until = stored.at + ttlOkMs;
      }
    } catch (e) {
      log('mint_discovery_store_unreadable', { err: (e as Error)?.name ?? 'error' });
    }
  }

  async function run(): Promise<void> {
    const gen = ++started;
    try {
      const result = await discoverMints({ ...options, log, now });
      const at = now();
      last = {
        at,
        ok: result.answered,
        ...(result.answered ? {} : { error: 'no relay answered' }),
        relays: result.relays,
        seen: result.seen,
        candidates: result.candidates,
        accepted: result.mints.length,
        rejected: result.rejected,
      };
      if (!result.answered) {
        // A failure never supersedes: an older refresh that still answers may land after this one.
        if (gen >= committed) until = at + ttlFailMs;
        log('mint_discovery_failed', { reason: 'no relay answered' });
        return;
      }
      if (gen < committed) return; // a newer answer already landed
      committed = gen;
      mints = result.mints;
      committedAt = at;
      until = at + ttlOkMs;
      log('mint_discovery_refreshed', { accepted: result.mints.length, candidates: result.candidates, seen: result.seen });
      try {
        options.store?.save({ v: 1, at, mints: result.mints } satisfies Stored);
      } catch (e) {
        log('mint_discovery_store_failed', { err: (e as Error)?.name ?? 'error' });
      }
    } catch (e) {
      if (gen >= committed) until = now() + ttlFailMs;
      last = { at: now(), ok: false, error: (e as Error)?.name ?? 'error', relays: [], seen: 0, candidates: 0, accepted: 0, rejected: [] };
      log('mint_discovery_failed', { err: (e as Error)?.name ?? 'error' });
    }
  }

  function kick(force: boolean): Promise<void> {
    if (!enabled) return Promise.resolve();
    if (!inFlight)
      inFlight = (async () => {
        if (!force && now() < until) return; // the stored set is still fresh
        await run();
      })().finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return {
    enabled,
    snapshot() {
      if (enabled && now() >= until) void kick(false);
      return mints;
    },
    refresh: () => kick(true),
    start() {
      if (!enabled || timer) return;
      void kick(false);
      // The background check is cheap: it only starts a refresh once the TTL (or failure TTL) passes.
      timer = setInterval(() => void kick(false), Math.min(ttlFailMs, ttlOkMs));
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    updatedAt: () => committedAt,
    status: () => ({
      enabled,
      relays: options.relays,
      min_reviewers: options.minReviewers,
      require_announcement: options.requireAnnouncement ?? true,
      max_discovered: options.maxDiscovered,
      ttl_minutes: Math.round(ttlOkMs / 60_000),
      updated_at: committedAt,
      next_refresh_at: enabled ? until : null,
      refreshing: !!inFlight,
      mints,
      last_refresh: last,
    }),
  };
}
