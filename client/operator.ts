/**
 * Operator announcements (docs/OPERATORS.md). An operator publishes one signed, replaceable Nostr event per
 * Bellows it runs. It says where the Bellows is and what it takes:
 *
 *   kind 38390 (addressable: the newest event per key and address replaces older ones)
 *   tags:
 *     ["d", "<address>"]            the Bellows' origin, e.g. https://bellows.example (the replaceable key)
 *     ["u", "<address>"]            the same origin
 *     ["ohttp-relay", "<url>"]      zero or more Oblivious HTTP relays that forward to it
 *     ["onion", "<url>"]            optional: its onion address, e.g. http://<56 chars>.onion
 *     ["version", "<version>"]      the Bellows release it runs
 *     ["measurement", "<type>", "<register>", ...]   optional: the build measurement, as builds.json lists it
 *     ["unit", "<unit>"]            one or more units balances are kept in (sat, usd)
 *     ["mint", "<url>"]             one or more mints whose eCash it takes
 *     ["alt", "Bellows operator announcement"]   NIP-31 text for clients that do not know the kind
 *   content: an optional plain-text description (at most 1000 characters)
 *
 * The same event is also served by the Bellows itself, inside its attested identity statement
 * (BELLOWS_OPERATOR_ANNOUNCEMENT_FILE). A client accepts an operator only when the attested copy is signed by
 * the same key for the same address, so a listed event cannot point at someone else's Bellows.
 */
import { measurementProblems, type Measurement } from './builds.ts';
import { OperatorError } from './errors.ts';
import { isEventShape, type NostrEvent, queryRelays, type RelayOptions, signEvent, type UnsignedEvent, verifyEvent } from './nostr.ts';

/** The Nostr kind of an operator announcement. Addressable (NIP-01 range 30000 to 39999); not registered in the NIPs list. */
export const OPERATOR_KIND = 38390;
export const OPERATOR_ALT = 'Bellows operator announcement';
const MAX_DESCRIPTION = 1000;
const MAX_TAGS = 64;
const MAX_LIST = 16;
const MAX_URL = 300;
/** An announcement dated further than this in the future is refused. */
const FUTURE_SLACK_S = 600;
const UNIT_RE = /^[a-z]{1,16}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const ONION_RE = /^[a-z2-7]{56}\.onion$/;

/** What an operator says about one Bellows. */
export interface OperatorAnnouncementFields {
  /** The Bellows' origin: https (http only on a loopback address, for local runs). */
  url: string;
  /** Oblivious HTTP relays that forward to it. */
  relays?: readonly string[];
  /** Its onion address, e.g. http://<56 chars>.onion. */
  onion?: string | null;
  version: string;
  measurement?: Measurement | null;
  units: readonly string[];
  mints: readonly string[];
  description?: string;
}

export interface OperatorAnnouncement {
  /** "38390:<pubkey>:<address>": names this operator's Bellows across replacements. */
  id: string;
  /** The operator's Nostr public key (hex). */
  pubkey: string;
  createdAt: number;
  url: string;
  relays: string[];
  onion: string | null;
  version: string;
  measurement: Measurement | null;
  units: string[];
  mints: string[];
  description: string;
  /** The signed event, exactly as received. */
  event: NostrEvent;
}

