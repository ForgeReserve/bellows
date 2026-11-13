import { describe, expect, it } from 'vitest';
import { parseUsageMetrics, TinfoilSupplier } from '../../src/suppliers/tinfoil.ts';

const cfg = (extra = {}) =>
  ({ type: 'tinfoil', tier: 'enclave', baseUrl: 'https://inference.tinfoil.sh/v1', pricing: 'metered', allowPlaintext: true, enclaveHosts: ['tinfoil.sh'], allowInsecureEnclave: false, ...extra }) as any;

describe('tinfoil', () => {
  it('parses X-Tinfoil-Usage-Metrics', () => {
    expect(parseUsageMetrics('prompt=67,completion=42,total=109,model=gpt-oss-120b,cost_usd=0.000042')).toEqual({ inputTokens: 67, outputTokens: 42, costUsd: 0.000042 });
    expect(parseUsageMetrics('prompt=1,completion=2')).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: undefined });
    expect(parseUsageMetrics('garbage')).toBeUndefined();
    expect(parseUsageMetrics(undefined)).toBeUndefined();
  });

  it('enforces the enclave URL allowlist', () => {
    const s = new TinfoilSupplier('t', cfg(), undefined, { retries: 0, timeoutMs: 1000 });
    expect(s.validateEnclaveUrl(undefined).origin).toBe('https://inference.tinfoil.sh');
    expect(s.validateEnclaveUrl('https://abc.inf6.tinfoil.sh').hostname).toBe('abc.inf6.tinfoil.sh');
    expect(() => s.validateEnclaveUrl('https://tinfoil.sh.evil.com')).toThrow();
    expect(() => s.validateEnclaveUrl('http://inference.tinfoil.sh')).toThrow();
    expect(() => s.validateEnclaveUrl('https://user:pw@inference.tinfoil.sh')).toThrow();
    expect(() => s.validateEnclaveUrl('https://eviltinfoil.sh')).toThrow();
  });
});
