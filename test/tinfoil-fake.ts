/**
 * A stand-in for the Tinfoil attestation socket (/tinfoil/attestation.sock) and its V3 documents, for tests.
 * The document follows the shape in Tinfoil's documentation and open-source verifier; its "quote" is fake:
 * a marker followed by REPORT_DATA, which fakeAuthenticate accepts in place of a hardware check.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concat, equalBytes, fromHex, sha256, toBase64, toHex, utf8Encode } from '../client/bytes.ts';
import type { Measurement } from '../client/builds.ts';
import { TINFOIL_REPORT_DATA_V1, TINFOIL_TDX_QUOTE_V1, TINFOIL_V3_FORMAT, type TinfoilAuthenticated, type TinfoilQuoteCheck, tinfoilReportData } from '../client/tinfoil.ts';

export const FAKE_QUOTE_MARKER = utf8Encode('FAKE-TDX-QUOTE-FOR-TESTS:');
export const FAKE_TINFOIL_MEASUREMENT: Measurement = {
  type: 'https://tinfoil.sh/predicate/tdx-guest/v2',
  registers: ['11'.repeat(48), '22'.repeat(48), '33'.repeat(48), '44'.repeat(48), '00'.repeat(48)],
};

export async function fakeTinfoilDocument(nonce: Uint8Array): Promise<Record<string, unknown>> {
  const cm = utf8Encode(JSON.stringify({ format: 'https://tinfoil.sh/crypto-material/v1', items: [{ id: 'tls', format: 'https://tinfoil.sh/key/spki-fp-sha256/v1', data: 'ab'.repeat(32) }] }));
  const de = utf8Encode(JSON.stringify({ format: 'https://tinfoil.sh/device-evidence/v1', items: [] }));
  const cmHash = await sha256(cm);
  const deHash = await sha256(de);
  const reportData = await tinfoilReportData(nonce, cmHash, deHash);
  return {
    format: TINFOIL_V3_FORMAT,
    challenge: { nonce: toHex(nonce), report_data: toHex(reportData), report_data_algorithm: TINFOIL_REPORT_DATA_V1 },
    cpu_evidence: {
      format: TINFOIL_TDX_QUOTE_V1,
      report_base64: toBase64(concat(FAKE_QUOTE_MARKER, reportData)),
      endorsed: { crypto_material_hash: toHex(cmHash), device_evidence_hash: toHex(deHash) },
    },
    crypto_material: toBase64(cm),
    device_evidence: toBase64(de),
    collateral: [],
  };
}

/** Accepts only the fake quote, and returns the REPORT_DATA the quote carries, as a real check would. */
export async function fakeAuthenticate(check: TinfoilQuoteCheck): Promise<TinfoilAuthenticated> {
  const m = FAKE_QUOTE_MARKER.length;
  if (!equalBytes(check.report.subarray(0, m), FAKE_QUOTE_MARKER)) throw new Error('not a fake quote');
  return { measurement: FAKE_TINFOIL_MEASUREMENT, reportData: check.report.subarray(m) };
}

export type FakeSocketMode = 'ok' | 'not_ready' | 'wrong_nonce' | 'not_json' | 'tampered';

export interface FakeTinfoilSocket {
  path: string;
  /** Request paths received. */
  requests: string[];
  mode: FakeSocketMode;
  close(): Promise<void>;
}

export async function startFakeTinfoilSocket(mode: FakeSocketMode = 'ok'): Promise<FakeTinfoilSocket> {
  const path = join(mkdtempSync(join(tmpdir(), 'tf-')), 'a.sock');
  const fake: FakeTinfoilSocket = { path, requests: [], mode, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    fake.requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/.well-known/tinfoil-attestation') {
      res.writeHead(404).end();
      return;
    }
    if (fake.mode === 'not_ready') {
      res.writeHead(503).end('not ready');
      return;
    }
    if (fake.mode === 'not_json') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
      return;
    }
    let nonce = fromHex(url.searchParams.get('nonce') ?? '', 32);
    if (fake.mode === 'wrong_nonce') nonce = new Uint8Array(32);
    const doc = await fakeTinfoilDocument(nonce);
    if (fake.mode === 'tampered') (doc.cpu_evidence as { endorsed: { device_evidence_hash: string } }).endorsed.device_evidence_hash = '00'.repeat(32);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
  });
  await new Promise<void>((r) => server.listen(path, r));
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
