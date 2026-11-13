/**
 * The development attester: a signed stand-in for hardware attestation, clearly marked, that clients refuse
 * unless they opt into development mode (client/dev.ts). It signs with an ECDSA P-256 key made in memory on
 * first use, so it proves only that the document was not altered after this process made it.
 */
import { createHash } from 'node:crypto';
import { DEV_ATTESTATION_FORMAT, DEV_MEASUREMENT_TYPE, DEV_SIGNATURE, DEV_WARNING, type DevPayload } from '../../client/dev.ts';
import { toBase64, toHex } from '../../client/bytes.ts';
import type { Measurement } from '../../client/builds.ts';
import type { AttestationDocument } from '../../client/identity.ts';
import type { Attester } from '../identity.ts';

/** The default development measurement: one register, SHA-256 of a fixed label. */
export const DEFAULT_DEV_REGISTER = createHash('sha256').update('bellows development build').digest('hex');

export function devMeasurement(register = DEFAULT_DEV_REGISTER): Measurement {
  return { type: DEV_MEASUREMENT_TYPE, registers: [register] };
}

export function devAttester(opts: { measurement: Measurement; now?: () => Date }): Attester {
  let keys: Promise<{ key: CryptoKey; spki: string }> | undefined;
  const signingKey = () =>
    (keys ??= (async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      return { key: pair.privateKey, spki: toBase64(spki) };
    })());
  return {
    kind: 'dev',
    async attest(reportData: Uint8Array): Promise<AttestationDocument> {
      if (reportData.length !== 32) throw new Error('report data must be 32 bytes');
      const { key, spki } = await signingKey();
      const payload: DevPayload = {
        report_data: toHex(reportData),
        measurement: opts.measurement,
        issued_at: (opts.now?.() ?? new Date()).toISOString(),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const sig = new Uint8Array(await crypto.subtle.sign(DEV_SIGNATURE, key, bytes));
      return { format: DEV_ATTESTATION_FORMAT, warning: DEV_WARNING, payload: toBase64(bytes), public_key: spki, signature: toBase64(sig) };
    },
  };
}
