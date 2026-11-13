/**
 * Other-mint discovery (src/mint-discovery.ts) and the funding policy built on it. Event vectors and
 * the relay-socket cases are adapted from cashucard/cashucard ops/test/discovery.test.ts @ b5ffe8a;
 * the recorded fixture is that repo's ops/test/fixtures/nip87/relays-2026-11-08.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { FundingService } from '../../src/funding.ts';
import {
  createDiscovery,
  createRelayQuery,
  discoverMints,
  type DiscoveredMint,
  type MintDiscovery,
  type MintProbe,
  type NostrEvent,
  normalizeDiscoveryUrl,
  parseNip87,
  parseStored,
  probeMint,
  rankCandidates,
  type RelayAnswer,
  type RelayQuery,
  type SocketLike,
  sqliteStore,
  verifyEvent,
} from '../../src/mint-discovery.ts';

// ── signed test events ────────────────────────────────────────────────────

/** Deterministic test keys: never a real identity. */
function key(n: number): Uint8Array {
  const k = new Uint8Array(32);
  k[31] = n;
  k[0] = 0x11;
  return k;
}

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const DAY = 86_400;

function sign(n: number, kind: number, tags: string[][], createdAt = NOW_S - DAY, content = ''): NostrEvent {
  const priv = key(n);
  const pubkey = bytesToHex(schnorr.getPublicKey(priv));
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, createdAt, kind, tags, content]))));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), priv));
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

const announce = (n: number, url: string, extra: string[][] = []) => sign(n, 38172, [['d', 'x'], ['u', url], ['n', 'mainnet'], ...extra]);
const review = (n: number, url: string, createdAt?: number, content = '') =>
  sign(
    n,
    38000,
    [
      ['k', '38172'],
      ['d', 'x'],
      ['u', url],
    ],
    createdAt,
    content,
  );

/** An announcement plus reviewers from..from+count-1 for url. */
function mint(url: string, count: number, from = 100): NostrEvent[] {
  return [announce(1, url), ...Array.from({ length: count }, (_, i) => review(from + i, url))];
}

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/nip87/relays-2026-11-08.json'), 'utf8')) as NostrEvent[];

describe('event verification', () => {
  it('recorded relay events verify, and a tampered copy does not', () => {
    expect(recorded.length).toBeGreaterThan(30);
    for (const ev of recorded) expect(verifyEvent(ev), ev.id).toBe(true);
    const ev = recorded[0]!;
    expect(verifyEvent({ ...ev, content: ev.content + 'x' })).toBe(false);
    expect(verifyEvent({ ...ev, created_at: ev.created_at + 1 })).toBe(false);
    const flipped = (ev.sig[0] === '0' ? '1' : '0') + ev.sig.slice(1);
    expect(verifyEvent({ ...ev, sig: flipped })).toBe(false);
    for (const junk of [null, 1, 'x', [], {}, { ...ev, tags: [[1]] }]) expect(verifyEvent(junk)).toBe(false);
  });

  it('a locally signed event verifies; a bad id or a signature by another key does not', () => {
    const good = review(2, 'https://mint.example');
    expect(verifyEvent(good)).toBe(true);
    expect(verifyEvent({ ...good, id: 'ab'.repeat(32) })).toBe(false);
    const other = review(3, 'https://mint.example');
    expect(verifyEvent({ ...good, sig: other.sig })).toBe(false);
  });
});

