/**
 * Tinfoil Containers attestation (V3, beta on Tinfoil's side). A container asks its enclave for a fresh
 * attestation over the socket /tinfoil/attestation.sock with a 32-byte nonce; Bellows passes its binding
 * as that nonce. The document (format https://tinfoil.sh/predicate/attestation/v3) carries:
 *
 *   challenge.nonce, challenge.report_data, challenge.report_data_algorithm
 *   cpu_evidence.{format, report_base64, endorsed.{crypto_material_hash, device_evidence_hash}}
 *   crypto_material, device_evidence (base64 JSON sections), collateral
 *
 * and the CPU quote's REPORT_DATA must equal
 *
 *   SHA-256("https://tinfoil.sh/report-data/v1" || nonce || SHA-256(crypto_material) || SHA-256(device_evidence)) || 32 zero bytes
 *
 * This module checks all of that except the hardware itself. Authenticating the SEV-SNP report or TDX quote
 * (vendor certificate chains, collateral, Sigstore provenance) and reading its measurement is the job of
 * `authenticate`, which the app supplies (for example from Tinfoil's own verifier). It returns the
 * REPORT_DATA it read from the authenticated quote, and the verifier compares that with the recomputed value. NOT VERIFIED against a
 * document from a real Tinfoil enclave: the format here follows Tinfoil's public documentation and the
 * document parser in its open-source Go SDK.
 */
import { equalBytes, fromBase64, fromHex, isLowerHex, sha256, toHex, utf8Encode } from './bytes.ts';
import { BellowsVerifyError } from './errors.ts';
import type { AttestationDocument } from './identity.ts';
import type { AttestationVerifier, VerifiedAttestation } from './verifier.ts';

export const TINFOIL_V3_FORMAT = 'https://tinfoil.sh/predicate/attestation/v3';
export const TINFOIL_REPORT_DATA_V1 = 'https://tinfoil.sh/report-data/v1';
export const TINFOIL_SEV_SNP_REPORT_V1 = 'https://tinfoil.sh/format/sev-snp-report/v1';
export const TINFOIL_TDX_QUOTE_V1 = 'https://tinfoil.sh/format/tdx-quote/v1';

/**
 * The measurement type of a Tinfoil release in builds.json: Tinfoil's code-provenance predicate, whose
 * registers are, in this order, the SEV-SNP launch measurement and the TDX RTMR1 and RTMR2, each as
 * lowercase hex. These are the values Tinfoil's release workflow publishes in tinfoil-deployment.json
 * (`snp_measurement`, `tdx_measurement.rtmr1`, `tdx_measurement.rtmr2`), and the deploy kit writes them in
 * this form (scripts/add-build.ts). An app's `authenticate` should return the measurement of the release it
 * authenticated in the same form, so that findBuild matches it. NOT VERIFIED against a real enclave.
 */
export const TINFOIL_RELEASE_MEASUREMENT_TYPE = 'https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1';

/** What the binding checks established, for `authenticate` to finish with the hardware. */
export interface TinfoilQuoteCheck {
  /** The whole document, as served. */
  document: AttestationDocument;
  /** The 64 bytes the CPU quote's REPORT_DATA must equal. */
  reportData: Uint8Array;
  /** cpu_evidence.format: which hardware (SEV-SNP report or TDX quote). */
  cpuFormat: string;
  /** The decoded report or quote. */
  report: Uint8Array;
}

/** What `authenticate` read from the authenticated quote. */
export interface TinfoilAuthenticated extends VerifiedAttestation {
  /**
   * The REPORT_DATA field read from the authenticated quote itself (64 bytes), never copied from
   * `check.reportData` or the document's JSON. The verifier compares it with the recomputed value.
   */
  reportData: Uint8Array;
}

