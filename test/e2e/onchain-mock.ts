import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A NUT-30 on-chain mint for tests, built as a proxy over a local FakeWallet Nutshell mint (which has
 * no on-chain support). It follows the request and response shapes of a Nutshell branch with NUT-30 (cashu/payment/onchain.py,
 * cashu/core/models/mint_quote.py):
 *   POST /v1/mint/quote/onchain {unit, pubkey}  (extra fields are refused, as with extra="forbid")
 *   GET  /v1/mint/quote/onchain/{quote}         {quote, request, unit, method, amount_paid, amount_issued, state, expiry: null, pubkey}
 *   POST /v1/mint/onchain {quote, outputs, signature}  (not NUT-19 cached; re-signing the same outputs is refused)
 * Deposits are simulated with pay(). Minting creates a bolt11 quote for the requested amount at the
 * backing mint (FakeWallet pays it) and forwards the outputs, so the signatures are real.
 * Everything else (keys, keysets, restore, checkstate, swap) is forwarded unchanged.
 */
export interface OnchainMock {
  url: string;
  pay(quote: string, sats: number): void;
  quotes: Map<string, { address: string; pubkey: string; paid: number; issued: number; signatures: number }>;
  mintCalls: number;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startOnchainMock(backing: string, opts: { minAmount?: number } = {}): Promise<OnchainMock> {
  const quotes: OnchainMock['quotes'] = new Map();
  const signed = new Set<string>();
  const state = { mintCalls: 0 };
  const view = (id: string) => {
    const q = quotes.get(id)!;
    return {
      quote: id,
      request: q.address,
      unit: 'sat',
      method: 'onchain',
      amount_paid: q.paid,
      amount_issued: q.issued,
      updated_at: Math.floor(Date.now() / 1000),
      state: q.paid === 0 ? 'UNPAID' : q.paid > q.issued ? 'PAID' : 'ISSUED',
      expiry: null,
      pubkey: q.pubkey,
    };
  };
  const send = (res: any, status: number, obj: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const server: Server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      const raw = req.method === 'POST' ? await body(req) : '';
      if (req.method === 'GET' && url === '/v1/info') {
        const info: any = await (await fetch(`${backing}/v1/info`)).json();
        info.nuts['4'].methods.push({ method: 'onchain', unit: 'sat', method_name: 'onchain', min_amount: opts.minAmount ?? 1000, options: { confirmations: 3 } });
        info.nuts['5'].methods.push({ method: 'onchain', unit: 'sat', method_name: 'onchain', min_amount: opts.minAmount ?? 1000, options: { confirmations: 3 } });
        return send(res, 200, info);
      }
      if (req.method === 'POST' && url === '/v1/mint/quote/onchain') {
        const b = JSON.parse(raw);
        const extra = Object.keys(b).filter((k) => k !== 'unit' && k !== 'pubkey');
        if (extra.length || b.unit !== 'sat' || typeof b.pubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(b.pubkey)) {
          return send(res, 400, { detail: `invalid onchain quote request: ${extra.join(',')}`, code: 0 });
        }
        const id = randomUUID();
        quotes.set(id, { address: 'bcrt1q' + randomBytes(19).toString('hex'), pubkey: b.pubkey, paid: 0, issued: 0, signatures: 0 });
        return send(res, 200, view(id));
      }
      const m = /^\/v1\/mint\/quote\/onchain\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && m) {
        if (!quotes.has(m[1]!)) return send(res, 400, { detail: 'quote not found', code: 20007 });
        return send(res, 200, view(m[1]!));
      }
      if (req.method === 'POST' && url === '/v1/mint/onchain') {
        state.mintCalls++;
        const b = JSON.parse(raw);
        const q = quotes.get(b.quote);
        if (!q) return send(res, 400, { detail: 'quote not found', code: 20007 });
        if (typeof b.signature !== 'string' || !/^[0-9a-f]{128}$/.test(b.signature)) return send(res, 400, { detail: 'NUT-20 signature missing', code: 20008 });
        const outputs = b.outputs as Array<{ amount: number; B_: string }>;
        if (outputs.some((o) => signed.has(o.B_))) return send(res, 400, { detail: 'outputs have already been signed before.', code: 10002 });
        const amount = outputs.reduce((s, o) => s + Number(o.amount), 0);
        if (amount > q.paid - q.issued) return send(res, 400, { detail: 'amount exceeds what was paid', code: 20002 });
        const mq: any = await (await fetch(`${backing}/v1/mint/quote/bolt11`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount, unit: 'sat' }) })).json();
        for (let i = 0; i < 50; i++) {
          const s: any = await (await fetch(`${backing}/v1/mint/quote/bolt11/${mq.quote}`)).json();
          if (s.state === 'PAID') break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const r = await fetch(`${backing}/v1/mint/bolt11`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quote: mq.quote, outputs }) });
        const out = await r.json();
        if (!r.ok) return send(res, r.status, out);
        for (const o of outputs) signed.add(o.B_);
        q.issued += amount;
        q.signatures += outputs.length;
        return send(res, 200, out);
      }
      // Pass-through.
      const r = await fetch(`${backing}${url}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? raw : undefined });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      send(res, 500, { detail: String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    quotes,
    get mintCalls() {
      return state.mintCalls;
    },
    pay(quote, sats) {
      quotes.get(quote)!.paid += sats;
    },
    close: () =>
      new Promise<void>((r) => {
        (server as any).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