describe('parseNip87', () => {
  it('groups the recorded events by normalized URL', () => {
    const map = parseNip87(recorded, Date.UTC(2026, 10, 9, 6, 0, 0));
    const minibits = map.get('https://mint.minibits.cash/Bitcoin');
    expect(minibits && minibits.reviewers.size).toBeGreaterThanOrEqual(10);
    expect(minibits!.announced).toBe(false);
    expect(map.get('https://mint.gitvid.net')?.announced).toBe(true);
    expect(map.get('https://mint.cashu.chat')?.announced).toBe(false); // its `n` is not mainnet
  });

  it('counts one reviewer once and merges URL spellings', () => {
    const url = 'https://mint.example/Bitcoin';
    const map = parseNip87(
      [
        announce(1, 'https://MINT.example/Bitcoin/'),
        review(2, url),
        sign(
          2,
          38000,
          [
            ['k', '38172'],
            ['u', url],
          ],
          NOW_S - 2 * DAY,
        ),
        review(3, 'https://mint.example/Bitcoin/'),
        review(3, url), // a duplicate reviewer
      ],
      NOW,
    );
    expect([...map.keys()]).toEqual([url]);
    expect(map.get(url)!.announced).toBe(true);
    expect(map.get(url)!.reviewers.size).toBe(2);
  });

  it('ignores malformed, forged, stale, future and off-topic events', () => {
    const url = 'https://mint.example';
    const good = review(2, url);
    const events: unknown[] = [
      null,
      'event',
      42,
      [],
      { ...good, id: 'ab'.repeat(32) }, // tampered id
      { ...review(3, url), sig: 'cd'.repeat(64) }, // bad signature
      { ...review(4, url), pubkey: 'XYZ' }, // pubkey not hex64
      review(5, url, NOW_S + 601), // 10+ minutes in the future
      review(6, url, NOW_S - 731 * DAY), // older than 24 months
      sign(7, 38000, [
        ['k', '38173'],
        ['u', url],
      ]), // a fedimint review
      sign(8, 38000, [['u', url]]), // no k
      sign(9, 38000, [['k', '38172']]), // no u
      sign(10, 38172, [['d', 'x']]), // announcement, no u
      announce(11, url, [['n', 'testnet']]), // non-mainnet
      sign(12, 1, [['u', url]]), // another kind
      sign(13, 38000, [
        ['k', '38172'],
        ['u', 'http://mint.example'],
      ]), // not https
      sign(14, 38000, [
        ['k', '38172'],
        ['u', 'https://127.0.0.1'],
      ]), // an IP
    ];
    expect(parseNip87(events, NOW).size).toBe(0);
    const inside = parseNip87([review(5, url, NOW_S + 599), review(6, url, NOW_S - 729 * DAY)], NOW);
    expect(inside.get(url)!.reviewers.size).toBe(2);
    // an old announcement still counts: only reviews expire
    expect(parseNip87([sign(1, 38172, [['u', url]], NOW_S - 1000 * DAY)], NOW).get(url)!.announced).toBe(true);
  });

  it('reads at most 5 u tags per event and verifies an id once', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://m${i}.example`);
    const many = sign(2, 38000, [['k', '38172'], ...urls.map((u) => ['u', u])]);
    let verified = 0;
    const map = parseNip87([many, many, many], NOW, (ev): ev is NostrEvent => {
      verified++;
      return verifyEvent(ev);
    });
    expect(map.size).toBe(5);
    expect(verified).toBe(1);
  });

  it('one relay cannot shadow a genuine event with a forged copy of its id', () => {
    const url = 'https://mint.example';
    const reviews = [review(2, url), review(3, url), review(4, url)];
    const badSig = reviews.map((r) => ({ ...r, sig: 'cd'.repeat(64) }));
    const altered = reviews.map((r) => ({ ...r, content: 'tampered' }));
    for (const forged of [badSig, altered]) {
      let verified = 0;
      const map = parseNip87([announce(1, url), ...forged, ...reviews, ...reviews], NOW, (ev): ev is NostrEvent => {
        verified++;
        return verifyEvent(ev);
      });
      expect(map.get(url)?.reviewers.size).toBe(3);
      expect(verified).toBe(forged === badSig ? 7 : 4);
    }
  });

  it('keeps each reviewer\'s latest rating', () => {
    const url = 'https://rated.example';
    const map = parseNip87([announce(1, url), review(2, url, NOW_S - 3 * DAY, '[1/5] meh'), review(2, url, NOW_S - DAY, '[5/5] great'), review(3, url, undefined, '[4/5]'), review(4, url)], NOW);
    const e = map.get(url)!;
    expect(e.reviewers.size).toBe(3);
    expect([...e.ratings.values()].map((r) => r.rating).sort()).toEqual([4, 5]);
  });
});

describe('normalizeDiscoveryUrl', () => {
  it('takes only public https mint URLs, unless insecure mode is on', () => {
    expect(normalizeDiscoveryUrl('https://Mint.Example/Bitcoin/')).toBe('https://mint.example/Bitcoin');
    for (const bad of ['http://mint.example', 'https://127.0.0.1', 'https://mint.local', 'https://u:p@mint.example', 'https://mint.example?x=1', 'https://mint.example:8443', 'https://localhost', 42]) {
      expect(normalizeDiscoveryUrl(bad), String(bad)).toBeUndefined();
    }
    expect(normalizeDiscoveryUrl('http://127.0.0.1:3339/', true)).toBe('http://127.0.0.1:3339');
    expect(normalizeDiscoveryUrl('https://u:p@127.0.0.1', true)).toBeUndefined();
  });
});