export interface TinfoilVerifierOptions {
  /**
   * Must throw unless `report` is an authentic quote from the platform in `cpuFormat`, for an enclave the
   * app trusts. Returns the measurement it proves and the REPORT_DATA it carries; the verifier refuses the
   * document unless that REPORT_DATA equals `check.reportData`.
   */
  authenticate(check: TinfoilQuoteCheck): Promise<TinfoilAuthenticated>;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * The challenge checks a V3 document must pass before its quote is worth authenticating: right format,
 * nonce equal to `binding`, both endorsed section hashes recomputed from the sections, and REPORT_DATA
 * recomputed. Throws BellowsVerifyError('attestation_invalid') on the first failure.
 */
export async function checkTinfoilBinding(doc: AttestationDocument, binding: Uint8Array): Promise<TinfoilQuoteCheck> {
  const bad = (why: string) => new BellowsVerifyError('attestation_invalid', `Tinfoil attestation: ${why}`);
  if (binding.length !== 32) throw bad('the binding must be 32 bytes');
  if (doc.format !== TINFOIL_V3_FORMAT) throw bad(`unsupported format ${String(doc.format)}`);
  const ch = doc.challenge;
  const cpu = doc.cpu_evidence;
  if (!isObject(ch) || !isObject(cpu) || !isObject(cpu.endorsed)) throw bad('challenge or cpu_evidence is missing');
  if (ch.report_data_algorithm !== TINFOIL_REPORT_DATA_V1) throw bad(`unsupported report_data_algorithm ${String(ch.report_data_algorithm)}`);
  if (!isLowerHex(ch.nonce) || ch.nonce.length !== 64) throw bad('challenge.nonce must be 32 bytes of lowercase hex');
  if (ch.nonce !== toHex(binding)) throw bad('challenge nonce does not bind this statement');
  if (!isLowerHex(ch.report_data) || ch.report_data.length !== 128) throw bad('challenge.report_data must be 64 bytes of lowercase hex');
  if (typeof cpu.format !== 'string' || cpu.format === '' || typeof cpu.report_base64 !== 'string' || cpu.report_base64 === '') {
    throw bad('cpu_evidence is incomplete');
  }
  let cm: Uint8Array;
  let de: Uint8Array;
  let report: Uint8Array;
  try {
    cm = fromBase64(String(doc.crypto_material));
    de = fromBase64(String(doc.device_evidence));
    report = fromBase64(cpu.report_base64);
  } catch {
    throw bad('crypto_material, device_evidence or the report is not canonical base64');
  }
  const cmHash = await sha256(cm);
  const deHash = await sha256(de);
  if (cpu.endorsed.crypto_material_hash !== toHex(cmHash)) throw bad('crypto_material hash does not match cpu_evidence.endorsed');
  if (cpu.endorsed.device_evidence_hash !== toHex(deHash)) throw bad('device_evidence hash does not match cpu_evidence.endorsed');
  const reportData = await tinfoilReportData(binding, cmHash, deHash);
  if (!equalBytes(reportData, fromHex(ch.report_data))) throw bad('challenge.report_data does not match the recomputed value');
  return { document: doc, reportData, cpuFormat: cpu.format, report };
}

/** REPORT_DATA under https://tinfoil.sh/report-data/v1. */
export async function tinfoilReportData(nonce: Uint8Array, cryptoMaterialHash: Uint8Array, deviceEvidenceHash: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(64);
  out.set(await sha256(utf8Encode(TINFOIL_REPORT_DATA_V1), nonce, cryptoMaterialHash, deviceEvidenceHash), 0);
  return out;
}

/** A verifier for Tinfoil V3 documents: binding checks here, hardware checks in `authenticate`. */
export function tinfoilVerifier(opts: TinfoilVerifierOptions): AttestationVerifier {
  return {
    formats: [TINFOIL_V3_FORMAT],
    async verify(att, binding) {
      const check = await checkTinfoilBinding(att, binding);
      let r: TinfoilAuthenticated;
      try {
        r = await opts.authenticate(check);
      } catch (e) {
        if (e instanceof BellowsVerifyError) throw e;
        throw new BellowsVerifyError('attestation_invalid', `Tinfoil attestation: hardware check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // challenge.report_data is unauthenticated JSON. Only the quote's own REPORT_DATA binds the statement.
      if (!(r?.reportData instanceof Uint8Array) || !equalBytes(r.reportData, check.reportData)) {
        throw new BellowsVerifyError('attestation_invalid', 'Tinfoil attestation: the authenticated quote does not carry this REPORT_DATA');
      }
      return { measurement: r.measurement };
    },
  };
}
