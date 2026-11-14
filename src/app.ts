import { randomUUID } from 'node:crypto';
import { PaymentRequest } from '@cashu/cashu-ts';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { openAccount, releaseIfEmpty } from './accounts.ts';
import { createAdminRouter } from './admin-api.ts';
import { parseOptionalLockPubkey } from './cashu/lock.ts';
import { type GatewayWallet, PaymentError } from './cashu/wallet.ts';
import { type Config, type ModelConfig, ohttpAdmitPerSecond, type Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';
import { FOREIGN_MINTS_PATH, type FundingService } from './funding.ts';
import type { MintDiscovery } from './mint-discovery.ts';
import { type Account, type Invites, type Ledger, LedgerError } from './ledger.ts';
import { errText, log } from './log.ts';
import type { Identity } from './identity.ts';
import { OhttpGateway } from './ohttp.ts';
import { OHTTP_KEYS_PATH, OHTTP_PATH } from '../client/ohttp.ts';
import { parseUsageMetrics, USAGE_HEADER as TINFOIL_USAGE_HEADER } from './suppliers/tinfoil.ts';
import { costFromHeaders, FrameCounter, SseMeter, usageFromJson } from './meter.ts';
import { costNanoUsd, displayPrice, estimateTokensFromBytes, flatCostNanoUsd, MSUB_PER_UNIT, msubToUnitsCeil, nanoUsdToMsub, type Usage } from './pricing.ts';
import { POW_CHALLENGE_HEADER, POW_HEADER, PowGate } from './pow.ts';
import { RateLimiter } from './ratelimit.ts';
import type { RateOracle } from './rates.ts';
import { type Supplier, UpstreamError } from './suppliers/types.ts';
import { paymentPending, recordUsageRaw, type SettledUsage } from './usage.ts';

export interface Deps {
  config: Config;
  db: DB;
  ledger: Ledger;
  invites: Invites;
  wallet: GatewayWallet;
  rates: RateOracle;
  suppliers: Map<string, Supplier>;
  funding: FundingService;
  discovery: MintDiscovery;
  identity: Identity;
}

// Client API headers keep their X-Forge-* names, the `event: forge` stream event and the sk-forge- key
// prefix, so existing clients (the Forge AI app among them) work against any Bellows unchanged.
const EXPOSE = [
  'X-Cashu',
  'X-Cashu-Change',
  'X-Forge-Request-Id',
  'X-Forge-Unit',
  'X-Forge-Charged-Msub',
  'X-Forge-Balance-Msub',
  'X-Forge-Change-Url',
  'X-Forge-Privacy',
  'Ehbp-Response-Nonce',
  'Retry-After',
  POW_CHALLENGE_HEADER,
];
const ALLOW = [
  'Accept',
  'Authorization',
  'Content-Type',
  'X-Cashu',
  'X-Cashu-Pubkey',
  'X-Forge-Invite',
  'X-Forge-Unit',
  POW_HEADER,
  'Ehbp-Encapsulated-Key',
  'X-Tinfoil-Enclave-Url',
  'X-Tinfoil-Model',
  'X-Tinfoil-Max-Output-Tokens',
  'X-Tinfoil-Completion-Count',
];

function apiError(c: Context, status: number, code: string, message: string, headers: Record<string, string> = {}, extra: object = {}) {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json({ error: { message, type: code, code }, ...extra }, status as any);
}

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1]?.trim();
}

/** Requests that can open a new balance. Without a known key they carry proof of work instead of a per-address limit. */
export const OPENS_BALANCE = new Set(['/v1/wallet/topup', '/v1/wallet/fund/lightning', '/v1/wallet/fund/onchain', '/v1/wallet/fund/foreign/quote']);

type Payment = { kind: 'balance'; account: Account; reservationId: string } | { kind: 'nut24'; mint: string; unit: Unit; paid: number };

/** What a chat request holds until it settles: its balance reservation or its NUT-24 request row (see the chat route). */
type ChatOwnership = { reservationId?: string; nut24RequestId?: string };

interface SettleResult {
  chargedMsub: number;
  /** A late charge the balance could not cover in full (src/ledger.ts settleRaw). */
  shortfallMsub?: number;
  balanceMsub?: number;
  changeUnits?: number;
  changeToken?: string;
  changeId?: string;
}

