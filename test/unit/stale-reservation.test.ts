/**
 * A balance-paid stream that outlives BELLOWS_STALE_RESERVATION_SECONDS has its reservation released by the
 * periodic sweep while it is still running. It must still settle (free), close with a settlement event and
 * count in the daily aggregates, and nothing may reject unhandled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { tx } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-slow', supplier: 'mock', upstream: 'mock-slow', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

describe('a reservation released while its stream is running', () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
  });

  it('settles free, closes with a settlement event and is counted in usage_daily', async () => {
    const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
    const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
    const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
    const app = createApp(deps);
    const key = newApiKey();
    const account = tx(deps.db, () => {
      const a = deps.ledger.createAccountRaw(key, 'usd', null);
      deps.ledger.creditRaw(a.id, 1_000_000, 'topup', null);
      return a;
    });

    const res = await app.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'mock-slow', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 15 }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let raw = '';
    // Wait for the first token, then run the stale sweep as the periodic timer would.
    const first = await reader.read();
    raw += dec.decode(first.value);
    expect(deps.db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 1 });
    expect(deps.ledger.releaseStale(0)).toBe(1);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value);
    }

    const forge = raw
      .split('\n\n')
      .map((b) => b.split('\n'))
      .find((l) => l[0] === 'event: forge');
    expect(forge, raw).toBeDefined();
    const settlement = JSON.parse(forge![1]!.slice(5));
    expect(settlement.charged_msub).toBe(0);
    expect(settlement.balance_msub).toBe(1_000_000);
    expect(settlement.partial).toBeUndefined();
    expect(deps.ledger.get(account.id)!.balance_msub).toBe(1_000_000);
    const usage = deps.db.prepare("SELECT requests, ok, charged_msub FROM usage_daily WHERE model = 'mock-slow'").get();
    expect(usage).toEqual({ requests: 1, ok: 1, charged_msub: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toEqual([]);
  });
});
