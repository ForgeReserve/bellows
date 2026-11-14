import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { getEncodedToken, type Proof, Wallet } from '@cashu/cashu-ts';
import { createApp, type Deps, startupRecovery } from '../../src/app.ts';
import type { WalletOptions } from '../../src/cashu/wallet.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import type { FundingFaults } from '../../src/funding.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { FIXED_SECRET_NAMES, newWalletSecret, WALLET_SECRET } from '../../src/secrets.ts';

setLogSilent(process.env.BELLOWS_TEST_LOGS !== '1');

export const MINT_A = process.env.TEST_MINT_A ?? 'http://127.0.0.1:3338';
export const MINT_B = process.env.TEST_MINT_B ?? 'http://127.0.0.1:3339';
/** The "foreign" mint for other-mint funding tests (input fees 100 ppk). */
export const MINT_C = process.env.TEST_MINT_C ?? 'http://127.0.0.1:3340';
export const BTC_USD = 100_000;

export async function mintsUp(): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fetch(`${MINT_A}/v1/info`), fetch(`${MINT_B}/v1/info`)]);
    return a.ok && b.ok;
  } catch {
    return false;
  }
}

const userWallets = new Map<string, Promise<Wallet>>();
export function userWallet(mint: string, unit: 'usd' | 'sat'): Promise<Wallet> {
  const k = `${mint}|${unit}`;
  if (!userWallets.has(k)) {
    userWallets.set(
      k,
      (async () => {
        const w = new Wallet(mint, { unit });
        await w.loadMint();
        return w;
      })(),
    );
  }
  return userWallets.get(k)!;
}