export function createApp(d: Deps) {
  const { config, db, ledger, invites, wallet, rates, suppliers } = d;
  const env = config.env;
  const app = new Hono();
  // Rate limits never key on a client address (Bellows reads none): per balance where the key is known,
  // one shared budget otherwise, and proof of work for requests that open a new balance.
  const limiter = new RateLimiter(env.BELLOWS_RATE_LIMIT_RPM);
  const anonLimiter = new RateLimiter(env.BELLOWS_ANON_RATE_LIMIT_RPM);
  const pow = new PowGate({ bits: env.BELLOWS_POW_BITS });
  const models = new Map(config.catalog.models.map((m) => [m.id, m]));

  installRecoveryHooks(d);

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });
  app.use('/v1/*', cors({ origin: '*', allowHeaders: ALLOW, exposeHeaders: EXPOSE, allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 }));
  app.use('/attestation', cors({ origin: '*', allowMethods: ['GET'] }));
  app.use('/.well-known/*', cors({ origin: '*', allowMethods: ['GET'] }));
  app.use(OHTTP_PATH, cors({ origin: '*', allowMethods: ['POST'], allowHeaders: ['Content-Type'], maxAge: 600 }));
  app.use(OHTTP_KEYS_PATH, cors({ origin: '*', allowMethods: ['GET'] }));
  app.use(
    '/v1/*',
    bodyLimit({ maxSize: env.BELLOWS_MAX_BODY_BYTES, onError: (c) => apiError(c, 413, 'request_too_large', `request body over ${env.BELLOWS_MAX_BODY_BYTES} bytes`) }),
  );
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.method === 'GET') return next();
    const key = bearer(c);
    const known = key ? ledger.findByKey(key) : undefined;
    if (known) {
      const wait = limiter.take(known.id);
      if (wait > 0) return apiError(c, 429, 'rate_limited', 'too many requests', { 'Retry-After': String(wait) });
      return next();
    }
    if (pow.enabled && OPENS_BALANCE.has(c.req.path)) {
      const v = pow.verify(c.req.header(POW_HEADER));
      if (v.ok) return next();
      const ch = pow.issue();
      const why = v.reason === 'missing' ? 'opening a balance needs proof of work' : `proof of work refused: ${v.reason}`;
      return apiError(c, 428, 'pow_required', `${why}. Find a nonce so that SHA-256 of "<challenge>:<nonce>" starts with ${ch.bits} zero bits, then resend with ${POW_HEADER}: <challenge>:<nonce>`, { [POW_CHALLENGE_HEADER]: ch.challenge }, { pow: { ...ch, header: POW_HEADER } });
    }
    const wait = anonLimiter.take('anonymous');
    if (wait > 0) return apiError(c, 429, 'rate_limited', 'too many requests', { 'Retry-After': String(wait) });
    return next();
  });

  app.onError((e, c) => {
    if (e instanceof PaymentError) return apiError(c, e.status, e.code, e.message, {}, e.extra ?? {});
    if (e instanceof LedgerError) return apiError(c, e.status, e.code, e.message);
    if (e instanceof UpstreamError) return apiError(c, e.status, 'upstream_error', e.message);
    log.error('unhandled', { path: c.req.path, err: errText(e) });
    return apiError(c, 500, 'internal_error', 'internal error');
  });

  // ------------------------------------------------------------------ meta

  app.get('/healthz', (c) => {
    const r = rates.status();
    return c.json({ ok: true, rate: r ? { btc_usd: r.rate, age_s: Math.round(r.ageMs / 1000) } : null, invite_only: env.BELLOWS_INVITE_ONLY });
  });

  app.get('/v1/models', async (c) => {
    const rate = env.BELLOWS_UNITS.includes('sat') ? await rates.get().catch(() => undefined) : undefined;
    const data = config.catalog.models.map((m) => {
      const s = config.catalog.suppliers[m.supplier]!;
      return {
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.supplier,
        name: m.name ?? m.id,
        tier: s.tier,
        privacy: s.tier,
        encrypted_passthrough: s.type === 'tinfoil',
        uncensored: m.uncensored,
        capabilities: { vision: m.vision, reasoning: m.reasoning, reasoning_efforts: m.reasoning_efforts },
        speed: m.speed ?? null,
        context_length: m.context_length ?? null,
        max_output_tokens: m.max_output_tokens,
        pricing: {
          mode: s.pricing,
          usd_per_mtok: { input: round(m.input_usd_per_mtok * env.BELLOWS_MARKUP), output: round(m.output_usd_per_mtok * env.BELLOWS_MARKUP) },
          sat_per_mtok: rate
            ? { input: round(displayPrice(m.input_usd_per_mtok, env.BELLOWS_MARKUP, 'sat', rate)!), output: round(displayPrice(m.output_usd_per_mtok, env.BELLOWS_MARKUP, 'sat', rate)!) }
            : null,
          verified: m.price_verified,
        },
        upstream_model: s.type === 'tinfoil' ? m.upstream : undefined,
      };
    });
    return c.json({ object: 'list', data, units: env.BELLOWS_UNITS, mints: wallet.trustedMints, invite_only: env.BELLOWS_INVITE_ONLY, btc_usd: rate ?? null });
  });

  // A fresh proof-of-work challenge, for clients that solve before sending (a 428 answer carries one too).
  app.get('/v1/pow', (c) => (pow.enabled ? c.json({ ...pow.issue(), header: POW_HEADER, paths: [...OPENS_BALANCE] }) : c.json({ bits: 0, header: POW_HEADER, paths: [] })));

  // ------------------------------------------------------------------ wallet

  app.post('/v1/wallet/topup', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, 'invalid_request', 'expected JSON {"token": "cashuB...", "invite": "..."}');
    }
    const token = String(body?.token ?? '');
    const invite = typeof body?.invite === 'string' ? body.invite : c.req.header('x-forge-invite');
    const t = await wallet.inspect(token);

    const opened = openAccount({ db, ledger, invites, inviteOnly: env.BELLOWS_INVITE_ONLY }, { key: bearer(c), invite, unit: t.unit });
    const account = opened.account;
    const created = opened.created;
    const generated = !!opened.generatedKey;
    const key = opened.generatedKey;
    const acct = account;
    try {
      const r = await wallet.receive(token, {
        purpose: 'topup',
        accountId: acct.id,
        onFinalize: (amount) => ledger.creditRaw(acct.id, amount * MSUB_PER_UNIT, 'topup', null),
      });
      const a = ledger.get(acct.id)!;
      log.info('topup', { unit: a.unit, amount: r.amount, replay: r.replay, new_balance: created });
      return c.json({
        key: generated ? key : undefined,
        account_id: a.id,
        unit: a.unit,
        credited: r.replay ? 0 : r.amount,
        replay: r.replay,
        balance_msub: a.balance_msub,
        balance: a.balance_msub / MSUB_PER_UNIT,
      });
    } catch (e) {
      const definitive = e instanceof PaymentError && e.status < 500;
      if (created && !definitive) {
        // Outcome unknown (mint unreachable or crash mid-swap): keep the account so recovery can credit it,
        // and hand the generated key back so the client can retry with the same key and token.
        log.warn('topup_pending', { unit: acct.unit, err: errText(e) });
        return c.json(
          {
            error: { message: 'topup outcome pending; retry with this key and the same token', type: 'topup_pending', code: 'topup_pending' },
            key: generated ? key : undefined,
            account_id: acct.id,
          },
          503,
        );
      }
      // Definitive rejection: undo the empty account so the invite can be used again.
      if (created) releaseIfEmpty(db, acct.id);
      throw e;
    }
  });

  const requireAccount = (c: Context): Account => {
    const key = bearer(c);
    const a = key ? ledger.findByKey(key) : undefined;
    if (!a) throw new LedgerError('invalid_key', 'missing or unknown balance key', 401);
    return a;
  };

  app.get('/v1/wallet', (c) => {
    const a = requireAccount(c);
    const reserved = ledger.reservedMsub(a.id);
    return c.json({
      account_id: a.id,
      unit: a.unit,
      balance_msub: a.balance_msub,
      available_msub: a.balance_msub - reserved,
      balance: a.balance_msub / MSUB_PER_UNIT,
      refundable: Math.floor((a.balance_msub - reserved) / MSUB_PER_UNIT),
    });
  });

  const outgoingView = (r: { id: string; mint: string; amount: number; unit: string; status: string; token: string | null; lock_pubkey?: string | null }) => ({
    id: r.id,
    amount: r.amount,
    unit: r.unit,
    mint: r.mint,
    status: r.status,
    token: r.token,
    locked_to: r.lock_pubkey ?? null,
  });

  app.get('/v1/wallet/refunds', (c) => {
    const a = requireAccount(c);
    return c.json({ data: wallet.listOutgoing({ accountId: a.id }).map(outgoingView) });
  });

  app.post('/v1/wallet/refund', async (c) => {
    const a = requireAccount(c);
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body is fine */
    }
    const lockPubkey = parseOptionalLockPubkey(body?.pubkey);
    // Retry anything still owed to this account first.
    for (const r of wallet.listOutgoing({ accountId: a.id })) {
      if (r.status !== 'done' && r.status !== 'failed') await wallet.issue(r.id).catch(() => {});
    }
    const avail = ledger.available(a.id);
    const maxUnits = Math.floor(avail / MSUB_PER_UNIT);
    const units = body?.amount === undefined ? maxUnits : Number(body.amount);
    if (!Number.isInteger(units) || units < 1 || units > maxUnits) {
      return apiError(c, 400, 'invalid_amount', `refundable amount is 1..${maxUnits} ${a.unit}`);
    }
    const mint = pickMint(a.unit, units);
    if (!mint) return apiError(c, 503, 'wallet_insufficient', 'gateway cannot cover this refund from a single mint right now');
    const outId = tx(db, () => {
      ledger.debitRaw(a.id, units * MSUB_PER_UNIT, 'refund', 'pending');
      return wallet.oweRaw({ mint, unit: a.unit, amount: units, purpose: 'refund', accountId: a.id, lockPubkey });
    });
    let token: string | null = null;
    try {
      token = await wallet.issue(outId);
    } catch (e) {
      log.warn('refund_issue_deferred', { id: outId, err: errText(e) });
    }
    const after = ledger.get(a.id)!;
    log.info('refund', { unit: a.unit, amount: units, issued: !!token, locked: !!lockPubkey });
    return c.json(
      {
        id: outId,
        token,
        amount: units,
        unit: a.unit,
        mint,
        status: token ? 'done' : 'owed',
        locked_to: lockPubkey,
        balance_msub: after.balance_msub,
        refunds: wallet.listOutgoing({ accountId: a.id }).map(outgoingView),
      },
      token ? 200 : 202,
    );
  });

  /** Mint with the most unspent eCash for this unit, if it covers amount. */
  const pickMint = (unit: Unit, amount: number): string | undefined => {
    const h = wallet
      .holdings()
      .filter((x) => x.unit === unit && wallet.isTrusted(x.mint))
      .sort((a, b) => b.unspent - a.unspent)[0];
    return h && h.unspent >= amount ? h.mint : undefined;
  };

  // ------------------------------------------------------------------ funding (Lightning, on-chain, other mints)

  const { funding } = d;
  const readJson = async (c: Context): Promise<any> => {
    try {
      return await c.req.json();
    } catch {
      throw new PaymentError('invalid_request', 'expected a JSON body');
    }
  };
  const unitOf = (v: unknown): Unit => {
    const u = String(v ?? env.BELLOWS_DEFAULT_UNIT) as Unit;
    if (!env.BELLOWS_UNITS.includes(u)) throw new PaymentError('wrong_unit', `unit must be one of ${env.BELLOWS_UNITS.join(', ')}`);
    return u;
  };
  const fundingResponse = (c: Context, row: Parameters<FundingService['view']>[0], key?: string) => c.json({ ...funding.view(row), key });
  /** Opens the balance for a funding; a balance created here is released again if the quote cannot be made. */
  const withAccount = async <T,>(c: Context, unit: Unit, invite: unknown, fn: (accountId: string) => Promise<T>): Promise<{ result: T; key?: string }> => {
    const opened = openAccount({ db, ledger, invites, inviteOnly: env.BELLOWS_INVITE_ONLY }, { key: bearer(c), invite: typeof invite === 'string' ? invite : undefined, unit });
    try {
      return { result: await fn(opened.account.id), key: opened.generatedKey };
    } catch (e) {
      if (opened.created) releaseIfEmpty(db, opened.account.id);
      throw e;
    }
  };

  app.get('/v1/wallet/fund/methods', async (c) => c.json({ ...(await funding.methods()), invite_only: env.BELLOWS_INVITE_ONLY }));

  // Other mints whose eCash is accepted for funding. Public; never waits on a relay.
  app.get(FOREIGN_MINTS_PATH, (c) => {
    const a = funding.acceptedForeignMints();
    return c.json({ enabled: env.BELLOWS_FOREIGN_ENABLED, ...a });
  });

  app.post('/v1/wallet/fund/lightning', async (c) => {
    const body = await readJson(c);
    const unit = unitOf(body?.unit);
    const amount = Number(body?.amount);
    if (!Number.isInteger(amount) || amount < 1) return apiError(c, 400, 'invalid_amount', 'amount must be a whole number of units');
    const { result, key } = await withAccount(c, unit, body?.invite, (id) => funding.createLightning(id, unit, amount));
    return fundingResponse(c, result, key);
  });

  app.post('/v1/wallet/fund/onchain', async (c) => {
    const body = await readJson(c).catch(() => ({}));
    const { result, key } = await withAccount(c, 'sat', body?.invite, (id) => funding.createOnchain(id));
    return fundingResponse(c, result, key);
  });

  app.post('/v1/wallet/fund/foreign/quote', async (c) => {
    const body = await readJson(c);
    const unit = unitOf(body?.unit);
    const token = String(body?.token ?? '').trim();
    if (!token.startsWith('cashuB')) return apiError(c, 400, 'invalid_token', 'expected a cashuB token');
    const lockPubkey = parseOptionalLockPubkey(body?.pubkey);
    const acceptUnlisted = body?.accept_unlisted === true;
    const { result, key } = await withAccount(c, unit, body?.invite, (id) => funding.quoteForeign(id, unit, token, lockPubkey, { acceptUnlisted }));
    return fundingResponse(c, result, key);
  });

  const ownFunding = (c: Context, id: string) => {
    const a = requireAccount(c);
    const row = funding.get(id);
    if (!row || row.account_id !== a.id) throw new PaymentError('not_found', 'unknown funding', 404);
    return row;
  };

  app.post('/v1/wallet/fund/foreign/confirm', async (c) => {
    const body = await readJson(c);
    const lockPubkey = parseOptionalLockPubkey(body?.pubkey);
    const row = ownFunding(c, String(body?.id ?? ''));
    const out = await funding.confirmForeign(row.id, String(body?.token ?? '').trim(), lockPubkey);
    return fundingResponse(c, out);
  });

  app.get('/v1/wallet/fund', (c) => {
    const a = requireAccount(c);
    return c.json({ data: funding.list(a.id).map((r) => funding.view(r)) });
  });

  app.get('/v1/wallet/fund/:id', async (c) => {
    const row = ownFunding(c, c.req.param('id'));
    // Polling drives progress too, so a funding completes even when the background poller is off,
    // but a pending quote only when it is due: a browser polling fast must not hammer the mint's quote checks.
    const due = row.state === 'pending' ? row.next_check <= Date.now() : Date.now() - row.updated_at > 1500 || row.state === 'minting';
    const fresh = due ? ((await funding.advance(row.id)) ?? row) : row;
    return fundingResponse(c, fresh);
  });

  // NUT-24 change re-delivery: the request id is an unguessable capability returned only to the payer.
  app.get('/v1/change/:id', async (c) => {
    const id = c.req.param('id');
    // Other-mint funding change shares purpose 'change' but is delivered with the funding, behind its key.
    // Request ids start with req_; a settled request leaves no row of its own, only the change owed to it.
    const isRequest = id.startsWith('req_');
    const changeRows = () => (isRequest ? wallet.listOutgoing({ requestId: id }).filter((r) => r.purpose === 'change') : []);
    let rows = changeRows();
    if (!rows.length && isRequest) {
      // A request that failed while its payment's outcome was unknown: settle that payment now.
      const s = await settleUnservedNut24(d, id);
      if (s === 'running') return apiError(c, 409, 'not_settled', 'request still running', { 'Retry-After': '2' });
      if (s === 'pending') return apiError(c, 409, 'not_settled', 'the payment is not confirmed by the mint yet; retry shortly', { 'Retry-After': '5' });
      rows = changeRows();
    }
    if (!rows.length) return apiError(c, 404, 'not_found', 'no change for this request');
    const out = [];
    for (const r of rows) {
      let token = r.token;
      if (r.status !== 'done') {
        try {
          token = await wallet.issue(r.id);
        } catch (e) {
          if (e instanceof PaymentError) throw e;
          // Mint unreachable: the change stays owed and the next fetch issues it.
          log.warn('change_deferred', { request_id: id, err: errText(e) });
          return apiError(c, 503, 'mint_unavailable', 'the change is owed but the mint did not answer; retry shortly', { 'Retry-After': '5' });
        }
      }
      out.push({ ...outgoingView(r), token, status: 'done' });
    }
    return c.json({ request_id: id, data: out, token: out[0]?.token });
  });

  // ------------------------------------------------------------------ identity (docs/ATTESTATION.md)

  // This Bellows' attested identity: statement (version, claimed measurement, HPKE key config, relays,
  // operator announcement) and the attestation binding it. Clients verify it before sending anything.
  app.get('/.well-known/bellows', async (c) => {
    try {
      const doc = await d.identity.document();
      c.header('Cache-Control', 'no-cache');
      return c.json(doc);
    } catch (e) {
      return apiError(c, 503, 'not_attested', `attestation is not available yet: ${errText(e)}`, { 'Retry-After': '5' });
    }
  });

  // ------------------------------------------------------------------ Oblivious HTTP (docs/OHTTP.md)

  // An encapsulated request for a client API path runs through this same app, so it is metered, paid and
  // rate limited exactly like a direct one. The outer request's address and headers never reach it.
  const ohttp = new OhttpGateway({
    identity: d.identity,
    dispatch: (r) => app.fetch(r),
    maxSkewMs: env.BELLOWS_OHTTP_MAX_SKEW_SECONDS * 1000,
    replayCacheMax: env.BELLOWS_OHTTP_REPLAY_CACHE_MAX,
    admitPerSecond: ohttpAdmitPerSecond(env),
    maxMessageBytes: env.BELLOWS_OHTTP_MAX_MESSAGE_BYTES,
  });
  app.get(OHTTP_KEYS_PATH, () => ohttp.keys());
  app.post(OHTTP_PATH, (c) => ohttp.handle(c.req.raw));

  // ------------------------------------------------------------------ attestation (Tinfoil SDK through the gateway)

  const enclaveSupplier = [...suppliers.values()].find((s) => s.config.type === 'tinfoil');
  // EHBP key config, for browser clients whose transport asks the proxy origin for it.
  app.get('/.well-known/hpke-keys', async (c) => {
    if (!enclaveSupplier?.hpkeKeys) return apiError(c, 404, 'not_found', 'no enclave supplier');
    return enclaveSupplier.hpkeKeys();
  });
  app.get('/attestation', async (c) => {
    if (!enclaveSupplier?.attestation) return apiError(c, 404, 'not_found', 'no enclave supplier');
    return enclaveSupplier.attestation();
  });

  // ------------------------------------------------------------------ chat

  // A request owns its balance reservation until it settles (src/ledger.ts), so the stale sweep never
  // releases it however long it streams, and its NUT-24 row stays 'running' while a handler serves it.
  // A request that ends without settling (an error escaped it) gives both up in this process: the sweep
  // releases the reservation, and a payment it received is marked 'paid' (unserved), so GET /v1/change
  // returns it in full, or a retry with the same token takes it over, once.
  const abandon = (own: ChatOwnership) => {
    if (own.reservationId) ledger.disown(own.reservationId);
    const id = own.nut24RequestId;
    if (!id) return;
    try {
      const n = tx(db, () => Number(db.prepare("UPDATE requests SET status = 'paid' WHERE id = ? AND status = 'running'").run(id).changes));
      if (n > 0) log.warn('nut24_request_abandoned', { request_id: id });
    } catch (e) {
      log.error('nut24_abandon_failed', { request_id: id, err: errText(e) });
    }
  };
  app.post('/v1/chat/completions', async (c) => {
    const own: ChatOwnership = {};
    try {
      return await chatCompletion(c, own);
    } catch (e) {
      abandon(own);
      throw e;
    }
  });
  const chatCompletion = async (c: Context, own: ChatOwnership) => {
    const t0 = Date.now();
    const requestId = 'req_' + randomUUID().replaceAll('-', '');
    c.header('X-Forge-Request-Id', requestId);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const encrypted = !!c.req.header('ehbp-encapsulated-key');

    // 1. Resolve model, max output, and the body we send upstream.
    let model: ModelConfig | undefined;
    let maxOut: number;
    let stream = false;
    let upstreamBody: Record<string, unknown> | undefined;
    let clientWantsUsage = false;
    if (encrypted) {
      const name = c.req.header('x-tinfoil-model');
      if (!name) return apiError(c, 400, 'invalid_request', 'encrypted requests must send X-Tinfoil-Model');
      model = config.catalog.models.find((m) => config.catalog.suppliers[m.supplier]!.type === 'tinfoil' && (m.upstream === name || m.id === name));
      if (!model) return apiError(c, 404, 'model_not_found', `no enclave model ${name}`);
      const hdr = c.req.header('x-tinfoil-max-output-tokens');
      maxOut = hdr ? Number(hdr) : model.max_output_tokens;
      if (c.req.header('x-tinfoil-completion-count') && c.req.header('x-tinfoil-completion-count') !== '1') {
        return apiError(c, 400, 'invalid_request', 'only one completion per request');
      }
    } else {
      let body: any;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return apiError(c, 400, 'invalid_request', 'body must be JSON');
      }
      if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
        return apiError(c, 400, 'invalid_request', 'model and messages are required');
      }
      model = models.get(body.model);
      if (!model) return apiError(c, 404, 'model_not_found', `unknown model ${body.model}; see GET /v1/models`);
      if (body.n !== undefined && body.n !== 1) return apiError(c, 400, 'invalid_request', 'n must be 1');
      maxOut = Number(body.max_completion_tokens ?? body.max_tokens ?? model.max_output_tokens);
      stream = body.stream === true;
      clientWantsUsage = body.stream_options?.include_usage === true;
      const ub: Record<string, unknown> = { ...body, model: model.upstream };
      if (body.max_completion_tokens == null && body.max_tokens == null) ub.max_tokens = maxOut;
      if (stream) ub.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
      upstreamBody = ub;
    }
    if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > model.max_output_tokens) {
      return apiError(c, 400, 'invalid_request', `max tokens must be 1..${model.max_output_tokens} for ${model.id}`);
    }
    const supplierCfg = config.catalog.suppliers[model.supplier]!;
    const supplier = suppliers.get(model.supplier)!;
    if (encrypted && !supplier.forwardEncrypted) return apiError(c, 400, 'invalid_request', 'this supplier does not accept encrypted bodies');
    if (!encrypted && supplierCfg.type === 'tinfoil' && !supplierCfg.allowPlaintext) {
      return apiError(c, 400, 'encryption_required', 'this model only accepts EHBP-encrypted requests');
    }
    const privacy = supplierCfg.tier === 'enclave' ? (encrypted ? 'enclave-encrypted' : 'enclave-plaintext') : 'standard';
    c.header('X-Forge-Privacy', privacy);

    // 2. Payment kind and unit.
    const key = bearer(c);
    const cashu = c.req.header('x-cashu');
    // NUT-11: lock this request's change to the payer's key. Stored with the request, never logged.
    const lockPubkey = parseOptionalLockPubkey(c.req.header('x-cashu-pubkey'));
    let account: Account | undefined;
    let unit: Unit;
    if (key) {
      account = ledger.findByKey(key);
      if (!account) return apiError(c, 401, 'invalid_key', 'unknown balance key');
      unit = account.unit;
    } else if (cashu) {
      unit = (await wallet.inspect(cashu)).unit;
    } else {
      const u = (c.req.header('x-forge-unit') ?? env.BELLOWS_DEFAULT_UNIT) as Unit;
      if (!env.BELLOWS_UNITS.includes(u)) return apiError(c, 400, 'wrong_unit', `unit must be one of ${env.BELLOWS_UNITS.join(', ')}`);
      unit = u;
    }
    let rate: number | undefined;
    if (unit === 'sat') {
      rate = await rates.get();
      if (!rate) return apiError(c, 503, 'rate_unavailable', 'BTC/USD rate unavailable; sat pricing is paused. Pay in usd or retry later.');
    }

    // 3. Maximum cost of this request.
    // pricing=flat: always the flat schedule. pricing=metered with a flat schedule: flat is the fallback
    // when no usage signal arrives (e.g. encrypted pass-through without usage metrics).
    const flat = supplierCfg.flat;
    const alwaysFlat = supplierCfg.pricing === 'flat';
    const markup = env.BELLOWS_MARKUP;
    const flatNano = flat ? flatCostNanoUsd(flat, raw.length, maxOut, markup) : 0;
    const meteredMax = costNanoUsd(model, { inputTokens: estimateTokensFromBytes(raw.length, env.BELLOWS_BYTES_PER_TOKEN), outputTokens: maxOut }, markup);
    const maxNano = alwaysFlat ? flatNano : Math.max(meteredMax, flatNano);
    const reserveMsub = Math.max(1, nanoUsdToMsub(maxNano, unit, rate));
    const requiredUnits = msubToUnitsCeil(reserveMsub);

    // 4. Payment.
    const inviteOk = () => !env.BELLOWS_INVITE_ONLY || invites.checkForNut24(c.req.header('x-forge-invite'));
    let pay: Payment;
    if (account) {
      const reservationId = ledger.reserve(account.id, reserveMsub);
      own.reservationId = reservationId;
      pay = { kind: 'balance', account, reservationId };
    } else if (!cashu) {
      if (!inviteOk()) return apiError(c, 403, 'invite_required', 'send X-Forge-Invite with a valid invite code, or use a balance key');
      const quoted = unit === 'sat' ? Math.ceil(requiredUnits * env.BELLOWS_SAT_PRICE_BUFFER) : requiredUnits;
      const pr = new PaymentRequest(undefined, requestId.slice(4, 20), quoted, unit, wallet.trustedMints, `${env.BELLOWS_SERVICE_NAME}: ${model.id}`, true);
      const creq = pr.toEncodedRequest();
      return apiError(c, 402, 'payment_required', `pay ${quoted} ${unit} in eCash: retry with X-Cashu: cashuB... Unused value is returned as change.`, { 'X-Cashu': creq }, {
        payment_request: creq,
        amount: quoted,
        unit,
        mints: wallet.trustedMints,
      });
    } else {
      if (!inviteOk()) return apiError(c, 403, 'invite_required', 'send X-Forge-Invite with a valid invite code');
      db.prepare(
        "INSERT INTO requests (id, payment, unit, model, supplier, encrypted, status, reserved_msub, lock_pubkey, created_at) VALUES (?, 'nut24', ?, ?, ?, ?, 'new', ?, ?, ?)",
      ).run(requestId, unit, model.id, model.supplier, encrypted ? 1 : 0, reserveMsub, lockPubkey, now());
      own.nut24RequestId = requestId;
      try {
        // A request is 'running' from the transaction that pays it, so 'paid' only ever means a payment no
        // handler serves any more (recovery finished it, or its handler ended unsettled): one a retry may take
        // over, or GET /v1/change return in full, once.
        const r = await wallet.receive(cashu, {
          purpose: 'nut24',
          expectUnit: unit,
          minAmount: requiredUnits,
          requestId,
          onFinalize: (amount) => db.prepare("UPDATE requests SET status = 'running', paid_units = ? WHERE id = ?").run(amount, requestId),
          adopt: (prior) => adoptNut24PaymentRaw(db, prior.requestId, requestId, prior.amount),
        });
        pay = { kind: 'nut24', mint: r.mint, unit, paid: r.amount };
      } catch (e) {
        const m = model;
        tx(db, () => dropFailedNut24Raw(db, requestId, { unit, model: m.id, supplier: m.supplier, encrypted }));
        throw e;
      }
    }
    // A balance payment needs no row of its own: the reservation holds the amount until settlement.

    // 5. Settlement, exactly once per request.
    let settled: Promise<SettleResult> | undefined;
    const settle = (usage: Usage | undefined, source: string, status: string): Promise<SettleResult> =>
      (settled ??= (async () => {
        let nano = 0;
        if (alwaysFlat && usage) source = 'flat';
        if (status === 'ok' || status === 'partial') {
          if (alwaysFlat || source === 'flat') nano = flatNano;
          else if (usage) nano = costNanoUsd(model, usage, markup);
        }
        const actualMsub = nanoUsdToMsub(nano, unit, rate);
        // Our cost: the supplier's own figure when it sends one, else the usage at our catalog cost (no markup).
        let costNusd: number | null = null;
        let costSource: string | null = null;
        if (usage && (status === 'ok' || status === 'partial')) {
          if (usage.costUsd !== undefined) {
            costNusd = Math.round(usage.costUsd * 1e9);
            costSource = 'supplier';
          } else if (!alwaysFlat && source !== 'flat') {
            costNusd = Math.round(costNanoUsd(model, usage, 1));
            costSource = 'catalog';
          }
        }
        const res: SettleResult = { chargedMsub: 0 };
        const ok = status === 'ok' || status === 'partial';
        const m = model;
        // One transaction: the charge (or the change owed), this request's share of the daily aggregates, and
        // removing the in-flight row. Nothing about the request is kept on its own afterwards.
        tx(db, () => {
          if (pay.kind === 'balance') {
            const s = ledger.settleRaw(pay.reservationId, actualMsub, pay.account.id);
            res.chargedMsub = s.charged;
            res.balanceMsub = s.balance;
            res.shortfallMsub = s.shortfall;
          } else {
            const chargedUnits = Math.min(pay.paid, msubToUnitsCeil(actualMsub));
            res.chargedMsub = chargedUnits * MSUB_PER_UNIT;
            res.changeUnits = pay.paid - chargedUnits;
            if (res.changeUnits > 0) res.changeId = wallet.oweRaw({ mint: pay.mint, unit, amount: res.changeUnits, purpose: 'change', requestId, lockPubkey });
            db.prepare('DELETE FROM requests WHERE id = ?').run(requestId);
          }
          recordUsageRaw(db, {
            at: t0,
            unit,
            model: m.id,
            supplier: m.supplier,
            ok,
            encrypted,
            nut24: pay.kind === 'nut24',
            estimated: source === 'estimate' || source === 'flat',
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            chargedMsub: res.chargedMsub,
            shortfallMsub: res.shortfallMsub ?? 0,
            priceNusd: nano,
            costNusd: costNusd,
            supplierReported: costSource === 'supplier',
          });
        });
        if (pay.kind === 'balance' && actualMsub > reserveMsub) log.warn('usage_over_reservation', { request_id: requestId, actual_msub: actualMsub, reserved_msub: reserveMsub });
        if (res.changeId) {
          try {
            res.changeToken = await wallet.issue(res.changeId);
          } catch (e) {
            log.warn('change_deferred', { request_id: requestId, err: errText(e) });
          }
        }
        log.info('request', {
          request_id: requestId,
          model: model.id,
          supplier: model.supplier,
          payment: pay.kind,
          unit,
          status,
          encrypted,
          stream,
          input_tokens: usage?.inputTokens,
          output_tokens: usage?.outputTokens,
          usage_source: source,
          cost_nusd: costNusd,
          cost_source: costSource,
          reserved_msub: reserveMsub,
          charged_msub: res.chargedMsub,
          change_units: res.changeUnits,
          change_locked: res.changeId ? !!lockPubkey : undefined,
          latency_ms: Date.now() - t0,
        });
        return res;
      })());

    const resultHeaders = (r: SettleResult): Record<string, string> => {
      const h: Record<string, string> = { 'X-Forge-Unit': unit, 'X-Forge-Charged-Msub': String(r.chargedMsub) };
      if (r.balanceMsub !== undefined) h['X-Forge-Balance-Msub'] = String(r.balanceMsub);
      if (r.changeToken) h['X-Cashu-Change'] = r.changeToken;
      if (r.changeId) h['X-Forge-Change-Url'] = `/v1/change/${requestId}`;
      return h;
    };

    const upstreamAbort = new AbortController();
    const signal = AbortSignal.any([upstreamAbort.signal, c.req.raw.signal]);
    const estimateInput = () => Math.ceil(raw.length / 4);

    // 6a. Encrypted pass-through.
    if (encrypted) {
      const fwd: Record<string, string> = {
        'content-type': c.req.header('content-type') ?? 'application/json',
        accept: c.req.header('accept') ?? '*/*',
        'ehbp-encapsulated-key': c.req.header('ehbp-encapsulated-key')!,
        'x-tinfoil-model': model.upstream,
        'x-tinfoil-max-output-tokens': String(maxOut),
        'x-tinfoil-completion-count': '1',
      };
      let up;
      try {
        up = await supplier.forwardEncrypted!({ model, path: '/v1/chat/completions', enclaveUrl: c.req.header('x-tinfoil-enclave-url'), headers: fwd, body: raw, signal });
      } catch (e) {
        const r = await settle(undefined, 'none', 'upstream_error');
        const status = e instanceof UpstreamError && e.status < 500 && e.status !== 499 ? e.status : 502;
        return apiError(c, status, 'upstream_error', errText(e), resultHeaders(r));
      }
      const ok = up.status >= 200 && up.status < 300;
      const passHeaders: Record<string, string> = { 'content-type': String(up.headers['content-type'] ?? 'application/octet-stream') };
      const nonce = up.headers['ehbp-response-nonce'];
      if (nonce) passHeaders['Ehbp-Response-Nonce'] = String(nonce);
      const isStream = String(up.headers['content-type'] ?? '').includes('event-stream');
      const frames = new FrameCounter();
      const finish = async (complete: boolean) => {
        const reported = complete ? await up.usage : undefined;
        if (!ok) return settle(undefined, 'none', 'upstream_error');
        if (reported) return settle(reported, 'tinfoil-metrics', complete ? 'ok' : 'partial');
        return settle({ inputTokens: estimateInput(), outputTokens: complete ? maxOut : frames.frames }, flat ? 'flat' : 'estimate', complete ? 'ok' : 'partial');
      };
      if (!isStream) {
        const chunks: Buffer[] = [];
        try {
          for await (const ch of up.body) chunks.push(ch as Buffer);
        } catch (e) {
          await finish(false);
          throw new UpstreamError(`enclave stream failed: ${errText(e)}`);
        }
        const r = await finish(true);
        return new Response(Buffer.concat(chunks), { status: up.status, headers: { ...passHeaders, ...resultHeaders(r), 'X-Forge-Request-Id': requestId, 'X-Forge-Privacy': privacy } });
      }
      let cancelled = false;
      const out = new ReadableStream<Uint8Array>({
        start(ctrl) {
          (async () => {
            try {
              try {
                for await (const ch of up.body) {
                  frames.push(ch as Uint8Array);
                  if (!cancelled) ctrl.enqueue(new Uint8Array(ch as Buffer));
                }
                await finish(true);
              } catch {
                await finish(false);
              }
            } catch (e) {
              // Settlement itself failed, so nothing was charged or owed: hand the request back.
              abandon(own);
              log.error('settle_failed', { request_id: requestId, err: errText(e) });
            }
            if (!cancelled) {
              try {
                ctrl.close();
              } catch {
                /* already closed */
              }
            }
          })();
        },
        cancel() {
          cancelled = true;
          up.body.destroy();
          upstreamAbort.abort();
        },
      });
      return new Response(out, {
        status: up.status,
        headers: { ...passHeaders, 'X-Forge-Request-Id': requestId, 'X-Forge-Unit': unit, 'X-Forge-Privacy': privacy, ...(pay.kind === 'nut24' ? { 'X-Forge-Change-Url': `/v1/change/${requestId}` } : {}) },
      });
    }

    // 6b. Plaintext OpenAI-compatible call.
    let res: Response;
    try {
      res = await supplier.chat({ model, body: upstreamBody!, stream, signal });
    } catch (e) {
      const r = await settle(undefined, 'none', 'upstream_error');
      const status = e instanceof UpstreamError && e.status < 500 && e.status !== 499 ? e.status : 502;
      return apiError(c, status, 'upstream_error', errText(e), resultHeaders(r));
    }
    if (!res.ok) {
      let msg = `upstream returned HTTP ${res.status}`;
      try {
        const j: any = JSON.parse((await res.text()).slice(0, 4000));
        if (typeof j?.error?.message === 'string') msg += `: ${j.error.message.slice(0, 300)}`;
      } catch {
        /* not JSON */
      }
      const r = await settle(undefined, 'none', 'upstream_error');
      const status = res.status >= 400 && res.status < 500 && res.status !== 429 ? res.status : 502;
      return apiError(c, status, 'upstream_error', msg + '. You were not charged.', resultHeaders(r));
    }

    if (!stream) {
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        // Headers arrived, then the body failed: nothing was served, so nothing is charged, a balance
        // reservation is released now and a NUT-24 payment comes back in full as change.
        const r = await settle(undefined, 'none', 'upstream_error');
        return apiError(c, 502, 'upstream_error', `upstream response failed: ${errText(e)}. You were not charged.`, resultHeaders(r));
      }
      let usage: Usage | undefined;
      let source = 'upstream';
      try {
        usage = usageFromJson(JSON.parse(text));
      } catch {
        /* ignore */
      }
      const headerCost = costFromHeaders(res.headers) ?? parseUsageMetrics(res.headers.get(TINFOIL_USAGE_HEADER) ?? undefined)?.costUsd;
      if (usage && usage.costUsd === undefined && headerCost !== undefined) usage.costUsd = headerCost;
      if (!usage) {
        source = flat ? 'flat' : 'estimate';
        usage = { inputTokens: estimateInput(), outputTokens: maxOut };
      }
      const r = await settle(usage, source, 'ok');
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json', 'X-Forge-Request-Id': requestId, 'X-Forge-Privacy': privacy, ...resultHeaders(r) },
      });
    }

    const meter = new SseMeter({ dropUsageChunk: !clientWantsUsage });
    const enc = new TextEncoder();
    let cancelled = false;
    const reader = res.body!.getReader();
    const usageNow = (): Usage => meter.usage ?? { inputTokens: estimateInput(), outputTokens: meter.estimatedOutputTokens() };
    const settlementEvent = (r: SettleResult, extra: object = {}) =>
      `event: forge\ndata: ${JSON.stringify({
        request_id: requestId,
        unit,
        charged_msub: r.chargedMsub,
        balance_msub: r.balanceMsub,
        change: r.changeToken,
        change_units: r.changeUnits,
        change_url: r.changeId ? `/v1/change/${requestId}` : undefined,
        ...extra,
      })}\n\n`;
    const out = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (s: string) => {
          if (!cancelled && s) {
            try {
              ctrl.enqueue(enc.encode(s));
            } catch {
              cancelled = true;
            }
          }
        };
        (async () => {
          try {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                send(meter.push(value));
              }
              send(meter.flush());
              const r = await settle(usageNow(), meter.usage ? 'upstream' : flat ? 'flat' : 'estimate', 'ok');
              send(settlementEvent(r));
            } catch (e) {
              const r = await settle(usageNow(), meter.usage ? 'upstream' : 'estimate', 'partial');
              send(`data: ${JSON.stringify({ error: { message: cancelled ? 'client disconnected' : `upstream stream failed: ${errText(e)}`, type: 'upstream_error' } })}\n\n`);
              send(settlementEvent(r, { partial: true }));
            }
          } catch (e) {
            // Settlement itself failed, so nothing was charged or owed: hand the request back.
            abandon(own);
            log.error('settle_failed', { request_id: requestId, err: errText(e) });
            send(`data: ${JSON.stringify({ error: { message: 'settlement failed', type: 'server_error' } })}\n\n`);
          }
          if (!cancelled) {
            try {
              ctrl.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },
      cancel() {
        cancelled = true;
        upstreamAbort.abort();
        reader.cancel().catch(() => {});
      },
    });
    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'X-Forge-Request-Id': requestId,
        'X-Forge-Unit': unit,
        'X-Forge-Privacy': privacy,
        ...(pay.kind === 'nut24' ? { 'X-Forge-Change-Url': `/v1/change/${requestId}` } : {}),
      },
    });
  };

  // ------------------------------------------------------------------ operator admin (404 unless an admin token is in the secrets source)
  app.route('/', createAdminRouter(d));

  return app;
}

