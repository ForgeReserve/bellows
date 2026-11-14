/**
 * The stale-reservation sweep and balance-paid requests. A stream that is still running keeps its
 * reservation however old it is, and pays for what it used. A reservation that is released while its
 * request still runs (only a second process on the same file can, which is unsupported; the late charge is
 * the backstop) is still charged at settlement, capped at what the balance covers, with any shortfall
 * counted in the daily aggregates and logged without a balance id. An upstream body that breaks settles
 * with no charge and releases the reservation at once; a request that fails before settling otherwise
 * gives its reservation up to the sweep, in-process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { tx } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { Ledger, newApiKey } from '../../src/ledger.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [
    { id: 'mock-slow', supplier: 'mock', upstream: 'mock-slow', input_usd_per_mtok: 1000, output_usd_per_mtok: 2000, price_verified: true },
    { id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1000, output_usd_per_mtok: 2000, price_verified: true },
  ],
};

const START = 10_000_000;

function setup() {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
  const app = createApp(deps);
  const key = newApiKey();
  const account = tx(deps.db, () => {
    const a = deps.ledger.createAccountRaw(key, 'usd', null);
    deps.ledger.creditRaw(a.id, START, 'topup', null);
    return a;
  });
  return { deps, app, key, account };
}

type Setup = ReturnType<typeof setup>;

/** Starts a slow stream and returns once its first token has arrived, with the rest still to come. */
async function startStream({ app, key }: Setup) {
  const res = await app.request('http://gw.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'mock-slow', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }], max_tokens: 15 }),
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = dec.decode((await reader.read()).value);
  return {
    async finish() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value);
      }
      const frames = raw.split('\n\n').map((b) => b.split('\n'));
      const forge = frames.find((l) => l[0] === 'event: forge');
      expect(forge, raw).toBeDefined();
      const usage = frames
        .filter((l) => l[0]?.startsWith('data: {'))
        .map((l) => JSON.parse(l[0]!.slice(6)))
        .find((d) => d.usage)?.usage;
      return { settlement: JSON.parse(forge![1]!.slice(5)), usage };
    },
  };
}

const usageRow = (s: Setup, model = 'mock-slow') =>
  s.deps.db.prepare('SELECT requests, ok, charged_msub, shortfall_msub FROM usage_daily WHERE model = ?').get(model) as Record<string, number>;

