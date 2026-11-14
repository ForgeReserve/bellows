/**
 * Sealed state (docs/DESIGN.md, S3): one secrets source, a wallet seed derived from the wallet secret and
 * never stored, a database that sealed mode refuses off the encrypted volume, and a startup line that names
 * the mode and never a secret.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import type { OpenAISupplier } from '../../src/suppliers/openai.ts';
import { type MountTable, parseMountInfo, realPathOf, sealedMountOf } from '../../src/sealed.ts';
import { fileSecrets, memorySecrets, newWalletSecret, platformSecrets, type SecretsSource } from '../../src/secrets.ts';
import { deriveWalletSeed, resolveWalletSeed, walletSeedCheck } from '../../src/wallet-seed.ts';

const catalog = {
  suppliers: {
    mock: { type: 'mock', tier: 'standard' },
    paid: { type: 'openai', tier: 'standard', baseUrl: 'http://127.0.0.1:1/v1', apiKeySecret: 'PAID_API_KEY' },
  },
  models: [
    { id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true },
    { id: 'paid-model', supplier: 'paid', upstream: 'x', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true },
  ],
};
const base = { BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
const tmp = (p = 'bellows-sealed-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
const mounts = (...points: string[]): MountTable => ({ mountPoints: () => ['/', ...points] });
const build = (config: ReturnType<typeof loadConfig>) => buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] });
const meta = (db: ReturnType<typeof openDb>, key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;

function writeSecrets(path: string, values: Record<string, string>, mode = 0o600) {
  writeFileSync(path, JSON.stringify(values), { mode });
  chmodSync(path, mode);
}

let lines: string[] = [];
beforeEach(() => {
  setLogSilent(true);
  lines = [];
  setLogSink((l) => lines.push(l));
});
afterEach(() => setLogSink(undefined));

describe('secrets file', () => {
  it('reads a JSON object of names to values; empty values count as unset', () => {
    const dir = tmp();
    writeSecrets(join(dir, 's.json'), { A: 'one', B: '' });
    const s = fileSecrets(join(dir, 's.json'));
    expect(s.kind).toBe('file');
    expect(s.get('A')).toBe('one');
    expect(s.get('B')).toBeUndefined();
    expect(s.get('C')).toBeUndefined();
  });

  it('refuses a file other users can read', () => {
    const dir = tmp();
    writeSecrets(join(dir, 's.json'), { A: 'one' }, 0o644);
    expect(() => fileSecrets(join(dir, 's.json'))).toThrow(/can be read by other users: run chmod 600/);
  });

  it('refuses bad content without quoting it', () => {
    const dir = tmp();
    const p = join(dir, 's.json');
    writeFileSync(p, '{"BELLOWS_ADMIN_TOKEN": "hunter2-very-secret', { mode: 0o600 });
    let msg = '';
    try {
      fileSecrets(p);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/is not valid JSON/);
    expect(msg).not.toContain('hunter2');
    writeSecrets(p, { A: 1 } as unknown as Record<string, string>);
    expect(() => fileSecrets(p)).toThrow(/A must be a string/);
    writeFileSync(p, '["x"]', { mode: 0o600 });
    expect(() => fileSecrets(p)).toThrow(/JSON object/);
    expect(() => fileSecrets(join(dir, 'missing.json'))).toThrow(/is missing/);
  });

  it('platform secrets are read from what the platform sets', () => {
    const s = platformSecrets({ X: 'y', E: '  ' });
    expect(s.kind).toBe('platform');
    expect(s.get('X')).toBe('y');
    expect(s.get('E')).toBeUndefined();
  });
});

describe('development mode', () => {
  it('creates secrets.json (mode 0600, a new wallet secret) next to a new database, when the database is created', () => {
    const dir = tmp();
    const db = join(dir, 'data', 'bellows.db');
    const config = loadConfig({ ...base, BELLOWS_DB_PATH: db } as NodeJS.ProcessEnv, catalog);
    // Loading the configuration writes nothing.
    expect(existsSync(join(dir, 'data', 'secrets.json'))).toBe(false);
    expect(config.mode).toBe('development');
    const d = build(config);
    const file = join(dir, 'data', 'secrets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(written)).toEqual(['BELLOWS_WALLET_SECRET']);
    expect(written.BELLOWS_WALLET_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(d.wallet.bip39seed).toEqual(deriveWalletSeed(written.BELLOWS_WALLET_SECRET));
    d.db.close();
    // A restart reads the same file and derives the same seed.
    const again = build(loadConfig({ ...base, BELLOWS_DB_PATH: db } as NodeJS.ProcessEnv, catalog));
    expect(again.wallet.bip39seed).toEqual(deriveWalletSeed(written.BELLOWS_WALLET_SECRET));
    again.db.close();
  });

  it('makes no new wallet secret for a database that already exists', () => {
    const dir = tmp();
    const db = join(dir, 'bellows.db');
    openDb(db).close();
    expect(() => loadConfig({ ...base, BELLOWS_DB_PATH: db } as NodeJS.ProcessEnv, catalog)).toThrow(/secrets file .*secrets\.json is missing, and the database .* already exists/);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });

  it('never creates a file named in BELLOWS_SECRETS_FILE', () => {
    const dir = tmp();
    expect(() => loadConfig({ ...base, BELLOWS_DB_PATH: join(dir, 'b.db'), BELLOWS_SECRETS_FILE: join(dir, 'mine.json') } as NodeJS.ProcessEnv, catalog)).toThrow(/mine\.json is missing/);
  });

  it('keeps an in-memory database secret in memory', () => {
    const c = loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, catalog);
    expect(c.secrets.kind).toBe('memory');
    expect(c.secrets.get('BELLOWS_WALLET_SECRET')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses the platform source', () => {
    expect(() => loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:', BELLOWS_SECRETS: 'platform' } as NodeJS.ProcessEnv, catalog)).toThrow(/needs BELLOWS_MODE=sealed/);
  });

  it('refuses a secret set in the environment, by name only', () => {
    const dir = tmp();
    writeSecrets(join(dir, 'secrets.json'), { BELLOWS_WALLET_SECRET: newWalletSecret() });
    const env = { ...base, BELLOWS_DB_PATH: join(dir, 'b.db') };
    for (const [name, value] of [
      ['BELLOWS_WALLET_SEED', 'ab'.repeat(64)],
      ['BELLOWS_WALLET_SECRET', 'cd'.repeat(32)],
      ['BELLOWS_ADMIN_TOKEN', 'admin-token-in-env-0001'],
      ['BELLOWS_ADMIN_TOKEN_HASH', 'ef'.repeat(32)],
      ['TINFOIL_ADMIN_KEY', 'tinfoil-admin-in-env'],
      ['PAID_API_KEY', 'sk-paid-in-env'],
    ]) {
      let msg = '';
      try {
        loadConfig({ ...env, [name!]: value } as NodeJS.ProcessEnv, catalog);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain(`secrets set in the environment: ${name}`);
      expect(msg).not.toContain(value!);
    }
    // Empty values are not secrets (an .env file copied from the example leaves them blank).
    expect(() => loadConfig({ ...env, PAID_API_KEY: '' } as NodeJS.ProcessEnv, catalog)).not.toThrow();
  });
});

describe('secrets in use', () => {
  const load = (values: Record<string, string>) =>
    loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, catalog, { secrets: memorySecrets({ BELLOWS_WALLET_SECRET: newWalletSecret(), ...values }) });

  it('a supplier key comes from the secrets source; without it the supplier and its models are left out', () => {
    expect(load({}).catalog.models.map((m) => m.id)).toEqual(['mock-echo']);
    const c = load({ PAID_API_KEY: 'sk-paid' });
    expect(c.catalog.models.map((m) => m.id)).toEqual(['mock-echo', 'paid-model']);
    const d = build(c);
    expect((d.suppliers.get('paid') as OpenAISupplier).configured).toBe(true);
    d.db.close();
  });

  it('refuses the old catalog field apiKeyEnv', () => {
    const old = { ...catalog, suppliers: { ...catalog.suppliers, paid: { type: 'openai', tier: 'standard', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'PAID_API_KEY' } } };
    expect(() => loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, old)).toThrow(/apiKeyEnv is now apiKeySecret/);
  });

  it('the admin token is kept only as its hash; the hash form works too; both at once is refused', () => {
    const token = 'operator-admin-token-123';
    const hash = 'c51b2e0b4a1fe5d7d6a1d2c1cbf2b4a3e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(load({}).adminTokenHash).toBeUndefined();
    const c = load({ BELLOWS_ADMIN_TOKEN: token });
    expect(c.adminTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify({ ...c, secrets: undefined })).not.toContain(token);
    expect(load({ BELLOWS_ADMIN_TOKEN_HASH: hash.toUpperCase() }).adminTokenHash).toBe(hash);
    expect(() => load({ BELLOWS_ADMIN_TOKEN: token, BELLOWS_ADMIN_TOKEN_HASH: hash })).toThrow(/not both/);
    expect(() => load({ BELLOWS_ADMIN_TOKEN: 'short' })).toThrow(/at least 16 characters/);
    let msg = '';
    try {
      load({ BELLOWS_ADMIN_TOKEN_HASH: 'not-a-hash-but-a-secret' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/must be the sha256 hex/);
    expect(msg).not.toContain('not-a-hash-but-a-secret');
  });

  it('refuses an admin token with whitespace in it, without echoing it', () => {
    const phrase = 'replace with a long random token';
    let msg = '';
    try {
      load({ BELLOWS_ADMIN_TOKEN: phrase });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('BELLOWS_ADMIN_TOKEN must be a random token without spaces');
    expect(() => load({ BELLOWS_ADMIN_TOKEN: 'operator-admin\ttoken-123' })).toThrow(/without spaces/);
  });

  it('secrets.example.json as shipped keeps the admin API off once the wallet secret and one supplier key are filled in', () => {
    const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '../../secrets.example.json'), 'utf8')) as Record<string, string>;
    expect(shipped).toHaveProperty('BELLOWS_ADMIN_TOKEN');
    const withKey = {
      ...catalog,
      suppliers: { ...catalog.suppliers, tf: { type: 'openai', tier: 'standard', baseUrl: 'http://127.0.0.1:1/v1', apiKeySecret: 'TOKENFACTORY_API_KEY' } },
      models: [...catalog.models, { id: 'tf-model', supplier: 'tf', upstream: 'x', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true }],
    };
    const path = join(tmp(), 'secrets.json');
    writeSecrets(path, { ...shipped, BELLOWS_WALLET_SECRET: newWalletSecret(), TOKENFACTORY_API_KEY: 'sk-tf' });
    const c = loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, withKey, { secrets: fileSecrets(path) });
    expect(c.catalog.models.map((m) => m.id)).toContain('tf-model');
    expect(c.adminTokenHash).toBeUndefined();
  });

  it('checks the wallet secret and the old seed form without echoing them', () => {
    const weak = 'abcd'.repeat(8); // 16 bytes
    let msg = '';
    try {
      loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, catalog, { secrets: memorySecrets({ BELLOWS_WALLET_SECRET: weak }) });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/at least 32 bytes of hex/);
    expect(msg).not.toContain(weak);
    expect(() => load({ BELLOWS_WALLET_SEED: 'ab'.repeat(64) })).toThrow(/not both/);
    expect(() =>
      loadConfig({ ...base, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, catalog, { secrets: memorySecrets({ BELLOWS_WALLET_SEED: 'ab'.repeat(63) }) }),
    ).toThrow(/64 bytes of hex/);
  });
});

describe('wallet seed', () => {
  const secrets = (v: Record<string, string>): SecretsSource => memorySecrets(v);

  it('is HKDF-SHA256 of the wallet secret, pinned', () => {
    const seed = deriveWalletSeed('00'.repeat(32));
    expect(seed).toHaveLength(64);
    expect(Buffer.from(seed).toString('hex')).toBe(PINNED_SEED_00);
    expect(deriveWalletSeed('01'.repeat(32))).not.toEqual(seed);
    expect(() => deriveWalletSeed('00'.repeat(31))).toThrow();
  });

  it('is never written to the database, and a fresh database with the same secret gets the same seed', () => {
    const secret = newWalletSecret();
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    const ra = resolveWalletSeed(a, secrets({ BELLOWS_WALLET_SECRET: secret }));
    const rb = resolveWalletSeed(b, secrets({ BELLOWS_WALLET_SECRET: secret }));
    expect(ra.source).toBe('derived');
    expect(ra.seed).toEqual(rb.seed);
    expect(meta(a, 'wallet_seed')).toBeUndefined();
    const stored = (a.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map((r) => r.value).join(' ');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(Buffer.from(ra.seed).toString('hex'));
    expect(meta(a, 'wallet_seed_check')).toBe(walletSeedCheck(ra.seed));
  });

  it('keeps using a seed an earlier version stored in the database, and says so at startup', () => {
    const dir = tmp();
    const dbPath = join(dir, 'bellows.db');
    const old = 'ab'.repeat(64);
    const db = openDb(dbPath);
    db.prepare("INSERT INTO meta (key, value) VALUES ('wallet_seed', ?)").run(old);
    db.close();
    writeSecrets(join(dir, 'secrets.json'), { BELLOWS_WALLET_SECRET: newWalletSecret() });
    const d = build(loadConfig({ ...base, BELLOWS_DB_PATH: dbPath } as NodeJS.ProcessEnv, catalog));
    expect(Buffer.from(d.wallet.bip39seed).toString('hex')).toBe(old);
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.find((e) => e.msg === 'startup')).toMatchObject({ wallet_seed: 'stored' });
    expect(entries.find((e) => e.msg === 'wallet_seed_stored')?.note).toMatch(/stored by an earlier version; it stays in use/);
    expect(lines.join('\n')).not.toContain(old);
    d.db.close();
  });

  it('uses BELLOWS_WALLET_SEED from the secrets source as is (the old variable)', () => {
    const seed = 'cd'.repeat(64);
    const r = resolveWalletSeed(openDb(':memory:'), secrets({ BELLOWS_WALLET_SEED: seed }));
    expect(r.source).toBe('legacy_secret');
    expect(Buffer.from(r.seed).toString('hex')).toBe(seed);
  });

  it('refuses a different seed for a database written under another one', () => {
    const db = openDb(':memory:');
    resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SECRET: newWalletSecret() }));
    expect(() => resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SECRET: newWalletSecret() }))).toThrow(/not the one this database was written under/);
  });

  const preS3 = (stored?: string) => {
    // A database an earlier version wrote: wallet history, no seed check value.
    const db = openDb(':memory:');
    db.prepare("INSERT INTO counters (mint, keyset_id, next) VALUES ('http://127.0.0.1:1', '00ab', 7)").run();
    if (stored) db.prepare("INSERT INTO meta (key, value) VALUES ('wallet_seed', ?)").run(stored);
    expect(meta(db, 'wallet_seed_check')).toBeUndefined();
    return db;
  };

  it('refuses to derive a new seed for a database that holds wallet state but no seed check (it ran with the old seed variable)', () => {
    const db = preS3();
    expect(() => resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SECRET: newWalletSecret() }))).toThrow(
      'this database holds wallet state from an earlier version that did not record its seed: put the BELLOWS_WALLET_SEED it ran with in the secrets source',
    );
    expect(meta(db, 'wallet_seed_check')).toBeUndefined();
    const seed = 'ef'.repeat(64);
    const r = resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SEED: seed }));
    expect(r.source).toBe('legacy_secret');
    expect(meta(db, 'wallet_seed_check')).toBe(walletSeedCheck(r.seed));
  });

  it('refuses a BELLOWS_WALLET_SEED that differs from the seed a pre-check database stored', () => {
    const db = preS3('ab'.repeat(64));
    expect(() => resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SEED: 'cd'.repeat(64) }))).toThrow(
      'BELLOWS_WALLET_SEED in the secrets source differs from the seed this database stored',
    );
    expect(meta(db, 'wallet_seed_check')).toBeUndefined();
    expect(resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SEED: 'AB'.repeat(64) })).source).toBe('legacy_secret');
  });

  it('a fresh empty database still derives its seed without error', () => {
    const db = openDb(':memory:');
    const r = resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SECRET: newWalletSecret() }));
    expect(r.source).toBe('derived');
    expect(meta(db, 'wallet_seed_check')).toBe(walletSeedCheck(r.seed));
  });

  it('names no particular secret when the seed in use does not match the database', () => {
    const db = openDb(':memory:');
    resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SECRET: newWalletSecret() }));
    let msg = '';
    try {
      resolveWalletSeed(db, secrets({ BELLOWS_WALLET_SEED: 'cd'.repeat(64) }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      'the wallet seed in use (legacy_secret) is not the one this database was written under: release the same wallet secret (or BELLOWS_WALLET_SEED) the database ran with, and remove the other',
    );
    expect(msg).not.toContain('cd'.repeat(64));
  });

  it('refuses to start with no wallet secret and no stored seed', () => {
    expect(() => resolveWalletSeed(openDb(':memory:'), secrets({}))).toThrow(/no wallet secret: set BELLOWS_WALLET_SECRET/);
  });
});

describe('sealed mode', () => {
  it('reads mount points from mountinfo, escapes included', () => {
    const text = [
      '22 1 0:21 / / rw,relatime - overlay overlay rw',
      '35 22 253:1 / /data rw,relatime shared:1 - ext4 /dev/mapper/sealed rw',
      '36 22 0:30 / /mnt/with\\040space rw - tmpfs tmpfs rw',
      '',
    ].join('\n');
    expect(parseMountInfo(text)).toEqual(['/', '/data', '/mnt/with space']);
  });

  it('accepts a database on a named mount and returns that mount', () => {
    const vol = tmp();
    expect(sealedMountOf('the database', join(vol, 'db', 'bellows.db'), [vol], mounts(vol))).toBe(vol);
  });

  it('refuses: no mounts named, in memory, a name that is not a mount, a path elsewhere, a mount nested inside, a symlink out', () => {
    const vol = tmp();
    const other = tmp();
    expect(() => sealedMountOf('the database', join(vol, 'b.db'), [], mounts(vol))).toThrow(/set BELLOWS_SEALED_MOUNTS/);
    expect(() => sealedMountOf('the database', ':memory:', [vol], mounts(vol))).toThrow(/cannot be in memory/);
    expect(() => sealedMountOf('the database', join(vol, 'b.db'), [vol], mounts())).toThrow(/is not a mount point/);
    expect(() => sealedMountOf('the database', join(vol, 'b.db'), ['relative/path'], mounts(vol))).toThrow(/absolute/);
    expect(() => sealedMountOf('the database', join(other, 'b.db'), [vol], mounts(vol))).toThrow(/is on \/, not on a mount named/);
    mkdirSync(join(vol, 'scratch'));
    expect(() => sealedMountOf('the database', join(vol, 'scratch', 'b.db'), [vol], mounts(vol, join(vol, 'scratch')))).toThrow(/scratch, not on a mount named/);
    symlinkSync(other, join(vol, 'link'));
    expect(realPathOf(join(vol, 'link', 'b.db'))).toBe(join(other, 'b.db'));
    expect(() => sealedMountOf('the database', join(vol, 'link', 'b.db'), [vol], mounts(vol))).toThrow(/not on a mount named/);
    expect(() => sealedMountOf('the database', join(vol, 'b.db'), [vol], { mountPoints: () => undefined })).toThrow(/cannot read the mount table/);
  });

  it('startup refuses a database off the encrypted volume', () => {
    const vol = tmp();
    const elsewhere = tmp();
    const env = { ...base, BELLOWS_MODE: 'sealed', BELLOWS_SEALED_MOUNTS: vol, BELLOWS_DB_PATH: join(elsewhere, 'bellows.db') };
    expect(() => loadConfig(env as NodeJS.ProcessEnv, catalog, { mounts: mounts(vol) })).toThrow(/sealed mode: the database .* not on a mount named in BELLOWS_SEALED_MOUNTS/);
    expect(() => loadConfig({ ...env, BELLOWS_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, catalog, { mounts: mounts(vol) })).toThrow(/cannot be in memory/);
    expect(existsSync(join(elsewhere, 'bellows.db'))).toBe(false);
  });

  it('runs with platform secrets and the database on the volume, and says so without printing a secret', () => {
    const vol = tmp();
    const walletSecret = newWalletSecret();
    const env = {
      ...base,
      BELLOWS_MODE: 'sealed',
      BELLOWS_SEALED_MOUNTS: vol,
      BELLOWS_DB_PATH: join(vol, 'bellows.db'),
    };
    const released = { BELLOWS_WALLET_SECRET: walletSecret, BELLOWS_ADMIN_TOKEN: 'sealed-admin-token-0001', PAID_API_KEY: 'sk-sealed-paid' };
    // The platform sets released secrets in the process environment; they are read from what loadConfig is given.
    const c = loadConfig({ ...env, ...released } as NodeJS.ProcessEnv, catalog, { mounts: mounts(vol) });
    expect(c.mode).toBe('sealed');
    expect(c.secrets.kind).toBe('platform');
    expect(c.secrets.get('PAID_API_KEY')).toBe('sk-sealed-paid');
    expect(c.sealedMount).toBe(vol);
    expect(c.pendingSecretsFile).toBeUndefined();
    const d = build(c);
    expect(d.wallet.bip39seed).toEqual(deriveWalletSeed(walletSecret));
    expect(existsSync(join(vol, 'secrets.json'))).toBe(false);
    const startup = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'startup');
    expect(startup).toMatchObject({ mode: 'sealed', secrets: 'platform', sealed_mount: vol, wallet_seed: 'derived', admin_api: 'on' });
    const all = lines.join('\n');
    for (const v of [...Object.values(released), Buffer.from(d.wallet.bip39seed).toString('hex')]) expect(all).not.toContain(v);
    d.db.close();
  });

  it('a secrets file in sealed mode must be on the volume too, and is never created', () => {
    const vol = tmp();
    const outside = tmp();
    const env = { ...base, BELLOWS_MODE: 'sealed', BELLOWS_SEALED_MOUNTS: vol, BELLOWS_DB_PATH: join(vol, 'bellows.db'), BELLOWS_SECRETS: 'file' };
    writeSecrets(join(outside, 's.json'), { BELLOWS_WALLET_SECRET: newWalletSecret() });
    expect(() => loadConfig({ ...env, BELLOWS_SECRETS_FILE: join(outside, 's.json') } as NodeJS.ProcessEnv, catalog, { mounts: mounts(vol) })).toThrow(/the secrets file .* not on a mount named/);
    expect(() => loadConfig(env as NodeJS.ProcessEnv, catalog, { mounts: mounts(vol) })).toThrow(/secrets\.json is missing/);
    writeSecrets(join(vol, 'secrets.json'), { BELLOWS_WALLET_SECRET: newWalletSecret() });
    expect(loadConfig(env as NodeJS.ProcessEnv, catalog, { mounts: mounts(vol) }).secrets.kind).toBe('file');
  });
});

describe('startup line', () => {
  it('names development mode and where secrets come from, never a secret', () => {
    const dir = tmp();
    const secret = newWalletSecret();
    writeSecrets(join(dir, 'secrets.json'), { BELLOWS_WALLET_SECRET: secret, BELLOWS_ADMIN_TOKEN: 'dev-admin-token-000001', PAID_API_KEY: 'sk-dev-paid' });
    const d = build(loadConfig({ ...base, BELLOWS_DB_PATH: join(dir, 'bellows.db') } as NodeJS.ProcessEnv, catalog));
    const startup = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'startup');
    expect(startup).toMatchObject({ mode: 'development', secrets: 'file', secrets_from: join(dir, 'secrets.json'), wallet_seed: 'derived', admin_api: 'on' });
    expect(startup.note).toMatch(/not sealed/);
    const all = lines.join('\n');
    for (const v of [secret, 'dev-admin-token-000001', 'sk-dev-paid', Buffer.from(d.wallet.bip39seed).toString('hex')]) expect(all).not.toContain(v);
    d.db.close();
  });
});

/** HKDF-SHA256(ikm = 32 zero bytes, salt = "bellows", info = "bellows/wallet-seed/v1", 64 bytes), computed outside Node. */
const PINNED_SEED_00 = 'da620e98f33252e9912dd098e654e5265174a55d8d752407322cb50c60aad6ce00ad47216614635462ff20865929b453197193fff2d6ab3859771b8417188c94';