/** What to do when recovery finalizes a receive whose HTTP request is gone. Runs inside the finalize transaction. */
function installRecoveryHooks(d: Deps) {
  d.wallet.onRecoveredIncoming = (row) => {
    if (row.purpose === 'topup' && row.account_id) {
      d.ledger.creditRaw(row.account_id, row.amount * MSUB_PER_UNIT, 'topup', 'recovered');
    } else if (row.purpose === 'nut24' && row.request_id) {
      d.db.prepare("UPDATE requests SET status = 'paid', paid_units = ? WHERE id = ?").run(row.amount, row.request_id);
    }
  };
}

function failedUsage(r: { unit: string; model: string; supplier: string; encrypted: number | boolean }): SettledUsage {
  return {
    at: Date.now(),
    unit: r.unit,
    model: r.model,
    supplier: r.supplier,
    ok: false,
    encrypted: !!r.encrypted,
    nut24: true,
    estimated: false,
    inputTokens: null,
    outputTokens: null,
    chargedMsub: 0,
    priceNusd: 0,
    costNusd: null,
    supplierReported: false,
  };
}

/**
 * A NUT-24 request whose payment failed. While the payment's outcome is unknown at the mint the row stays
 * (status failed), so recovery can still return the payment as change; otherwise it is counted as failed and
 * deleted. Caller provides the transaction. Returns true when the row was deleted.
 */
