import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, tx } from '../../src/db.ts';
import { Invites, Ledger, newApiKey } from '../../src/ledger.ts';
import { dayOf, recordUsageRaw, type SettledUsage, usageSince, windowStart } from '../../src/usage.ts';

const base: SettledUsage = {
  at: Date.parse('2026-11-12T10:00:00Z'),
  unit: 'usd',
  model: 'm1',
  supplier: 's1',
  ok: true,
  encrypted: false,
  nut24: false,
  estimated: false,
  inputTokens: 100,
  outputTokens: 10,
  chargedMsub: 50,
  priceNusd: 400,
  costNusd: 300,
  supplierReported: true,
};

describe('daily usage aggregates', () => {
  it('adds requests into one row per day, unit, model and supplier', () => {
    const db = openDb(':memory:');
    recordUsageRaw(db, base);
    recordUsageRaw(db, { ...base, encrypted: true, nut24: true, estimated: true, supplierReported: false, inputTokens: 1, outputTokens: 2, chargedMsub: 5, priceNusd: 7, costNusd: null });
    recordUsageRaw(db, { ...base, ok: false, inputTokens: null, outputTokens: null, chargedMsub: 0, priceNusd: 0, costNusd: null, supplierReported: false });
    recordUsageRaw(db, { ...base, at: base.at + 86_400_000 });
    recordUsageRaw(db, { ...base, unit: 'sat' });
    const rows = usageSince(db, '2026-11-01');
    expect(rows).toHaveLength(3);
    const day1 = rows.find((r) => r.day === '2026-11-12' && r.unit === 'usd')!;
    expect(day1).toMatchObject({ requests: 3, ok: 2, failed: 1, encrypted: 1, nut24: 1, estimated: 1, input_tokens: 101, output_tokens: 12, charged_msub: 55, price_nusd: 407, cost_nusd: 300, supplier_reported: 1 });
    expect(day1).toMatchObject({ fit_ii: 100 * 100, fit_io: 100 * 10, fit_oo: 100, fit_ic: 100 * 300, fit_oc: 10 * 300 });
    expect(rows.map((r) => r.day)).toContain('2026-11-13');
  });

  it('sums the shortfall of late charges, and adds the column to a database from an earlier release', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bellows-shortfall-')), 'bellows.db');
    let db = openDb(path);
    db.exec('ALTER TABLE usage_daily DROP COLUMN shortfall_msub');
    db.close();
    db = openDb(path);
    recordUsageRaw(db, base);
    recordUsageRaw(db, { ...base, chargedMsub: 3, shortfallMsub: 47 });
    recordUsageRaw(db, { ...base, ok: false, chargedMsub: 0, shortfallMsub: 9 });
    const [row] = usageSince(db, '2026-11-01');
    expect(row).toMatchObject({ requests: 3, ok: 2, charged_msub: 53, shortfall_msub: 47 });
    db.close();
  });

  it('works out windows in whole UTC days', () => {
    const now = Date.parse('2026-11-12T23:59:00Z');
    expect(windowStart(1, now)).toEqual({ day: '2026-11-12', since: Date.parse('2026-11-12T00:00:00Z') });
    expect(windowStart(7, now).day).toBe('2026-11-06');
    expect(dayOf(now)).toBe('2026-11-12');
  });
});

