/**
 * GET /v1/change/{request_id} for a NUT-24 request that failed before it was served, in the same process.
 * The mint here is unreachable, so these cover the paths where the mint has not answered: the request and
 * its payment stay recoverable, nothing is owed twice. The paths where the mint answers run against the
 * local mints in test/e2e/recovery.e2e.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const MINT = 'http://127.0.0.1:1';
const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1000, output_usd_per_mtok: 2000, price_verified: true }],
};

function setup() {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: MINT, BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
  const app = createApp(deps);
  const request = (id: string, status: string, paidUnits: number | null = null) =>
    deps.db
      .prepare("INSERT INTO requests (id, payment, unit, model, supplier, encrypted, status, reserved_msub, paid_units, created_at) VALUES (?, 'nut24', 'usd', 'mock-echo', 'mock', 0, ?, 1000, ?, ?)")
      .run(id, status, paidUnits, Date.now());
  const incoming = (requestId: string, status: string, amount: number) =>
    deps.db
      .prepare(
        "INSERT INTO incoming (id, token_hash, mint, unit, amount, purpose, account_id, request_id, status, preview, counters, created_at, updated_at) VALUES (?, ?, ?, 'usd', ?, 'nut24', NULL, ?, ?, '{}', NULL, ?, ?)",
      )
      .run('in_' + requestId, 'hash_' + requestId, MINT, amount, requestId, status, Date.now(), Date.now());
  const change = async (id: string) => {
    const res = await app.request(`http://gw.test/v1/change/${id}`);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as any };
  };
  const rows = () => ({
    requests: deps.db.prepare('SELECT id, status FROM requests ORDER BY id').all(),
    change: deps.db.prepare("SELECT request_id, amount, status FROM outgoing WHERE purpose = 'change'").all(),
  });
  return { deps, request, incoming, change, rows };
}

describe('change of a NUT-24 request that failed before it was served', () => {
  it('answers 409 with Retry-After while the mint has not settled the payment, and keeps it recoverable', async () => {
    const s = setup();
    s.request('req_unknown', 'failed');
    s.incoming('req_unknown', 'prepared', 9);
    for (let i = 0; i < 2; i++) {
      const r = await s.change('req_unknown');
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('not_settled');
      expect(r.retryAfter).toBe('5');
    }
    expect(s.rows()).toEqual({ requests: [{ id: 'req_unknown', status: 'failed' }], change: [] });
    expect(s.deps.db.prepare('SELECT status FROM incoming').get()).toEqual({ status: 'prepared' });
  });

  it('owes a recovered payment back in full once, even while the mint cannot issue it yet', async () => {
    const s = setup();
    s.request('req_paid', 'paid', 7);
    s.incoming('req_paid', 'done', 7);
    const first = await s.change('req_paid');
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe('mint_unavailable');
    expect(first.retryAfter).toBe('5');
    expect(s.rows()).toEqual({ requests: [], change: [{ request_id: 'req_paid', amount: 7, status: 'owed' }] });
    expect(s.deps.db.prepare("SELECT failed, nut24 FROM usage_daily WHERE model = 'mock-echo'").get()).toEqual({ failed: 1, nut24: 1 });
    // A second poll retries the same payout; nothing is owed twice.
    expect((await s.change('req_paid')).status).toBe(503);
    expect(s.rows().change).toEqual([{ request_id: 'req_paid', amount: 7, status: 'owed' }]);
  });

  it('still answers 409 for a request a handler is serving', async () => {
    const s = setup();
    s.request('req_live', 'running', 7);
    s.incoming('req_live', 'done', 7);
    const r = await s.change('req_live');
    expect(r.status).toBe(409);
    expect(r.retryAfter).toBe('2');
    expect(s.rows()).toEqual({ requests: [{ id: 'req_live', status: 'running' }], change: [] });
  });

  it('forgets a failed request whose payment the mint refused, and answers 404', async () => {
    const s = setup();
    s.request('req_refused', 'failed');
    s.incoming('req_refused', 'rejected', 9);
    expect((await s.change('req_refused')).status).toBe(404);
    expect(s.rows()).toEqual({ requests: [], change: [] });
    expect(s.deps.db.prepare("SELECT failed FROM usage_daily WHERE model = 'mock-echo'").get()).toEqual({ failed: 1 });
  });

  it('forgets a failed request whose token never reached the mint, and answers 404', async () => {
    const s = setup();
    s.request('req_unsent', 'failed');
    s.incoming('req_unsent', 'new', 9);
    expect((await s.change('req_unsent')).status).toBe(404);
    expect(s.rows()).toEqual({ requests: [], change: [] });
    expect(s.deps.db.prepare('SELECT COUNT(*) AS n FROM incoming').get()).toEqual({ n: 0 });
    expect(s.deps.db.prepare("SELECT failed FROM usage_daily WHERE model = 'mock-echo'").get()).toEqual({ failed: 1 });
  });

  it('answers 404 for an unknown request id', async () => {
    const s = setup();
    expect((await s.change('req_nothing')).status).toBe(404);
  });
});
