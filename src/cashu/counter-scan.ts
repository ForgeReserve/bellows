/**
 * NUT-13 counter recovery. The wallet derives every output from the wallet secret and a per-keyset counter
 * kept in the database. A new database (memory storage after any restart, or a lost volume) starts those
 * counters at 0 under the same secret, so the mint would refuse the outputs as already signed. The scan
 * asks the mint (NUT-09 restore) which counters it has signed, from a starting counter, one batch at a
 * time, and stops after a run of empty batches: the gap.
 *
 * Gaps inside the used range are normal: a swap the mint refused (a spent token) reserved counters it never
 * signed. One operation reserves at most a few dozen. The gap below is far larger, and a collision the scan
 * still misses (a longer run of refused swaps) is caught when it happens: the mint answers "outputs already
 * signed", the wallet scans forward from there and retries (src/cashu/wallet.ts).
 */
import type { Proof } from '@cashu/cashu-ts';

export interface ScanLimits {
  /** Counters asked per restore request (capped by the mint's NUT-06 max_array_length). */
  batchSize: number;
  /** Empty counters in a row after the last signed one before the scan stops. */
  gap: number;
  /** Most restore requests for one keyset. */
  maxBatches: number;
  /** The scan gives up (incomplete) at this time, in ms since the epoch. */
  deadline: number;
}

export const COUNTER_SCAN_DEFAULTS = {
  batchSize: 500,
  gap: 1000,
  maxBatches: 400,
  /** Per mint, every keyset of every unit included. */
  timeoutMs: 120_000,
} as const;

/** One restore request: the proofs the mint signed in [start, start+count), and the highest signed counter. */
export type RestoreBatch = (start: number, count: number) => Promise<{ proofs: Proof[]; lastCounterWithSignature?: number }>;

export interface ScanResult {
  /** Proofs the mint signed at or after `from`. Their state is not checked here. */
  proofs: Proof[];
  /** The first counter after the highest one the mint signed, or `from` when it signed none. */
  next: number;
  batches: number;
  /** false: a bound was reached before the gap; `next` is then not known to be safe. */
  complete: boolean;
}

/** Empty batches in a row that make up the gap. */
export function gapBatches(l: Pick<ScanLimits, 'batchSize' | 'gap'>): number {
  return Math.max(1, Math.ceil(l.gap / l.batchSize));
}

/** Scans from `from` until `gap` counters in a row come back unsigned, or a bound is reached. */
export async function scanCounters(restore: RestoreBatch, from: number, limits: ScanLimits, now: () => number = Date.now): Promise<ScanResult> {
  if (!(limits.batchSize >= 1) || !(limits.gap >= 1)) throw new Error('scan: batchSize and gap must be at least 1');
  const need = gapBatches(limits);
  const proofs: Proof[] = [];
  let last: number | undefined;
  let empty = 0;
  let batches = 0;
  let start = from;
  while (empty < need) {
    if (batches >= limits.maxBatches || now() >= limits.deadline) {
      return { proofs, next: last === undefined ? from : last + 1, batches, complete: false };
    }
    const r = await restore(start, limits.batchSize);
    batches++;
    if (r.lastCounterWithSignature !== undefined) {
      if (r.lastCounterWithSignature < start || r.lastCounterWithSignature >= start + limits.batchSize) {
        throw new Error(`scan: the mint signed counter ${r.lastCounterWithSignature}, outside the batch ${start}..${start + limits.batchSize - 1}`);
      }
      last = r.lastCounterWithSignature;
      proofs.push(...r.proofs);
      empty = 0;
    } else {
      empty++;
    }
    start += limits.batchSize;
  }
  return { proofs, next: last === undefined ? from : last + 1, batches, complete: true };
}