describe('migration from per-request rows', () => {
  it('folds old request rows into aggregates and forgets which balance made them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bellows-mig-')), 'bellows.db');
    let db = openDb(path);
    const ledger = new Ledger(db);
    const invites = new Invites(db);
    // The shape an earlier release left: one requests row per request, with the balance id.
    db.exec(`DROP TABLE requests;
      CREATE TABLE requests (id TEXT PRIMARY KEY, account_id TEXT, payment TEXT NOT NULL, unit TEXT NOT NULL, model TEXT NOT NULL, supplier TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, usage_source TEXT, reserved_msub INTEGER,
        charged_msub INTEGER, paid_units INTEGER, change_units INTEGER, latency_ms INTEGER, lock_pubkey TEXT, price_nusd INTEGER, supplier_cost_nusd INTEGER,
        cost_source TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX requests_account ON requests(account_id);`);
    const funded = tx(db, () => ledger.createAccountRaw(newApiKey(), 'usd', null));
    const unfunded = tx(db, () => ledger.createAccountRaw(newApiKey(), 'usd', null));
    const inv1 = invites.create('alice');
    const inv2 = invites.create('bob');
    tx(db, () => {
      invites.redeemRaw(inv1.code, funded.id);
      invites.redeemRaw(inv2.code, unfunded.id);
      db.prepare('UPDATE accounts SET invite_id = ? WHERE id = ?').run(inv1.id, funded.id);
      db.prepare('UPDATE accounts SET invite_id = ? WHERE id = ?').run(inv2.id, unfunded.id);
      db.prepare("UPDATE accounts SET balance_msub = 9000 WHERE id = ?").run(funded.id);
      db.prepare("INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, 'topup', 10000, NULL, 1)").run(funded.id);
      db.prepare("INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, 'charge', -1000, 'req_a', 2)").run(funded.id);
      db.prepare("INSERT INTO reservations (id, account_id, amount_msub, status, charged_msub, created_at, settled_at) VALUES ('res_a', ?, 2000, 'settled', 1000, 1, 2)").run(funded.id);
      db.prepare("INSERT INTO reservations (id, account_id, amount_msub, status, created_at) VALUES ('res_live', ?, 500, 'active', ?)").run(funded.id, Date.now());
      const ins = db.prepare(
        `INSERT INTO requests (id, account_id, payment, unit, model, supplier, status, input_tokens, output_tokens, usage_source, charged_msub, price_nusd, supplier_cost_nusd, cost_source, created_at)
         VALUES (?, ?, ?, 'usd', 'm1', 's1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const at = Date.parse('2026-11-10T12:00:00Z');
      ins.run('req_a', funded.id, 'balance', 'settled', 100, 10, 'upstream', 1000, 400, 300, 'supplier', at);
      ins.run('req_b', funded.id, 'balance', 'failed', null, null, 'none', 0, 0, null, null, at);
      ins.run('req_c', null, 'nut24', 'settled', 5, 5, 'estimate', 7, 9, null, null, at);
      ins.run('req_d', null, 'nut24', 'paid', null, null, null, null, null, null, null, at);
    });
    db.close();

    db = openDb(path);
    const reqCols = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(reqCols).not.toContain('account_id');
    expect(reqCols).not.toContain('input_tokens');
    // Only the request still in flight is left.
    expect(db.prepare('SELECT id, status FROM requests').all()).toEqual([{ id: 'req_d', status: 'paid' }]);
    const day = usageSince(db, '2026-11-10')[0]!;
    expect(day).toMatchObject({ day: '2026-11-10', requests: 3, ok: 2, failed: 1, nut24: 1, estimated: 1, input_tokens: 105, output_tokens: 15, charged_msub: 1007, price_nusd: 409, cost_nusd: 300, supplier_reported: 1 });
    // No settled reservation and no per-request charge stay tied to the balance; the balance itself is unchanged.
    expect(db.prepare('SELECT id FROM reservations').all()).toEqual([{ id: 'res_live' }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'charge'").get()).toEqual({ n: 0 });
    expect((db.prepare('SELECT balance_msub FROM accounts WHERE id = ?').get(funded.id) as any).balance_msub).toBe(9000);
    // The funded balance is no longer linked to its invite; the unfunded one keeps the link so it can give the invite back.
    expect(db.prepare('SELECT invite_id FROM accounts WHERE id = ?').get(funded.id)).toEqual({ invite_id: null });
    expect(db.prepare('SELECT account_id, status FROM invites WHERE id = ?').get(inv1.id)).toEqual({ account_id: null, status: 'redeemed' });
    expect(db.prepare('SELECT account_id FROM invites WHERE id = ?').get(inv2.id)).toEqual({ account_id: unfunded.id });
    db.close();
    // Opening again changes nothing.
    db = openDb(path);
    expect(usageSince(db, '2026-11-10')[0]!.requests).toBe(3);
    db.close();
  });
});
