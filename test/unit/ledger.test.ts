import { describe, expect, it } from 'vitest';
import { openDb, tx } from '../../src/db.ts';
import { Invites, isApiKeyShape, Ledger, newApiKey, sha256 } from '../../src/ledger.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';

setLogSilent(true);

function setup() {
  const db = openDb(':memory:');
  const ledger = new Ledger(db);
  const key = newApiKey();
  const a = tx(db, () => {
    const a = ledger.createAccountRaw(key, 'usd', null);
    ledger.creditRaw(a.id, 10_000, 'topup', null);
    return a;
  });
  return { db, ledger, key, a };
}

describe('ledger', () => {
  it('stores only a hash of the key', () => {
    const { db, key } = setup();
    const row: any = db.prepare('SELECT key_hash FROM accounts').get();
    expect(row.key_hash).toBe(sha256(key));
    expect(JSON.stringify(db.prepare('SELECT * FROM accounts').all())).not.toContain(key);
    expect(isApiKeyShape(key)).toBe(true);
  });

  it('reserve then settle charges actual and releases the rest', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 6000);
    expect(ledger.available(a.id)).toBe(4000);
    expect(() => ledger.reserve(a.id, 4001)).toThrow(/balance too low/);
    const s = ledger.settle(r, 1234, 'req');
    expect(s.charged).toBe(1234);
    expect(s.balance).toBe(10_000 - 1234);
    expect(ledger.available(a.id)).toBe(10_000 - 1234);
  });

  it('caps the charge at the reservation and is idempotent', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 500);
    expect(ledger.settle(r, 9999, 'req').charged).toBe(500);
    expect(ledger.settle(r, 9999, 'req').charged).toBe(500);
    expect(ledger.get(a.id)!.balance_msub).toBe(9500);
  });

  it('keeps nothing per request: settling deletes the reservation and writes no ledger row', () => {
    const { db, ledger, a } = setup();
    const r = ledger.reserve(a.id, 600);
    ledger.settle(r, 250, 'req');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'charge'").get()).toEqual({ n: 0 });
    expect(ledger.get(a.id)!.balance_msub).toBe(10_000 - 250);
    // releaseStale deletes too.
    ledger.reserve(a.id, 100);
    expect(ledger.releaseStale(0)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 0 });
  });

  it('concurrent reservations cannot overdraw', () => {
    const { ledger, a } = setup();
    ledger.reserve(a.id, 5000);
    ledger.reserve(a.id, 5000);
    expect(() => ledger.reserve(a.id, 1)).toThrow();
  });

  it('releases stale reservations without charge', () => {
    const { ledger, a } = setup();
    ledger.reserve(a.id, 5000);
    expect(ledger.releaseStale(0)).toBe(1);
    expect(ledger.available(a.id)).toBe(10_000);
    expect(ledger.get(a.id)!.balance_msub).toBe(10_000);
  });

  it('settles a reservation the stale sweep already released as charged 0, without throwing', () => {
    const { db, ledger, a } = setup();
    const r = ledger.reserve(a.id, 5000);
    expect(ledger.releaseStale(0)).toBe(1);
    expect(ledger.settle(r, 100, 'req', a.id)).toEqual({ charged: 0, balance: 10_000 });
    // Repeated, and without the caller's balance id, it is still free.
    expect(ledger.settle(r, 100)).toEqual({ charged: 0, balance: 10_000 });
    expect(ledger.get(a.id)!.balance_msub).toBe(10_000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reservations').get()).toEqual({ n: 0 });
  });

  it('settles a reservation this process never saw as charged 0 and logs no balance id', () => {
    const { ledger, a } = setup();
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      expect(ledger.settle('res_unknown', 100, 'req', a.id)).toEqual({ charged: 0, balance: 10_000 });
      expect(ledger.settle('res_unknown2', 100)).toEqual({ charged: 0, balance: 0 });
    } finally {
      setLogSink(undefined);
    }
    const warns = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'reservation_released');
    expect(warns).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(a.id);
  });

  it('debit refuses to go negative', () => {
    const { db, ledger, a } = setup();
    expect(() => tx(db, () => ledger.debitRaw(a.id, 10_001, 'refund', 'x'))).toThrow();
    tx(db, () => ledger.debitRaw(a.id, 10_000, 'refund', 'x'));
    expect(ledger.get(a.id)!.balance_msub).toBe(0);
  });
});

describe('invites', () => {
  it('redeem once, nut24 checks, revoke', () => {
    const db = openDb(':memory:');
    const inv = new Invites(db);
    const ledger = new Ledger(db);
    const { id, code } = inv.create('x');
    expect(inv.checkForNut24(code)).toBe(true);
    expect(inv.checkForNut24('nope')).toBe(false);
    expect(inv.checkForNut24(undefined)).toBe(false);
    const a = ledger.createAccountRaw(newApiKey(), 'usd', null);
    tx(db, () => inv.redeemRaw(code, a.id));
    expect(() => tx(db, () => inv.redeemRaw(code, a.id))).toThrow(/already/);
    expect(inv.revoke(id)).toBe(true);
    expect(inv.checkForNut24(code)).toBe(false);
    expect(JSON.stringify(db.prepare('SELECT * FROM invites').all())).not.toContain(code);
  });

  it('a funded balance is no longer linked to the invite that opened it', () => {
    const db = openDb(':memory:');
    const inv = new Invites(db);
    const ledger = new Ledger(db);
    const { id, code } = inv.create('a name the operator typed');
    const a = tx(db, () => {
      const a = ledger.createAccountRaw(newApiKey(), 'usd', null);
      db.prepare('UPDATE accounts SET invite_id = ? WHERE id = ?').run(inv.redeemRaw(code, a.id), a.id);
      return a;
    });
    expect(inv.lookup(code)!.account_id).toBe(a.id);
    tx(db, () => ledger.creditRaw(a.id, 100, 'topup', null));
    expect(inv.lookup(code)).toMatchObject({ id, status: 'redeemed', account_id: null });
    expect(ledger.get(a.id)!.invite_id).toBeNull();
    expect(JSON.stringify(inv.list())).not.toContain(a.id);
  });
});
