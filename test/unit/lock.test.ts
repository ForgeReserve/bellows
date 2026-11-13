import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { decodeNpub, parseLockPubkey, parseOptionalLockPubkey } from '../../src/cashu/lock.ts';

// NIP-19 test vector.
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const X = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

describe('parseLockPubkey', () => {
  it('accepts compressed keys (02/03), normalising case and whitespace', () => {
    expect(parseLockPubkey(G)).toBe(G);
    expect(parseLockPubkey(`  ${G.toUpperCase()} `)).toBe(G);
    const odd = Buffer.from(getPubKeyFromPrivKey(Buffer.alloc(32, 3))).toString('hex');
    expect(parseLockPubkey(odd)).toBe(odd);
  });

  it('maps npub and x-only hex to "02" + x, as cashu.me, Minibits and cashu-ts do', () => {
    expect(decodeNpub(NPUB)).toBe(X);
    expect(parseLockPubkey(NPUB)).toBe('02' + X);
    expect(parseLockPubkey(NPUB.toUpperCase())).toBe('02' + X);
    expect(parseLockPubkey(X)).toBe('02' + X);
  });

  it('rejects everything else with invalid_pubkey (400)', () => {
    const bad = [
      '',
      'zz',
      42,
      null,
      '04' + 'ab'.repeat(64), // uncompressed
      '05' + G.slice(2), // bad prefix
      '02' + '00'.repeat(32), // x not on the curve
      '02' + 'ff'.repeat(32), // x >= p
      NPUB.slice(0, -1) + 'h', // bad checksum
      'nsec1' + NPUB.slice(5), // wrong prefix
    ];
    for (const b of bad) {
      let err: any;
      try {
        parseLockPubkey(b);
      } catch (e) {
        err = e;
      }
      expect(err?.code, String(b)).toBe('invalid_pubkey');
      expect(err.status).toBe(400);
    }
  });

  it('optional variant treats missing as no lock', () => {
    expect(parseOptionalLockPubkey(undefined)).toBeNull();
    expect(parseOptionalLockPubkey('')).toBeNull();
    expect(parseOptionalLockPubkey(G)).toBe(G);
    expect(() => parseOptionalLockPubkey('nope')).toThrow();
  });
});
