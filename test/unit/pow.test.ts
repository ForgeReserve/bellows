import { describe, expect, it } from 'vitest';
import { leadingZeroBits, solvePow } from '../../client/pow.ts';
import { PowGate } from '../../src/pow.ts';

describe('proof of work', () => {
  it('counts leading zero bits', () => {
    expect(leadingZeroBits(Uint8Array.from([0x80]))).toBe(0);
    expect(leadingZeroBits(Uint8Array.from([0x01]))).toBe(7);
    expect(leadingZeroBits(Uint8Array.from([0x00, 0x10]))).toBe(11);
    expect(leadingZeroBits(Uint8Array.from([0, 0]))).toBe(16);
  });

  it('accepts a solved challenge once', async () => {
    const gate = new PowGate({ bits: 10 });
    const ch = gate.issue();
    expect(ch.bits).toBe(10);
    const sol = await solvePow(ch.challenge, ch.bits);
    expect(gate.verify(sol)).toEqual({ ok: true });
    expect(gate.verify(sol)).toEqual({ ok: false, reason: 'reused' });
  });

  it('refuses missing, malformed, unsolved, forged and expired solutions', async () => {
    let t = 1_000_000;
    const gate = new PowGate({ bits: 12, ttlMs: 60_000, now: () => t });
    expect(gate.verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(gate.verify('nonsense')).toEqual({ ok: false, reason: 'malformed' });
    const ch = gate.issue();
    // Find a nonce that does not meet the difficulty.
    let weak = '';
    for (let i = 0; ; i++) {
      const s = `${ch.challenge}:w${i}`;
      if (!gate.verify(s).ok) {
        weak = s;
        break;
      }
    }
    expect(gate.verify(weak)).toEqual({ ok: false, reason: 'insufficient' });
    // A challenge from another gate (another process key) is refused.
    const other = new PowGate({ bits: 12, now: () => t }).issue();
    expect(gate.verify(await solvePow(other.challenge, 12))).toEqual({ ok: false, reason: 'bad_challenge' });
    // A valid solution that arrives after the challenge expired.
    const sol = await solvePow(ch.challenge, 12);
    t += 61_000;
    expect(gate.verify(sol)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a challenge whose difficulty was edited', async () => {
    const gate = new PowGate({ bits: 12 });
    const ch = gate.issue();
    const [v, p, mac] = ch.challenge.split('.');
    const payload = Buffer.from(p!, 'base64url');
    payload.writeUInt8(1, 24);
    const edited = `${v}.${payload.toString('base64url')}.${mac}`;
    expect(gate.verify(await solvePow(edited, 1))).toEqual({ ok: false, reason: 'bad_challenge' });
  });
});