/** The origin of `raw` when it is an https URL, or http on loopback (or an onion host when `onion`). Throws otherwise. */
function checkUrl(raw: string, what: string, o: { origin?: boolean; onion?: boolean } = {}): string {
  if (typeof raw !== 'string' || raw.length > MAX_URL) throw new Error(`${what} must be a URL of at most ${MAX_URL} characters`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL: ${raw}`);
  }
  if (u.username || u.password || u.hash) throw new Error(`${what} must not carry credentials or a fragment: ${raw}`);
  if (o.onion) {
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !ONION_RE.test(u.hostname)) throw new Error(`${what} must be an http(s) v3 onion address: ${raw}`);
  } else if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error(`${what} must be https: ${raw}`);
  }
  if (o.origin) {
    if ((u.pathname !== '/' && u.pathname !== '') || u.search) throw new Error(`${what} must be an origin with no path or query: ${raw}`);
    return u.origin;
  }
  return raw;
}

/** A mint URL as compared everywhere in Bellows: trailing slashes dropped. */
export const normalizeMint = (u: string): string => u.trim().replace(/\/+$/, '');

interface CheckedFields {
  url: string;
  relays: string[];
  onion: string | null;
  version: string;
  measurement: Measurement | null;
  units: string[];
  mints: string[];
  description: string;
}

function checkFields(f: OperatorAnnouncementFields): CheckedFields {
  const url = checkUrl(f.url, 'url', { origin: true });
  const relays = [...(f.relays ?? [])].map((r, i) => checkUrl(r, `relays[${i}]`));
  const onion = f.onion ? checkUrl(f.onion, 'onion', { onion: true, origin: true }) : null;
  if (typeof f.version !== 'string' || !VERSION_RE.test(f.version)) throw new Error('version must be a release version such as 1.2.3');
  const measurement = f.measurement ?? null;
  if (measurement) {
    const p = measurementProblems(measurement, 'measurement');
    if (p.length) throw new Error(p.join('; '));
  }
  const units = [...f.units];
  if (units.length === 0 || !units.every((u) => typeof u === 'string' && UNIT_RE.test(u))) throw new Error('units must list at least one unit, such as sat or usd');
  const mints = [...f.mints].map((m, i) => normalizeMint(checkUrl(m, `mints[${i}]`)));
  if (mints.length === 0) throw new Error('mints must list at least one mint');
  for (const [name, list] of [['relays', relays], ['units', units], ['mints', mints]] as const) {
    if (list.length > MAX_LIST) throw new Error(`${name} lists more than ${MAX_LIST} entries`);
    if (new Set(list).size !== list.length) throw new Error(`${name} lists an entry twice`);
  }
  const description = f.description ?? '';
  if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) throw new Error(`description must be text of at most ${MAX_DESCRIPTION} characters`);
  return { url, relays, onion, version: f.version, measurement, units, mints, description };
}

/** The unsigned event for these fields. Throws on a field that would not parse back. */
export function operatorEventTemplate(fields: OperatorAnnouncementFields, createdAt: number): UnsignedEvent {
  const f = checkFields(fields);
  const tags: string[][] = [['d', f.url], ['u', f.url]];
  for (const r of f.relays) tags.push(['ohttp-relay', r]);
  if (f.onion) tags.push(['onion', f.onion]);
  tags.push(['version', f.version]);
  if (f.measurement) tags.push(['measurement', f.measurement.type, ...f.measurement.registers]);
  for (const u of f.units) tags.push(['unit', u]);
  for (const m of f.mints) tags.push(['mint', m]);
  tags.push(['alt', OPERATOR_ALT]);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('createdAt must be a Unix time in seconds');
  return { kind: OPERATOR_KIND, created_at: createdAt, tags, content: f.description };
}

/** Builds and signs an announcement with the operator's 32-byte Nostr secret key. */
export function signOperatorAnnouncement(fields: OperatorAnnouncementFields, secretKey: Uint8Array, createdAt = Math.floor(Date.now() / 1000)): NostrEvent {
  return signEvent(operatorEventTemplate(fields, createdAt), secretKey);
}

/**
 * Checks a signed announcement and returns what it says. Throws OperatorError('bad_announcement') unless it
 * is a correctly signed event of OPERATOR_KIND with well-formed tags.
 */
export function parseOperatorAnnouncement(ev: unknown, o: { now?: number } = {}): OperatorAnnouncement {
  const bad = (why: string) => new OperatorError('bad_announcement', `operator announcement: ${why}`);
  if (!isEventShape(ev)) throw bad('not a Nostr event');
  if (ev.kind !== OPERATOR_KIND) throw bad(`kind must be ${OPERATOR_KIND}, got ${ev.kind}`);
  if (ev.tags.length > MAX_TAGS) throw bad(`more than ${MAX_TAGS} tags`);
  if (!verifyEvent(ev)) throw bad('the id or the signature is wrong');
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (ev.created_at > now + FUTURE_SLACK_S) throw bad('dated in the future');

  const all = (name: string) => ev.tags.filter((t) => t[0] === name);
  const one = (name: string, required: boolean): string[] | undefined => {
    const found = all(name);
    if (found.length > 1) throw bad(`more than one "${name}" tag`);
    if (required && found.length === 0) throw bad(`no "${name}" tag`);
    return found[0];
  };
  const value = (t: string[] | undefined, name: string): string => {
    if (!t || t.length !== 2) throw bad(`the "${name}" tag must hold one value`);
    return t[1]!;
  };
  const d = value(one('d', true), 'd');
  const u = value(one('u', true), 'u');
  if (d !== u) throw bad('the "d" and "u" tags must both hold the address');
  const m = one('measurement', false);
  let fields: CheckedFields;
  try {
    fields = checkFields({
      url: u,
      relays: all('ohttp-relay').map((t) => value(t, 'ohttp-relay')),
      onion: one('onion', false) ? value(one('onion', false), 'onion') : null,
      version: value(one('version', true), 'version'),
      measurement: m ? { type: m[1] ?? '', registers: m.slice(2) } : null,
      units: all('unit').map((t) => value(t, 'unit')),
      mints: all('mint').map((t) => value(t, 'mint')),
      description: ev.content,
    });
  } catch (e) {
    if (e instanceof OperatorError) throw e;
    throw bad(e instanceof Error ? e.message : String(e));
  }
  if (fields.url !== u) throw bad('the address must be written as an origin, e.g. https://bellows.example');
  if (fields.mints.some((x, i) => x !== all('mint')[i]![1])) throw bad('mint URLs must have no trailing slash');
  return {
    id: `${OPERATOR_KIND}:${ev.pubkey}:${fields.url}`,
    pubkey: ev.pubkey,
    createdAt: ev.created_at,
    ...fields,
    event: ev,
  };
}

/**
 * The current announcements among `events`: each one checked, and for each key and address only the newest
 * (NIP-01: for equal times, the lowest id). Invalid events are listed in `rejected` with the reason.
 */
export function latestAnnouncements(events: readonly unknown[], o: { now?: number; authors?: readonly string[] } = {}): { announcements: OperatorAnnouncement[]; rejected: { event: unknown; reason: string }[] } {
  const byId = new Map<string, OperatorAnnouncement>();
  const rejected: { event: unknown; reason: string }[] = [];
  const authors = o.authors ? new Set(o.authors) : undefined;
  for (const ev of events) {
    let a: OperatorAnnouncement;
    try {
      a = parseOperatorAnnouncement(ev, o);
    } catch (e) {
      rejected.push({ event: ev, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (authors && !authors.has(a.pubkey)) {
      rejected.push({ event: ev, reason: 'not by one of the listed operator keys' });
      continue;
    }
    const prev = byId.get(a.id);
    if (!prev || a.createdAt > prev.createdAt || (a.createdAt === prev.createdAt && a.event.id < prev.event.id)) byId.set(a.id, a);
  }
  return { announcements: [...byId.values()], rejected };
}

export interface LoadOperatorsOptions extends RelayOptions {
  /** Only announcements by these keys (hex). Unset: every announcement the relays hold. */
  authors?: readonly string[];
  /** Most events asked of each relay (default 500). */
  limit?: number;
}

/** Reads operator announcements from Nostr relays and returns the current ones. */
export async function loadOperatorAnnouncements(nostrRelays: readonly string[], o: LoadOperatorsOptions = {}): Promise<{ announcements: OperatorAnnouncement[]; rejected: { event: unknown; reason: string }[] }> {
  const filter: Record<string, unknown> = { kinds: [OPERATOR_KIND], limit: o.limit ?? 500 };
  if (o.authors) filter.authors = [...o.authors];
  const events = await queryRelays(nostrRelays, [filter], o);
  return latestAnnouncements(events, { authors: o.authors });
}
