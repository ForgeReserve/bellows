/**
 * Proof of work for requests that open a new balance. It replaces the per-address rate limit those
 * requests had: Bellows never looks at a client address, so a client pays a little CPU instead.
 *
 * A challenge is stateless: random bytes, an expiry and the difficulty, with an HMAC under a key that
 * exists only in this process (new on every start). A solution is `<challenge>:<nonce>` such that
 * SHA-256 of that string starts with at least `bits` zero bits. Each challenge is accepted once.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { leadingZeroBits } from '../client/pow.ts';

// One definition of the headers and the bit count, shared with the client that solves the challenge
// (client/pow.ts). Tests solve with the client's solvePow, the one apps run.
export { POW_CHALLENGE_HEADER, POW_HEADER } from '../client/pow.ts';

const PREFIX = 'v1';
const MAC_BYTES = 16;

export interface PowChallenge {
  challenge: string;
  bits: number;
  expires_at: number;
}

export type PowFailure = 'missing' | 'malformed' | 'bad_challenge' | 'expired' | 'insufficient' | 'reused';

function powHash(challenge: string, nonce: string): Buffer {
  return createHash('sha256').update(`${challenge}:${nonce}`).digest();
}

export class PowGate {
  readonly bits: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly key = randomBytes(32);
  private readonly used = new Map<string, number>();
  private lastSweep = 0;

  constructor(opts: { bits: number; ttlMs?: number; now?: () => number }) {
    this.bits = opts.bits;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.bits > 0;
  }

  private mac(payload: Buffer): Buffer {
    return createHmac('sha256', this.key).update(payload).digest().subarray(0, MAC_BYTES);
  }

  issue(): PowChallenge {
    const expires = this.now() + this.ttlMs;
    const payload = Buffer.alloc(16 + 8 + 1);
    randomBytes(16).copy(payload, 0);
    payload.writeBigUInt64BE(BigInt(expires), 16);
    payload.writeUInt8(this.bits, 24);
    const challenge = `${PREFIX}.${payload.toString('base64url')}.${this.mac(payload).toString('base64url')}`;
    return { challenge, bits: this.bits, expires_at: expires };
  }

  /** Checks a `<challenge>:<nonce>` solution and spends the challenge. */
  verify(solution: string | undefined): { ok: true } | { ok: false; reason: PowFailure } {
    if (!solution) return { ok: false, reason: 'missing' };
    const m = /^(v1\.[A-Za-z0-9_-]{30,40}\.[A-Za-z0-9_-]{20,24}):([A-Za-z0-9_-]{1,32})$/.exec(solution.trim());
    if (!m) return { ok: false, reason: 'malformed' };
    const challenge = m[1]!;
    const nonce = m[2]!;
    const [, p, t] = challenge.split('.');
    const payload = Buffer.from(p!, 'base64url');
    const tag = Buffer.from(t!, 'base64url');
    if (payload.length !== 25 || tag.length !== MAC_BYTES || !timingSafeEqual(tag, this.mac(payload))) return { ok: false, reason: 'bad_challenge' };
    const expires = Number(payload.readBigUInt64BE(16));
    const bits = payload.readUInt8(24);
    const t0 = this.now();
    if (expires <= t0) return { ok: false, reason: 'expired' };
    if (bits < this.bits || leadingZeroBits(powHash(challenge, nonce)) < bits) return { ok: false, reason: 'insufficient' };
    this.sweep(t0);
    if (this.used.has(challenge)) return { ok: false, reason: 'reused' };
    this.used.set(challenge, expires);
    return { ok: true };
  }

  private sweep(t0: number) {
    if (t0 - this.lastSweep < 30_000) return;
    this.lastSweep = t0;
    for (const [c, exp] of this.used) if (exp <= t0) this.used.delete(c);
  }
}
