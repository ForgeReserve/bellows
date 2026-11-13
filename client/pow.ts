/**
 * Proof of work for requests that open a new balance (the Bellows answers 428 pow_required with a
 * challenge). A solution is "<challenge>:<nonce>" whose SHA-256 starts with at least `bits` zero bits.
 * Expected work: 2^bits hashes (16 bits, the default difficulty, takes well under a second).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8Encode } from './bytes.ts';

/** The request header that carries a solution. */
export const POW_HEADER = 'X-Bellows-Pow';
/** The answer header that carries a new challenge. */
export const POW_CHALLENGE_HEADER = 'X-Bellows-Pow-Challenge';

export function leadingZeroBits(buf: Uint8Array): number {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

/**
 * Finds a nonce for a challenge and returns the header value. Yields to the event loop every few thousand
 * hashes so a page stays responsive.
 */
export async function solvePow(challenge: string, bits: number): Promise<string> {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`proof of work difficulty out of range: ${bits}`);
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (leadingZeroBits(sha256(utf8Encode(`${challenge}:${nonce}`))) >= bits) return `${challenge}:${nonce}`;
    if (i % 4096 === 4095) await new Promise((r) => setTimeout(r, 0));
  }
}
