/**
 * HPKE key configuration in the encoding of RFC 9458 (Oblivious HTTP), section 3.1:
 *
 *   key_id (1 byte) | kem_id (2) | public_key (Npk) | cipher_suites length (2) | (kdf_id (2) | aead_id (2))...
 *
 * Bellows uses one KEM, DHKEM(X25519, HKDF-SHA256), whose public key is 32 bytes.
 */
import { BellowsVerifyError } from './errors.ts';

export const KEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;
export const AEAD_CHACHA20_POLY1305 = 0x0003;

const NPK: Record<number, number> = { [KEM_X25519_HKDF_SHA256]: 32 };

export interface CipherSuite {
  kdfId: number;
  aeadId: number;
}

export interface KeyConfig {
  keyId: number;
  kemId: number;
  publicKey: Uint8Array;
  suites: CipherSuite[];
}

export function encodeKeyConfig(k: KeyConfig): Uint8Array<ArrayBuffer> {
  const npk = NPK[k.kemId];
  if (npk === undefined) throw new Error(`unsupported KEM 0x${k.kemId.toString(16)}`);
  if (k.publicKey.length !== npk) throw new Error(`public key must be ${npk} bytes`);
  if (!Number.isInteger(k.keyId) || k.keyId < 0 || k.keyId > 255) throw new Error('key id must be one byte');
  if (k.suites.length === 0) throw new Error('at least one cipher suite');
  const out = new Uint8Array(1 + 2 + npk + 2 + 4 * k.suites.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, k.keyId);
  v.setUint16(1, k.kemId);
  out.set(k.publicKey, 3);
  v.setUint16(3 + npk, 4 * k.suites.length);
  k.suites.forEach((s, i) => {
    v.setUint16(5 + npk + 4 * i, s.kdfId);
    v.setUint16(7 + npk + 4 * i, s.aeadId);
  });
  return out;
}

/** Parses exactly one key configuration; anything left over, short, or of an unknown KEM is refused. */
export function parseKeyConfig(b: Uint8Array): KeyConfig {
  const bad = (why: string) => new BellowsVerifyError('bad_key_config', `HPKE key config: ${why}`);
  if (b.length < 3) throw bad('too short');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const keyId = v.getUint8(0);
  const kemId = v.getUint16(1);
  const npk = NPK[kemId];
  if (npk === undefined) throw bad(`unsupported KEM 0x${kemId.toString(16).padStart(4, '0')}`);
  if (b.length < 3 + npk + 2) throw bad('too short');
  const publicKey = b.slice(3, 3 + npk);
  const len = v.getUint16(3 + npk);
  if (len === 0 || len % 4 !== 0) throw bad('cipher suites must be a non-empty list of 4-byte entries');
  if (b.length !== 5 + npk + len) throw bad('length does not match its cipher suites');
  const suites: CipherSuite[] = [];
  for (let o = 5 + npk; o < b.length; o += 4) suites.push({ kdfId: v.getUint16(o), aeadId: v.getUint16(o + 2) });
  return { keyId, kemId, publicKey, suites };
}
