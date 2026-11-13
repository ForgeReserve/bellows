/**
 * The development stand-in for hardware attestation. A Bellows on a laptop signs its binding with a key it
 * made at boot, so the whole flow runs and is tested without sealed hardware. It proves nothing about what
 * runs: anyone can make one. verifyBellows refuses it unless the caller sets allowDevelopment.
 *
 *   {
 *     "format": "urn:bellows:attestation:dev:v1",
 *     "warning": "DEVELOPMENT STAND-IN. NOT HARDWARE ATTESTATION. PROVES NOTHING.",
 *     "payload": "<base64 of JSON { report_data: <hex>, measurement: {...}, issued_at: <ISO time> }>",
 *     "public_key": "<base64 SPKI, ECDSA P-256>",
 *     "signature": "<base64 ECDSA P-256 SHA-256 signature over the payload bytes, r||s>"
 *   }
 */
import { type Measurement, parseMeasurement } from './builds.ts';
import { fromBase64, fromHex, toHex, utf8Decode } from './bytes.ts';
import { BellowsVerifyError } from './errors.ts';
import type { AttestationVerifier } from './verifier.ts';

export const DEV_ATTESTATION_FORMAT = 'urn:bellows:attestation:dev:v1';
export const DEV_MEASUREMENT_TYPE = 'urn:bellows:measurement:dev:v1';
export const DEV_WARNING = 'DEVELOPMENT STAND-IN. NOT HARDWARE ATTESTATION. PROVES NOTHING.';
export const DEV_SIGNATURE = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface DevPayload {
  report_data: string;
  measurement: { type: string; registers: string[] };
  issued_at: string;
}

export interface DevVerifierOptions {
  /** Base64 SPKI keys to accept. Unset: any key, which is all a stand-in can offer. */
  trustedKeys?: readonly string[];
}

export function devVerifier(opts: DevVerifierOptions = {}): AttestationVerifier {
  const bad = (why: string) => new BellowsVerifyError('attestation_invalid', `development attestation: ${why}`);
  return {
    formats: [DEV_ATTESTATION_FORMAT],
    async verify(att, binding) {
      if (att.format !== DEV_ATTESTATION_FORMAT) throw bad('wrong format');
      if (att.warning !== DEV_WARNING) throw bad('missing the development warning');
      if (typeof att.payload !== 'string' || typeof att.public_key !== 'string' || typeof att.signature !== 'string') throw bad('incomplete');
      if (opts.trustedKeys && !opts.trustedKeys.includes(att.public_key)) throw bad('signing key is not trusted');
      let payloadBytes: Uint8Array<ArrayBuffer>;
      let key: CryptoKey;
      let sig: Uint8Array<ArrayBuffer>;
      try {
        payloadBytes = fromBase64(att.payload);
        sig = fromBase64(att.signature);
        key = await crypto.subtle.importKey('spki', fromBase64(att.public_key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      } catch {
        throw bad('undecodable key, payload or signature');
      }
      if (!(await crypto.subtle.verify(DEV_SIGNATURE, key, sig, payloadBytes))) throw bad('bad signature');
      let p: DevPayload;
      try {
        p = JSON.parse(utf8Decode(payloadBytes)) as DevPayload;
        fromHex(p.report_data, 32);
      } catch {
        throw bad('malformed payload');
      }
      if (p.report_data !== toHex(binding)) throw bad('does not bind this statement');
      let measurement: Measurement;
      try {
        measurement = parseMeasurement(p.measurement, 'development measurement');
      } catch {
        throw bad('malformed measurement');
      }
      if (measurement.type !== DEV_MEASUREMENT_TYPE) throw bad('measurement is not a development measurement');
      return { measurement };
    },
  };
}