// ── discoverMints ────────────────────────────────────────────────────────

const answer = (events: unknown[]): RelayAnswer => ({ answered: true, events });
const relaysOf =
  (...answers: (RelayAnswer | Error)[]): RelayQuery =>
  async (relay) => {
    const a = answers[['r0', 'r1', 'r2'].indexOf(relay)];
    if (a instanceof Error) throw a;
    return a ?? { answered: false, events: [] };
  };
const RELAYS = ['r0', 'r1', 'r2'];
const okProbe = async (url: string): Promise<MintProbe> => ({ url, ok: true, units: ['sat'], name: `name of ${new URL(url).hostname}` });
const base = { relays: RELAYS, minReviewers: 3, maxDiscovered: 10, units: ['sat', 'usd'], probe: okProbe, now: () => NOW };

describe('discoverMints', () => {
  it('ranks by reviewers, applies the floor, needs an announcement and drops excluded mints', async () => {
    const events = [
      ...mint('https://three.example', 3),
      ...mint('https://five.example', 5),
      ...mint('https://bbb.example', 4),
      ...mint('https://aaa.example', 4),
      ...mint('https://two.example', 2), // below the floor
      ...Array.from({ length: 9 }, (_, i) => review(200 + i, 'https://unannounced.example')),
      ...mint('https://mint.example', 9), // the gateway's own mint is never "discovered"
    ];
    const result = await discoverMints({ ...base, query: relaysOf(answer(events)), excluded: ['https://mint.example/'] });
    expect(result.answered).toBe(true);
    expect(result.mints.map((m) => [m.url, m.reviewers])).toEqual([
      ['https://five.example', 5],
      ['https://aaa.example', 4],
      ['https://bbb.example', 4],
      ['https://three.example', 3],
    ]);
    expect(result.mints[0]!.name).toBe('name of five.example');
    expect(result.mints[0]!.probed_at).toBe(NOW);
    expect(result.rejected).toContainEqual({ url: 'https://two.example', reviewers: 2, reason: '2 of 3 reviewers' });
    // a lower floor lets the two-reviewer mint in
    const low = await discoverMints({ ...base, minReviewers: 2, query: relaysOf(answer(events)), excluded: ['https://mint.example'] });
    expect(low.mints.map((m) => m.url)).toContain('https://two.example');
  });

  it('probes a bounded candidate list with a pool of 3, caps the result, and reports failures', async () => {
    const events = Array.from({ length: 20 }, (_, i) => mint(`https://m${String(i).padStart(2, '0')}.example`, 3 + (20 - i))).flat();
    const probed: string[] = [];
    let live = 0;
    let peak = 0;
    const result = await discoverMints({
      ...base,
      query: relaysOf(answer(events)),
      excluded: ['https://M00.example/', 'not a url'],
      probe: async (url) => {
        probed.push(url);
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 1));
        live--;
        if (url === 'https://m01.example') return { url, ok: false, reason: 'info: no NUT-05 melt' };
        if (url === 'https://m02.example') throw new Error('boom');
        return { url, ok: true, units: ['sat'] };
      },
    });
    expect(probed.length).toBe(15);
    expect(probed).not.toContain('https://m00.example');
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.mints.length).toBe(10);
    expect(result.mints[0]!.url).toBe('https://m03.example');
    expect(result.rejected).toContainEqual({ url: 'https://m01.example', reviewers: 22, reason: 'probe: info: no NUT-05 melt' });
    expect(result.rejected).toContainEqual({ url: 'https://m02.example', reviewers: 21, reason: 'probe: probe threw' });
    expect(result.rejected.filter((r) => r.reason === 'over the list cap').length).toBe(3);
  });

  it('merges a partial relay failure and reports no answer when all fail', async () => {
    const url = 'https://split.example';
    const [a, ...reviews] = mint(url, 3);
    const partial = await discoverMints({ ...base, query: relaysOf(answer([a, reviews[0]]), new Error('down'), answer([reviews[1], reviews[2], a])) });
    expect(partial.mints.map((m) => m.url)).toEqual([url]);
    expect(partial.relays.map((r) => r.answered)).toEqual([true, false, true]);
    const none = await discoverMints({ ...base, query: relaysOf(new Error('down'), { answered: false, events: [] }) });
    expect(none.answered).toBe(false);
    expect(none.mints).toEqual([]);
  });
});

// ── probeMint ────────────────────────────────────────────────────────────

