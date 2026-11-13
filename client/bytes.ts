/**
 * Byte helpers on Web APIs only (TextEncoder, atob/btoa, crypto.subtle), so the client runs in browsers
 * and in Node without Node-only modules.
 */

export const utf8Encode = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
export const utf8Decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Lowercase hex only, even length; `bytes` checks the decoded length when given. */
export function fromHex(s: string, bytes?: number): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !HEX_RE.test(s)) throw new Error('not lowercase hex');
  if (bytes !== undefined && s.length !== bytes * 2) throw new Error(`expected ${bytes} bytes of hex, got ${s.length / 2}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const isLowerHex = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && HEX_RE.test(s);

export function toBase64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 with padding, nothing else (no whitespace, no URL alphabet). */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || !B64_RE.test(s)) throw new Error('not canonical base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Canonical: re-encoding gives the same text, so unused trailing bits are zero.
  if (toBase64(out) !== s) throw new Error('not canonical base64');
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** A copy backed by its own ArrayBuffer, as WebCrypto wants. */
export const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}