/** Mints fresh proofs from a FakeWallet mint (quotes are paid automatically). */
export async function mintProofs(mint: string, unit: 'usd' | 'sat', amount: number): Promise<Proof[]> {
  const w = await userWallet(mint, unit);
  const q = await w.createMintQuoteBolt11(amount);
  for (let i = 0; i < 50; i++) {
    const s = await w.checkMintQuoteBolt11(q.quote);
    if (s.state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return w.mintProofsBolt11(amount, q.quote);
}

export async function mintToken(mint: string, unit: 'usd' | 'sat', amount: number): Promise<string> {
  return getEncodedToken({ mint, unit, proofs: await mintProofs(mint, unit, amount) });
}

/** Redeems a token at its mint and returns the amount received (proves the token is real and unspent). */
export async function redeem(token: string, mint = MINT_A, unit: 'usd' | 'sat' = 'usd'): Promise<number> {
  const w = await userWallet(mint, unit);
  const proofs = await w.receive(token);
  return proofs.reduce((s, p) => s + p.amount.toNumber(), 0);
}

export const PRICE_IN = 100; // USD per million input tokens
export const PRICE_OUT = 1000; // USD per million output tokens

export function testCatalog(enclavePort = 1) {
  const mock = { type: 'mock', tier: 'standard' } as const;
  const m = (id: string, supplier = 'mock', extra: object = {}) => ({
    id,
    supplier,
    upstream: id,
    input_usd_per_mtok: PRICE_IN,
    output_usd_per_mtok: PRICE_OUT,
    max_output_tokens: 256,
    price_verified: true,
    ...extra,
  });
  return {
    suppliers: {
      mock,
      mockflat: { ...mock, pricing: 'flat', flat: { buckets: [{ maxBytes: 1000, usd: 0.03 }, { maxBytes: 1_000_000, usd: 0.1 }], output_usd_per_mtok: 0 } },
      tinfoil: {
        type: 'tinfoil',
        tier: 'enclave',
        baseUrl: `http://127.0.0.1:${enclavePort}/v1`,
        enclaveUrl: `http://127.0.0.1:${enclavePort}`,
        apiKeySecret: 'TEST_TINFOIL_KEY',
        enclaveHosts: ['127.0.0.1'],
        allowInsecureEnclave: true,
        allowPlaintext: true,
      },
    },
    models: [
      m('mock-echo'),
      m('mock-slow'),
      m('mock-nousage'),
      m('mock-fail'),
      m('mock-flaky'),
      m('mock-uncensored', 'mock', { upstream: 'mock-echo', uncensored: true }),
      m('mock-think', 'mock', { reasoning: true, reasoning_efforts: ['low', 'high'] }),
      { ...m('flat-echo', 'mockflat'), upstream: 'mock-echo' },
      { ...m('tinfoil/enc-model', 'tinfoil'), upstream: 'enc-model' },
    ],
  };
}

/**
 * Gateways in this suite read their secrets the way a development install does: from secrets.json next to the
 * database (mode 0600). Tests pass secrets in `env` for brevity; this moves every secret name (the fixed ones
 * and the catalog's supplier keys) out of the environment into that file, and keeps the file's wallet secret
 * across restarts on the same database, so a restarted gateway derives the same wallet seed.
 */
export function writeSecretsFile(dbPath: string, env: Record<string, string>, catalog: unknown): Record<string, string> {
  const suppliers = Object.values((catalog as { suppliers: Record<string, { apiKeySecret?: string }> }).suppliers);
  const names = new Set<string>([...FIXED_SECRET_NAMES, ...suppliers.flatMap((s) => (s.apiKeySecret ? [s.apiKeySecret] : []))]);
  const path = join(dirname(dbPath), 'secrets.json');
  const before = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
  const secrets: Record<string, string> = {};
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) (names.has(k) ? secrets : rest)[k] = v;
  if (!secrets.BELLOWS_WALLET_SEED && !secrets[WALLET_SECRET]) secrets[WALLET_SECRET] = before[WALLET_SECRET] ?? newWalletSecret();
  writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
  return rest;
}

export interface Gateway {
  url: string;
  deps: Deps;
  dbPath: string;
  /** The HTTP server, for tests that watch connections. */
  server: ServerType;
  close(): Promise<void>;
}

export async function startGateway(
  opts: {
    env?: Record<string, string>;
    enclavePort?: number;
    dbPath?: string;
    faults?: { afterReceiveSwap?: boolean; afterSendSwap?: boolean; noReplayOnRecovery?: boolean; noRestoreOnRecovery?: boolean };
    fundingFaults?: FundingFaults;
    recover?: boolean;
    /** Address to listen on (default 127.0.0.1). */
    host?: string;
    /** Port to listen on (default: any free one). */
    port?: number;
    /**
     * Most of the suite exercises the optional invite gate, so it is on unless this is false. false leaves
     * BELLOWS_INVITE_ONLY unset, so the engine's own default applies.
     */
    inviteOnly?: boolean;
    /**
     * Counter scans and retries (src/cashu/counter-scan.ts). Default here: a short scan (100-counter batches,
     * gap 200), since every gateway in this suite starts on a new database. {} gives the production defaults.
     */
    counterScan?: WalletOptions['counterScan'];
  } = {},
): Promise<Gateway> {
  const dbPath = opts.dbPath ?? join(mkdtempSync(join(tmpdir(), 'bellows-e2e-')), 'bellows.db');
  const env = {
    BELLOWS_DB_PATH: dbPath,
    BELLOWS_TRUSTED_MINTS: MINT_A,
    BELLOWS_MARKUP: '1',
    BELLOWS_RATE_LIMIT_RPM: '100000',
    BELLOWS_ANON_RATE_LIMIT_RPM: '100000',
    // Proof of work for new balances has its own tests (test/unit/blind.test.ts, test/e2e/blind.e2e.test.ts,
    // which run it at the default difficulty); the rest of the suite funds new balances without it.
    BELLOWS_POW_BITS: '0',
    BELLOWS_MINT_QUOTE_CHECKS_PER_MIN: '100000',
    BELLOWS_UPSTREAM_RETRIES: '2',
    TEST_TINFOIL_KEY: 'test-enclave-key',
    // Never reach the public Nostr relays from tests; the local mints are accepted under 'any'.
    BELLOWS_FOREIGN_DISCOVERY_RELAYS: '',
    BELLOWS_FOREIGN_POLICY: 'any',
    ...(opts.inviteOnly === false ? {} : { BELLOWS_INVITE_ONLY: 'true' }),
    ...opts.env,
  };
  const catalog = testCatalog(opts.enclavePort);
  const config = loadConfig(writeSecretsFile(dbPath, env, catalog) as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', BTC_USD)], faults: opts.faults, fundingFaults: opts.fundingFaults, counterScan: opts.counterScan ?? { batchSize: 100, gap: 200 } });
  if (opts.recover !== false) await startupRecovery(deps);
  const app = createApp(deps);
  const host = opts.host ?? '127.0.0.1';
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: host }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    deps,
    dbPath,
    server,
    close: () =>
      new Promise<void>((r) => {
        (server as any).closeAllConnections?.();
        server.close(() => {
          deps.wallet.stop();
          deps.db.close();
          r();
        });
      }),
  };
}

