/**
 * The Tinfoil Containers attester. Inside a Tinfoil enclave, a container with `attestation: true` in
 * tinfoil-config.yml gets the Unix socket /tinfoil/attestation.sock, which answers
 *
 *   GET /.well-known/tinfoil-attestation?nonce=<64 hex>
 *
 * with a fresh V3 attestation document whose challenge nonce is the one asked for, and 503 until the
 * enclave's attestation is ready (docs.tinfoil.sh/containers/attestation). Bellows passes its 32-byte
 * binding as the nonce, so the hardware quote binds the statement through Tinfoil's REPORT_DATA
 * derivation (client/tinfoil.ts).
 *
 * NOT VERIFIED: the socket and the document shape follow Tinfoil's public documentation and its
 * open-source verifier; neither has been exercised against a real Tinfoil enclave (fresh attestation is
 * beta on Tinfoil's side). The tests run against a stand-in socket.
 */
import http from 'node:http';
import { checkTinfoilBinding, TINFOIL_V3_FORMAT } from '../../client/tinfoil.ts';
import { toHex } from '../../client/bytes.ts';
import type { AttestationDocument } from '../../client/identity.ts';
import type { Attester } from '../identity.ts';

export const TINFOIL_ATTESTATION_SOCKET = '/tinfoil/attestation.sock';
export const TINFOIL_ATTESTATION_PATH = '/.well-known/tinfoil-attestation';
/** V3 documents carry certificate collateral; well under this in practice. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export class AttestationUnavailable extends Error {
  readonly status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = 'AttestationUnavailable';
    this.status = status;
  }
}

function getOverSocket(socketPath: string, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: 'GET', headers: { host: 'localhost', accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_DOCUMENT_BYTES) {
          req.destroy(new Error('attestation document too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('attestation socket timed out')));
    req.on('error', reject);
    req.end();
  });
}

export function tinfoilAttester(opts: { socketPath?: string; timeoutMs?: number } = {}): Attester {
  const socketPath = opts.socketPath ?? TINFOIL_ATTESTATION_SOCKET;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    kind: 'tinfoil',
    async attest(reportData: Uint8Array): Promise<AttestationDocument> {
      if (reportData.length !== 32) throw new Error('report data must be 32 bytes');
      const nonce = toHex(reportData);
      let res: { status: number; body: string };
      try {
        res = await getOverSocket(socketPath, `${TINFOIL_ATTESTATION_PATH}?nonce=${nonce}`, timeoutMs);
      } catch (e) {
        throw new AttestationUnavailable(`Tinfoil attestation socket ${socketPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 503) throw new AttestationUnavailable('Tinfoil attestation is not ready yet');
      if (res.status !== 200) throw new AttestationUnavailable(`Tinfoil attestation socket answered HTTP ${res.status}`, 502);
      let doc: unknown;
      try {
        doc = JSON.parse(res.body);
      } catch {
        throw new AttestationUnavailable('Tinfoil attestation socket returned something other than JSON', 502);
      }
      if (typeof doc !== 'object' || doc === null || (doc as { format?: unknown }).format !== TINFOIL_V3_FORMAT) {
        throw new AttestationUnavailable(`Tinfoil attestation is not a ${TINFOIL_V3_FORMAT} document`, 502);
      }
      // The same checks a client makes, so a document that cannot verify is never served.
      try {
        await checkTinfoilBinding(doc as AttestationDocument, reportData);
      } catch (e) {
        throw new AttestationUnavailable(e instanceof Error ? e.message : String(e), 502);
      }
      return doc as AttestationDocument;
    },
  };
}
