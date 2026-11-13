/**
 * A Forge AI image kept its database at /data/forge.db. Upgrading to Bellows on the same volume
 * without setting BELLOWS_DB_PATH must not open an empty bellows.db with a fresh wallet beside it.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

function deps(dbPath: string) {
  const e = { BELLOWS_DB_PATH: dbPath, BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
  return buildDeps(loadConfig(e as NodeJS.ProcessEnv, catalog), { rateSources: [fixedRateSource('fixed', 100_000)] });
}

describe('a leftover forge.db', () => {
  beforeAll(() => setLogSilent(true));
  afterAll(() => setLogSilent(false));

  it('stops startup from creating a new database next to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellows-forge-db-'));
    writeFileSync(join(dir, 'forge.db'), '');
    const dbPath = join(dir, 'bellows.db');
    expect(() => deps(dbPath)).toThrow(/found forge\.db next to .*bellows\.db: set BELLOWS_DB_PATH/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('does not stop a fresh empty directory from starting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellows-fresh-db-'));
    const dbPath = join(dir, 'bellows.db');
    expect(() => deps(dbPath)).not.toThrow();
    expect(existsSync(dbPath)).toBe(true);
  });

  it('does not stop a database that already exists next to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellows-both-db-'));
    const dbPath = join(dir, 'bellows.db');
    deps(dbPath);
    writeFileSync(join(dir, 'forge.db'), '');
    expect(() => deps(dbPath)).not.toThrow();
  });
});
