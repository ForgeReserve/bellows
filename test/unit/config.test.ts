import { describe, expect, it } from 'vitest';
import { EnvSchema, loadConfig, ohttpAdmitBurst, ohttpAdmitPerSecond } from '../../src/config.ts';

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2, price_verified: true }],
};
const base = { BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1' };

describe('environment variables', () => {
  it('are all named BELLOWS_* (apart from HOST and PORT); no secret is an environment variable', () => {
    const names = Object.keys(EnvSchema.shape);
    expect(names.filter((n) => n.startsWith('FORGE_'))).toEqual([]);
    expect(names.filter((n) => !n.startsWith('BELLOWS_')).sort()).toEqual(['HOST', 'PORT']);
    for (const secret of ['BELLOWS_WALLET_SEED', 'BELLOWS_WALLET_SECRET', 'BELLOWS_ADMIN_TOKEN', 'BELLOWS_ADMIN_TOKEN_HASH', 'TINFOIL_ADMIN_KEY']) expect(names).not.toContain(secret);
  });

  it('refuses to start while an old FORGE_* name is set: there are no aliases', () => {
    expect(() => loadConfig({ ...base, FORGE_WALLET_SEED: 'aa'.repeat(64) } as NodeJS.ProcessEnv, catalog)).toThrow(/FORGE_WALLET_SEED/);
    const stale = { FORGE_MARKUP: '3', FORGE_INVITE_ONLY: 'true', FORGE_FOREIGN_DENY: 'https://mint.example' };
    let msg = '';
    try {
      loadConfig({ ...base, BELLOWS_MARKUP: '3', ...stale } as NodeJS.ProcessEnv, catalog);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('FORGE_FOREIGN_DENY, FORGE_INVITE_ONLY, FORGE_MARKUP');
    expect(msg).toMatch(/BELLOWS_\*/);
    // The refusal fires even when the matching BELLOWS_* name is also set.
    expect(() =>
      loadConfig({ ...base, BELLOWS_WALLET_SEED: 'bb'.repeat(64), FORGE_WALLET_SEED: 'aa'.repeat(64) } as NodeJS.ProcessEnv, catalog),
    ).toThrow(/FORGE_WALLET_SEED/);
  });

  it('reads the BELLOWS_* names', () => {
    const c = loadConfig({ ...base, BELLOWS_MARKUP: '3', BELLOWS_UNITS: 'sat', BELLOWS_DEFAULT_UNIT: 'sat' } as NodeJS.ProcessEnv, catalog);
    expect(c.env.BELLOWS_MARKUP).toBe(3);
    expect(c.env.BELLOWS_UNITS).toEqual(['sat']);
    expect(c.trustedMints).toEqual(['http://127.0.0.1:1']);
  });

  it('has no built-in mint: BELLOWS_TRUSTED_MINTS is required', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv, catalog)).toThrow(/BELLOWS_TRUSTED_MINTS/);
    expect(() => loadConfig({ BELLOWS_TRUSTED_MINTS: ' , ' } as NodeJS.ProcessEnv, catalog)).toThrow(/BELLOWS_TRUSTED_MINTS/);
  });

  it('defaults for a standalone engine: invites off, no mint aliases, its own database file', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv, catalog);
    expect(c.env.BELLOWS_INVITE_ONLY).toBe(false);
    expect(c.env.BELLOWS_MINT_ALIASES).toEqual([]);
    expect(c.env.BELLOWS_DB_PATH).toBe('data/bellows.db');
    expect(loadConfig({ ...base, BELLOWS_INVITE_ONLY: 'true' } as NodeJS.ProcessEnv, catalog).env.BELLOWS_INVITE_ONLY).toBe(true);
  });
});

describe('Oblivious HTTP admission bound', () => {
  const lifetime = (skew: number) => 2 * skew + 1;
  /** Most requests the bucket admits while one remembered key is still live. */
  const admittedPerLifetime = (perSecond: number, skew: number) => ohttpAdmitBurst(perSecond) + perSecond * lifetime(skew);

  it('defaults to the most the replay cache holds for a whole key lifetime', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv, catalog);
    expect(c.env.BELLOWS_OHTTP_ADMIT_PER_SECOND).toBeUndefined();
    const r = ohttpAdmitPerSecond(c.env);
    // 200,000 keys, each kept up to 601 s: about 332 new requests a second.
    expect(r).toBeCloseTo(200_000 / 602, 6);
    expect(admittedPerLifetime(r, 300)).toBeLessThanOrEqual(200_000 + 1e-6);
    for (const [skew, max] of [[5, 1000], [3600, 1000], [3600, 200_000], [60, 5000]] as const) {
      const d = ohttpAdmitPerSecond({ BELLOWS_OHTTP_MAX_SKEW_SECONDS: skew, BELLOWS_OHTTP_REPLAY_CACHE_MAX: max, BELLOWS_OHTTP_ADMIT_PER_SECOND: undefined });
      expect(d, `${skew}/${max}`).toBeGreaterThan(0);
      expect(admittedPerLifetime(d, skew), `${skew}/${max}`).toBeLessThanOrEqual(max + 1e-6);
    }
  });

  it('takes a lower BELLOWS_OHTTP_ADMIT_PER_SECOND and refuses one that could fill the cache', () => {
    expect(ohttpAdmitPerSecond(loadConfig({ ...base, BELLOWS_OHTTP_ADMIT_PER_SECOND: '50' } as NodeJS.ProcessEnv, catalog).env)).toBe(50);
    expect(() => loadConfig({ ...base, BELLOWS_OHTTP_ADMIT_PER_SECOND: '333' } as NodeJS.ProcessEnv, catalog)).toThrow(/BELLOWS_OHTTP_ADMIT_PER_SECOND=333 could fill the replay cache.*at most 332\.225/);
    expect(() => loadConfig({ ...base, BELLOWS_OHTTP_ADMIT_PER_SECOND: '50', BELLOWS_OHTTP_REPLAY_CACHE_MAX: '1000' } as NodeJS.ProcessEnv, catalog)).toThrow(/REPLAY_CACHE_MAX/);
    expect(() => loadConfig({ ...base, BELLOWS_OHTTP_ADMIT_PER_SECOND: '0' } as NodeJS.ProcessEnv, catalog)).toThrow(/invalid environment/);
  });
});