describe('the stale-reservation sweep and balance-paid requests', () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    setLogSink(undefined);
  });

  it('never releases the reservation of a stream that is still running, and the stream pays for what it used', async () => {
    const s = setup();
    const stream = await startStream(s);
    expect(s.deps.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 1 });
    const held = s.deps.ledger.reservedMsub(s.account.id);
    expect(held).toBeGreaterThan(0);
    // The periodic sweep with a zero window: the stream is older than any window.
    expect(s.deps.ledger.releaseStale(0)).toBe(0);
    expect(s.deps.ledger.reservedMsub(s.account.id)).toBe(held);
    const { settlement, usage } = await stream.finish();

    expect(usage.completion_tokens).toBe(15);
    expect(settlement.charged_msub).toBeGreaterThan(0);
    expect(settlement.charged_msub).toBeLessThanOrEqual(held);
    expect(settlement.balance_msub).toBe(START - settlement.charged_msub);
    expect(settlement.partial).toBeUndefined();
    expect(s.deps.ledger.get(s.account.id)!.balance_msub).toBe(START - settlement.charged_msub);
    expect(s.deps.ledger.reservedMsub(s.account.id)).toBe(0);
    expect(usageRow(s)).toEqual({ requests: 1, ok: 1, charged_msub: settlement.charged_msub, shortfall_msub: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toEqual([]);
  });

  it('charges a stream whose reservation another process released while it ran', async () => {
    const s = setup();
    const control = await startStream(s);
    const { settlement: paid } = await control.finish();
    const cost = paid.charged_msub;
    expect(cost).toBeGreaterThan(0);

    const stream = await startStream(s);
    // A process with no live requests over the same database (what a restart sees) releases it.
    expect(new Ledger(s.deps.db).releaseStale(0)).toBe(1);
    expect(s.deps.ledger.reservedMsub(s.account.id)).toBe(0);
    const { settlement } = await stream.finish();

    expect(settlement.charged_msub).toBe(cost);
    expect(s.deps.ledger.get(s.account.id)!.balance_msub).toBe(START - 2 * cost);
    expect(usageRow(s)).toEqual({ requests: 2, ok: 2, charged_msub: 2 * cost, shortfall_msub: 0 });
    expect(s.deps.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 0 });
  });

  it('caps a late charge at what the balance covers, records the shortfall and logs no balance id', async () => {
    const s = setup();
    const control = await startStream(s);
    const cost = (await control.finish()).settlement.charged_msub;
    expect(cost).toBeGreaterThan(1);
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));

    const stream = await startStream(s);
    expect(new Ledger(s.deps.db).releaseStale(0)).toBe(1);
    // The freed balance is held by another request meanwhile, leaving 1 msub.
    s.deps.ledger.reserve(s.account.id, s.deps.ledger.available(s.account.id) - 1);
    const { settlement } = await stream.finish();

    expect(settlement.charged_msub).toBe(1);
    expect(s.deps.ledger.get(s.account.id)!.balance_msub).toBe(START - cost - 1);
    expect(usageRow(s)).toEqual({ requests: 2, ok: 2, charged_msub: cost + 1, shortfall_msub: cost - 1 });
    const late = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'settled_after_release');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ level: 'warn', owed_msub: cost, charged_msub: 1, shortfall_msub: cost - 1 });
    expect(lines.join('\n')).not.toContain(s.account.id);
  });

  const post = (s: Setup, extra: object = {}) =>
    s.app.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 15, ...extra }),
    });

  it('an upstream body that breaks after the headers charges nothing and releases the reservation at once', async () => {
    const s = setup();
    const mock = s.deps.suppliers.get('mock')!;
    // The upstream answers 200 and the body read then fails.
    mock.chat = async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.error(new Error('connection reset'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const res = await post(s);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('upstream_error');
    expect(res.headers.get('x-forge-charged-msub')).toBe('0');
    expect(res.headers.get('x-forge-balance-msub')).toBe(String(START));
    // Released by settlement, not left for the sweep.
    expect(s.deps.ledger.reservedMsub(s.account.id)).toBe(0);
    expect(s.deps.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 0 });
    expect(s.deps.ledger.releaseStale(0)).toBe(0);
    expect(s.deps.ledger.get(s.account.id)!.balance_msub).toBe(START);
    expect(usageRow(s, 'mock-echo')).toEqual({ requests: 1, ok: 0, charged_msub: 0, shortfall_msub: 0 });
  });

  it('a request that throws before settling leaves its reservation to the sweep, with no restart', async () => {
    const s = setup();
    const mock = s.deps.suppliers.get('mock')!;
    // A stream answer with no body: reading it throws in the handler, before anything settles.
    mock.chat = async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const res = await post(s, { stream: true });
    expect(res.status).toBe(500);
    expect(s.deps.ledger.reservedMsub(s.account.id)).toBeGreaterThan(0);
    expect(s.deps.ledger.releaseStale(0)).toBe(1);
    expect(s.deps.ledger.reservedMsub(s.account.id)).toBe(0);
    expect(s.deps.ledger.get(s.account.id)!.balance_msub).toBe(START);
  });

  it('a stream whose settlement write fails ends with an error and leaves its reservation to the sweep', async () => {
    const s = setup();
    vi.spyOn(s.deps.ledger, 'settleRaw').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      const res = await post(s, { model: 'mock-slow', stream: true });
      expect(res.status).toBe(200);
      // The stream closes (it never hangs) with an error frame and no settlement event.
      const raw = await res.text();
      expect(raw).toContain('settlement failed');
      expect(raw).not.toContain('event: forge');
      // Before the fix the reservation stayed owned, so the sweep could never release it in this process.
      expect(s.deps.ledger.reservedMsub(s.account.id)).toBeGreaterThan(0);
      expect(s.deps.ledger.releaseStale(0)).toBe(1);
      expect(s.deps.ledger.reservedMsub(s.account.id)).toBe(0);
      expect(s.deps.ledger.get(s.account.id)!.balance_msub).toBe(START);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
