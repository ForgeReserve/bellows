import { describe, expect, it } from 'vitest';
import { fixedRateSource, median, RateOracle, type RateSource } from '../../src/rates.ts';
import { setLogSilent } from '../../src/log.ts';

setLogSilent(true);
const failing: RateSource = { name: 'down', fetchBtcUsd: async () => Promise.reject(new Error('down')) };

describe('rates', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('takes the median of 2+ sources and caches it', async () => {
    let calls = 0;
    const counting: RateSource = { name: 'c', fetchBtcUsd: async () => (calls++, 101) };
    const o = new RateOracle([fixedRateSource('a', 100), counting, fixedRateSource('b', 120)], { minSources: 2, ttlMs: 60_000, maxStaleMs: 600_000 });
    expect(await o.get()).toBe(101);
    expect(await o.get()).toBe(101);
    expect(calls).toBe(1);
  });

  it('refuses a rate from too few sources', async () => {
    const o = new RateOracle([fixedRateSource('a', 100), failing], { minSources: 2, ttlMs: 1, maxStaleMs: 1000 });
    expect(await o.get()).toBeUndefined();
  });

  it('keeps the last good rate until max staleness, then gives up', async () => {
    let t = 0;
    let up = true;
    const flaky: RateSource = { name: 'f', fetchBtcUsd: async () => (up ? 100 : Promise.reject(new Error('x'))) };
    const o = new RateOracle([flaky, fixedRateSource('a', 100)], { minSources: 2, ttlMs: 10, maxStaleMs: 100, now: () => t });
    expect(await o.get()).toBe(100);
    up = false;
    t = 50;
    expect(await o.get()).toBe(100); // stale but usable
    t = 200;
    expect(await o.get()).toBeUndefined(); // too stale: sat pricing pauses
  });
});
