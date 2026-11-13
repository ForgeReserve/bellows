/**
 * Operators (docs/DESIGN.md, S6): signed operator announcements, the publishing command, the client's
 * operator pool (verify, health-check, pick, fail over, remember) and the error paths of moving a balance.
 * Bellows instances run in process here; test/e2e/operators.e2e.test.ts runs them over HTTP with the local
 * mints and moves a real balance.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../../client/bytes.ts';
import {
  BellowsFetchError,
  devVerifier,
  latestAnnouncements,
  loadOperatorAnnouncements,
  MoveBalanceError,
  memoryInProcess,
  moveBalance,
  newBalanceKey,
  OPERATOR_KIND,
  OperatorError,
  OperatorPool,
  parseOperatorAnnouncement,
  publicKeyOf,
  publishEvent,
  signEvent,
  signOperatorAnnouncement,
  solvePow,
  storageMemory,
  tryOrder,
  verifyEvent,
} from '../../client/index.ts';
import type { NostrEvent, OperatorAnnouncementFields, SocketLike } from '../../client/index.ts';
import { createRelay } from '../../relay/relay.ts';
import { bech32Decode, decodeSecretKey, type PromptInput, readHiddenLine, runAnnounce } from '../../src/announce.ts';
import { createApp } from '../../src/app.ts';
import { devMeasurement } from '../../src/attest/dev.ts';
import { BELLOWS_VERSION, loadConfig } from '../../src/config.ts';
import { PaymentError } from '../../src/cashu/wallet.ts';
import { buildDeps } from '../../src/deps.ts';
import { isApiKeyShape } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { PowGate } from '../../src/pow.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const KEY_A = new Uint8Array(32).fill(0x11);
const KEY_B = new Uint8Array(32).fill(0x22);
const KEY_X = new Uint8Array(32).fill(0x33);
const MINT = 'http://127.0.0.1:1';
const ONION = `http://${'a'.repeat(56)}.onion`;
const devBuilds = { format: 'bellows-builds/v1', builds: [{ version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement() }] };
const otherBuilds = { format: 'bellows-builds/v1', builds: [{ version: BELLOWS_VERSION, image: `example/bellows@sha256:${'cd'.repeat(32)}`, measurement: devMeasurement('ef'.repeat(32)) }] };

const fields = (o: Partial<OperatorAnnouncementFields> = {}): OperatorAnnouncementFields => ({ url: 'https://a.bellows.test', version: BELLOWS_VERSION, units: ['usd', 'sat'], mints: [MINT], ...o });
const now = () => Math.floor(Date.now() / 1000);

describe('Nostr events', () => {
  it('signs and verifies, and refuses any change', () => {
    const ev = signEvent({ kind: 1, created_at: 1_700_000_000, tags: [['t', 'x']], content: 'hello' }, KEY_A);
    expect(ev.pubkey).toBe(publicKeyOf(KEY_A));
    expect(verifyEvent(ev)).toBe(true);
    expect(verifyEvent({ ...ev, content: 'hello!' })).toBe(false);
    expect(verifyEvent({ ...ev, tags: [['t', 'y']] })).toBe(false);
    expect(verifyEvent({ ...ev, created_at: ev.created_at + 1 })).toBe(false);
    const sig = ev.sig.slice(0, -1) + (ev.sig.endsWith('0') ? '1' : '0');
    expect(verifyEvent({ ...ev, sig })).toBe(false);
    // A valid signature by another key over the same id.
    expect(verifyEvent({ ...ev, pubkey: publicKeyOf(KEY_B) })).toBe(false);
    for (const junk of [null, 1, 'x', [], {}, { ...ev, tags: [[1]] }]) expect(verifyEvent(junk)).toBe(false);
  });
});

describe('operator announcements', () => {
  it('round-trips every field', () => {
    const ev = signOperatorAnnouncement(
      fields({ relays: ['https://relay.test/relay/a.bellows.test'], onion: ONION, measurement: devMeasurement(), mints: [MINT, 'https://mint.example/path'], description: 'Example operator' }),
      KEY_A,
      1_700_000_000,
    );
    expect(ev.kind).toBe(OPERATOR_KIND);
    const a = parseOperatorAnnouncement(ev);
    expect(a).toMatchObject({
      id: `${OPERATOR_KIND}:${publicKeyOf(KEY_A)}:https://a.bellows.test`,
      pubkey: publicKeyOf(KEY_A),
      createdAt: 1_700_000_000,
      url: 'https://a.bellows.test',
      relays: ['https://relay.test/relay/a.bellows.test'],
      onion: ONION,
      version: BELLOWS_VERSION,
      measurement: devMeasurement(),
      units: ['usd', 'sat'],
      mints: [MINT, 'https://mint.example/path'],
      description: 'Example operator',
    });
    expect(ev.tags).toContainEqual(['alt', 'Bellows operator announcement']);
    expect(ev.tags).toContainEqual(['d', 'https://a.bellows.test']);
  });

  it('writes the address as an origin and mints without a trailing slash', () => {
    const a = parseOperatorAnnouncement(signOperatorAnnouncement(fields({ url: 'https://a.bellows.test/', mints: ['https://mint.example/'] }), KEY_A));
    expect(a.url).toBe('https://a.bellows.test');
    expect(a.mints).toEqual(['https://mint.example']);
  });

  it('refuses announcements that would not parse back', () => {
    for (const bad of [
      fields({ url: 'http://a.bellows.test' }),
      fields({ url: 'https://a.bellows.test/path' }),
      fields({ url: 'https://user@a.bellows.test' }),
      fields({ units: [] }),
      fields({ units: ['USD'] }),
      fields({ mints: [] }),
      fields({ mints: ['ftp://mint.example'] }),
      fields({ mints: [MINT, MINT] }),
      fields({ onion: 'http://short.onion' }),
      fields({ version: 'latest' }),
      fields({ measurement: { type: 'x', registers: ['XY'] } }),
      fields({ description: 'x'.repeat(1001) }),
    ]) {
      expect(() => signOperatorAnnouncement(bad, KEY_A), JSON.stringify(bad)).toThrow();
    }
  });

  const resign = (ev: NostrEvent, change: (e: NostrEvent) => void): NostrEvent => {
    const copy: NostrEvent = JSON.parse(JSON.stringify(ev));
    change(copy);
    return signEvent(copy, KEY_A);
  };

  it('refuses events that are signed but malformed', () => {
    const ev = signOperatorAnnouncement(fields(), KEY_A);
    const refused = (e: unknown, why: RegExp) => {
      expect(() => parseOperatorAnnouncement(e)).toThrow(OperatorError);
      expect(() => parseOperatorAnnouncement(e)).toThrow(why);
    };
    refused({ ...ev, content: 'changed' }, /signature/);
    refused(resign(ev, (e) => (e.kind = 30078)), /kind must be 38390/);
    refused(resign(ev, (e) => e.tags.push(['version', '9.9.9'])), /more than one "version"/);
    refused(resign(ev, (e) => (e.tags = e.tags.filter((t) => t[0] !== 'u'))), /no "u" tag/);
    refused(resign(ev, (e) => (e.tags.find((t) => t[0] === 'd')![1] = 'https://b.bellows.test')), /"d" and "u"/);
    refused(resign(ev, (e) => (e.tags = e.tags.filter((t) => t[0] !== 'mint'))), /mints must list/);
    refused(resign(ev, (e) => e.tags.push(['mint', 'https://mint.example/'])), /trailing slash/);
    refused(resign(ev, (e) => (e.created_at = now() + 3600)), /future/);
    refused(resign(ev, (e) => e.tags.push(...Array.from({ length: 70 }, () => ['x', 'y']))), /more than 64 tags/);
    refused({ kind: OPERATOR_KIND }, /not a Nostr event/);
    // Unknown tags are ignored, for later versions.
    expect(parseOperatorAnnouncement(resign(ev, (e) => e.tags.push(['later', 'value']))).url).toBe('https://a.bellows.test');
  });

  it('keeps only the newest announcement per key and address', () => {
    const old = signOperatorAnnouncement(fields({ version: '0.0.1' }), KEY_A, 1000);
    const cur = signOperatorAnnouncement(fields(), KEY_A, 2000);
    const otherAddress = signOperatorAnnouncement(fields({ url: 'https://b.bellows.test' }), KEY_A, 1500);
    const otherKey = signOperatorAnnouncement(fields(), KEY_B, 500);
    const { announcements, rejected } = latestAnnouncements([cur, old, otherAddress, otherKey, { ...old, content: 'x' }]);
    expect(announcements.map((a) => [a.pubkey === publicKeyOf(KEY_A) ? 'A' : 'B', a.url, a.createdAt])).toEqual([
      ['A', 'https://a.bellows.test', 2000],
      ['A', 'https://b.bellows.test', 1500],
      ['B', 'https://a.bellows.test', 500],
    ]);
    expect(rejected).toHaveLength(1);
    // Equal times: the lower id wins (NIP-01).
    const t1 = signOperatorAnnouncement(fields({ description: 'one' }), KEY_A, 3000);
    const t2 = signOperatorAnnouncement(fields({ description: 'two' }), KEY_A, 3000);
    const low = t1.id < t2.id ? t1 : t2;
    expect(latestAnnouncements([t1, t2]).announcements[0]!.event.id).toBe(low.id);
    expect(latestAnnouncements([t2, t1]).announcements[0]!.event.id).toBe(low.id);
    // Only the keys asked for.
    expect(latestAnnouncements([cur, otherKey], { authors: [publicKeyOf(KEY_B)] }).announcements.map((a) => a.pubkey)).toEqual([publicKeyOf(KEY_B)]);
  });
});

/** A fake Nostr relay socket: answers REQ from `events` and EVENT with OK `accept`. */
function fakeRelay(events: unknown[], accept: boolean | 'silent' = true) {
  const sent: unknown[] = [];
  const connect = async (): Promise<SocketLike> => {
    const listeners = new Map<string, Array<(e: { data: unknown }) => void>>();
    const emit = (msg: unknown) => queueMicrotask(() => (listeners.get('message') ?? []).forEach((fn) => fn({ data: JSON.stringify(msg) })));
    return {
      send(data: string) {
        const msg = JSON.parse(data);
        sent.push(msg);
        if (msg[0] === 'REQ') {
          for (const e of events) emit(['EVENT', msg[1], e]);
          emit(['EVENT', 'another-subscription', events[0]]);
          emit(['EOSE', msg[1]]);
        } else if (msg[0] === 'EVENT' && accept !== 'silent') {
          emit(['OK', msg[1].id, accept, accept ? '' : 'blocked: not allowed']);
        }
      },
      close() {},
      addEventListener(type: string, fn: (e: { data: unknown }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    } as SocketLike;
  };
  return { connect, sent };
}

describe('Nostr relays', () => {
  it('loads announcements from relays, filtered by kind and author', async () => {
    const a = signOperatorAnnouncement(fields(), KEY_A, 1000);
    const a2 = signOperatorAnnouncement(fields({ description: 'newer' }), KEY_A, 2000);
    const relay = fakeRelay([a, a2, { junk: true }]);
    const out = await loadOperatorAnnouncements(['wss://one.test', 'wss://two.test'], { connect: relay.connect, authors: [publicKeyOf(KEY_A)] });
    expect(out.announcements).toHaveLength(1);
    expect(out.announcements[0]!.description).toBe('newer');
    const req = relay.sent.find((m) => (m as unknown[])[0] === 'REQ') as unknown[];
    expect(req[2]).toEqual({ kinds: [OPERATOR_KIND], limit: 500, authors: [publicKeyOf(KEY_A)] });
  });

  it('a relay that cannot be reached gives nothing and does not throw', async () => {
    const out = await loadOperatorAnnouncements(['wss://down.test'], { connect: () => Promise.reject(new Error('down')), timeoutMs: 50 });
    expect(out.announcements).toEqual([]);
  });

  it('publishes and reports each relay\'s answer', async () => {
    const ev = signOperatorAnnouncement(fields(), KEY_A);
    expect(await publishEvent(['wss://ok.test'], ev, { connect: fakeRelay([], true).connect })).toEqual([{ relay: 'wss://ok.test', ok: true, message: '' }]);
    expect(await publishEvent(['wss://no.test'], ev, { connect: fakeRelay([], false).connect })).toEqual([{ relay: 'wss://no.test', ok: false, message: 'blocked: not allowed' }]);
    expect(await publishEvent(['wss://quiet.test'], ev, { connect: fakeRelay([], 'silent').connect, timeoutMs: 50 })).toEqual([{ relay: 'wss://quiet.test', ok: false, message: 'no answer from the relay' }]);
  });
});

describe('proof of work (client)', () => {
  it('finds solutions the Bellows accepts', async () => {
    const gate = new PowGate({ bits: 10 });
    const ch = gate.issue();
    expect(gate.verify(await solvePow(ch.challenge, ch.bits))).toEqual({ ok: true });
    await expect(solvePow('x', 33)).rejects.toThrow(/out of range/);
  });
});

describe('the publishing command', () => {
  const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
  const NSEC_HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';

  it('reads hex and nsec keys (NIP-19 test vector) and refuses anything else', () => {
    expect(toHex(decodeSecretKey(NSEC))).toBe(NSEC_HEX);
    expect(toHex(decodeSecretKey(`  ${NSEC_HEX.toUpperCase()}\n`))).toBe(NSEC_HEX);
    expect(bech32Decode('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6').prefix).toBe('npub');
    expect(toHex(bech32Decode('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6').bytes)).toBe('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d');
    expect(() => decodeSecretKey(NSEC.slice(0, -1) + 'q')).toThrow(/not a valid nsec/);
    expect(() => decodeSecretKey('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6')).toThrow(/64 hex characters or an nsec1/);
    expect(() => decodeSecretKey('0'.repeat(64))).toThrow(/not a valid secp256k1/);
    // The error never repeats the key.
    try {
      decodeSecretKey(NSEC.slice(0, -1) + 'q');
    } catch (e) {
      expect(String(e)).not.toContain(NSEC.slice(5, 30));
    }
  });

  /** A terminal or a pipe, feeding `chunks`. */
  function fakeInput(chunks: string[], tty: boolean) {
    const handlers = new Map<string, Array<(x?: unknown) => void>>();
    const raw: boolean[] = [];
    const input = {
      isTTY: tty,
      setRawMode: tty ? (r: boolean) => raw.push(r) : undefined,
      setEncoding() {},
      on(ev: string, fn: (x?: unknown) => void) {
        handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
      },
      off(ev: string, fn: (x?: unknown) => void) {
        handlers.set(ev, (handlers.get(ev) ?? []).filter((f) => f !== fn));
      },
      resume() {
        queueMicrotask(() => {
          for (const c of chunks) (handlers.get('data') ?? []).forEach((fn) => fn(c));
          (handlers.get('end') ?? []).forEach((fn) => fn());
        });
      },
      pause() {},
    };
    return { input: input as unknown as PromptInput, raw, listeners: () => [...handlers.values()].flat().length };
  }

  it('reads the key from a terminal without echoing it, and switches raw mode back off', async () => {
    const out: string[] = [];
    const t = fakeInput(['ab', 'x\u007fc', '\r', 'ignored'], true);
    expect(await readHiddenLine('Key: ', t.input, { write: (s: string) => out.push(s) })).toBe('abc');
    expect(out).toEqual(['Key: ', '\n']);
    expect(t.raw).toEqual([true, false]);
    expect(t.listeners()).toBe(0);
    const c = fakeInput(['ab\u0003'], true);
    await expect(readHiddenLine('Key: ', c.input, { write: () => {} })).rejects.toThrow(/cancelled/);
    expect(c.raw).toEqual([true, false]);
  });

  it('reads the first line of a pipe without a prompt', async () => {
    const out: string[] = [];
    const t = fakeInput([`${NSEC_HEX}\nmore\n`], false);
    expect(await readHiddenLine('Key: ', t.input, { write: (s: string) => out.push(s) })).toBe(NSEC_HEX);
    expect(out).toEqual([]);
    expect(await readHiddenLine('Key: ', fakeInput([], false).input, { write: () => {} })).toBe('');
  });

  function io(key = NSEC_HEX, connect?: ReturnType<typeof fakeRelay>['connect']) {
    const lines: string[] = [];
    const files = new Map<string, string>();
    const readKey = vi.fn(async () => key);
    return {
      lines,
      files,
      readKey,
      io: {
        readKey,
        stdout: (l: string) => lines.push(l),
        stderr: (l: string) => lines.push(l),
        writeFile: (p: string, t: string) => void files.set(p, t),
        readFile: (p: string) => {
          if (p === 'builds.json') return JSON.stringify(devBuilds);
          throw new Error('no such file');
        },
        connect,
        now: () => 1_700_000_000_000,
      },
    };
  }
  const args = ['--url', 'https://a.bellows.test', '--unit', 'usd', '--mint', MINT, '--relay', 'https://relay.test/relay/a.bellows.test'];

  it('writes a signed announcement with the build from builds.json, and never prints the key', async () => {
    const t = io(NSEC);
    expect(await runAnnounce([...args, '--builds', 'builds.json', '--out', 'a.json', '--description', 'Example'], t.io)).toBe(0);
    const a = parseOperatorAnnouncement(JSON.parse(t.files.get('a.json')!), { now: 1_700_000_000 });
    expect(a).toMatchObject({ pubkey: publicKeyOf(decodeSecretKey(NSEC_HEX)), createdAt: 1_700_000_000, measurement: devMeasurement(), relays: ['https://relay.test/relay/a.bellows.test'], description: 'Example' });
    const printed = t.lines.join('\n');
    expect(printed).toContain(a.event.id);
    expect(printed).not.toContain(NSEC_HEX);
    expect(printed).not.toContain(NSEC.slice(5));
  });

  it('picks the build for its deployment when a version is listed for several', async () => {
    const shared = {
      format: 'bellows-builds/v1',
      builds: [
        { version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement(), deployment: 'alice/bellows-deploy@v1.0.0' },
        { version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement('ef'.repeat(32)), deployment: 'bob/bellows-deploy@v1.0.0' },
      ],
    };
    const t = io(NSEC);
    t.io.readFile = (p: string) => {
      if (p === 'shared.json') return JSON.stringify(shared);
      throw new Error('no such file');
    };
    expect(await runAnnounce([...args, '--builds', 'shared.json', '--out', 'a.json'], t.io)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/listed for several deployments .*alice\/bellows-deploy@v1\.0\.0, bob\/bellows-deploy@v1\.0\.0.*--deployment/);
    expect(t.readKey).not.toHaveBeenCalled();
    expect(await runAnnounce([...args, '--builds', 'shared.json', '--deployment', 'carol/bellows-deploy@v1.0.0', '--out', 'a.json'], t.io)).toBe(2);
    expect(t.lines.join('\n')).toMatch(/not listed for carol\/bellows-deploy@v1\.0\.0/);
    expect(await runAnnounce([...args, '--builds', 'shared.json', '--deployment', 'bob/bellows-deploy@v1.0.0', '--out', 'a.json'], t.io)).toBe(0);
    const a = parseOperatorAnnouncement(JSON.parse(t.files.get('a.json')!), { now: 1_700_000_000 });
    expect(a.measurement).toEqual(devMeasurement('ef'.repeat(32)));
  });

  it('checks the fields before asking for the key', async () => {
    const t = io();
    expect(await runAnnounce(['--url', 'http://a.bellows.test', '--unit', 'usd', '--mint', MINT, '--out', 'a.json'], t.io)).toBe(2);
    expect(t.readKey).not.toHaveBeenCalled();
    expect(await runAnnounce(['--url', 'https://a.bellows.test', '--unit', 'usd', '--mint', MINT], t.io)).toBe(2);
    expect(await runAnnounce(['--url', 'https://a.bellows.test', '--key', NSEC_HEX], t.io)).toBe(2);
    expect(t.readKey).not.toHaveBeenCalled();
    expect(t.files.size).toBe(0);
  });

  it('refuses a bad key without writing anything', async () => {
    const t = io('not a key');
    expect(await runAnnounce([...args, '--out', 'a.json'], t.io)).toBe(2);
    expect(t.files.size).toBe(0);
  });

  it('publishes to Nostr relays and fails when one refuses; --dry-run sends nothing', async () => {
    const ok = fakeRelay([], true);
    expect(await runAnnounce([...args, '--nostr', 'wss://one.test', '--nostr', 'wss://two.test'], io(NSEC_HEX, ok.connect).io)).toBe(0);
    expect(ok.sent.filter((m) => (m as unknown[])[0] === 'EVENT')).toHaveLength(2);
    const ev = (ok.sent[0] as [string, NostrEvent])[1];
    expect(parseOperatorAnnouncement(ev, { now: 1_700_000_000 }).url).toBe('https://a.bellows.test');
    const no = fakeRelay([], false);
    expect(await runAnnounce([...args, '--nostr', 'wss://one.test'], io(NSEC_HEX, no.connect).io)).toBe(1);
    const dry = fakeRelay([], true);
    expect(await runAnnounce([...args, '--nostr', 'wss://one.test', '--dry-run'], io(NSEC_HEX, dry.connect).io)).toBe(0);
    expect(dry.sent).toEqual([]);
  });
});

// ── the pool, against Bellows instances in this process ───────────────────────

interface Instance {
  origin: string;
  announcement: NostrEvent;
  deps: ReturnType<typeof buildDeps>;
  fetch(req: Request): Response | Promise<Response>;
}

function bellows(origin: string, key: Uint8Array, o: { units?: string[]; mints?: string[]; relays?: string[]; onion?: string; announce?: boolean; env?: Record<string, string> } = {}): Instance {
  const units = o.units ?? ['usd', 'sat'];
  const mints = o.mints ?? [MINT];
  const announcement = signOperatorAnnouncement({ url: origin, version: BELLOWS_VERSION, units, mints, relays: o.relays, onion: o.onion }, key);
  const dir = mkdtempSync(join(tmpdir(), 'bellows-ops-'));
  writeFileSync(join(dir, 'announcement.json'), JSON.stringify(announcement));
  const env = {
    BELLOWS_DB_PATH: ':memory:',
    BELLOWS_TRUSTED_MINTS: mints.join(','),
    BELLOWS_FOREIGN_DISCOVERY_RELAYS: '',
    BELLOWS_POW_BITS: '0',
    BELLOWS_UNITS: units.join(','),
    BELLOWS_DEFAULT_UNIT: units[0]!,
    BELLOWS_RELAYS: (o.relays ?? []).join(','),
    ...(o.announce === false ? {} : { BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: join(dir, 'announcement.json') }),
    ...o.env,
  };
  const catalog = { suppliers: { mock: { type: 'mock', tier: 'standard' } }, models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }] };
  const deps = buildDeps(loadConfig(env as NodeJS.ProcessEnv, catalog), { rateSources: [fixedRateSource('fixed', 100_000)] });
  const app = createApp(deps);
  return { origin, announcement, deps, fetch: (req) => app.fetch(req) };
}

