import type { Measurement } from './builds.ts';
import type { AttestationDocument } from './identity.ts';

export interface VerifiedAttestation {
  /** The measurement the hardware proves, in the form builds.json lists. */
  measurement: Measurement;
}

/**
 * Hardware verification, supplied by the app. A verifier handles the attestation formats it names. It must
 * throw unless the document is authentic for its platform AND binds exactly `binding` (32 bytes), and it
 * returns the measurement the document proves.
 */
export interface AttestationVerifier {
  readonly formats: readonly string[];
  verify(attestation: AttestationDocument, binding: Uint8Array): Promise<VerifiedAttestation>;
}
