import type { SupplierConfig } from '../config.ts';
import { errText, log } from '../log.ts';
import { type ChatCall, type Supplier, UpstreamError } from './types.ts';

export interface RetryOptions {
  retries: number;
  timeoutMs: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * fetch with retries on network errors and retryable statuses, before any body byte is consumed.
 * A header timeout is final, since the supplier may already be working on the request.
 * timeoutMs bounds the time to response headers; the body is bounded only by the caller's signal.
 */
export async function fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal, o: RetryOptions): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (signal.aborted) throw new UpstreamError('client aborted', 499);
    const headerTimeout = new AbortController();
    const timer = setTimeout(() => headerTimeout.abort(new Error('upstream timeout')), o.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, headerTimeout.signal]) });
      clearTimeout(timer);
      if (RETRYABLE.has(res.status) && attempt < o.retries) {
        await res.body?.cancel().catch(() => {});
        lastErr = new UpstreamError(`upstream HTTP ${res.status}`, res.status);
      } else {
        return res;
      }
    } catch (e) {
      clearTimeout(timer);
      if (signal.aborted) throw new UpstreamError('client aborted', 499);
      // The request reached the supplier and may still be running (and billing) there: never resend it.
      if (headerTimeout.signal.aborted) throw new UpstreamError('upstream timeout', 504);
      lastErr = e;
    }
    log.warn('upstream_retry', { url: new URL(url).host, attempt, err: errText(lastErr) });
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  if (lastErr instanceof UpstreamError) throw lastErr;
  throw new UpstreamError(`upstream unreachable: ${errText(lastErr)}`, 502);
}

/** Any OpenAI-compatible endpoint (Token Factory's LiteLLM proxy, Tinfoil plaintext, ...). */
export class OpenAISupplier implements Supplier {
  readonly id: string;
  readonly config: SupplierConfig;
  protected readonly apiKey: string | undefined;
  protected readonly retry: RetryOptions;

  /** apiKey: read from the secrets source by the caller (config.apiKeySecret names it). */
  constructor(id: string, config: SupplierConfig, apiKey: string | undefined, retry: RetryOptions) {
    this.id = id;
    this.config = config;
    this.apiKey = apiKey;
    this.retry = retry;
    if (!config.baseUrl) throw new Error(`supplier ${id}: baseUrl required`);
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  /** Supplier-specific request headers. */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  async chat(call: ChatCall): Promise<Response> {
    if (!this.apiKey) throw new UpstreamError(`supplier ${this.id} has no API key configured`, 503);
    const url = `${this.config.baseUrl!.replace(/\/$/, '')}/chat/completions`;
    return fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: call.stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders(),
        },
        body: JSON.stringify(call.body),
      },
      call.signal,
      this.retry,
    );
  }
}
