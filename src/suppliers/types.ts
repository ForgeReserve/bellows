import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import type { ModelConfig, SupplierConfig } from '../config.ts';

export interface ChatCall {
  model: ModelConfig;
  /** OpenAI chat.completions body, already rewritten for the upstream (model, max tokens, stream_options). */
  body: Record<string, unknown>;
  stream: boolean;
  signal: AbortSignal;
}

/** Usage that a supplier reports out of band (for encrypted bodies the gateway cannot parse). */
export interface ReportedUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface EncryptedCall {
  model: ModelConfig;
  /** Path below the enclave origin, e.g. /v1/chat/completions. */
  path: string;
  /** Client-supplied enclave origin (X-Tinfoil-Enclave-Url), validated by the supplier. */
  enclaveUrl?: string;
  /** Headers forwarded verbatim (content-type, accept, Ehbp-Encapsulated-Key, X-Tinfoil-*). */
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
}

export interface EncryptedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
  /** Resolves after the body ends, with usage from a header or trailer if the supplier sent one. */
  usage: Promise<ReportedUsage | undefined>;
}

export interface Supplier {
  readonly id: string;
  readonly config: SupplierConfig;
  /** Plaintext OpenAI-compatible call. Returns the upstream Response (any status). */
  chat(call: ChatCall): Promise<Response>;
  /** Encrypted pass-through (EHBP). Only suppliers that support it implement this. */
  forwardEncrypted?(call: EncryptedCall): Promise<EncryptedResponse>;
  /** Proxy for the supplier's attestation bundle, if any. */
  attestation?(): Promise<Response>;
  /** Proxy for the enclave's HPKE key config (/.well-known/hpke-keys), if any. */
  hpkeKeys?(): Promise<Response>;
}

export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}
