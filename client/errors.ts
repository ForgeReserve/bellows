/** Every refusal from the client library. `code` is stable; the message says what failed. */
export type VerifyErrorCode =
  | 'fetch_failed'
  | 'bad_document'
  | 'development_refused'
  | 'no_verifier'
  | 'attestation_invalid'
  | 'build_not_approved'
  | 'build_mismatch'
  | 'bad_key_config'
  | 'bad_builds';

export class BellowsVerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = 'BellowsVerifyError';
    this.code = code;
  }
}

/** Refusals from the operator list, the pool and moving a balance. `code` is stable; the message says what failed. */
export type OperatorErrorCode =
  /** An announcement is not a valid, signed Bellows operator announcement. */
  | 'bad_announcement'
  /** The Bellows at the announced address does not carry, in its attested identity, a signed announcement by the same key for the same address. */
  | 'announcement_mismatch'
  /** The Bellows does not take what the caller needs (unit, mint, a relay, an onion address). */
  | 'not_accepted'
  /** The Bellows was verified but did not answer its health check. */
  | 'unhealthy'
  /** No operator in the list could be used. `failures` says why for each. */
  | 'no_operator'
  /** The operator id is not in the list. */
  | 'unknown_operator';

export class OperatorError extends Error {
  readonly code: OperatorErrorCode;
  /** For no_operator: each operator tried and why it was passed over. */
  readonly failures: readonly { id: string; reason: string }[];
  constructor(code: OperatorErrorCode, message: string, failures: readonly { id: string; reason: string }[] = []) {
    super(message);
    this.name = 'OperatorError';
    this.code = code;
    this.failures = failures;
  }
}