function dropFailedNut24Raw(db: DB, requestId: string, r: { unit: string; model: string; supplier: string; encrypted: boolean }): boolean {
  if (paymentPending(db, requestId)) {
    db.prepare("UPDATE requests SET status = 'failed' WHERE id = ?").run(requestId);
    return false;
  }
  const del = db.prepare('DELETE FROM requests WHERE id = ?').run(requestId);
  if (Number(del.changes) > 0) recordUsageRaw(db, failedUsage(r));
  return Number(del.changes) > 0;
}

/** A NUT-24 request row whose payment arrived but which no handler will serve. */
type UnservedNut24 = { id: string; unit: Unit; model: string; supplier: string; encrypted: number; paid_units: number | null; lock_pubkey: string | null };

/**
 * Owes a NUT-24 request's whole payment back as change (from the mint it was paid at), counts the request as
 * failed and deletes its row. Caller provides the transaction.
 */
function returnNut24PaymentRaw(d: Deps, r: UnservedNut24): void {
  const inc = d.db.prepare("SELECT mint FROM incoming WHERE request_id = ? AND status = 'done'").get(r.id) as { mint: string } | undefined;
  if (inc && r.paid_units && r.paid_units > 0) d.wallet.oweRaw({ mint: inc.mint, unit: r.unit, amount: r.paid_units, purpose: 'change', requestId: r.id, lockPubkey: r.lock_pubkey });
  recordUsageRaw(d.db, failedUsage(r));
  d.db.prepare('DELETE FROM requests WHERE id = ?').run(r.id);
}