describe('probeMint', () => {
  const fake =
    (info: unknown, keysets: unknown, status = 200) =>
    async (url: string) =>
      new Response(JSON.stringify(url.endsWith('/v1/info') ? info : keysets), { status });
  const nuts = (methods: unknown[], disabled = false) => ({ '5': { methods, disabled } });

  it('needs an active keyset in a gateway unit with bolt11 melt in that unit', async () => {
    const ks = { keysets: [{ id: '00aa', unit: 'sat', active: true }, { id: '00bb', unit: 'eur', active: true }, { id: '00cc', unit: 'usd', active: false }] };
    const ok = await probeMint('https://m.example', ['sat', 'usd'], fake({ name: ' Good\nMint ', nuts: nuts([{ method: 'bolt11', unit: 'sat' }]) }, ks));
    expect(ok).toEqual({ url: 'https://m.example', ok: true, units: ['sat'], name: 'GoodMint' });
    const noMelt = await probeMint('https://m.example', ['sat'], fake({ nuts: nuts([{ method: 'bolt11', unit: 'eur' }]) }, ks));
    expect(noMelt).toMatchObject({ ok: false, reason: 'info: no bolt11 melt in an active unit' });
    const disabled = await probeMint('https://m.example', ['sat'], fake({ nuts: nuts([{ method: 'bolt11', unit: 'sat' }], true) }, ks));
    expect(disabled).toMatchObject({ ok: false, reason: 'info: no NUT-05 melt' });
    const inactive = await probeMint('https://m.example', ['usd'], fake({ nuts: nuts([{ method: 'bolt11', unit: 'usd' }]) }, ks));
    expect(inactive).toMatchObject({ ok: false, reason: 'keysets: no active usd' });
    const down = await probeMint('https://m.example', ['sat'], fake({}, {}, 502));
    expect(down).toMatchObject({ ok: false, reason: 'info: http 502' });
    const thrown = await probeMint('https://m.example', ['sat'], async () => {
      throw new TypeError('fetch failed');
    });
    expect(thrown).toMatchObject({ ok: false, reason: 'info: TypeError' });
  });
});

// ── the cached set ───────────────────────────────────────────────────────