/** A network of origins served in process. Origins in `down` cannot be reached. */
function network() {
  const routes = new Map<string, (req: Request) => Response | Promise<Response>>();
  const down = new Set<string>();
  const hits = new Map<string, number>();
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const origin = new URL(url).origin;
    hits.set(origin, (hits.get(origin) ?? 0) + 1);
    const route = routes.get(origin);
    if (!route || down.has(origin)) throw new TypeError('fetch failed');
    return route(new Request(url, init));
  };
  const add = (b: Instance, at = b.origin) => routes.set(at, (r) => b.fetch(r));
  return { routes, down, hits, fetch, add };
}

const A = 'https://a.bellows.test';
const B = 'https://b.bellows.test';
const idOf = (ev: NostrEvent) => parseOperatorAnnouncement(ev).id;

function twoOperators(o: { a?: Parameters<typeof bellows>[2]; b?: Parameters<typeof bellows>[2] } = {}) {
  const net = network();
  const a = bellows(A, KEY_A, o.a);
  const b = bellows(B, KEY_B, o.b);
  net.add(a);
  net.add(b);
  return { net, a, b, idA: idOf(a.announcement), idB: idOf(b.announcement) };
}

const poolOf = (net: ReturnType<typeof network>, operators: unknown[], extra: Partial<ConstructorParameters<typeof OperatorPool>[0]> = {}) =>
  new OperatorPool({ operators, approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true, fetch: net.fetch, ...extra });

