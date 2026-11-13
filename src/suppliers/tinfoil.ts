import http from 'node:http';
import https from 'node:https';
import type { SupplierConfig } from '../config.ts';
import { OpenAISupplier, type RetryOptions } from './openai.ts';
import { type EncryptedCall, type EncryptedResponse, type ReportedUsage, UpstreamError } from './types.ts';

export const USAGE_REQUEST_HEADER = 'x-tinfoil-request-usage-metrics';
export const USAGE_HEADER = 'x-tinfoil-usage-metrics';

/** Parses `prompt=67,completion=42,total=109,model=gpt-oss-120b,cost_usd=0.000042`. */
export function parseUsageMetrics(v: string | string[] | undefined): ReportedUsage | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return undefined;
  const map = new Map<string, string>();
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const prompt = Number(map.get('prompt'));
  const completion = Number(map.get('completion'));
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return undefined;
  const cost = map.has('cost_usd') ? Number(map.get('cost_usd')) : undefined;
  return { inputTokens: prompt, outputTokens: completion, costUsd: Number.isFinite(cost) ? cost : undefined };
}

/**
 * Tinfoil: plaintext OpenAI-compatible calls (gateway can read them) plus EHBP pass-through, where the
 * request and response bodies are HPKE ciphertext end to end between the client and the enclave.
 * Following Tinfoil's proxy guide, the gateway forwards Content-Type, Accept, Ehbp-Encapsulated-Key and
 * the X-Tinfoil-* limit headers, adds its own bearer key and X-Tinfoil-Request-Usage-Metrics, and reads
 * X-Tinfoil-Usage-Metrics from the response header (non-streaming) or HTTP trailer (streaming).
 */
export class TinfoilSupplier extends OpenAISupplier {
  constructor(id: string, config: SupplierConfig, apiKey: string | undefined, retry: RetryOptions) {
    super(id, config, apiKey, retry);
  }

  /** Asks for X-Tinfoil-Usage-Metrics on plaintext calls too: its cost_usd is what the request cost us. */
  protected override extraHeaders(): Record<string, string> {
    return { [USAGE_REQUEST_HEADER]: 'true' };
  }

  private defaultEnclave(): string {
    return this.config.enclaveUrl ?? new URL(this.config.baseUrl!).origin;
  }

  /** Allowlist check from the proxy guide: https, host is (a subdomain of) an allowed host, no userinfo. */
  validateEnclaveUrl(raw: string | undefined): URL {
    const u = new URL(raw ?? this.defaultEnclave());
    if (u.username || u.password) throw new UpstreamError('enclave URL must not carry credentials', 400);
    const insecureOk = this.config.allowInsecureEnclave && u.protocol === 'http:';
    if (u.protocol !== 'https:' && !insecureOk) throw new UpstreamError('enclave URL must be https', 400);
    const host = u.hostname.toLowerCase();
    const allowed = this.config.enclaveHosts.some((h) => host === h || host.endsWith('.' + h));
    if (!allowed) throw new UpstreamError(`enclave host not allowed: ${host}`, 400);
    return u;
  }

  async forwardEncrypted(call: EncryptedCall): Promise<EncryptedResponse> {
    if (!this.apiKey) throw new UpstreamError(`supplier ${this.id} has no API key configured`, 503);
    const base = this.validateEnclaveUrl(call.enclaveUrl);
    const target = new URL(call.path, base);
    const mod = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      ...call.headers,
      authorization: `Bearer ${this.apiKey}`,
      [USAGE_REQUEST_HEADER]: 'true',
      'content-length': String(call.body.length),
      te: 'trailers',
    };
    return new Promise<EncryptedResponse>((resolve, reject) => {
      const req = mod.request(target, { method: 'POST', headers, signal: call.signal, timeout: this.retry.timeoutMs }, (res) => {
        const usage = new Promise<ReportedUsage | undefined>((done) => {
          const fromHeader = parseUsageMetrics(res.headers[USAGE_HEADER]);
          res.on('end', () => done(fromHeader ?? parseUsageMetrics(res.trailers[USAGE_HEADER])));
          res.on('error', () => done(fromHeader));
          res.on('close', () => done(fromHeader ?? parseUsageMetrics(res.trailers?.[USAGE_HEADER])));
        });
        resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res, usage });
      });
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      req.on('error', (e) => reject(call.signal.aborted ? new UpstreamError('client aborted', 499) : new UpstreamError(`enclave unreachable: ${e.message}`, 502)));
      req.end(call.body);
    });
  }

  async hpkeKeys(): Promise<Response> {
    const url = new URL('/.well-known/hpke-keys', this.validateEnclaveUrl(undefined));
    const res = await fetch(url, { signal: AbortSignal.timeout(this.retry.timeoutMs) });
    return new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/ohttp-keys', 'cache-control': 'public, max-age=60' },
    });
  }

  async attestation(): Promise<Response> {
    const url = this.config.attestationUrl;
    if (!url) throw new UpstreamError('no attestation URL configured', 404);
    const res = await fetch(url, { signal: AbortSignal.timeout(this.retry.timeoutMs) });
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'public, max-age=60' },
    });
  }
}
