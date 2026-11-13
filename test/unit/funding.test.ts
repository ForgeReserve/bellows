import { describe, expect, it } from 'vitest';
import { openAccount, releaseIfEmpty } from '../../src/accounts.ts';
import { openDb, tx } from '../../src/db.ts';
import { checkForeignMintUrl, isPrivateAddress } from '../../src/funding.ts';
import { Invites, Ledger, LedgerError, newApiKey } from '../../src/ledger.ts';

describe('foreign mint URL guard', () => {
  it('flags private, loopback and link-local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('requires https and a public host unless insecure mode is on', async () => {
    await expect(checkForeignMintUrl('http://mint.example.com', false)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(checkForeignMintUrl('https://127.0.0.1:3338', false)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(checkForeignMintUrl('https://169.254.169.254', false)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(checkForeignMintUrl('https://localhost', false)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(checkForeignMintUrl('https://user:pw@mint.example.com', false)).rejects.toMatchObject({ code: 'mint_not_allowed' });
    await expect(checkForeignMintUrl('https://1.1.1.1/', false)).resolves.toBe('https://1.1.1.1');
    await expect(checkForeignMintUrl('http://127.0.0.1:3340/', true)).resolves.toBe('http://127.0.0.1:3340');
  });
});

describe('openAccount / releaseIfEmpty', () => {
  const setup = () => {
    const db = openDb(':memory:');
    return { db, ledger: new Ledger(db), invites: new Invites(db) };
  };

  it('needs an open invite for a new balance and binds it', () => {
    const d = setup();
    expect(() => openAccount({ ...d, inviteOnly: true }, { unit: 'usd' })).toThrow(LedgerError);
    const { code } = d.invites.create();
    const o = openAccount({ ...d, inviteOnly: true }, { unit: 'usd', invite: code });
    expect(o.created).toBe(true);
    expect(o.generatedKey).toMatch(/^sk-forge-/);
    expect(d.invites.lookup(code)!.status).toBe('redeemed');
    expect(() => openAccount({ ...d, inviteOnly: true }, { unit: 'usd', invite: code })).toThrow(/already redeemed/);
    // The same key finds the balance again; another unit is refused.
    expect(openAccount({ ...d, inviteOnly: true }, { unit: 'usd', key: o.generatedKey }).created).toBe(false);
    expect(() => openAccount({ ...d, inviteOnly: true }, { unit: 'sat', key: o.generatedKey })).toThrow(/this balance is in usd/);
  });

  it('a client-chosen key opens a balance without the gateway returning a key', () => {
    const d = setup();
    const key = newApiKey();
    const o = openAccount({ ...d, inviteOnly: false }, { unit: 'sat', key });
    expect(o.created).toBe(true);
    expect(o.generatedKey).toBeUndefined();
    expect(d.ledger.findByKey(key)!.id).toBe(o.account.id);
  });

  it('releases only an empty balance with nothing in flight', () => {
    const d = setup();
    const { code } = d.invites.create();
    const o = openAccount({ ...d, inviteOnly: true }, { unit: 'usd', invite: code });
    const t = Date.now();
    d.db
      .prepare("INSERT INTO fundings (id, method, account_id, unit, mint, state, created_at, updated_at) VALUES ('f1', 'lightning', ?, 'usd', 'm', 'pending', ?, ?)")
      .run(o.account.id, t, t);
    expect(releaseIfEmpty(d.db, o.account.id)).toBe(false);
    d.db.prepare("UPDATE fundings SET state = 'expired' WHERE id = 'f1'").run();
    expect(releaseIfEmpty(d.db, o.account.id)).toBe(true);
    expect(d.ledger.get(o.account.id)).toBeUndefined();
    expect(d.invites.lookup(code)!.status).toBe('open');

    const o2 = openAccount({ ...d, inviteOnly: true }, { unit: 'usd', invite: code });
    tx(d.db, () => d.ledger.creditRaw(o2.account.id, 1000, 'topup', null));
    expect(releaseIfEmpty(d.db, o2.account.id)).toBe(false);
  });
});
