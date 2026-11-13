/**
 * Operators end to end (docs/DESIGN.md, S6), against the local test mints. Three Bellows instances, each
 * with its own operator key and signed announcement:
 *   A  takes eCash from mint A; reached through an Oblivious HTTP relay
 *   B  takes eCash from mint A; opens new balances with proof of work
 *   C  takes eCash from mint B only
 * The client's pool verifies each one, picks, fails over and remembers. A balance funded at A moves to
 * another operator: withdrawn as eCash at A, passed over at C without a request (its attested announcement
 * takes another mint), funded at B. A funding whose answer is lost is finished with the same key, once.
 */
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devVerifier, memoryInProcess, moveBalance, type NostrEvent, OperatorPool, parseOperatorAnnouncement, signOperatorAnnouncement, type Withdrawn } from '../../client/index.ts';
import { createRelay } from '../../relay/relay.ts';
import { devMeasurement } from '../../src/attest/dev.ts';
import { BELLOWS_VERSION } from '../../src/config.ts';
import { chatBody, freePort, type Gateway, MINT_A, MINT_B, mintToken, mintsUp, startGateway } from './helpers.ts';

const up = await mintsUp();
const devBuilds = { format: 'bellows-builds/v1', builds: [{ version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement() }] };

describe.skipIf(!up)('operators: announcements, pool, failover and moving a balance (S6)', () => {
  const gateways = new Map<string, { g: Gateway; closed: boolean }>();
  const ids: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
  const announcements: NostrEvent[] = [];
  let relayServer: ServerType;
  let relayRequests = 0;
  const memory = memoryInProcess();
  let pool: OperatorPool;
  /** Requests the client sent, by origin (an origin is a Bellows or the relay). */
  const sent = new Map<string, number>();
  /** When set, the answer to the n-th Oblivious HTTP request to that origin is thrown away after it ran. */
  let lose: { origin: string; n: number } | null = null;
  const countingFetch = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    sent.set(u.origin, (sent.get(u.origin) ?? 0) + 1);
    if (lose && lose.origin === u.origin && u.pathname === '/ohttp' && --lose.n === 0) {
      lose = null;
      await fetch(url, init);
      throw new TypeError('fetch failed');
    }
    return fetch(url, init);
  };
  const urls: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };

  const json = (body: unknown, key?: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const wallet = async (id: string, key: string) => {
    const { response } = await pool.fetch('/v1/wallet', { headers: { authorization: `Bearer ${key}` } }, { operator: id });
    expect(response.status).toBe(200);
    return (await response.json()) as { unit: string; balance_msub: number; refundable: number };
  };

  beforeAll(async () => {
    const [pA, pB, pC] = [await freePort(), await freePort(), await freePort()];
    const handler = createRelay({ targets: [`http://127.0.0.1:${pA}/ohttp`] });
    relayServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: (r) => (relayRequests++, handler(r)), port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    const relayPath = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}/relay/127.0.0.1:${pA}`;
    const dir = mkdtempSync(join(tmpdir(), 'bellows-operators-'));

    const spec = [
      { name: 'A', port: pA, key: 0x0a, mint: MINT_A, relays: [relayPath], env: {} },
      { name: 'B', port: pB, key: 0x0b, mint: MINT_A, relays: [], env: { BELLOWS_POW_BITS: '8' } },
      { name: 'C', port: pC, key: 0x0c, mint: MINT_B, relays: [], env: { BELLOWS_POW_BITS: '8', BELLOWS_TRUSTED_MINTS: MINT_B } },
    ] as const;
    for (const s of spec) {
      const ev = signOperatorAnnouncement(
        { url: `http://127.0.0.1:${s.port}`, relays: s.relays, version: BELLOWS_VERSION, measurement: devMeasurement(), units: ['usd'], mints: [s.mint], description: `Test operator ${s.name}` },
        new Uint8Array(32).fill(s.key),
      );
      const file = join(dir, `${s.name}.json`);
      writeFileSync(file, JSON.stringify(ev));
      const g = await startGateway({
        inviteOnly: false,
        port: s.port,
        env: { BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: file, BELLOWS_RELAYS: s.relays.join(','), BELLOWS_UNITS: 'usd', BELLOWS_DEFAULT_UNIT: 'usd', ...s.env },
      });
      gateways.set(s.name, { g, closed: false });
      ids[s.name] = parseOperatorAnnouncement(ev).id;
      urls[s.name] = `http://127.0.0.1:${s.port}`;
      announcements.push(ev);
    }
    // The list order puts C first: it takes another mint, so a move has to pass it over.
    pool = new OperatorPool({ operators: [announcements[2], announcements[0], announcements[1]], approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true, memory, fetch: countingFetch });
  });

  afterAll(async () => {
    await new Promise<void>((r) => (relayServer ? relayServer.close(() => r()) : r()));
    for (const x of gateways.values()) if (!x.closed) await x.g.close();
  });

  const stop = async (name: string) => {
    const x = gateways.get(name)!;
    x.closed = true;
    await x.g.close();
  };

  it('verifies every operator, health-checks it and serves its own signed announcement', async () => {
    for (const name of ['A', 'B', 'C'] as const) {
      const op = await pool.prepare(ids[name]);
      expect(op.announcement.description).toBe(`Test operator ${name}`);
      expect(op.verified.development).toBe(true);
    }
    expect((await pool.prepare(ids.A)).endpoint.relay).toMatch(/\/relay\/127\.0\.0\.1:/);
    expect((await pool.prepare(ids.B)).endpoint.relay).toBeNull();
    expect((await pool.pick({ mint: MINT_A })).id).toBe(ids.A);
  });

  let key = '';
  let withdrawn: Withdrawn | undefined;
  let tokenSeenBeforeFunding = false;

  it('funds a balance at A through its relay and spends part of it', async () => {
    const before = relayRequests;
    const token = await mintToken(MINT_A, 'usd', 50);
    const { response } = await pool.fetch('/v1/wallet/topup', json({ token }), { operator: ids.A });
    expect(response.status).toBe(200);
    key = ((await response.json()) as { key: string }).key;
    const chat = await pool.fetch('/v1/chat/completions', json(chatBody('mock-echo'), key), { operator: ids.A });
    expect(chat.response.status).toBe(200);
    expect(relayRequests).toBeGreaterThan(before);
    const w = await wallet(ids.A, key);
    expect(w.balance_msub).toBeLessThan(50_000);
    expect(w.refundable).toBe(Math.floor(w.balance_msub / 1000));
  });

  let moved: Awaited<ReturnType<typeof moveBalance>>;

  it('moves the balance: withdraws at A, passes over C (another mint) without a request, funds B with proof of work', async () => {
    const start = await wallet(ids.A, key);
    await pool.prepare(ids.C);
    const toC = sent.get(urls.C) ?? 0;
    moved = await moveBalance(pool, {
      from: ids.A,
      key,
      onToken: async (w) => {
        withdrawn = w;
        // The token is handed over before it is spent: nothing at B yet.
        tokenSeenBeforeFunding = gateways.get('B')!.g.deps.ledger.totals().every((t) => t.balance_msub === 0);
      },
    });
    expect(withdrawn).toMatchObject({ amount: start.refundable, unit: 'usd', mint: MINT_A, from: ids.A });
    expect(tokenSeenBeforeFunding).toBe(true);
    expect(moved).toMatchObject({ from: ids.A, to: ids.B, unit: 'usd', withdrawn: start.refundable, credited: start.refundable, balanceMsub: start.refundable * 1000 });
    expect(moved.key).not.toBe(key);
    // C comes first in the list, but its attested announcement takes another mint: it got no request,
    // so it never saw the token or the new key.
    expect((sent.get(urls.C) ?? 0) - toC).toBe(0);

    // A keeps only the remainder below one cent; B holds the rest under the new key; C opened nothing.
    const afterA = await wallet(ids.A, key);
    expect(afterA.refundable).toBe(0);
    expect(afterA.balance_msub).toBe(start.balance_msub - start.refundable * 1000);
    expect((await wallet(ids.B, moved.key)).balance_msub).toBe(start.refundable * 1000);
    expect(gateways.get('C')!.g.deps.ledger.totals().reduce((n, t) => n + t.balances, 0)).toBe(0);
  });

  it('finishing the same move again credits nothing twice', async () => {
    const again = await moveBalance(pool, { from: ids.A, key, to: ids.B, newKey: moved.key, token: { token: withdrawn!.token, unit: 'usd', mint: withdrawn!.mint! } });
    expect(again.credited).toBe(0);
    expect((await wallet(ids.B, moved.key)).balance_msub).toBe(moved.balanceMsub);
  });

  it('a funding whose answer is lost is fund_unknown; finishing it with the same key credits it once', async () => {
    const token = await mintToken(MINT_A, 'usd', 20);
    const { response } = await pool.fetch('/v1/wallet/topup', json({ token }), { operator: ids.A });
    expect(response.status).toBe(200);
    const key2 = ((await response.json()) as { key: string }).key;
    const start = await wallet(ids.A, key2);
    // B asks a new balance for proof of work first: the second request is the funding itself.
    lose = { origin: urls.B, n: 2 };
    const err = await moveBalance(pool, { from: ids.A, key: key2, to: ids.B }).catch((e) => e);
    expect(err).toMatchObject({ code: 'fund_unknown', to: ids.B, key: expect.any(String), token: expect.any(String) });
    expect(lose).toBeNull();
    // B did credit it; the client could not know.
    expect(gateways.get('B')!.g.deps.ledger.findByKey(err.key)?.balance_msub).toBe(start.refundable * 1000);

    const done = await moveBalance(pool, { from: ids.A, key: key2, to: ids.B, newKey: err.key, token: { token: err.token, unit: 'usd', mint: MINT_A } });
    expect(done).toMatchObject({ to: ids.B, key: err.key, credited: 0, balanceMsub: start.refundable * 1000 });
    expect((await wallet(ids.B, err.key)).balance_msub).toBe(start.refundable * 1000);
    expect((await wallet(ids.A, key2)).refundable).toBe(0);
  });

  it('nothing is left to move from A', async () => {
    await expect(moveBalance(pool, { from: ids.A, key })).rejects.toMatchObject({ code: 'nothing_to_move' });
  });

  it('fails over when the remembered operator goes down, and remembers the new one', async () => {
    // Any call that gets an answer, pinned or not, makes its operator the remembered one.
    expect((await pool.fetch('/v1/models', {}, { operator: ids.B })).response.status).toBe(200);
    expect(memory.get()).toBe(ids.B);
    await stop('B');
    const { response, operator } = await pool.fetch('/v1/models');
    expect(response.status).toBe(200);
    expect(operator.id).not.toBe(ids.B);
    expect(memory.get()).toBe(operator.id);

    // A new client with the same memory starts there.
    const next = new OperatorPool({ operators: announcements, approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true, memory });
    expect((await next.order())[0]).toBe(operator.id);
    // B is down: picking it fails, and the pool says why.
    await expect(next.prepare(ids.B)).rejects.toMatchObject({ code: 'fetch_failed' });
  });

  it('when every operator is down, says so for each', async () => {
    await stop('A');
    await stop('C');
    const err = await pool.fetch('/v1/models').catch((e) => e);
    expect(err).toMatchObject({ code: 'no_operator' });
    expect(err.failures).toHaveLength(3);
  });
});
