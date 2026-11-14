import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEncodedToken, Mint, Wallet } from '@cashu/cashu-ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CASHU_REQUEST_OPTIONS, GatewayWallet, PaymentError } from '../../src/cashu/wallet.ts';
import { openDb } from '../../src/db.ts';

/** A loopback HTTP listener that records every path it is asked for. */
interface Listener {
  url: string;
  hits: string[];
  server: Server;
}

function listen(handler: (path: string, res: ServerResponse) => void): Promise<Listener> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    req.resume();
    handler(req.url ?? '', res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server })));
}

const seed = new Uint8Array(64);
const fakeProof = { id: '00ad268c4d1f5826', amount: 8, secret: 'abc', C: '02' + '11'.repeat(32) } as any;

// A mint that answers the first safety check could send the later Cashu requests on to a host that was
// never vetted. `target` stands for that host: it must never be reached.
describe('Cashu transport: redirects are refused, untrusted mints are vetted before contact', () => {
  let target: Listener;
  let redirector: Listener;

  beforeAll(async () => {
    target = await listen((_path, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"synthetic":"invalid mint document"}');
    });
    redirector = await listen((_path, res) => {
      res.writeHead(302, { location: `${target.url}/private-target` });
      res.end();
    });
  });
  afterAll(() => {
    target.server.close();
    redirector.server.close();
  });
  beforeEach(() => {
    target.hits.length = 0;
    redirector.hits.length = 0;
  });

  it('the process-wide Cashu policy refuses redirects and keeps the 60 s timeout', () => {
    expect(CASHU_REQUEST_OPTIONS).toEqual({ redirect: 'error', requestTimeout: 60_000 });
  });

  it('mint discovery (info, keysets, keys) does not follow a redirect', async () => {
    const w = new GatewayWallet(openDb(':memory:'), { trustedMints: [redirector.url], units: ['sat'], maxTokenBytes: 2000, seed });
    await expect(w.wallet(redirector.url, 'sat')).rejects.toThrow();
    expect(redirector.hits).toContain('/v1/info');
    expect(target.hits).toEqual([]);
  });

  it('every other Cashu GET refuses a redirect too (keysets, keys, quote checks)', async () => {
    // Constructing the gateway wallet applies the policy to every cashu-ts request in the process.
    new GatewayWallet(openDb(':memory:'), { trustedMints: [redirector.url], units: ['sat'], maxTokenBytes: 2000, seed });
    const mint = new Mint(redirector.url);
    await expect(mint.getKeySets()).rejects.toThrow();
    await expect(mint.getKeys()).rejects.toThrow();
    await expect(mint.checkMintQuoteBolt11('q')).rejects.toThrow();
    await expect(mint.checkMeltQuoteBolt11('q')).rejects.toThrow();
    expect(redirector.hits.length).toBeGreaterThanOrEqual(4);
    expect(target.hits).toEqual([]);
  });

  it('an untrusted mint that fails the safety check is never contacted, and the error says why', async () => {
    const vetted: string[] = [];
    const w = new GatewayWallet(openDb(':memory:'), {
      trustedMints: ['https://mint.example'],
      units: ['sat'],
      maxTokenBytes: 2000,
      seed,
      vetMint: async (m) => {
        vetted.push(m);
        throw new PaymentError('mint_not_allowed', 'this mint address is not allowed');
      },
    });
    const token = getEncodedToken({ mint: redirector.url, unit: 'sat', proofs: [fakeProof] });
    await expect(w.inspect(token, undefined, { foreign: true })).rejects.toMatchObject({ code: 'mint_not_allowed', status: 400 });
    await expect(w.wallet(redirector.url, 'sat')).rejects.toMatchObject({ code: 'mint_not_allowed' });
    expect(vetted).toEqual([redirector.url, redirector.url]);
    expect(redirector.hits).toEqual([]);
    expect(target.hits).toEqual([]);
  });

  it('an untrusted mint is vetted on every load, cached or not', async () => {
    let allow = true;
    const vetted: string[] = [];
    // loadMint is stubbed so the first load succeeds without a network call and the second one is served
    // from the cache (same Wallet instance). The check must still run before each load.
    const w = new GatewayWallet(openDb(':memory:'), {
      trustedMints: ['https://mint.example'],
      units: ['sat'],
      maxTokenBytes: 2000,
      seed,
      vetMint: async (m) => {
        vetted.push(m);
        if (!allow) throw new PaymentError('mint_not_allowed', 'this mint address is not allowed');
      },
    });
    const spy = vi.spyOn(Wallet.prototype, 'loadMint').mockResolvedValue(undefined as any);
    try {
      const a = await w.wallet(target.url, 'sat');
      const b = await w.wallet(target.url, 'sat');
      expect(a).toBe(b);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(vetted).toEqual([target.url, target.url]);
      allow = false;
      await expect(w.wallet(target.url, 'sat')).rejects.toMatchObject({ code: 'mint_not_allowed' });
      expect(vetted).toEqual([target.url, target.url, target.url]);
      expect(target.hits).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('an untrusted mint whose load fails is vetted again before the next attempt', async () => {
    let allow = true;
    const vetted: string[] = [];
    // The target answers 200 with a document that is not a mint, so the load fails after the check passes;
    // what matters here is that the check runs before each attempt.
    const w = new GatewayWallet(openDb(':memory:'), {
      trustedMints: ['https://mint.example'],
      units: ['sat'],
      maxTokenBytes: 2000,
      seed,
      vetMint: async (m) => {
        vetted.push(m);
        if (!allow) throw new PaymentError('mint_not_allowed', 'this mint address is not allowed');
      },
    });
    await expect(w.wallet(target.url, 'sat')).rejects.toThrow();
    await expect(w.wallet(target.url, 'sat')).rejects.toThrow();
    expect(vetted).toEqual([target.url, target.url]);
    const before = target.hits.length;
    allow = false;
    await expect(w.wallet(target.url, 'sat')).rejects.toMatchObject({ code: 'mint_not_allowed' });
    expect(target.hits.length).toBe(before);
  });

  it('a trusted mint is not put through the foreign-mint check', async () => {
    const vetted: string[] = [];
    const w = new GatewayWallet(openDb(':memory:'), {
      trustedMints: [redirector.url],
      units: ['sat'],
      maxTokenBytes: 2000,
      seed,
      vetMint: async (m) => {
        vetted.push(m);
      },
    });
    await expect(w.wallet(redirector.url, 'sat')).rejects.toThrow();
    expect(vetted).toEqual([]);
  });
});
