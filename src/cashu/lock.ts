import { pointFromHex } from '@cashu/cashu-ts';
import { PaymentError } from './wallet.ts';

/**
 * Parses the key a customer wants their change or refund locked to (NUT-11 P2PK) and returns it as
 * the 33-byte compressed SEC1 hex that goes into the lock.
 *
 * Accepted forms:
 *  - 66 hex chars starting 02 or 03: a compressed public key, as cashu.me ("P2PK Key") and Foxy show it.
 *  - npub1...: a nostr public key (Minibits and cashu.me lock to these). Converted to "02" + x, the
 *    convention both wallets and cashu-ts use for x-only keys.
 *  - 64 hex chars: an x-only (nostr hex) key, converted the same way.
 * The point must be on secp256k1; anything else is a 400.
 */
export function parseLockPubkey(input: unknown): string {
  const bad = (why: string) => new PaymentError('invalid_pubkey', `pubkey ${why}; expected a 33-byte compressed secp256k1 key in hex (02.. or 03..) or an npub`);
  if (typeof input !== 'string') throw bad('is not a string');
  const s = input.trim();
  let hex: string;
  if (/^npub1/i.test(s)) {
    const x = decodeNpub(s.toLowerCase());
    if (!x) throw bad('is not a valid npub');
    hex = '02' + x;
  } else if (/^0[23][0-9a-f]{64}$/i.test(s)) hex = s.toLowerCase();
  else if (/^[0-9a-f]{64}$/i.test(s)) hex = '02' + s.toLowerCase();
  else throw bad(/^04[0-9a-f]{128}$/i.test(s) ? 'is uncompressed' : 'has the wrong format');
  try {
    pointFromHex(hex);
  } catch {
    throw bad('is not a point on secp256k1');
  }
  return hex;
}

/** Optional variant: undefined/null/'' mean "no lock". */
export function parseOptionalLockPubkey(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  return parseLockPubkey(input);
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]!;
  }
  return chk >>> 0;
}

/** Decodes a bech32 (BIP-173) npub to its 32-byte x-only key in hex, or null. */
export function decodeNpub(s: string): string | null {
  const pos = s.lastIndexOf('1');
  if (s.length > 90 || pos < 1 || s.slice(0, pos) !== 'npub') return null;
  const data: number[] = [];
  for (const ch of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  if (data.length < 6) return null;
  const hrp = [...'npub'].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)];
  if (polymod([...expanded, ...data]) !== 1) return null;
  // 5-bit groups to bytes, no padding allowed beyond 4 zero bits.
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
  if (out.length !== 32) return null;
  return Buffer.from(out).toString('hex');
}