describe('operator pool', () => {
  it('verifies, health-checks and picks the first listed operator, then remembers it', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const memory = memoryInProcess();
    const pool = poolOf(net, [a.announcement, b.announcement], { memory });
    const op = await pool.pick();
    expect(op.id).toBe(idA);
    expect(op.verified.origin).toBe(A);
    expect(op.verified.development).toBe(true);
    expect(op.announcement.pubkey).toBe(publicKeyOf(KEY_A));
    const { response, operator } = await pool.fetch('/v1/models');
    expect(response.status).toBe(200);
    expect(operator.id).toBe(idA);
    expect(memory.get()).toBe(idA);

    // A new pool with the same memory starts with the remembered operator, whatever the list order.
    const again = poolOf(net, [b.announcement, a.announcement], { memory });
    expect(await again.order()).toEqual([idA, idB]);
    expect((await again.pick()).id).toBe(idA);
  });

  it('storage memory survives a storage that throws', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const m = storageMemory(throwing);
    expect(m.get()).toBeNull();
    expect(() => m.set('x')).not.toThrow();
    const map = new Map<string, string>();
    const ok = storageMemory({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) });
    ok.set('op');
    expect(ok.get()).toBe('op');
    expect(map.get('bellows.last-operator')).toBe('op');
  });

  it('orders the remembered operator first and recently failed ones last', () => {
    const failed = new Map([['a', 1000], ['b', 500]]);
    expect(tryOrder(['a', 'b', 'c'], 'c', new Map(), 0, 60_000)).toEqual(['c', 'a', 'b']);
    expect(tryOrder(['a', 'b', 'c'], 'gone', new Map(), 0, 60_000)).toEqual(['a', 'b', 'c']);
    expect(tryOrder(['a', 'b', 'c'], 'a', failed, 2000, 60_000)).toEqual(['c', 'b', 'a']);
    expect(tryOrder(['a', 'b', 'c'], 'a', failed, 70_000, 60_000)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a listed announcement whose Bellows serves another operator\'s announcement', async () => {
    const { net, b, idB } = twoOperators();
    // Someone else lists A's address under their own key.
    const impostor = signOperatorAnnouncement(fields({ url: A }), KEY_X);
    const pool = poolOf(net, [impostor, b.announcement]);
    await expect(pool.prepare(idOf(impostor))).rejects.toMatchObject({ code: 'announcement_mismatch' });
    expect((await pool.pick()).id).toBe(idB);
  });

  it('refuses a Bellows that serves no signed announcement', async () => {
    const net = network();
    const plain = bellows(A, KEY_A);
    const listed = plain.announcement;
    // The same app, but its configuration had no announcement file.
    const bare = bellows(A, KEY_A, { announce: false });
    net.add(bare);
    const pool = poolOf(net, [listed]);
    await expect(pool.pick()).rejects.toMatchObject({ code: 'no_operator' });
    await expect(pool.prepare(idOf(listed))).rejects.toThrow(/no valid signed announcement/);
  });

  it('refuses every operator whose attested build is not approved, and says why', async () => {
    const { net, a, b } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement], { approvedBuilds: otherBuilds });
    const err = await pool.pick().catch((e) => e);
    expect(err).toBeInstanceOf(OperatorError);
    expect(err.code).toBe('no_operator');
    expect(err.failures).toHaveLength(2);
    expect(err.failures[0].reason).toMatch(/build_not_approved/);
  });

  it('refuses the development stand-in unless the app opts in', async () => {
    const { net, a } = twoOperators();
    const pool = poolOf(net, [a.announcement], { allowDevelopment: false });
    await expect(pool.prepare(idOf(a.announcement))).rejects.toMatchObject({ code: 'development_refused' });
  });

  it('passes over an operator that does not take the unit or the mint', async () => {
    const { net, a, b, idB } = twoOperators({ a: { units: ['usd'] } });
    const pool = poolOf(net, [a.announcement, b.announcement], { unit: 'sat' });
    await expect(pool.prepare(idOf(a.announcement))).rejects.toMatchObject({ code: 'not_accepted' });
    expect((await pool.pick()).id).toBe(idB);
    await expect(pool.pick({ unit: 'sat', mint: 'https://other-mint.test' })).rejects.toMatchObject({ code: 'no_operator' });
    expect((await pool.pick({ mint: `${MINT}/` })).id).toBe(idB);
  });

  it('fails over a GET to the next operator and remembers the one that answered', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const memory = memoryInProcess();
    const pool = poolOf(net, [a.announcement, b.announcement], { memory });
    expect((await pool.fetch('/v1/models')).operator.id).toBe(idA);
    net.down.add(A);
    const { response, operator } = await pool.fetch('/v1/models');
    expect(response.status).toBe(200);
    expect(operator.id).toBe(idB);
    expect(memory.get()).toBe(idB);
    // A failed recently, so it now comes last.
    expect(await pool.order()).toEqual([idB, idA]);
  });

  it('never sends a POST to a second operator once it may have reached the first', async () => {
    const { net, a, b, idA } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement]);
    await pool.prepare(idA);
    net.down.add(A);
    const before = net.hits.get(B) ?? 0;
    await expect(pool.fetch('/v1/wallet/topup', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(BellowsFetchError);
    expect(net.hits.get(B) ?? 0).toBe(before);
    // Asked to, it does fail over.
    expect((await pool.fetch('/v1/models', { method: 'POST' }, { failover: true })).operator.id).toBe(idOf(b.announcement));
  });

  it('a POST goes to the next operator when the first fails before anything is sent', async () => {
    const { net, a, b, idB } = twoOperators();
    net.down.add(A);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const { response, operator } = await pool.fetch('/v1/wallet/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(operator.id).toBe(idB);
    expect(response.status).toBe(400);
  });

  it('a call pinned to its operator skips the pool\'s unit and mint', async () => {
    // The pool is for new sat balances; A keeps usd only, and the app already holds a usd balance there.
    const { net, a, b, idA } = twoOperators({ a: { units: ['usd'] } });
    const pool = poolOf(net, [a.announcement, b.announcement], { unit: 'sat', mint: 'https://other-mint.test' });
    const key = newBalanceKey();
    const acct = a.deps.ledger.createAccountRaw(key, 'usd', null);
    a.deps.ledger.creditRaw(acct.id, 2500, 'test', null);
    const { response, operator } = await pool.fetch('/v1/wallet', { headers: { authorization: `Bearer ${key}` } }, { operator: idA });
    expect(operator.id).toBe(idA);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unit: 'usd', balance_msub: 2500 });
    // Unpinned calls and explicit requirements still apply them.
    await expect(pool.prepare(idA)).rejects.toMatchObject({ code: 'not_accepted' });
    await expect(pool.prepare(idA, { unit: 'usd' })).rejects.toThrow(/does not take eCash from https:\/\/other-mint.test/);
    expect((await pool.prepare(idA, { unit: 'usd', mint: MINT })).id).toBe(idA);
  });

  it('refuses an unpinned call that carries a balance key, and sends nothing', async () => {
    const { net, a, b } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const before = { a: net.hits.get(A) ?? 0, b: net.hits.get(B) ?? 0 };
    const key = newBalanceKey();
    for (const headers of [{ authorization: `Bearer ${key}` }, new Headers({ Authorization: `Bearer ${key}` }), [['authorization', `Bearer ${key}`]] as [string, string][]]) {
      await expect(pool.fetch('/v1/wallet', { headers })).rejects.toMatchObject({ code: 'not_accepted', message: expect.stringMatching(/must name its operator/) });
      await expect(pool.fetch('/v1/wallet/refunds', { headers }, { failover: true })).rejects.toMatchObject({ code: 'not_accepted' });
    }
    expect({ a: net.hits.get(A) ?? 0, b: net.hits.get(B) ?? 0 }).toEqual(before);
  });

  it('a call pinned to one operator never fails over', async () => {
    const { net, a, b, idA } = twoOperators();
    net.down.add(A);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    await expect(pool.fetch('/v1/models', {}, { operator: idA })).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(pool.fetch('/v1/models', {}, { operator: 'nope' })).rejects.toMatchObject({ code: 'unknown_operator' });
  });

  it('verifies again after a Bellows restarts with a new key', async () => {
    const { net, a, b, idA } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement]);
    expect((await pool.fetch('/v1/models', {}, { operator: idA })).response.status).toBe(200);
    const before = (await pool.prepare(idA)).verified.binding;
    net.add(bellows(A, KEY_A)); // same address and operator, new process, new HPKE key
    await expect(pool.fetch('/v1/models', {}, { operator: idA })).rejects.toMatchObject({ code: 'gateway_refused' });
    const { response } = await pool.fetch('/v1/models', {}, { operator: idA });
    expect(response.status).toBe(200);
    expect((await pool.prepare(idA)).verified.binding).not.toBe(before);
  });

  it('passes over an operator that fails its health check', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const real = net.routes.get(A)!;
    net.routes.set(A, (r) => (new URL(r.url).pathname === '/ohttp' ? new Response('nope', { status: 502 }) : real(r)));
    const pool = poolOf(net, [a.announcement, b.announcement]);
    await expect(pool.prepare(idA)).rejects.toMatchObject({ code: 'unhealthy' });
    expect((await pool.pick()).id).toBe(idB);
  });

  it('route relay: sends through the attested relay, and passes over a Bellows without one', async () => {
    const relayUrl = 'https://relay.test/relay/a.bellows.test';
    const { net, a, b, idA } = twoOperators({ a: { relays: [relayUrl] } });
    const relay = createRelay({ targets: [`${A}/ohttp`], fetch: net.fetch });
    net.routes.set('https://relay.test', relay);
    const pool = poolOf(net, [b.announcement, a.announcement], { route: 'relay' });
    await expect(pool.prepare(idOf(b.announcement))).rejects.toMatchObject({ code: 'not_accepted' });
    const relayHits = net.hits.get('https://relay.test') ?? 0;
    const { response, operator } = await pool.fetch('/v1/models');
    expect(response.status).toBe(200);
    expect(operator.id).toBe(idA);
    expect(operator.endpoint.relay).toBe(relayUrl);
    expect(net.hits.get('https://relay.test')!).toBeGreaterThan(relayHits);
  });

  it('route onion: verifies and sends at the onion address', async () => {
    const { net, a, b } = twoOperators({ a: { onion: ONION } });
    net.add(a, ONION);
    net.down.add(A); // the clear address is not used
    const pool = poolOf(net, [b.announcement, a.announcement], { route: 'onion' });
    const { response, operator } = await pool.fetch('/v1/models');
    expect(response.status).toBe(200);
    expect(operator.verified.origin).toBe(ONION);
    expect(operator.endpoint.relay).toBeNull();
    await expect(pool.prepare(idOf(b.announcement))).rejects.toMatchObject({ code: 'not_accepted' });
  });

  it('lists entries that are not announcements as rejected', () => {
    const net = network();
    const pool = poolOf(net, [{ nope: 1 }, signOperatorAnnouncement(fields(), KEY_A)]);
    expect(pool.operators).toHaveLength(1);
    expect(pool.rejected).toHaveLength(1);
  });
});