/**
 * A retry of the same token takes over the payment of an earlier request that no handler serves (status
 * 'paid': recovery finished it, or its handler failed and is gone). The earlier request is counted as failed and deleted, the
 * retry becomes the paid, running request. Runs inside the wallet's transaction; false leaves both as they are.
 */
function adoptNut24PaymentRaw(db: DB, fromId: string, toId: string, amount: number): boolean {
  const r = db.prepare("SELECT unit, model, supplier, encrypted FROM requests WHERE id = ? AND payment = 'nut24' AND status = 'paid'").get(fromId) as
    | { unit: string; model: string; supplier: string; encrypted: number }
    | undefined;
  if (!r) return false;
  recordUsageRaw(db, failedUsage(r));
  db.prepare('DELETE FROM requests WHERE id = ?').run(fromId);
  db.prepare("UPDATE requests SET status = 'running', paid_units = ? WHERE id = ?").run(amount, toId);
  log.info('nut24_payment_adopted', { request_id: toId, amount });
  return true;
}

/**
 * Settles, in this process, the payment of a NUT-24 request that failed before it was served:
 *  - its receive is still unknown at the mint: recovery runs now (replay, restore or retry);
 *  - recovery finished it, or its handler ended without settling ('paid'): the whole payment is owed back
 *    as change;
 *  - recovery found the token spent elsewhere: the request is counted as failed and forgotten.
 *  - its token never reached the mint (receive row still new, not in flight): the receive is forgotten,
 *    the request is counted as failed and forgotten, and the client keeps its token.
 * Returns 'running' while a handler still holds the request (a handler that ends unsettled marks it 'paid',
 * see the chat route), 'pending' while the mint has not settled the
 * receive, 'done' otherwise (the change, if any, is then owed under the request id).
 */