/** Gateway with an arbitrary catalog (used by live tests). */
export async function startGatewayWithCatalog(catalog: unknown, extraEnv: Record<string, string>): Promise<Gateway> {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'bellows-live-')), 'bellows.db');
  const env = { BELLOWS_DB_PATH: dbPath, BELLOWS_TRUSTED_MINTS: MINT_A, BELLOWS_RATE_LIMIT_RPM: '100000', BELLOWS_ANON_RATE_LIMIT_RPM: '100000', BELLOWS_POW_BITS: '0', BELLOWS_MINT_QUOTE_CHECKS_PER_MIN: '100000', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', ...extraEnv };
  const config = loadConfig(writeSecretsFile(dbPath, env, catalog) as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', BTC_USD)] });
  await startupRecovery(deps);
  const app = createApp(deps);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    deps,
    dbPath,
    server,
    close: () => new Promise<void>((r) => server.close(() => (deps.db.close(), r()))),
  };
}

/** A port that was free a moment ago on 127.0.0.1, for a server whose address must be known before it starts. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export function createInvite(g: Gateway): string {
  return g.deps.invites.create('test').code;
}

/** Cost in msub (usd milli-cents) for given usage at the test prices with markup 1. */
export function expectedMsub(input: number, output: number): number {
  const nano = input * PRICE_IN * 1000 + output * PRICE_OUT * 1000;
  return Math.ceil(nano / 10_000);
}

export const chatBody = (model: string, extra: object = {}) => ({
  model,
  messages: [{ role: 'user', content: 'Say hello' }],
  max_tokens: 64,
  ...extra,
});

/** Reads an SSE response fully; returns data payloads and the forge event. */
export async function readSse(res: Response): Promise<{ data: any[]; forge?: any; raw: string }> {
  const raw = await res.text();
  const data: any[] = [];
  let forge: any;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const d = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (!d) continue;
    if (ev === 'forge') forge = JSON.parse(d);
    else if (d !== '[DONE]') data.push(JSON.parse(d));
  }
  return { data, forge, raw };
}

/**
 * Collects every log line the gateway writes from now on (also while output is silent). Settlement details
 * per request are in the "request" log line, never in the database, so tests read them here.
 */
export function captureLogs(): { lines: string[]; entries(): any[]; request(id: string): any | undefined; waitForRequest(id: string, ms?: number): Promise<any>; stop(): void } {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  const entries = () => lines.map((l) => JSON.parse(l));
  const request = (id: string) => entries().find((e) => e.msg === 'request' && e.request_id === id);
  return {
    lines,
    entries,
    request,
    async waitForRequest(id: string, ms = 5000) {
      const until = Date.now() + ms;
      for (;;) {
        const e = request(id);
        if (e || Date.now() > until) return e;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    stop: () => setLogSink(undefined),
  };
}