describe('moving a balance: refusals', () => {
  it('makes keys a Bellows accepts', () => {
    const k = newBalanceKey();
    expect(isApiKeyShape(k)).toBe(true);
    expect(newBalanceKey()).not.toBe(k);
  });

  it('refuses a balance below one unit, an unknown key and the same operator', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const key = newBalanceKey();
    const acct = a.deps.ledger.createAccountRaw(key, 'usd', null);
    a.deps.ledger.creditRaw(acct.id, 500, 'test', null); // half a cent
    await expect(moveBalance(pool, { from: idA, key })).rejects.toMatchObject({ code: 'nothing_to_move' });
    await expect(moveBalance(pool, { from: idA, key: newBalanceKey() })).rejects.toMatchObject({ code: 'withdraw_failed' });
    await expect(moveBalance(pool, { from: idA, key, to: idA })).rejects.toMatchObject({ code: 'not_accepted' });
    void idB;
  });

  it('keeps the token in the error when the destination refuses it', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const newKey = newBalanceKey();
    const err = await moveBalance(pool, { from: idA, key: newBalanceKey(), to: idB, newKey, token: { token: 'cashuBnotatoken', unit: 'usd', mint: MINT } }).catch((e) => e);
    expect(err).toBeInstanceOf(MoveBalanceError);
    expect(err.code).toBe('fund_failed');
    expect(err.token).toBe('cashuBnotatoken');
    expect(err.to).toBe(idB);
    expect(err.key).toBe(newKey);
  });

  it('refuses to finish a move without the newKey from the error, and sends nothing', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const pool = poolOf(net, [a.announcement, b.announcement]);
    await pool.prepare(idB);
    const before = net.hits.get(B) ?? 0;
    const err = await moveBalance(pool, { from: idA, key: newBalanceKey(), to: idB, token: { token: 'cashuBx', unit: 'usd', mint: MINT } }).catch((e) => e);
    expect(err).toBeInstanceOf(OperatorError);
    expect(err).toMatchObject({ code: 'not_accepted', message: expect.stringMatching(/needs the newKey/) });
    expect(net.hits.get(B) ?? 0).toBe(before);
  });

  it('says no operator took the token when none keeps the unit', async () => {
    const { net, a, b, idA } = twoOperators({ b: { units: ['usd'] } });
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const err = await moveBalance(pool, { from: idA, key: newBalanceKey(), newKey: newBalanceKey(), token: { token: 'cashuBx', unit: 'sat', mint: MINT } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'no_destination', token: 'cashuBx' });
    expect(err.key).toEqual(expect.any(String));
  });
});

