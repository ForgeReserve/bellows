import { getEncodedToken } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { GatewayWallet } from '../../src/cashu/wallet.ts';
import { openDb } from '../../src/db.ts';
import { RateLimiter } from '../../src/ratelimit.ts';

const fakeProof = { id: '00ad268c4d1f5826', amount: 8, secret: 'abc', C: '02' + '11'.repeat(32) } as any;

describe('token validation (no mint contact)', () => {
  const w = new GatewayWallet(openDb(':memory:'), { trustedMints: ['https://mint.example/'], units: ['usd', 'sat'], maxTokenBytes: 2000, seed: new Uint8Array(64) });

  it('rejects non-cashuB input', async () => {
    await expect(w.inspect('cashuAeyJ0b2tlbiI6W119')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(w.inspect('hello')).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects untrusted mints before contacting anything', async () => {
    const t = getEncodedToken({ mint: 'https://evil.example', unit: 'usd', proofs: [fakeProof] });
    await expect(w.inspect(t)).rejects.toMatchObject({ code: 'untrusted_mint', status: 400 });
  });

  it('rejects units the gateway does not take, and the wrong unit', async () => {
    const eur = getEncodedToken({ mint: 'https://mint.example', unit: 'eur', proofs: [fakeProof] });
    await expect(w.inspect(eur)).rejects.toMatchObject({ code: 'wrong_unit' });
    const sat = getEncodedToken({ mint: 'https://mint.example', unit: 'sat', proofs: [fakeProof] });
    await expect(w.inspect(sat, 'usd')).rejects.toMatchObject({ code: 'wrong_unit' });
  });

  it('rejects oversized tokens', async () => {
    await expect(w.inspect('cashuB' + 'a'.repeat(3000))).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('normalizes trusted mint URLs', () => {
    expect(w.isTrusted('https://mint.example')).toBe(true);
    expect(w.isTrusted('https://mint.example/')).toBe(true);
    expect(w.isTrusted('https://mint.example.evil')).toBe(false);
  });
});

describe('rate limiter', () => {
  it('allows a burst then refills', () => {
    const r = new RateLimiter(60, 2);
    expect(r.take('k', 0)).toBe(0);
    expect(r.take('k', 0)).toBe(0);
    expect(r.take('k', 0)).toBeGreaterThan(0);
    expect(r.take('k', 1000)).toBe(0);
    expect(r.take('other', 0)).toBe(0);
  });
});
