import { describe, expect, it } from 'vitest';
import { costNanoUsd, displayPrice, estimateTokensFromBytes, flatCostNanoUsd, msubToUnitsCeil, nanoUsdPerToken, nanoUsdToMsub } from '../../src/pricing.ts';

const model = { input_usd_per_mtok: 0.6, output_usd_per_mtok: 1.45 };

describe('pricing', () => {
  it('converts USD per million tokens to nano-USD per token', () => {
    expect(nanoUsdPerToken(1, 1)).toBe(1000);
    expect(nanoUsdPerToken(0.15, 1)).toBe(150);
    expect(nanoUsdPerToken(1.45, 1.25)).toBe(1813); // 1812.5 rounded up
  });

  it('computes request cost', () => {
    expect(costNanoUsd(model, { inputTokens: 1000, outputTokens: 500 }, 1)).toBe(1000 * 600 + 500 * 1450);
  });

  it('converts to milli-cents and msat, rounding up', () => {
    expect(nanoUsdToMsub(10_000, 'usd')).toBe(1); // 1 milli-cent
    expect(nanoUsdToMsub(10_001, 'usd')).toBe(2);
    expect(nanoUsdToMsub(0, 'usd')).toBe(0);
    // $1 at $100k/BTC = 1000 sat = 1_000_000 msat
    expect(nanoUsdToMsub(1e9, 'sat', 100_000)).toBe(1_000_000);
    expect(() => nanoUsdToMsub(1, 'sat')).toThrow();
  });

  it('accumulates sub-unit charges without loss', () => {
    // 100 tiny requests of 0.3 milli-cents each = 30 milli-cents, not 100 cents
    const per = nanoUsdToMsub(costNanoUsd({ input_usd_per_mtok: 0.15, output_usd_per_mtok: 0 }, { inputTokens: 20, outputTokens: 0 }, 1), 'usd');
    expect(per).toBe(1);
    expect(msubToUnitsCeil(per * 100)).toBe(1);
  });

  it('flat pricing picks the size bucket plus declared output', () => {
    const flat = { buckets: [{ maxBytes: 100, usd: 0.01 }, { maxBytes: 1000, usd: 0.02 }], output_usd_per_mtok: 10 };
    expect(flatCostNanoUsd(flat, 50, 0, 1)).toBe(1e7);
    expect(flatCostNanoUsd(flat, 500, 100, 1)).toBe(2e7 + 100 * 10_000);
    expect(flatCostNanoUsd(flat, 5000, 0, 1)).toBe(2e7); // larger than last bucket: last bucket
  });

  it('display prices and estimates', () => {
    expect(displayPrice(2, 1.5, 'usd')).toBe(3);
    expect(displayPrice(100, 1, 'sat', 100_000)).toBe(100_000);
    expect(displayPrice(1, 1, 'sat')).toBeNull();
    expect(estimateTokensFromBytes(101, 2)).toBe(51);
  });
});
