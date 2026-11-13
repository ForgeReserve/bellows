/**
 * The gap logic of the NUT-13 counter scan (src/cashu/counter-scan.ts), against a fake mint that has
 * signed a given set of counters.
 */
import type { Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { COUNTER_SCAN_DEFAULTS, gapBatches, type RestoreBatch, scanCounters } from '../../src/cashu/counter-scan.ts';

/** A mint that signed exactly `signed`; counts the restore requests it answers. */
function fakeMint(signed: Iterable<number>) {
  const set = new Set(signed);
  const calls: Array<[number, number]> = [];
  const restore: RestoreBatch = async (start, count) => {
    calls.push([start, count]);
    const hits = [...set].filter((c) => c >= start && c < start + count).sort((a, b) => a - b);
    return { proofs: hits.map((c) => ({ secret: `s${c}`, amount: 1, id: 'ks', C: '' }) as unknown as Proof), lastCounterWithSignature: hits.at(-1) };
  };
  return { restore, calls };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const limits = (o: Partial<{ batchSize: number; gap: number; maxBatches: number; deadline: number }> = {}) => ({
  batchSize: 10,
  gap: 30,
  maxBatches: 100,
  deadline: Number.MAX_SAFE_INTEGER,
  ...o,
});

describe('counter scan', () => {
  it('stops after the gap with nothing signed, and leaves the counter where it started', async () => {
    const m = fakeMint([]);
    expect(await scanCounters(m.restore, 0, limits())).toEqual({ proofs: [], next: 0, batches: 3, complete: true });
    expect(m.calls).toEqual([
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
  });

  it('moves the counter past the highest signed one and returns every signed proof', async () => {
    const m = fakeMint(range(0, 23));
    const r = await scanCounters(m.restore, 0, limits());
    expect(r).toMatchObject({ next: 23, complete: true, batches: 6 });
    expect(r.proofs.map((p) => p.secret)).toEqual(range(0, 23).map((c) => `s${c}`));
  });

  it('crosses a hole shorter than the gap (refused swaps reserve counters the mint never signs)', async () => {
    const m = fakeMint([...range(0, 5), ...range(30, 34)]);
    expect(await scanCounters(m.restore, 0, limits())).toMatchObject({ next: 34, complete: true });
  });

  it('stops at a hole as long as the gap: what lies beyond is caught when the mint refuses it', async () => {
    const m = fakeMint([...range(0, 5), ...range(45, 50)]);
    expect(await scanCounters(m.restore, 0, limits())).toMatchObject({ next: 5, complete: true, batches: 4 });
  });

  it('starts where it is told to', async () => {
    const m = fakeMint(range(0, 50));
    expect(await scanCounters(m.restore, 40, limits())).toMatchObject({ next: 50, complete: true });
    expect(m.calls[0]).toEqual([40, 10]);
  });

  it('is incomplete when it runs out of requests or time, and never claims a safe counter then', async () => {
    const busy = fakeMint(range(0, 1000));
    expect(await scanCounters(busy.restore, 0, limits({ maxBatches: 5 }))).toMatchObject({ next: 50, batches: 5, complete: false });
    expect(busy.calls).toHaveLength(5);
    let t = 0;
    const late = fakeMint(range(0, 1000));
    const timed: RestoreBatch = async (s, n) => {
      t += 1000;
      return late.restore(s, n);
    };
    expect(await scanCounters(timed, 0, limits({ deadline: 2500 }), () => t)).toMatchObject({ batches: 3, complete: false });
  });

  it('refuses an answer outside the batch it asked for', async () => {
    const liar: RestoreBatch = async () => ({ proofs: [], lastCounterWithSignature: 99 });
    await expect(scanCounters(liar, 0, limits())).rejects.toThrow(/outside the batch/);
  });

  it('counts the gap in whole batches, at least one', () => {
    expect(gapBatches({ batchSize: 10, gap: 30 })).toBe(3);
    expect(gapBatches({ batchSize: 10, gap: 31 })).toBe(4);
    expect(gapBatches({ batchSize: 500, gap: 10 })).toBe(1);
    expect(gapBatches(COUNTER_SCAN_DEFAULTS)).toBe(2);
    expect(COUNTER_SCAN_DEFAULTS.batchSize * COUNTER_SCAN_DEFAULTS.maxBatches).toBe(200_000);
  });
});