function controlled(initial: unknown[]) {
  let calls = 0;
  let up = true;
  let events = initial;
  const gates: (() => void)[] = [];
  let hold = false;
  const query: RelayQuery = async () => {
    calls++;
    if (hold) await new Promise<void>((r) => gates.push(r));
    return up ? answer(events) : { answered: false, events: [] };
  };
  return {
    query,
    get calls() {
      return calls;
    },
    set up(v: boolean) {
      up = v;
    },
    set events(v: unknown[]) {
      events = v;
    },
    set hold(v: boolean) {
      hold = v;
    },
    release() {
      for (const g of gates.splice(0)) g();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const HOUR = 3_600_000;

describe('createDiscovery', () => {
  it('a request never waits on a relay: snapshot returns at once and refreshes in the background', async () => {
    let t = NOW;
    const relay = controlled(mint('https://one.example', 3));
    relay.hold = true;
    const d = createDiscovery({ ...base, relays: ['r0'], query: relay.query, ttlOkMs: HOUR, now: () => t });
    expect(relay.calls).toBe(0); // no I/O at construction
    const started = performance.now();
    expect(d.snapshot()).toEqual([]);
    expect(d.snapshot()).toEqual([]); // concurrent snapshots start one refresh
    expect(performance.now() - started).toBeLessThan(50);
    await flush();
    expect(relay.calls).toBe(1);
    expect(d.status().refreshing).toBe(true);
    relay.release();
    await flush();
    expect(d.snapshot().map((m) => m.url)).toEqual(['https://one.example']);
    t += HOUR - 1;
    d.snapshot();
    await flush();
    expect(relay.calls).toBe(1); // cached for the TTL
    t += 1;
    relay.hold = false;
    relay.events = mint('https://two.example', 4);
    d.snapshot();
    await flush();
    expect(relay.calls).toBe(2);
    expect(d.snapshot().map((m) => m.url)).toEqual(['https://two.example']);
  });

  it('keeps the old set when no relay answers and retries after the failure TTL', async () => {
    let t = NOW;
    const relay = controlled(mint('https://one.example', 3));
    const d = createDiscovery({ ...base, relays: ['r0'], query: relay.query, ttlOkMs: HOUR, now: () => t });
    await d.refresh();
    relay.up = false;
    t += HOUR;
    d.snapshot();
    await flush();
    expect(relay.calls).toBe(2);
    expect(d.snapshot().map((m) => m.url)).toEqual(['https://one.example']);
    expect(d.status().last_refresh).toMatchObject({ ok: false, error: 'no relay answered' });
    t += 59_999;
    d.snapshot();
    await flush();
    expect(relay.calls).toBe(2);
    t += 1;
    d.snapshot();
    await flush();
    expect(relay.calls).toBe(3);
  });

  it('does nothing without relays (tests and operators who turn discovery off)', async () => {
    let calls = 0;
    const d = createDiscovery({
      ...base,
      relays: [],
      query: async () => {
        calls++;
        return answer([]);
      },
      ttlOkMs: HOUR,
    });
    d.start();
    d.snapshot();
    await d.refresh();
    d.stop();
    expect(calls).toBe(0);
    expect(d.enabled).toBe(false);
  });

  it('round-trips the last-good set through the sqlite meta table, and a bad one is discarded', async () => {
    const db = openDb(':memory:');
    let t = NOW;
    const relay = controlled([...mint('https://one.example', 3), review(9, 'https://one.example', undefined, '[4/5] ok')]);
    const first = createDiscovery({ ...base, relays: ['r0'], query: relay.query, ttlOkMs: HOUR, now: () => t, store: sqliteStore(db) });
    await first.refresh();
    const saved = first.snapshot();
    expect(saved[0]).toMatchObject({ url: 'https://one.example', reviewers: 4, avg_rating: 4, units: ['sat'] });
    // a restart serves the stored set synchronously, with no relay call while it is fresh
    t += HOUR / 2;
    const second = createDiscovery({ ...base, relays: ['r0'], query: relay.query, ttlOkMs: HOUR, now: () => t, store: sqliteStore(db) });
    expect(second.snapshot()).toEqual(saved);
    expect(second.updatedAt()).toBe(NOW);
    await flush();
    expect(relay.calls).toBe(1);
    // a tampered row is discarded
    db.prepare("UPDATE meta SET value = ? WHERE key = 'mint-discovery'").run(JSON.stringify({ v: 1, at: NOW, mints: [{ url: 'http://evil.example', reviewers: 3, units: [], probed_at: NOW }] }));
    const third = createDiscovery({ ...base, relays: [], query: relay.query, ttlOkMs: HOUR, now: () => t, store: sqliteStore(db) });
    expect(third.snapshot()).toEqual([]);
    db.close();
  });

  it('parseStored accepts only the shape it wrote', () => {
    const m: DiscoveredMint = { url: 'https://a.example', reviewers: 2, units: ['sat'], probed_at: NOW, name: 'A' };
    expect(parseStored({ v: 1, at: NOW, mints: [m] }, 10)?.mints).toEqual([m]);
    for (const bad of [null, { v: 2, at: NOW, mints: [] }, { v: 1, at: 'x', mints: [] }, { v: 1, at: NOW, mints: [{ ...m, reviewers: -1 }] }, { v: 1, at: NOW, mints: [{ ...m, name: 'a\nb' }] }, { v: 1, at: NOW, mints: [{ ...m, avg_rating: 9 }] }]) {
      expect(parseStored(bad, 10), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseStored({ v: 1, at: NOW, mints: [{ ...m, url: 'http://127.0.0.1:3339' }] }, 10)).toBeUndefined();
    expect(parseStored({ v: 1, at: NOW, mints: [{ ...m, url: 'http://127.0.0.1:3339' }] }, 10, true)?.mints.length).toBe(1);
  });
});

// ── the relay query over a fake socket ───────────────────────────────────

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private readonly handlers: Record<string, ((e: { data: unknown }) => void)[]> = {};
  private readonly onSend?: (s: FakeSocket, data: string) => void;
  constructor(onSend?: (s: FakeSocket, data: string) => void) {
    this.onSend = onSend;
  }
  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(this, data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, fn: (e: { data: unknown }) => void): void {
    (this.handlers[type] ??= []).push(fn);
  }
  emit(type: string, data?: unknown): void {
    for (const fn of this.handlers[type] ?? []) fn({ data });
  }
}

describe('relay query', () => {
  it('collects events until EOSE and sends CLOSE', async () => {
    const ev = review(2, 'https://x.example');
    const sock = new FakeSocket((s, data) => {
      const msg = JSON.parse(data);
      if (msg[0] !== 'REQ') return;
      queueMicrotask(() => {
        s.emit('message', JSON.stringify(['NOTICE', 'hello']));
        s.emit('message', '{not json');
        s.emit('message', JSON.stringify(['EVENT', 'other-sub', ev]));
        s.emit('message', JSON.stringify(['EVENT', msg[1], ev]));
        s.emit('message', JSON.stringify(['EVENT', msg[1], { ...ev, content: 'x'.repeat(300_000) }]));
        s.emit('message', JSON.stringify(['EOSE', msg[1]]));
        s.emit('message', JSON.stringify(['EVENT', msg[1], ev])); // after EOSE
      });
    });
    const r = await createRelayQuery(async () => sock)('wss://r.example');
    expect(r).toEqual({ answered: true, events: [ev] });
    expect(JSON.parse(sock.sent[0]!).slice(2)).toEqual([
      { kinds: [38172], limit: 500 },
      { kinds: [38000], '#k': ['38172'], limit: 500 },
    ]);
    expect(JSON.parse(sock.sent.at(-1)!)[0]).toBe('CLOSE');
    expect(sock.closed).toBe(true);
  });

  it('ends on timeout and connect failure without throwing', async () => {
    const silent = new FakeSocket();
    expect(await createRelayQuery(async () => silent, 20)('wss://r')).toEqual({ answered: false, events: [] });
    expect(silent.closed).toBe(true);
    const refused = await createRelayQuery(async () => {
      throw new Error('refused');
    })('wss://r');
    expect(refused).toEqual({ answered: false, events: [] });
  });
});

// ── the funding policy ───────────────────────────────────────────────────

const OWN = 'https://own.mint.example';
const LISTED = 'https://listed.example';
const OPERATOR = 'https://operator.example';
const OTHER = 'https://other.example';

function fakeDiscovery(urls: string[]): MintDiscovery {
  const mints = urls.map((url) => ({ url, reviewers: 3, units: ['sat'], probed_at: NOW }));
  return { enabled: true, snapshot: () => mints, refresh: async () => {}, start() {}, stop() {}, updatedAt: () => NOW, status: () => ({}) as never };
}

type ProbeFn = (url: string) => Promise<MintProbe>;
const probedOk: ProbeFn = async (url) => ({ url, ok: true, units: ['sat'], name: 'Probed Mint' });

function service(env: Record<string, string>, discovered: string[] = [LISTED], probe: ProbeFn = probedOk) {
  const e = EnvSchema.parse({ BELLOWS_TRUSTED_MINTS: OWN, BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', BELLOWS_FOREIGN_ALLOW_INSECURE: 'true', ...env });
  const trusted = [OWN];
  const wallet = { trustedMints: trusted, isTrusted: (m: string) => trusted.includes(m.replace(/\/+$/, '')) };
  return new FundingService({ db: openDb(':memory:'), ledger: {} as never, wallet: wallet as never, env: e, rates: {} as never, mint: OWN, discovery: fakeDiscovery(discovered), probe });
}

async function verdict(s: FundingService, mint: string, acceptUnlisted = false): Promise<string> {
  try {
    const v = await s.vetForeignMint(mint, { acceptUnlisted });
    return v.unlisted ? 'ok-unlisted' : 'ok';
  } catch (e) {
    return (e as { code: string }).code;
  }
}

describe('other-mint policy', () => {
  it('discovered: operator list plus discovered mints; deny wins; own mints answer use_topup', async () => {
    const s = service({ BELLOWS_FOREIGN_ALLOW: OPERATOR, BELLOWS_FOREIGN_DENY: 'https://LISTED.example/', BELLOWS_FOREIGN_UNLISTED: 'false' });
    expect(await verdict(s, OPERATOR + '/')).toBe('ok');
    expect(await verdict(s, LISTED)).toBe('mint_not_allowed'); // denied, though discovered
    expect(await verdict(s, OTHER)).toBe('mint_not_allowed');
    expect(await verdict(s, OWN)).toBe('use_topup');
    const open = service({ BELLOWS_FOREIGN_UNLISTED: 'false' });
    expect(await verdict(open, 'https://Listed.example/')).toBe('ok');
    await expect(open.vetForeignMint(OTHER)).rejects.toThrow(/\/v1\/wallet\/fund\/mints/);
  });

  it('allowlist: only the operator list', async () => {
    const s = service({ BELLOWS_FOREIGN_POLICY: 'allowlist', BELLOWS_FOREIGN_ALLOW: OPERATOR, BELLOWS_FOREIGN_UNLISTED: 'false' });
    expect(await verdict(s, OPERATOR)).toBe('ok');
    expect(await verdict(s, LISTED)).toBe('mint_not_allowed');
    expect(await verdict(service({ BELLOWS_FOREIGN_POLICY: 'allowlist', BELLOWS_FOREIGN_UNLISTED: 'false' }), OPERATOR)).toBe('mint_not_allowed');
  });

  it('any: every mint unless an operator list limits it; deny still wins; never asks about unlisted mints', async () => {
    const s = service({ BELLOWS_FOREIGN_POLICY: 'any', BELLOWS_FOREIGN_DENY: OTHER });
    expect(await verdict(s, 'https://whatever.example')).toBe('ok');
    expect(await verdict(s, OTHER)).toBe('mint_not_allowed');
    expect(await verdict(s, OWN)).toBe('use_topup');
    const limited = service({ BELLOWS_FOREIGN_POLICY: 'any', BELLOWS_FOREIGN_ALLOW: OPERATOR });
    expect(await verdict(limited, LISTED)).toBe('mint_not_allowed');
    expect(await verdict(limited, LISTED, true)).toBe('mint_not_allowed');
  });

  it('still runs the URL safety check on an accepted mint', async () => {
    const s = new FundingService({
      db: openDb(':memory:'),
      ledger: {} as never,
      wallet: { trustedMints: [OWN], isTrusted: () => false } as never,
      env: EnvSchema.parse({ BELLOWS_TRUSTED_MINTS: OWN, BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', BELLOWS_FOREIGN_POLICY: 'allowlist', BELLOWS_FOREIGN_ALLOW: 'https://127.0.0.1' }),
      rates: {} as never,
      mint: OWN,
      discovery: fakeDiscovery([]),
    });
    expect(await verdict(s, 'https://127.0.0.1')).toBe('mint_not_allowed');
    // An unlisted private address is refused before the customer is asked.
    expect(await verdict(s, 'https://10.0.0.1')).toBe('mint_not_allowed');
    expect(await verdict(s, 'https://10.0.0.1', true)).toBe('mint_not_allowed');
  });

  it('lists accepted mints without denied or own mints, operator entries first', () => {
    const s = service({ BELLOWS_FOREIGN_ALLOW: `${OPERATOR},${OWN}`, BELLOWS_FOREIGN_DENY: OTHER }, [LISTED, OTHER, OPERATOR]);
    const a = s.acceptedForeignMints();
    expect(a.policy).toBe('discovered');
    expect(a.mints).toEqual([
      { url: OPERATOR, source: 'operator' },
      { url: LISTED, reviewers: 3, source: 'discovered' },
    ]);
    expect(service({ BELLOWS_FOREIGN_POLICY: 'allowlist' }).acceptedForeignMints().mints).toEqual([]);
  });
});

describe('unlisted mints', () => {
  it('discovered and allowlist: an unlisted mint answers mint_unlisted (409) with the mint and cap', async () => {
    for (const policy of ['discovered', 'allowlist']) {
      const s = service({ BELLOWS_FOREIGN_POLICY: policy });
      const err = await s.vetForeignMint(OTHER).catch((e) => e);
      expect(err).toMatchObject({ code: 'mint_unlisted', status: 409, extra: { unlisted: { mint: OTHER, max: { sat: 5000, usd: 500 } } } });
      expect(err.message).toMatch(/not on this gateway's recommended list/);
      expect(await verdict(s, OTHER, true)).toBe('ok-unlisted');
    }
  });

  it('deny wins over accept_unlisted; own mints still answer use_topup', async () => {
    const s = service({ BELLOWS_FOREIGN_DENY: OTHER });
    expect(await verdict(s, OTHER)).toBe('mint_not_allowed');
    expect(await verdict(s, OTHER, true)).toBe('mint_not_allowed');
    expect(await verdict(s, OWN, true)).toBe('use_topup');
  });

  it('off: refused with mint_not_allowed even with the flag', async () => {
    const s = service({ BELLOWS_FOREIGN_UNLISTED: 'false' });
    expect(await verdict(s, OTHER, true)).toBe('mint_not_allowed');
  });

  it('a listed mint is never marked unlisted, even with the flag', async () => {
    expect(await verdict(service({}), LISTED, true)).toBe('ok');
  });

  it('the mint must pass the live probe; results are cached', async () => {
    let calls = 0;
    const s = service({}, [], async (url) => {
      calls++;
      return { url, ok: false, reason: 'info: no NUT-05 melt' };
    });
    expect(await verdict(s, OTHER, true)).toBe('mint_check_failed');
    expect(await verdict(s, OTHER, true)).toBe('mint_check_failed');
    expect(calls).toBe(1);
    let okCalls = 0;
    const t = service({}, [], async (url) => {
      okCalls++;
      return { url, ok: true, units: ['sat'] };
    });
    for (let i = 0; i < 3; i++) expect(await verdict(t, OTHER, true)).toBe('ok-unlisted');
    expect(okCalls).toBe(1);
  });

  it('the cap is the lower of the unlisted and the other-mint caps, and methods() shows it', async () => {
    const s = service({ BELLOWS_FOREIGN_UNLISTED_MAX_SAT: '9000', BELLOWS_FOREIGN_MAX_SAT: '7000', BELLOWS_FOREIGN_UNLISTED_MAX_USD: '300' });
    const err = await s.vetForeignMint(OTHER).catch((e) => e);
    expect(err.extra.unlisted.max).toEqual({ sat: 7000, usd: 300 });
    const off = service({ BELLOWS_FOREIGN_POLICY: 'any' });
    const internal = off as unknown as { unlistedEnabled(): boolean };
    expect(internal.unlistedEnabled()).toBe(false);
  });
});

describe('operator mints (admin)', () => {
  it('an added mint is accepted under discovered and allowlist, listed as operator with its name, and can be removed', async () => {
    for (const policy of ['discovered', 'allowlist']) {
      const s = service({ BELLOWS_FOREIGN_POLICY: policy, BELLOWS_FOREIGN_UNLISTED: 'false' }, []);
      expect(await verdict(s, OTHER)).toBe('mint_not_allowed');
      const r = await s.addOperatorMint('https://Other.example/', 'trusted friend');
      expect(r).toMatchObject({ forced: false, added: true, mint: { url: OTHER, name: 'Probed Mint', note: 'trusted friend' } });
      expect(await verdict(s, OTHER)).toBe('ok');
      expect(s.acceptedForeignMints().mints).toEqual([{ url: OTHER, name: 'Probed Mint', source: 'operator' }]);
      expect(s.removeOperatorMint(OTHER + '/')).toBe(true);
      expect(s.removeOperatorMint(OTHER)).toBe(false);
      expect(await verdict(s, OTHER)).toBe('mint_not_allowed');
    }
  });

  it('under any, an added mint does not limit the policy', async () => {
    const s = service({ BELLOWS_FOREIGN_POLICY: 'any' }, []);
    await s.addOperatorMint(OPERATOR, null);
    expect(await verdict(s, 'https://whatever.example')).toBe('ok');
    expect(s.acceptedForeignMints().mints.map((m) => m.url)).toEqual([OPERATOR]);
  });

  it("refuses the gateway's own, denied and unsafe mints", async () => {
    const s = service({ BELLOWS_FOREIGN_DENY: OTHER, BELLOWS_FOREIGN_ALLOW_INSECURE: 'false' });
    await expect(s.addOperatorMint(OWN + '/', null)).rejects.toMatchObject({ code: 'own_mint', status: 409 });
    await expect(s.addOperatorMint(OTHER, null)).rejects.toMatchObject({ code: 'mint_denied', status: 409 });
    await expect(s.addOperatorMint('http://plain.example', null)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(s.addOperatorMint('https://192.168.1.4', null)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(s.addOperatorMint('', null)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(s.operatorMints()).toEqual([]);
  });

  it('a failed probe refuses the add unless forced, and the forced add is flagged', async () => {
    const s = service({}, [], async (url) => ({ url, ok: false, reason: 'keysets: http 500' }));
    const err = await s.addOperatorMint(OTHER, null).catch((e) => e);
    expect(err).toMatchObject({ code: 'mint_check_failed', status: 400, extra: { probe: { ok: false, reason: 'keysets: http 500' } } });
    expect(s.operatorMints()).toEqual([]);
    const r = await s.addOperatorMint(OTHER, null, true);
    expect(r).toMatchObject({ forced: true, added: true, mint: { url: OTHER, name: null } });
    expect(s.acceptedForeignMints().mints).toEqual([{ url: OTHER, source: 'operator' }]);
  });
});

describe('reviews-only rule (the default)', () => {
  it('ranks an unannounced mint with enough reviewers only when the announcement is not required', () => {
    const map = new Map([
      ['https://reviewed.example', { announced: false, reviewers: new Set(['a', 'b', 'c']), ratings: new Map() }],
      ['https://few.example', { announced: false, reviewers: new Set(['a']), ratings: new Map() }],
    ]) as any;
    expect(rankCandidates(map, 3, new Set(), true)).toEqual([]);
    expect(rankCandidates(map, 3, new Set(), false).map((c: { url: string }) => c.url)).toEqual(["https://reviewed.example"]);
  });
});