// ── moving a balance: the money paths ─────────────────────────────────────────
// The mint in these instances cannot be reached, so the wallets are stood in for: A issues a fixed token
// when it pays out, and B (or C) receives tokens the way the real wallet does: a token is credited once,
// to the first balance it reaches; sending it again with the same balance key is a replay that credits
// nothing; with another key it is refused as spent. test/e2e/operators.e2e.test.ts runs the real wallets.

const MOVED = 7; // whole units withdrawn
const MOVED_TOKEN = 'cashuBmovedtoken';

/** Gives A a balance of 7.5 usd and a wallet that pays it out as MOVED_TOKEN (or fails to issue). */
function fundedAtA(a: Instance, o: { issue?: 'ok' | 'fail' } = {}) {
  const key = newBalanceKey();
  const acct = a.deps.ledger.createAccountRaw(key, 'usd', null);
  a.deps.ledger.creditRaw(acct.id, MOVED * 1000 + 500, 'test', null);
  vi.spyOn(a.deps.wallet, 'holdings').mockReturnValue([{ mint: MINT, unit: 'usd', unspent: 1000, reserved: 0, owed: 0 }]);
  const issue = vi.spyOn(a.deps.wallet, 'issue');
  if (o.issue === 'fail') issue.mockRejectedValue(new PaymentError('mint_unavailable', 'mint did not answer', 503));
  else issue.mockResolvedValue(MOVED_TOKEN);
  return key;
}