async function settleUnservedNut24(d: Deps, id: string): Promise<'running' | 'pending' | 'done'> {
  const get = () =>
    d.db.prepare("SELECT id, unit, model, supplier, encrypted, paid_units, lock_pubkey, status FROM requests WHERE id = ? AND payment = 'nut24'").get(id) as
      | (UnservedNut24 & { status: string })
      | undefined;
  let r = get();
  if (!r) return 'done';
  if (r.status === 'failed' && paymentPending(d.db, id)) {
    try {
      await d.wallet.recoverIncomingFor(id);
    } catch (e) {
      log.warn('nut24_recovery_deferred', { request_id: id, err: errText(e) });
      return 'pending';
    }
    r = get();
    if (!r) return 'done';
  }
  if (r.status !== 'failed' && r.status !== 'paid') return 'running';
  const req = r;
  return tx(d.db, () => {
    const cur = get();
    if (!cur) return 'done';
    if (cur.status === 'paid') {
      returnNut24PaymentRaw(d, cur);
      log.info('nut24_payment_returned', { request_id: id, amount: cur.paid_units });
      return 'done';
    }
    if (cur.status !== 'failed') return 'running';
    // Still unknown (another caller is recovering it right now) or refused at the mint.
    return dropFailedNut24Raw(d.db, id, { ...req, encrypted: !!req.encrypted }) ? 'done' : 'pending';
  });
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Startup tasks: recover mint operations, release stale reservations, owe change to interrupted NUT-24 requests. */
export async function startupRecovery(d: Deps, olderThanMs = 0): Promise<void> {
  // At process start nothing is in flight, so every active reservation and running request is orphaned.
  installRecoveryHooks(d);
  const w = await d.wallet.recover();
  const released = d.ledger.releaseStale(olderThanMs);
  const cutoff = Date.now() - olderThanMs;
  const stuck = d.db
    .prepare("SELECT id, unit, model, supplier, encrypted, paid_units, lock_pubkey FROM requests WHERE payment = 'nut24' AND status IN ('paid', 'running') AND created_at <= ?")
    .all(cutoff) as UnservedNut24[];
  for (const r of stuck) tx(d.db, () => returnNut24PaymentRaw(d, r));
  // Requests whose payment never arrived (or was refused) and is no longer pending at the mint.
  const unpaid = d.db
    .prepare("SELECT id, unit, model, supplier, encrypted FROM requests WHERE status IN ('new', 'failed') AND created_at <= ?")
    .all(cutoff) as Array<{ id: string; unit: Unit; model: string; supplier: string; encrypted: number }>;
  let dropped = 0;
  for (const r of unpaid) if (tx(d.db, () => dropFailedNut24Raw(d.db, r.id, { ...r, encrypted: !!r.encrypted }))) dropped++;
  log.info('startup_recovery', { incoming: w.incoming, outgoing: w.outgoing, errors: w.errors, released_reservations: released, aborted_nut24: stuck.length, dropped_unpaid: dropped });
}