type ReceiveFn = (token: string, o: { accountId?: string; onFinalize?: (amount: number) => void }) => Promise<unknown>;

/** Makes x's wallet take any token as worth MOVED usd from MINT, crediting it once. Returns the real-like receive. */
function receiving(x: Instance) {
  const owner = new Map<string, string | undefined>();
  vi.spyOn(x.deps.wallet, 'inspect').mockImplementation(async (token: string) => ({ mint: MINT, unit: 'usd', amount: MOVED, hash: token, proofs: [] }));
  const receive: ReceiveFn = async (token, o) => {
    if (owner.has(token)) {
      if (owner.get(token) === o.accountId) return { incomingId: 'in_t', mint: MINT, unit: 'usd', amount: MOVED, replay: true };
      throw new PaymentError('token_spent', 'token was already redeemed');
    }
    owner.set(token, o.accountId);
    o.onFinalize?.(MOVED);
    return { incomingId: 'in_t', mint: MINT, unit: 'usd', amount: MOVED, replay: false };
  };
  const spy = vi.spyOn(x.deps.wallet, 'receive').mockImplementation(receive as never);
  return { receive, spy };
}

const balanceAt = (x: Instance, key: string) => x.deps.ledger.findByKey(key)?.balance_msub;

describe('moving a balance: unknown outcomes and retries', () => {
  it('moves the whole units and says which mint the token is from', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const key = fundedAtA(a);
    receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const seen: unknown[] = [];
    const moved = await moveBalance(pool, { from: idA, key, onToken: (w) => void seen.push(w) });
    expect(seen).toEqual([{ token: MOVED_TOKEN, amount: MOVED, unit: 'usd', mint: MINT, from: idA }]);
    expect(moved).toMatchObject({ from: idA, to: idB, unit: 'usd', withdrawn: MOVED, credited: MOVED, balanceMsub: MOVED * 1000 });
    expect(balanceAt(b, moved.key)).toBe(MOVED * 1000);
    expect(balanceAt(a, key)).toBe(500);
  });

  it('a funding request lost on the way is fund_unknown; the retry with newKey credits it once', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const key = fundedAtA(a);
    receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    await pool.prepare(idB);
    let drop = true;
    net.routes.set(B, (r) => {
      if (drop && new URL(r.url).pathname === '/ohttp') {
        drop = false;
        throw new TypeError('fetch failed');
      }
      return b.fetch(r);
    });
    const err = await moveBalance(pool, { from: idA, key, to: idB }).catch((e) => e);
    expect(err).toBeInstanceOf(MoveBalanceError);
    expect(err).toMatchObject({ code: 'fund_unknown', token: MOVED_TOKEN, to: idB, key: expect.any(String) });
    expect(balanceAt(b, err.key)).toBeUndefined();

    const again = await moveBalance(pool, { from: idA, key, to: idB, newKey: err.key, token: { token: err.token, unit: 'usd', mint: MINT } });
    expect(again).toMatchObject({ to: idB, key: err.key, withdrawn: 0, credited: MOVED, balanceMsub: MOVED * 1000 });
    expect(balanceAt(b, err.key)).toBe(MOVED * 1000);
  });

  it('a funding answer lost on the way back is fund_unknown; the retry credits nothing twice', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const key = fundedAtA(a);
    receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    await pool.prepare(idB);
    let drop = true;
    net.routes.set(B, async (r) => {
      if (drop && new URL(r.url).pathname === '/ohttp') {
        drop = false;
        await b.fetch(r); // B runs the funding; its answer never arrives
        throw new TypeError('fetch failed');
      }
      return b.fetch(r);
    });
    const err = await moveBalance(pool, { from: idA, key, to: idB }).catch((e) => e);
    expect(err).toMatchObject({ code: 'fund_unknown', token: MOVED_TOKEN, to: idB });
    expect(balanceAt(b, err.key)).toBe(MOVED * 1000);

    const again = await moveBalance(pool, { from: idA, key, to: idB, newKey: err.key, token: { token: err.token, unit: 'usd', mint: MINT } });
    expect(again).toMatchObject({ key: err.key, credited: 0, balanceMsub: MOVED * 1000 });
    expect(balanceAt(b, err.key)).toBe(MOVED * 1000);
    // With any other key the token is spent: a refusal for good.
    const other = await moveBalance(pool, { from: idA, key, to: idB, newKey: newBalanceKey(), token: { token: err.token, unit: 'usd', mint: MINT } }).catch((e) => e);
    expect(other).toMatchObject({ code: 'fund_failed' });
    expect(balanceAt(b, err.key)).toBe(MOVED * 1000);
  });

  it('retries a funding the operator reports as pending, and it completes', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const key = fundedAtA(a);
    const { receive, spy } = receiving(b);
    spy.mockRejectedValueOnce(new PaymentError('mint_unavailable', 'mint did not answer; retry with the same token', 503)).mockImplementation(receive as never);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const moved = await moveBalance(pool, { from: idA, key, to: idB, pendingRetries: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(moved).toMatchObject({ credited: MOVED, balanceMsub: MOVED * 1000 });
    expect(balanceAt(b, moved.key)).toBe(MOVED * 1000);
  });

  it('a server error after the funding went pending is fund_unknown, never fund_failed', async () => {
    for (const fault of [new PaymentError('mint_unavailable', 'mint did not answer; retry with the same token', 503), new TypeError('mint offline during recovery')]) {
      const { net, a, b, idA, idB } = twoOperators();
      const key = fundedAtA(a);
      const { spy } = receiving(b);
      spy.mockRejectedValue(fault);
      const pool = poolOf(net, [a.announcement, b.announcement]);
      const err = await moveBalance(pool, { from: idA, key, to: idB, pendingRetries: 1 }).catch((e) => e);
      expect(spy).toHaveBeenCalledTimes(2); // the first answer is topup_pending, the retry gets the raw error
      expect(err, String(fault)).toMatchObject({ code: 'fund_unknown', token: MOVED_TOKEN, to: idB, key: expect.any(String) });
      expect(err.message).toMatch(fault instanceof PaymentError ? /HTTP 503/ : /HTTP 500/);
      // The account was kept for recovery under the key in the error.
      expect(balanceAt(b, err.key)).toBe(0);
    }
  });

  it('a withdrawal the old operator cannot issue yet is withdraw_pending', async () => {
    const { net, a, b, idA } = twoOperators();
    const key = fundedAtA(a, { issue: 'fail' });
    receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const onToken = vi.fn();
    const err = await moveBalance(pool, { from: idA, key, onToken }).catch((e) => e);
    expect(err).toBeInstanceOf(MoveBalanceError);
    expect(err.code).toBe('withdraw_pending');
    expect(onToken).not.toHaveBeenCalled();
    // The withdrawal is owed and listed, with its mint, at GET /v1/wallet/refunds.
    const { response } = await pool.fetch('/v1/wallet/refunds', { headers: { authorization: `Bearer ${key}` } }, { operator: idA });
    expect((await response.json()).data).toEqual([expect.objectContaining({ amount: MOVED, unit: 'usd', mint: MINT, status: 'owed', token: null })]);
  });

  it('never sends the token or a key to an operator that does not take its mint; a refusing operator never sees the funded key', async () => {
    const net = network();
    const C = 'https://c.bellows.test';
    const D = 'https://d.bellows.test';
    const a = bellows(A, KEY_A);
    const b = bellows(B, KEY_B);
    const c = bellows(C, KEY_X, { mints: ['http://127.0.0.1:2'] }); // another mint
    const d = bellows(D, new Uint8Array(32).fill(0x44), { env: { BELLOWS_INVITE_ONLY: 'true' } }); // refuses: invite needed
    for (const x of [a, b, c, d]) net.add(x);
    const key = fundedAtA(a);
    receiving(b);
    receiving(d);
    const dKeys = vi.spyOn(d.deps.ledger, 'findByKey');
    const pool = poolOf(net, [c.announcement, d.announcement, a.announcement, b.announcement]);
    for (const x of [c, d, b]) await pool.prepare(idOf(x.announcement));
    const toC = net.hits.get(C) ?? 0;
    const moved = await moveBalance(pool, { from: idOf(a.announcement), key });
    expect(moved.to).toBe(idOf(b.announcement));
    expect(net.hits.get(C) ?? 0).toBe(toC);
    // D was asked and refused; it saw a key of its own, never the one B now holds the balance under.
    const seenByD = dKeys.mock.calls.map((x) => x[0]);
    expect(seenByD.length).toBeGreaterThan(0);
    expect(seenByD).not.toContain(moved.key);
    expect(balanceAt(b, moved.key)).toBe(MOVED * 1000);
    expect(d.deps.ledger.totals().reduce((n, t) => n + t.balances, 0)).toBe(0);
  });

  it('a withdrawal answered without its mint is withdrawn_unroutable: onToken gets the token first, and the move can be finished', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const key = fundedAtA(a);
    const { spy } = receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const real = pool.fetch.bind(pool);
    const fetchSpy = vi.spyOn(pool, 'fetch').mockImplementation(async (path, init, opts) => {
      const out = await real(path, init, opts);
      if (path !== '/v1/wallet/refund') return out;
      // The old operator withdraws for real, but its answer leaves the mint out.
      const { mint: _mint, ...rest } = (await out.response.json()) as Record<string, unknown>;
      return { ...out, response: Response.json(rest) };
    });
    const onToken = vi.fn();
    const err = await moveBalance(pool, { from: idA, key, onToken }).catch((e) => e);
    expect(err).toBeInstanceOf(MoveBalanceError);
    expect(err).toMatchObject({ code: 'withdrawn_unroutable', token: MOVED_TOKEN, key: expect.any(String) });
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith({ token: MOVED_TOKEN, amount: MOVED, unit: 'usd', from: idA });
    expect(spy).not.toHaveBeenCalled();
    expect(balanceAt(a, key)).toBe(500);
    fetchSpy.mockRestore();

    const done = await moveBalance(pool, { from: idA, key, to: idB, newKey: err.key, token: { token: err.token, unit: 'usd', mint: MINT } });
    expect(done).toMatchObject({ to: idB, key: err.key, credited: MOVED });
    expect(balanceAt(b, err.key)).toBe(MOVED * 1000);
  });

  it('a destination limiting requests (429) is fund_retry with the token and key, never fund_failed; the token stays untouched', async () => {
    // One request a minute and a burst of 5 at B, spent before the move: B answers 429 with a Retry-After of about a minute.
    const { net, a, b, idA, idB } = twoOperators({ b: { env: { BELLOWS_ANON_RATE_LIMIT_RPM: '1' } } });
    const key = fundedAtA(a);
    const { spy } = receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    for (let i = 0; i < 5; i++) await pool.fetch('/v1/wallet/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, { operator: idB });
    spy.mockClear();
    const err = await moveBalance(pool, { from: idA, key, to: idB }).catch((e) => e);
    expect(err).toBeInstanceOf(MoveBalanceError);
    expect(err).toMatchObject({ code: 'fund_retry', token: MOVED_TOKEN, to: idB, key: expect.any(String) });
    expect(err.message).toMatch(/HTTP 429/);
    expect(spy).not.toHaveBeenCalled();
    expect(balanceAt(b, err.key)).toBeUndefined();

    // A minute later the same to, newKey and token fund the balance.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      const again = await moveBalance(pool, { from: idA, key, to: idB, newKey: err.key, token: { token: err.token, unit: 'usd', mint: MINT } });
      expect(again).toMatchObject({ to: idB, key: err.key, credited: MOVED, balanceMsub: MOVED * 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out a short Retry-After and then funds', async () => {
    const { net, a, b, idA, idB } = twoOperators();
    const key = fundedAtA(a);
    receiving(b);
    const pool = poolOf(net, [a.announcement, b.announcement]);
    const real = pool.fetch.bind(pool);
    let topups = 0;
    vi.spyOn(pool, 'fetch').mockImplementation(async (path, init, opts) => {
      if (path === '/v1/wallet/topup' && topups++ === 0) {
        const op = await pool.prepare(idB);
        return { operator: op, response: Response.json({ error: { code: 'rate_limited', message: 'too many requests' } }, { status: 429, headers: { 'Retry-After': '1' } }) };
      }
      return real(path, init, opts);
    });
    const started = Date.now();
    const moved = await moveBalance(pool, { from: idA, key, to: idB });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(topups).toBe(2);
    expect(moved).toMatchObject({ to: idB, credited: MOVED });
    expect(balanceAt(b, moved.key)).toBe(MOVED * 1000);
  });

  it('a 429 after a pending answer is fund_unknown with to and key; the next operator is never asked', async () => {
    const net = network();
    const C = 'https://c.bellows.test';
    const a = bellows(A, KEY_A);
    const b = bellows(B, KEY_B);
    const c = bellows(C, KEY_X);
    for (const x of [a, b, c]) net.add(x);
    const key = fundedAtA(a);
    receiving(b);
    const atC = receiving(c);
    const pool = poolOf(net, [a.announcement, b.announcement, c.announcement]);
    const idB = idOf(b.announcement);
    const idC = idOf(c.announcement);
    const real = pool.fetch.bind(pool);
    const topups: string[] = [];
    vi.spyOn(pool, 'fetch').mockImplementation(async (path, init, opts) => {
      if (path !== '/v1/wallet/topup') return real(path, init, opts);
      topups.push(String(opts?.operator));
      if (opts?.operator !== idB) return real(path, init, opts);
      const op = await pool.prepare(idB);
      // B first reports the funding as pending, then limits requests: the swap may still finish at B.
      if (topups.length === 1) return { operator: op, response: Response.json({ error: { code: 'topup_pending', message: 'funding pending' } }, { status: 503 }) };
      return { operator: op, response: Response.json({ error: { code: 'rate_limited', message: 'too many requests' } }, { status: 429, headers: { 'Retry-After': '1' } }) };
    });
    const err = await moveBalance(pool, { from: idOf(a.announcement), key, pendingRetries: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(MoveBalanceError);
    expect(err.code).not.toBe('fund_retry');
    expect(err).toMatchObject({ code: 'fund_unknown', token: MOVED_TOKEN, to: idB, key: expect.any(String) });
    expect(topups).toEqual([idB, idB]);
    expect(topups).not.toContain(idC);
    expect(atC.spy).not.toHaveBeenCalled();
  });

  it('without a destination, an operator limiting requests is passed over and the next one is asked', async () => {
    const net = network();
    const C = 'https://c.bellows.test';
    const a = bellows(A, KEY_A);
    const b = bellows(B, KEY_B, { env: { BELLOWS_ANON_RATE_LIMIT_RPM: '1' } });
    const c = bellows(C, KEY_X);
    for (const x of [a, b, c]) net.add(x);
    const key = fundedAtA(a);
    const atB = receiving(b);
    receiving(c);
    const pool = poolOf(net, [a.announcement, b.announcement, c.announcement]);
    const idB = idOf(b.announcement);
    for (let i = 0; i < 5; i++) await pool.fetch('/v1/wallet/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, { operator: idB });
    atB.spy.mockClear();
    const moved = await moveBalance(pool, { from: idOf(a.announcement), key });
    expect(moved.to).toBe(idOf(c.announcement));
    expect(atB.spy).not.toHaveBeenCalled();
    expect(balanceAt(c, moved.key)).toBe(MOVED * 1000);
  });

  it('a no_destination error carries a key no refusing operator has seen', async () => {
    const net = network();
    const a = bellows(A, KEY_A);
    const d = bellows(B, KEY_B, { env: { BELLOWS_INVITE_ONLY: 'true' } });
    net.add(a);
    net.add(d);
    const key = fundedAtA(a);
    receiving(d);
    const dKeys = vi.spyOn(d.deps.ledger, 'findByKey');
    const pool = poolOf(net, [a.announcement, d.announcement]);
    const err = await moveBalance(pool, { from: idOf(a.announcement), key }).catch((e) => e);
    expect(err).toMatchObject({ code: 'no_destination', token: MOVED_TOKEN, key: expect.any(String) });
    expect(dKeys.mock.calls.map((x) => x[0])).not.toContain(err.key);
  });
});

describe('the announcement a Bellows serves', () => {
  const catalog = { suppliers: { mock: { type: 'mock', tier: 'standard' } }, models: [{ id: 'm', supplier: 'mock', upstream: 'm', input_usd_per_mtok: 1, output_usd_per_mtok: 1 }] };
  const dir = mkdtempSync(join(tmpdir(), 'bellows-ann-'));
  let n = 0;
  const load = (f: Partial<OperatorAnnouncementFields>, env: Record<string, string> = {}) => {
    const path = join(dir, `a${n++}.json`);
    writeFileSync(path, JSON.stringify(signOperatorAnnouncement(fields(f), KEY_A)));
    return () => loadConfig({ BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: `${MINT},https://mint.example`, BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: path, ...env } as NodeJS.ProcessEnv, catalog);
  };

  it('is accepted when it matches the configuration', () => {
    expect(load({ relays: ['https://r.example/relay/a'], measurement: devMeasurement(), units: ['sat'], mints: ['https://mint.example'] }, { BELLOWS_RELAYS: 'https://r.example/relay/a' })).not.toThrow();
    // The measurement is optional.
    expect(load({})).not.toThrow();
  });

  it('is refused at startup when it does not match', () => {
    expect(load({ relays: ['https://r.example/relay/a'] })).toThrow(/lists the relays \[https:\/\/r.example\/relay\/a\] and BELLOWS_RELAYS is \[\]/);
    expect(load({}, { BELLOWS_RELAYS: 'https://r.example/relay/a' })).toThrow(/BELLOWS_RELAYS/);
    expect(load({ version: '9.9.9' })).toThrow(/names version 9.9.9/);
    expect(load({ measurement: devMeasurement('ef'.repeat(32)) })).toThrow(/build measurement/);
    expect(load({ units: ['sat'] }, { BELLOWS_UNITS: 'usd', BELLOWS_DEFAULT_UNIT: 'usd' })).toThrow(/unit sat/);
    expect(load({ mints: ['https://unlisted-mint.example'] })).toThrow(/mint https:\/\/unlisted-mint.example/);
  });

  it('can be given inline in BELLOWS_OPERATOR_ANNOUNCEMENT, as a keyserver releases it, with the same checks', () => {
    const inline = (f: Partial<OperatorAnnouncementFields>, env: Record<string, string> = {}) => () =>
      loadConfig(
        { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: `${MINT},https://mint.example`, BELLOWS_OPERATOR_ANNOUNCEMENT: JSON.stringify(signOperatorAnnouncement(fields(f), KEY_A)), ...env } as NodeJS.ProcessEnv,
        catalog,
      );
    const event = signOperatorAnnouncement(fields({}), KEY_A);
    const c = loadConfig({ BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: `${MINT},https://mint.example`, BELLOWS_OPERATOR_ANNOUNCEMENT: JSON.stringify(event) } as NodeJS.ProcessEnv, catalog);
    expect(c.operatorAnnouncement).toEqual(event);
    expect(inline({ version: '9.9.9' })).toThrow(/operator announcement in BELLOWS_OPERATOR_ANNOUNCEMENT does not match this Bellows: it names version 9.9.9/);
    expect(inline({ mints: ['https://unlisted-mint.example'] })).toThrow(/mint https:\/\/unlisted-mint.example/);
    const base = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: MINT } as Record<string, string>;
    expect(() => loadConfig({ ...base, BELLOWS_OPERATOR_ANNOUNCEMENT: '{not json' } as NodeJS.ProcessEnv, catalog)).toThrow(/BELLOWS_OPERATOR_ANNOUNCEMENT is not JSON/);
    expect(() => loadConfig({ ...base, BELLOWS_OPERATOR_ANNOUNCEMENT: '[1]' } as NodeJS.ProcessEnv, catalog)).toThrow(/must hold a JSON object/);
    expect(() => loadConfig({ ...base, BELLOWS_OPERATOR_ANNOUNCEMENT: JSON.stringify({ ...event, content: 'changed' }) } as NodeJS.ProcessEnv, catalog)).toThrow(/not a signed Bellows announcement/);
    const path = join(dir, 'both.json');
    writeFileSync(path, JSON.stringify(event));
    expect(() => loadConfig({ ...base, BELLOWS_OPERATOR_ANNOUNCEMENT: JSON.stringify(event), BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: path } as NodeJS.ProcessEnv, catalog)).toThrow(/not both/);
  });

  it('is refused when its signature is broken', () => {
    const path = join(dir, 'tampered.json');
    writeFileSync(path, JSON.stringify({ ...signOperatorAnnouncement(fields(), KEY_A), content: 'changed' }));
    expect(() => loadConfig({ BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: MINT, BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: path } as NodeJS.ProcessEnv, catalog)).toThrow(/not a signed Bellows announcement/);
  });
});
