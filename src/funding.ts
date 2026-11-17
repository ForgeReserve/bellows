import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  getEncodedToken,
  getPubKeyFromPrivKey,
  getTokenMetadata,
  type MeltQuoteBolt11Response,
  MintOperationError,
  type MintPreview,
  type OperationCounters,
  OutputData,
  type Proof,
  type SerializedOutputData,
  type Wallet,
} from '@cashu/cashu-ts';
import { BalanceCap, OPEN_FUNDING_STATES, releaseIfEmpty } from './accounts.ts';
import { type GatewayWallet, PaymentError } from './cashu/wallet.ts';
import { type Env, normalizeMintUrl, type Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';
import type { Ledger } from './ledger.ts';
import { errText, log } from './log.ts';
import { type MintDiscovery, type MintProbe, normalizeDiscoveryUrl, probeMint, sanitizeMintName } from './mint-discovery.ts';
import { MSUB_PER_UNIT } from './pricing.ts';
import type { RateOracle } from './rates.ts';

export type FundingMethod = 'lightning' | 'onchain' | 'foreign';
export type FundingState = 'quoted' | 'receiving' | 'melting' | 'pending' | 'minting' | 'done' | 'expired' | 'failed' | 'refunded';

export interface FundingRow {
  id: string;
  method: FundingMethod;
  account_id: string;
  unit: Unit;
  mint: string;
  quote: string | null;
  request: string | null;
  amount: number | null;
  expires_at: number | null;
  lock_key: string | null;
  state: FundingState;
  credited: number;
  mint_op: string | null;
  next_check: number;
  observed: string | null;
  f_mint: string | null;
  f_unit: Unit | null;
  f_token_hash: string | null;
  f_amount: number | null;
  f_melt_quote: string | null;
  f_fee_max: number | null;
  f_melt_op: string | null;
  f_attempts: number;
  f_change_token: string | null;
  f_refund_token: string | null;
  f_lock_pubkey: string | null;
  f_unlisted: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface MintOp {
  amount: number;
  keysetId: string;
  outputs: SerializedOutputData[];
  counters: OperationCounters | null;
  signature?: string;
  legacySignature?: string;
}

interface MeltOp {
  quote: string;
  amount: number;
  feeReserve: number;
  keysetId: string;
  outputs: SerializedOutputData[];
  counters: OperationCounters | null;
}

interface Observed {
  state?: string;
  amount_paid?: number;
  amount_issued?: number;
  seen_sat?: number | null;
  confirmed_sat?: number | null;
  confirmations?: number | null;
}

export interface FundingMethods {
  /** Where balances are kept (BELLOWS_STORAGE). memory: every restart loses every balance. */
  storage: Env['BELLOWS_STORAGE'];
  /**
   * Memory storage: the most one balance may hold, per unit, in whole units (cents for usd), counting open
   * fundings. A funding or top-up past it is refused with balance_limit. null: no cap.
   */
  balance_max: Partial<Record<Unit, number>> | null;
  ecash: { mints: string[]; units: Unit[] };
  lightning: { enabled: boolean; units: Unit[]; min: Partial<Record<Unit, number>>; max: Partial<Record<Unit, number>> };
  onchain: { enabled: boolean; unit: 'sat'; min_amount: number; confirmations: number };
  foreign: {
    enabled: boolean;
    max: { sat: number; usd: number };
    policy: ForeignPolicy;
    mints: string[];
    mints_url: string;
    /** Mints that are not accepted may still be used after a warning, up to max (sat / cents). */
    unlisted: { enabled: boolean; max: { sat: number; usd: number } };
  };
}

/** A mint the operator added through the admin API. */
export interface OperatorMint {
  url: string;
  name: string | null;
  note: string | null;
  added_at: number;
}

/** How long a live probe of an unlisted mint is reused (a failure: a minute). */
export const PROBE_CACHE_MS = 10 * 60_000;
const PROBE_FAIL_CACHE_MS = 60_000;

export type ForeignPolicy = Env['BELLOWS_FOREIGN_POLICY'];

export interface AcceptedMint {
  url: string;
  name?: string;
  reviewers?: number;
  source: 'discovered' | 'operator';
}

export interface AcceptedMints {
  policy: ForeignPolicy;
  mints: AcceptedMint[];
  /** When the discovered part was fetched (ms), or null. */
  updated_at: number | null;
}

export const FOREIGN_MINTS_PATH = '/v1/wallet/fund/mints';

/** The result of vetting a token's mint: its normalized URL, and whether the customer chose it off the list. */
export interface VettedMint {
  url: string;
  unlisted: boolean;
}

/** The key two spellings of one mint URL share (host case, trailing slash). */
export function mintKey(url: string, allowInsecure: boolean): string {
  return normalizeDiscoveryUrl(normalizeMintUrl(url), allowInsecure) ?? normalizeMintUrl(url);
}

export interface FundingFaults {
  /** Throw after the funding mint signed our outputs, before the DB write. */
  afterMint?: boolean;
  /** Throw after the foreign mint answered the melt, before the DB write. */
  afterMelt?: boolean;
  /** Skip NUT-19 replay on recovery so NUT-09 restore is exercised. */
  noReplay?: boolean;
}

const TERMINAL: FundingState[] = ['done', 'expired', 'failed', 'refunded'];
const num = (a: unknown): number => (a == null ? 0 : typeof a === 'number' ? a : Number(String(a)));
const popcount = (n: number): number => n.toString(2).replace(/0/g, '').length;

function isRejection(e: unknown): boolean {
  return e instanceof MintOperationError;
}

/**
 * SSRF guard for user-supplied mint URLs: https only, no credentials, and the host must not be a
 * private, loopback or link-local address (checked on every resolved address). A DNS answer can
 * still change between this check and the request; the mint is only ever sent Cashu API calls.
 */
export async function checkForeignMintUrl(url: string, allowInsecure: boolean): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PaymentError('invalid_token', 'token mint URL is not valid');
  }
  if (u.username || u.password) throw new PaymentError('mint_not_allowed', 'mint URL must not carry credentials');
  if (allowInsecure) return normalizeMintUrl(u.toString());
  if (u.protocol !== 'https:') throw new PaymentError('mint_not_allowed', 'only https mints are accepted');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new PaymentError('mint_not_allowed', 'this mint address is not allowed');
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new PaymentError('mint_unavailable', 'could not resolve the mint host', 503);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new PaymentError('mint_not_allowed', 'this mint address is not allowed');
  return normalizeMintUrl(u.toString());
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Funding a balance through the funding mint (BELLOWS_FUND_MINT). Every mint step follows the receive path's rule: persist
 * what will be sent (quote, then deterministic outputs and counter range) before sending it, so a
 * restart can finish the step through NUT-19 replay or NUT-09 restore and credit exactly once.
 *
 * Lightning: pending -> (quote PAID) minting -> done. Unpaid past expiry -> expired.
 * On-chain:  pending -> (amount_paid > amount_issued) minting -> pending ... until the watch window ends.
 * Foreign:   quoted -> (confirm) receiving -> melting -> pending -> minting -> done; a failed melt -> refunded.
 */
export class FundingService {
  private readonly db: DB;
  private readonly ledger: Ledger;
  private readonly wallet: GatewayWallet;
  private readonly env: Env;
  private readonly rates: RateOracle;
  /** The memory-storage balance cap (no cap unless BELLOWS_STORAGE=memory). */
  readonly cap: BalanceCap;
  readonly mint: string;
  private readonly inflight = new Set<string>();
  private info?: { at: number; value: any };
  faults: FundingFaults;
  private timer?: NodeJS.Timeout;
  private readonly discovery?: MintDiscovery;
  private readonly probeFn: (url: string) => Promise<MintProbe>;
  private readonly probes = new Map<string, { at: number; value: MintProbe }>();

  constructor(d: {
    db: DB;
    ledger: Ledger;
    wallet: GatewayWallet;
    env: Env;
    rates: RateOracle;
    mint: string;
    faults?: FundingFaults;
    discovery?: MintDiscovery;
    /** Tests: a stand-in for the live mint probe (probeMint). */
    probe?: (url: string) => Promise<MintProbe>;
    /** The memory-storage balance cap. Default: none. */
    cap?: BalanceCap;
  }) {
    this.db = d.db;
    this.ledger = d.ledger;
    this.wallet = d.wallet;
    this.env = d.env;
    this.rates = d.rates;
    this.cap = d.cap ?? new BalanceCap(d.db, null);
    this.mint = normalizeMintUrl(d.mint);
    this.faults = d.faults ?? {};
    this.discovery = d.discovery;
    this.probeFn = d.probe ?? ((url) => probeMint(url, this.env.BELLOWS_UNITS));
  }

  // ------------------------------------------------------------------ info

  private async mintInfo(): Promise<any> {
    if (this.info && Date.now() - this.info.at < 300_000) return this.info.value;
    const res = await fetch(`${this.mint}/v1/info`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new PaymentError('mint_unavailable', `mint info returned HTTP ${res.status}`, 503);
    const value = await res.json();
    this.info = { at: Date.now(), value };
    return value;
  }

  async methods(): Promise<FundingMethods> {
    const env = this.env;
    let info: any = {};
    try {
      info = await this.mintInfo();
    } catch (e) {
      log.warn('fund_mint_info_failed', { err: errText(e) });
    }
    const m4: any[] = info?.nuts?.['4']?.disabled ? [] : (info?.nuts?.['4']?.methods ?? []);
    const bolt11 = m4.filter((m) => m.method === 'bolt11' && env.BELLOWS_UNITS.includes(m.unit));
    const onchain = m4.find((m) => m.method === 'onchain' && m.unit === 'sat');
    const balanceMax = this.cap.max;
    // In memory storage no balance holds more than its cap, so neither does one invoice.
    const cap: Record<Unit, number> = {
      sat: Math.min(env.BELLOWS_FUND_MAX_SAT, balanceMax?.sat ?? Infinity),
      usd: Math.min(env.BELLOWS_FUND_MAX_USD, balanceMax?.usd ?? Infinity),
    };
    const lightningUnits = bolt11.map((m) => m.unit as Unit);
    return {
      storage: env.BELLOWS_STORAGE,
      balance_max: balanceMax ? { ...balanceMax } : null,
      ecash: { mints: this.wallet.trustedMints, units: env.BELLOWS_UNITS },
      lightning: {
        enabled: env.BELLOWS_LIGHTNING_ENABLED && lightningUnits.length > 0,
        units: lightningUnits,
        min: Object.fromEntries(bolt11.map((m) => [m.unit, Math.max(1, num(m.min_amount))])),
        max: Object.fromEntries(bolt11.map((m) => [m.unit, Math.min(cap[m.unit as Unit], m.max_amount ? num(m.max_amount) : Infinity)])),
      },
      onchain: {
        enabled: env.BELLOWS_ONCHAIN_ENABLED && !!onchain && env.BELLOWS_UNITS.includes('sat'),
        unit: 'sat',
        min_amount: onchain ? num(onchain.min_amount) : 0,
        confirmations: env.BELLOWS_ONCHAIN_CONFIRMATIONS,
      },
      foreign: {
        enabled: env.BELLOWS_FOREIGN_ENABLED && lightningUnits.length > 0,
        max: { sat: env.BELLOWS_FOREIGN_MAX_SAT, usd: env.BELLOWS_FOREIGN_MAX_USD },
        policy: env.BELLOWS_FOREIGN_POLICY,
        mints: this.acceptedForeignMints().mints.map((m) => m.url),
        mints_url: FOREIGN_MINTS_PATH,
        unlisted: { enabled: this.unlistedEnabled(), max: this.unlistedMax() },
      },
    };
  }

  private async fundWallet(unit: Unit): Promise<Wallet> {
    try {
      return await this.wallet.wallet(this.mint, unit);
    } catch (e) {
      throw new PaymentError('mint_unavailable', `could not reach the funding mint: ${errText(e)}`, 503);
    }
  }

  // ------------------------------------------------------------------ rows

  get(id: string): FundingRow | undefined {
    return this.db.prepare('SELECT * FROM fundings WHERE id = ?').get(id) as FundingRow | undefined;
  }

  list(accountId: string, limit = 20): FundingRow[] {
    return this.db.prepare('SELECT * FROM fundings WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit) as unknown as FundingRow[];
  }

  private set(id: string, fields: Partial<FundingRow>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE fundings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as any)[k] ?? null), now(), id);
  }

  private openCount(accountId: string): number {
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM fundings WHERE account_id = ? AND state IN (${marks})`).get(accountId, ...OPEN_FUNDING_STATES) as { n: number }).n;
  }

  private checkPendingLimit(accountId: string) {
    if (this.openCount(accountId) >= this.env.BELLOWS_FUND_MAX_PENDING) {
      throw new PaymentError('too_many_pending', 'this balance has too many unfinished fundings; finish or wait for them to expire', 429);
    }
  }

  private insert(r: Partial<FundingRow> & Pick<FundingRow, 'method' | 'account_id' | 'unit' | 'state'>): FundingRow {
    const id = 'fund_' + randomUUID().replaceAll('-', '');
    const row: Record<string, unknown> = { id, mint: this.mint, created_at: now(), updated_at: now(), next_check: now(), ...r };
    const keys = Object.keys(row);
    this.db.prepare(`INSERT INTO fundings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => (row[k] ?? null) as any));
    return this.get(id)!;
  }

  view(r: FundingRow) {
    const acct = this.ledger.get(r.account_id);
    const obs: Observed = r.observed ? JSON.parse(r.observed) : {};
    return {
      id: r.id,
      method: r.method,
      state: r.state,
      unit: r.unit,
      amount: r.amount,
      request: r.state === 'quoted' && r.method === 'foreign' ? null : r.request,
      expires_at: r.method === 'onchain' ? null : r.expires_at,
      credited: r.credited,
      balance_msub: acct?.balance_msub,
      account_id: r.account_id,
      mint: r.mint,
      onchain:
        r.method === 'onchain'
          ? {
              confirmations_required: this.env.BELLOWS_ONCHAIN_CONFIRMATIONS,
              paid_sat: obs.amount_paid ?? 0,
              seen_sat: obs.seen_sat ?? null,
              confirmed_sat: obs.confirmed_sat ?? null,
              confirmations: obs.confirmations ?? null,
              watch_until: r.expires_at,
            }
          : undefined,
      foreign:
        r.method === 'foreign'
          ? {
              mint: r.f_mint,
              unlisted: !!r.f_unlisted,
              unit: r.f_unit,
              token_amount: r.f_amount,
              credit: r.amount,
              fee_max: r.f_fee_max,
              change_token: r.f_change_token,
              refund_token: r.f_refund_token,
              locked_to: r.f_lock_pubkey,
              // A locked change or refund the mint has not issued yet (it is retried on every status poll).
              payout_pending: this.undeliveredPayouts(r.id).length > 0,
            }
          : undefined,
      error: r.error ?? undefined,
      created_at: r.created_at,
    };
  }

  // ------------------------------------------------------------------ create

  async createLightning(accountId: string, unit: Unit, amount: number): Promise<FundingRow> {
    const m = await this.methods();
    if (!m.lightning.enabled || !m.lightning.units.includes(unit)) throw new PaymentError('method_unavailable', `Lightning funding in ${unit} is not available`, 400);
    const min = m.lightning.min[unit] ?? 1;
    const max = m.lightning.max[unit] ?? 0;
    // Refused up front, before an invoice exists, when the balance cannot take it.
    this.cap.check(accountId, unit, amount);
    if (!Number.isInteger(amount) || amount < min || amount > max) throw new PaymentError('invalid_amount', `amount must be ${min}..${max} ${unit}`);
    this.checkPendingLimit(accountId);
    const w = await this.fundWallet(unit);
    let q;
    try {
      q = await w.createMintQuoteBolt11(amount);
    } catch (e) {
      throw new PaymentError('mint_unavailable', `the funding mint did not create an invoice: ${errText(e)}`, 503);
    }
    // Persisted before the invoice is shown: a restart resumes watching it. The room is checked again in the
    // same step as the insert, since another request may have taken it while the invoice was made.
    this.cap.check(accountId, unit, amount);
    const row = this.insert({
      method: 'lightning',
      account_id: accountId,
      unit,
      quote: q.quote,
      request: q.request,
      amount,
      expires_at: q.expiry ? q.expiry * 1000 : now() + 3600_000,
      state: 'pending',
      next_check: now() + 2000,
    });
    log.info('fund_created', { id: row.id, method: 'lightning', unit, amount });
    return row;
  }

  async createOnchain(accountId: string): Promise<FundingRow> {
    const m = await this.methods();
    if (!m.onchain.enabled) throw new PaymentError('method_unavailable', 'on-chain funding is not available', 400);
    this.checkPendingLimit(accountId);
    const w = await this.fundWallet('sat');
    // NUT-20: the quote is locked to a key only this gateway holds, so nobody else can mint it.
    const priv = randomBytes(32);
    const pub = Buffer.from(getPubKeyFromPrivKey(priv)).toString('hex');
    let q;
    try {
      q = await w.createMintQuoteOnchain(pub);
    } catch (e) {
      throw new PaymentError('mint_unavailable', `the funding mint did not create an address: ${errText(e)}`, 503);
    }
    const row = this.insert({
      method: 'onchain',
      account_id: accountId,
      unit: 'sat',
      quote: q.quote,
      request: q.request,
      lock_key: priv.toString('hex'),
      expires_at: now() + this.env.BELLOWS_ONCHAIN_WATCH_DAYS * 86400_000,
      state: 'pending',
      next_check: now() + 5000,
    });
    log.info('fund_created', { id: row.id, method: 'onchain' });
    return row;
  }

  private keySet(list: readonly string[]): Set<string> {
    return new Set(list.map((u) => mintKey(u, this.env.BELLOWS_FOREIGN_ALLOW_INSECURE)));
  }

  /** URLs discovery never offers: the gateway's own mints and the deny list. */
  discoveryExcluded(): string[] {
    return [...this.wallet.trustedMints, ...this.env.BELLOWS_FOREIGN_DENY];
  }

  // ------------------------------------------------------------------ other mints

  /** Mints the operator added through the admin API, oldest first. */
  operatorMints(): OperatorMint[] {
    return this.db.prepare('SELECT url, name, note, added_at FROM operator_mints ORDER BY added_at, url').all() as unknown as OperatorMint[];
  }

  /** Env BELLOWS_FOREIGN_ALLOW plus the admin-added mints, as keys. */
  private operatorKeys(): Set<string> {
    return this.keySet([...this.env.BELLOWS_FOREIGN_ALLOW, ...this.operatorMints().map((m) => m.url)]);
  }

  /** Unlisted mints can be chosen by the customer: on, and the policy is one that has a list. */
  private unlistedEnabled(): boolean {
    return this.env.BELLOWS_FOREIGN_ENABLED && this.env.BELLOWS_FOREIGN_UNLISTED && this.env.BELLOWS_FOREIGN_POLICY !== 'any';
  }

  /** The unlisted cap per token unit: the lower of the unlisted and the other-mint caps. */
  private unlistedMax(): { sat: number; usd: number } {
    const e = this.env;
    return { sat: Math.min(e.BELLOWS_FOREIGN_UNLISTED_MAX_SAT, e.BELLOWS_FOREIGN_MAX_SAT), usd: Math.min(e.BELLOWS_FOREIGN_UNLISTED_MAX_USD, e.BELLOWS_FOREIGN_MAX_USD) };
  }

  /**
   * Other mints whose eCash is accepted under the policy: the operator's (env list and admin-added),
   * then the discovered set (under 'discovered', and under 'any' with no env list, where they are
   * suggestions). Denied mints and the gateway's own mints are never listed. Never waits on a relay.
   */
  acceptedForeignMints(): AcceptedMints {
    const env = this.env;
    const insecure = env.BELLOWS_FOREIGN_ALLOW_INSECURE;
    const skip = this.keySet([...this.wallet.trustedMints, ...env.BELLOWS_FOREIGN_DENY]);
    const out: AcceptedMint[] = [];
    const add = (m: AcceptedMint) => {
      const k = mintKey(m.url, insecure);
      if (skip.has(k)) return;
      skip.add(k);
      out.push(m);
    };
    for (const u of env.BELLOWS_FOREIGN_ALLOW) add({ url: mintKey(u, insecure), source: 'operator' });
    for (const m of this.operatorMints()) add({ url: m.url, ...(m.name ? { name: m.name } : {}), source: 'operator' });
    const listDiscovered = env.BELLOWS_FOREIGN_POLICY === 'discovered' || (env.BELLOWS_FOREIGN_POLICY === 'any' && env.BELLOWS_FOREIGN_ALLOW.length === 0);
    if (listDiscovered && this.discovery) {
      for (const m of this.discovery.snapshot()) add({ url: m.url, ...(m.name ? { name: m.name } : {}), reviewers: m.reviewers, source: 'discovered' });
    }
    return { policy: env.BELLOWS_FOREIGN_POLICY, mints: out, updated_at: listDiscovered ? (this.discovery?.updatedAt() ?? null) : null };
  }

  /** A live probe of a mint (info, an active keyset in a unit this gateway uses, NUT-05 bolt11 melt), reused for a while. */
  async probeForeignMint(url: string, fresh = false): Promise<MintProbe> {
    const key = mintKey(url, this.env.BELLOWS_FOREIGN_ALLOW_INSECURE);
    const hit = this.probes.get(key);
    if (!fresh && hit && Date.now() - hit.at < (hit.value.ok ? PROBE_CACHE_MS : PROBE_FAIL_CACHE_MS)) return hit.value;
    let value: MintProbe;
    try {
      value = await this.probeFn(key);
    } catch {
      value = { url: key, ok: false, reason: 'probe threw' };
    }
    if (this.probes.size > 500) this.probes.clear();
    this.probes.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Vets a foreign token's mint against the policy. A mint that is not accepted answers 'mint_unlisted'
   * (when BELLOWS_FOREIGN_UNLISTED is on and the policy has a list) unless the customer accepted it; it
   * then must pass the live probe, and the caller applies the lower cap.
   */
  async vetForeignMint(mint: string, opts: { acceptUnlisted?: boolean } = {}): Promise<VettedMint> {
    const env = this.env;
    if (!env.BELLOWS_FOREIGN_ENABLED) throw new PaymentError('method_unavailable', 'eCash from other mints is not accepted here', 400);
    const m = normalizeMintUrl(mint);
    if (this.wallet.isTrusted(m)) throw new PaymentError('use_topup', 'this token is from an accepted mint: add it as eCash instead');
    const insecure = env.BELLOWS_FOREIGN_ALLOW_INSECURE;
    const key = mintKey(m, insecure);
    if (this.keySet(env.BELLOWS_FOREIGN_DENY).has(key)) throw new PaymentError('mint_not_allowed', 'eCash from this mint is not accepted');
    const operator = this.operatorKeys();
    let ok: boolean;
    if (env.BELLOWS_FOREIGN_POLICY === 'any') ok = env.BELLOWS_FOREIGN_ALLOW.length === 0 || operator.has(key);
    else if (env.BELLOWS_FOREIGN_POLICY === 'allowlist') ok = operator.has(key);
    else ok = operator.has(key) || !!this.discovery?.snapshot().some((d) => mintKey(d.url, insecure) === key);
    if (ok) return { url: await checkForeignMintUrl(m, insecure), unlisted: false };
    if (!this.unlistedEnabled()) {
      throw new PaymentError(
        'mint_not_allowed',
        `eCash from this mint is not accepted yet. The mints this gateway accepts are listed at ${FOREIGN_MINTS_PATH}.`,
      );
    }
    // The URL safety check runs before the customer is asked, so an unsafe mint is never offered.
    const url = await checkForeignMintUrl(m, insecure);
    const max = this.unlistedMax();
    if (!opts.acceptUnlisted) {
      throw new PaymentError(
        'mint_unlisted',
        `This mint is not on this gateway's recommended list. You can continue at your own risk, up to ${max.sat} sat or $${(max.usd / 100).toFixed(2)}. Resend with accept_unlisted: true to continue.`,
        409,
        { unlisted: { mint: url, max } },
      );
    }
    const probe = await this.probeForeignMint(url);
    if (!probe.ok) throw new PaymentError('mint_check_failed', `this mint did not pass this gateway's checks (${probe.reason ?? 'unknown'}), so its eCash cannot be used`, 400);
    return { url, unlisted: true };
  }

  // ------------------------------------------------------------------ operator mints (admin)

  /**
   * Adds a mint to the operator list. Refuses the gateway's own and denied mints and runs the URL safety
   * check; the live probe must pass unless force is set. The mint's /v1/info name is kept.
   */
  async addOperatorMint(raw: string, note: string | null, force = false): Promise<{ mint: OperatorMint; probe: MintProbe; forced: boolean; added: boolean }> {
    const env = this.env;
    const insecure = env.BELLOWS_FOREIGN_ALLOW_INSECURE;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 200) throw new PaymentError('invalid_request', 'send a mint URL of at most 200 characters');
    const m = normalizeMintUrl(trimmed);
    if (this.wallet.isTrusted(m) || this.keySet(this.wallet.trustedMints).has(mintKey(m, insecure)) || mintKey(m, insecure) === mintKey(this.mint, insecure)) {
      throw new PaymentError('own_mint', "this is one of this gateway's own mints; its eCash is already accepted", 409);
    }
    if (this.keySet(env.BELLOWS_FOREIGN_DENY).has(mintKey(m, insecure))) throw new PaymentError('mint_denied', 'this mint is in BELLOWS_FOREIGN_DENY; remove it there first', 409);
    const url = mintKey(await checkForeignMintUrl(m, insecure), insecure);
    const probe = await this.probeForeignMint(url, true);
    if (!probe.ok && !force) {
      throw new PaymentError('mint_check_failed', `the mint did not pass the check: ${probe.reason ?? 'unknown'}. Add it anyway with force.`, 400, { probe });
    }
    const existed = !!this.db.prepare('SELECT 1 FROM operator_mints WHERE url = ?').get(url);
    const name = sanitizeMintName(probe.name) ?? null;
    const cleanNote = note ? note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || null : null;
    this.db
      .prepare('INSERT INTO operator_mints (url, name, note, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET name = excluded.name, note = excluded.note')
      .run(url, name, cleanNote, now());
    const mint = this.db.prepare('SELECT url, name, note, added_at FROM operator_mints WHERE url = ?').get(url) as unknown as OperatorMint;
    return { mint, probe, forced: !probe.ok, added: !existed };
  }

  /** Removes an admin-added mint. Returns false when it was not on the list. */
  removeOperatorMint(raw: string): boolean {
    const key = mintKey(String(raw ?? ''), this.env.BELLOWS_FOREIGN_ALLOW_INSECURE);
    return Number(this.db.prepare('DELETE FROM operator_mints WHERE url = ?').run(key).changes) > 0;
  }

  /**
   * Prices a foreign token: creates a bolt11 quote at the funding mint for the credit and a melt quote for it at
   * the token's mint, shrinking the credit until the melt (amount + fee reserve + input fees) fits.
   * Nothing is spent; the token stays with the client until confirm.
   */
  async quoteForeign(accountId: string, unit: Unit, token: string, lockPubkey: string | null = null, opts: { acceptUnlisted?: boolean } = {}): Promise<FundingRow> {
    const m = await this.methods();
    if (!m.foreign.enabled || !m.lightning.units.includes(unit)) throw new PaymentError('method_unavailable', `funding in ${unit} from other mints is not available`, 400);
    let meta: { mint: string };
    try {
      meta = getTokenMetadata(token);
    } catch {
      throw new PaymentError('invalid_token', 'could not decode token');
    }
    const vetted = await this.vetForeignMint(meta.mint, opts);
    const t = await this.wallet.inspect(token, undefined, { foreign: true });
    const rawAmount = t.proofs.reduce((s, p) => s + num(p.amount), 0);
    const max = t.unit === 'sat' ? this.env.BELLOWS_FOREIGN_MAX_SAT : this.env.BELLOWS_FOREIGN_MAX_USD;
    if (rawAmount > max) throw new PaymentError('amount_too_large', `tokens from other mints are limited to ${max} ${t.unit}`);
    if (vetted.unlisted) {
      const cap = this.unlistedMax()[t.unit];
      if (rawAmount > cap) throw new PaymentError('amount_too_large', `tokens from a mint that is not on this gateway's list are limited to ${cap} ${t.unit}`);
    }
    this.checkPendingLimit(accountId);

    const fw = await this.wallet.wallet(t.mint, t.unit);
    const fundW = await this.fundWallet(unit);
    // After the swap we hold `t.amount` in about popcount(t.amount) proofs; melting them costs input fees.
    const meltInputFee = num(fw.getFeesForKeyset(popcount(t.amount), fw.getKeyset().id));
    const budget = t.amount - meltInputFee;
    if (budget < 2) throw new PaymentError('insufficient_amount', 'this token is too small to move to the funding mint');
    let credit: number;
    if (t.unit === unit) credit = budget - Math.max(2, Math.ceil(budget * 0.01));
    else {
      const rate = await this.rates.get();
      if (!rate) throw new PaymentError('rate_unavailable', 'BTC/USD rate unavailable; try a token in the same unit', 503);
      credit = t.unit === 'sat' ? Math.floor(((budget * rate) / 1e8) * 100 * 0.97) : Math.floor(((budget / 100) * 1e8 * 0.97) / rate);
    }
    let fq: Awaited<ReturnType<Wallet['createMintQuoteBolt11']>> | undefined;
    let mq: MeltQuoteBolt11Response | undefined;
    for (let i = 0; i < 6; i++) {
      if (credit < 1) break;
      try {
        fq = await fundW.createMintQuoteBolt11(credit);
      } catch (e) {
        throw new PaymentError('mint_unavailable', `the funding mint did not create an invoice: ${errText(e)}`, 503);
      }
      try {
        mq = await fw.createMeltQuoteBolt11(fq.request);
      } catch (e) {
        throw new PaymentError('foreign_mint_error', `the token's mint cannot pay Lightning invoices: ${errText(e)}`, isRejection(e) ? 400 : 503);
      }
      const cost = num(mq.amount) + num(mq.fee_reserve);
      if (cost <= budget) break;
      mq = undefined;
      credit = Math.floor((credit * budget) / cost) - (i + 1);
    }
    if (!fq || !mq) throw new PaymentError('insufficient_amount', 'this token cannot cover the Lightning fees to move it to the funding mint');
    const feeMax = rawAmount - t.amount + meltInputFee + num(mq.fee_reserve);
    const expiries = [fq.expiry, mq.expiry].filter((x): x is number => typeof x === 'number' && x > 0);
    // Nothing is taken at a quote; the token stays with its owner. Checked in the same step as the insert.
    this.cap.check(accountId, unit, credit);
    const row = this.insert({
      method: 'foreign',
      account_id: accountId,
      unit,
      quote: fq.quote,
      request: fq.request,
      amount: credit,
      expires_at: expiries.length ? Math.min(...expiries) * 1000 : now() + 600_000,
      state: 'quoted',
      next_check: expiries.length ? Math.min(...expiries) * 1000 : now() + 600_000,
      f_mint: t.mint,
      f_unit: t.unit,
      f_token_hash: t.hash,
      f_amount: rawAmount,
      f_melt_quote: mq.quote,
      f_fee_max: feeMax,
      f_lock_pubkey: lockPubkey,
      f_unlisted: vetted.unlisted ? 1 : 0,
    });
    log.info('fund_created', { id: row.id, method: 'foreign', unit, amount: credit, foreign_unit: t.unit, foreign_amount: rawAmount, unlisted: vetted.unlisted });
    return row;
  }

  /** Takes the token: receive at its mint (held for this funding), then melt into the funding mint's quote. */
  async confirmForeign(id: string, token: string, lockPubkey: string | null = null): Promise<FundingRow> {
    const row = this.get(id);
    if (!row || row.method !== 'foreign') throw new PaymentError('not_found', 'unknown funding', 404);
    if (row.state !== 'quoted') return row;
    // A key given at confirm replaces the one given at quote; neither is required.
    if (lockPubkey) this.set(id, { f_lock_pubkey: lockPubkey });
    if (row.expires_at && now() > row.expires_at - 15_000) throw new PaymentError('quote_expired', 'this quote expired; ask for a new one', 409);
    const t = await this.wallet.inspect(token, undefined, { foreign: true });
    if (t.hash !== row.f_token_hash) throw new PaymentError('token_mismatch', 'this is not the token that was quoted', 400);
    if (this.inflight.has(id)) throw new PaymentError('in_flight', 'this funding is being processed', 409);
    this.inflight.add(id);
    try {
      this.set(id, { state: 'receiving' });
      try {
        await this.wallet.receive(token, { purpose: 'foreign', foreign: true, requestId: id });
      } catch (e) {
        if (e instanceof PaymentError && e.status < 500) {
          this.set(id, { state: 'quoted' });
          throw e;
        }
        // Unknown outcome: startup or the next check finishes the receive and moves on.
        this.set(id, { next_check: now() + 5000, error: errText(e) });
        return this.get(id)!;
      }
      this.set(id, { state: 'melting', error: null });
      await this.melt(this.get(id)!);
      const after = this.get(id)!;
      if (after.state === 'pending') await this.checkQuote(after);
      await this.deliverPayouts(id);
      return this.get(id)!;
    } finally {
      this.inflight.delete(id);
    }
  }

  // ------------------------------------------------------------------ progress

  /** One step for a funding; safe to call from the poller and the status endpoint at once. */
  async advance(id: string): Promise<FundingRow | undefined> {
    const row = this.get(id);
    if (!row || this.inflight.has(id)) return row;
    if (TERMINAL.includes(row.state)) {
      if (row.method === 'foreign' && this.undeliveredPayouts(id).length) {
        this.inflight.add(id);
        try {
          await this.deliverPayouts(id);
        } finally {
          this.inflight.delete(id);
        }
      }
      return this.get(id);
    }
    this.inflight.add(id);
    try {
      switch (row.state) {
        case 'quoted':
          if (row.expires_at && now() > row.expires_at) this.expire(row);
          break;
        case 'receiving':
          await this.resumeReceive(row);
          break;
        case 'melting':
          await this.melt(row);
          break;
        case 'minting':
          await this.recoverMint(row);
          break;
        case 'pending':
          await this.checkQuote(row);
          break;
      }
      await this.deliverPayouts(id);
    } catch (e) {
      const r = this.get(id)!;
      const err = errText(e);
      // The mint is rate limiting this gateway: pause every quote check, not just this one.
      if (/\b429\b|too many requests/i.test(err)) this.mintCooldownUntil = now() + 60_000;
      log.warn('fund_step_failed', { id, state: r.state, err });
      this.set(id, { error: err, next_check: Math.max(now() + 15_000, this.mintCooldownUntil) });
    } finally {
      this.inflight.delete(id);
    }
    return this.get(id);
  }

  /** Background poller: advances every unfinished funding that is due. */
  async tick(): Promise<void> {
    const marks = OPEN_FUNDING_STATES.map(() => '?').join(',');
    const due = this.db.prepare(`SELECT id FROM fundings WHERE state IN (${marks}) AND next_check <= ? ORDER BY next_check LIMIT 50`).all(...OPEN_FUNDING_STATES, now()) as Array<{
      id: string;
    }>;
    for (const { id } of due) await this.advance(id);
  }

  start(intervalMs = 3000) {
    if (this.timer) return;
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      this.tick()
        .catch((e) => log.warn('fund_tick_failed', { err: errText(e) }))
        .finally(() => (running = false));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private expire(row: FundingRow) {
    this.set(row.id, { state: 'expired' });
    const released = releaseIfEmpty(this.db, row.account_id);
    log.info('fund_expired', { id: row.id, method: row.method, released_account: released });
  }

  private nextPendingCheck(row: FundingRow): number {
    // A credited address stays watched for later deposits, at a slower pace.
    if (row.method === 'onchain') return now() + (row.credited > 0 ? 300_000 : 60_000);
    const age = now() - row.created_at;
    // Quick while someone is likely watching the invoice, then rarely: every check costs the
    // gateway's shared per-IP allowance at the mint.
    return now() + (age < 120_000 ? 5000 : age < 600_000 ? 15_000 : age < 3_600_000 ? 60_000 : 300_000);
  }

  /** Mint quote checks share the gateway's single IP at the mint (Nutshell allows 20/min per IP). */
  private quoteChecks: number[] = [];
  private mintCooldownUntil = 0;

  /** The shared quote-check budget and the 429 pause, for the admin API. Read-only. */
  quoteCheckStatus(): { used: number; budget: number; cooldown_until: number | null; available: boolean } {
    const t = now();
    const used = this.quoteChecks.filter((x) => t - x < 60_000).length;
    const budget = this.env.BELLOWS_MINT_QUOTE_CHECKS_PER_MIN;
    const cooling = t < this.mintCooldownUntil;
    return { used, budget, cooldown_until: cooling ? this.mintCooldownUntil : null, available: !cooling && used < budget };
  }

  /** Whether a quote check may go to the mint now; records it when it may. */
  private takeQuoteCheck(): boolean {
    const t = now();
    if (t < this.mintCooldownUntil) return false;
    this.quoteChecks = this.quoteChecks.filter((x) => t - x < 60_000);
    if (this.quoteChecks.length >= this.env.BELLOWS_MINT_QUOTE_CHECKS_PER_MIN) return false;
    this.quoteChecks.push(t);
    return true;
  }

  /** pending: ask the funding mint whether the quote is paid; mint when it is. */
  private async checkQuote(row: FundingRow): Promise<void> {
    if (!this.takeQuoteCheck()) {
      this.set(row.id, { next_check: Math.max(now() + 5000, this.mintCooldownUntil) });
      return;
    }
    const w = await this.fundWallet(row.unit);
    if (row.method === 'onchain') {
      const q = await w.checkMintQuoteOnchain(row.quote!);
      const paid = num(q.amount_paid);
      const issued = num(q.amount_issued);
      const obs: Observed = { state: (q as any).state, amount_paid: paid, amount_issued: issued, ...(await this.esplora(row.request!)) };
      this.set(row.id, { observed: JSON.stringify(obs), next_check: this.nextPendingCheck(row), error: null });
      if (paid > issued) return this.mintNow(this.get(row.id)!, paid - issued, q);
      if (now() > (row.expires_at ?? Infinity)) {
        if (row.credited > 0) this.set(row.id, { state: 'done' });
        else this.expire(row);
      }
      return;
    }
    const q = await w.checkMintQuoteBolt11(row.quote!);
    this.set(row.id, { observed: JSON.stringify({ state: q.state }), next_check: this.nextPendingCheck(row), error: null });
    if (q.state === 'PAID') return this.mintNow(this.get(row.id)!, row.amount!, q);
    if (q.state === 'ISSUED') {
      // Issued but no mint operation of ours is recorded: not something this gateway did.
      this.set(row.id, { state: 'failed', error: 'quote was issued without this gateway' });
      log.error('fund_issued_elsewhere', { id: row.id });
      return;
    }
    // Unpaid. A foreign funding whose melt went through keeps waiting for the invoice to settle.
    if (row.method === 'lightning' && row.expires_at && now() > row.expires_at + 60_000) this.expire(row);
  }

  /** Prepares deterministic outputs, persists them (state minting), then mints. */
  private async mintNow(row: FundingRow, amount: number, quote: any): Promise<void> {
    const w = await this.fundWallet(row.unit);
    let counters: OperationCounters | null = null;
    const priv = row.lock_key ?? undefined;
    const method = row.method === 'onchain' ? 'onchain' : 'bolt11';
    const preview = await w.prepareMint(method, amount, quote, { privkey: priv, onCountersReserved: (c) => (counters = c) }, { type: 'deterministic', counter: 0 });
    const op: MintOp = {
      amount,
      keysetId: preview.keysetId,
      outputs: preview.outputData.map((o) => OutputData.serialize(o)),
      counters,
      signature: (preview.payload as any).signature,
      legacySignature: preview.legacySignature,
    };
    const claimed = Number(
      this.db
        .prepare("UPDATE fundings SET state = 'minting', mint_op = ?, error = NULL, updated_at = ? WHERE id = ? AND state = 'pending'")
        .run(JSON.stringify(op), now(), row.id).changes,
    );
    if (claimed !== 1) return;
    await this.completeMint(this.get(row.id)!, op);
  }

  private previewOf(row: FundingRow, op: MintOp): MintPreview<{ quote: string }> {
    const outputData = op.outputs.map((o) => OutputData.deserialize(o));
    return {
      method: row.method === 'onchain' ? 'onchain' : 'bolt11',
      payload: { quote: row.quote!, outputs: outputData.map((o) => o.blindedMessage), ...(op.signature ? { signature: op.signature } : {}) } as any,
      outputData,
      keysetId: op.keysetId,
      quote: { quote: row.quote! },
      legacySignature: op.legacySignature,
    };
  }

  private async completeMint(row: FundingRow, op: MintOp): Promise<void> {
    const w = await this.fundWallet(row.unit);
    let proofs: Proof[];
    try {
      proofs = await w.completeMint(this.previewOf(row, op));
    } catch (e) {
      // A refusal: find out what the mint did with our outputs. A network error: outcome unknown, retry later.
      if (isRejection(e)) return this.recoverMint(this.get(row.id)!);
      this.set(row.id, { next_check: now() + 5000, error: errText(e) });
      return;
    }
    if (this.faults.afterMint) throw new Error('fault injected after mint');
    this.finalizeMint(row.id, op, proofs);
  }

  /** One transaction: proofs stored, balance credited, funding moved on. Exactly once per mint op. */
  private finalizeMint(id: string, op: MintOp, proofs: Proof[]) {
    const total = proofs.reduce((s, p) => s + num(p.amount), 0);
    const credited = tx(this.db, () => {
      const r = this.get(id)!;
      if (r.state !== 'minting' || r.mint_op !== JSON.stringify(op)) return 0;
      this.wallet.insertProofs(proofs, r.mint, r.unit);
      this.ledger.creditRaw(r.account_id, total * MSUB_PER_UNIT, 'topup', r.id);
      const next = r.method === 'onchain' ? 'pending' : 'done';
      this.db
        .prepare('UPDATE fundings SET state = ?, credited = credited + ?, mint_op = NULL, error = NULL, next_check = ?, updated_at = ? WHERE id = ?')
        .run(next, total, now() + (r.method === 'onchain' ? 60_000 : 0), now(), id);
      return total;
    });
    if (credited) log.info('fund_credited', { id, amount: credited });
  }

  /** minting after a restart or an error: replay (NUT-19), else restore (NUT-09), else mint again if still paid. */
  private async recoverMint(row: FundingRow): Promise<void> {
    const op: MintOp = JSON.parse(row.mint_op!);
    const w = await this.fundWallet(row.unit);
    if (!this.faults.noReplay) {
      try {
        const proofs = await w.completeMint(this.previewOf(row, op));
        this.finalizeMint(row.id, op, proofs);
        log.info('fund_recovered', { id: row.id, via: 'replay' });
        return;
      } catch (e) {
        if (!isRejection(e)) throw e;
      }
    }
    if (op.counters && op.counters.count > 0) {
      const { proofs } = await w.restore(op.counters.start, op.counters.count, { keysetId: op.counters.keysetId });
      if (proofs.length) {
        this.finalizeMint(row.id, op, proofs);
        log.info('fund_recovered', { id: row.id, via: 'restore' });
        return;
      }
    }
    // Nothing was signed for our outputs. If the quote can still be minted, do it with the same outputs.
    const q: any = row.method === 'onchain' ? await w.checkMintQuoteOnchain(row.quote!) : await w.checkMintQuoteBolt11(row.quote!);
    const mintable = row.method === 'onchain' ? num(q.amount_paid) - num(q.amount_issued) >= op.amount : q.state === 'PAID';
    if (mintable) {
      const proofs = await w.completeMint(this.previewOf(row, op));
      this.finalizeMint(row.id, op, proofs);
      log.info('fund_recovered', { id: row.id, via: 'retry' });
      return;
    }
    this.set(row.id, { state: 'failed', error: 'quote issued but our outputs were not signed' });
    log.error('fund_mint_lost', { id: row.id });
  }

  // ------------------------------------------------------------------ foreign

  private async resumeReceive(row: FundingRow): Promise<void> {
    const status = () => (this.db.prepare("SELECT status FROM incoming WHERE request_id = ? AND purpose = 'foreign'").get(row.id) as { status: string } | undefined)?.status;
    let st = status();
    if (st === 'prepared') {
      // The swap's outcome is unknown: replay or restore it now (startup recovery does the same).
      await this.wallet.recoverIncomingFor(row.id);
      st = status();
      if (st === 'prepared') {
        this.set(row.id, { next_check: now() + 10_000 });
        return;
      }
    }
    if (!st || st === 'new') {
      // Nothing reached the token's mint; the client still holds a valid token.
      this.set(row.id, { state: 'quoted' });
      return;
    }
    if (st === 'rejected') {
      this.set(row.id, { state: 'failed', error: 'the token was spent elsewhere' });
      releaseIfEmpty(this.db, row.account_id);
      return;
    }
    this.set(row.id, { state: 'melting', next_check: now() });
    await this.melt(this.get(row.id)!);
  }

  /** Gives the held foreign proofs back to the user as a token from their mint. */
  private refund(row: FundingRow, reason: string) {
    const proofs = this.wallet.heldProofs(row.id);
    const lock = row.f_lock_pubkey && proofs.length ? row.f_lock_pubkey : null;
    const token = proofs.length && !lock ? getEncodedToken({ mint: row.f_mint!, unit: row.f_unit!, proofs }) : null;
    tx(this.db, () => {
      // Locked: the held proofs move to a payout that swaps them into outputs only the key can spend.
      if (lock) this.wallet.owePinned({ mint: row.f_mint!, unit: row.f_unit!, purpose: 'refund', requestId: row.id, lockPubkey: lock, fromOpId: row.id });
      this.db.prepare("UPDATE proofs SET state = 'spent' WHERE op_id = ? AND state = 'reserved'").run(row.id);
      this.db
        .prepare("UPDATE fundings SET state = 'refunded', f_refund_token = ?, f_melt_op = NULL, error = ?, updated_at = ? WHERE id = ?")
        .run(token, reason, now(), row.id);
    });
    releaseIfEmpty(this.db, row.account_id);
    log.warn('fund_refunded', { id: row.id, reason });
  }

  private async melt(row: FundingRow): Promise<void> {
    const fw = await this.wallet.wallet(row.f_mint!, row.f_unit!);
    if (row.f_melt_op) return this.recoverMelt(row, fw);
    const proofs = this.wallet.heldProofs(row.id);
    if (!proofs.length) {
      this.set(row.id, { state: 'failed', error: 'no eCash held for this funding' });
      return;
    }
    const held = proofs.reduce((s, p) => s + num(p.amount), 0);
    const inputFee = num(fw.getFeesForProofs(proofs));
    let mq = await fw.checkMeltQuoteBolt11(row.f_melt_quote!);
    if (mq.state !== 'UNPAID') {
      this.set(row.id, { next_check: now() + 10_000 });
      return;
    }
    if (mq.expiry && mq.expiry * 1000 < now() + 30_000) {
      try {
        mq = await fw.createMeltQuoteBolt11(row.request!);
      } catch (e) {
        if (isRejection(e)) return this.refund(row, `could not get a new melt quote: ${errText(e)}`);
        throw e;
      }
      this.set(row.id, { f_melt_quote: mq.quote });
    }
    if (num(mq.amount) + num(mq.fee_reserve) + inputFee > held) return this.refund(row, 'Lightning fees rose above what the token covers');
    let counters: OperationCounters | null = null;
    const preview = await fw.prepareMelt('bolt11', mq, proofs, { onCountersReserved: (c) => (counters = c) }, { type: 'deterministic', counter: 0 });
    const op: MeltOp = {
      quote: mq.quote,
      amount: num(mq.amount),
      feeReserve: num(mq.fee_reserve),
      keysetId: preview.keysetId,
      outputs: preview.outputData.map((o) => OutputData.serialize(o)),
      counters,
    };
    this.set(row.id, { f_melt_op: JSON.stringify(op), f_attempts: row.f_attempts + 1 });
    let res;
    try {
      res = await fw.completeMelt(preview);
    } catch (e) {
      if (isRejection(e)) {
        // The mint refused before paying: inputs are not spent (checked in recoverMelt).
        this.set(row.id, { next_check: now(), error: errText(e) });
        return this.recoverMelt(this.get(row.id)!, fw);
      }
      this.set(row.id, { next_check: now() + 5000, error: errText(e) });
      return;
    }
    if (this.faults.afterMelt) throw new Error('fault injected after melt');
    if (res.quote.state === 'PAID') return this.meltPaid(this.get(row.id)!, res.change);
    this.set(row.id, { next_check: now() + 5000 });
  }

  private async recoverMelt(row: FundingRow, fw: Wallet): Promise<void> {
    const op: MeltOp = JSON.parse(row.f_melt_op!);
    const q = await fw.checkMeltQuoteBolt11(op.quote);
    if (q.state === 'PAID') {
      const outputs = op.outputs.map((o) => OutputData.deserialize(o));
      let change: Proof[] = [];
      const sigs = ((q as any).change ?? []).filter((s: any) => num(s.amount) > 0);
      if (sigs.length) {
        await fw.ensureOperableKeysets(sigs.map((s: any) => s.id));
        change = fw.createMeltChangeProofs(outputs, sigs);
      } else if (op.counters && op.counters.count > 0) {
        change = (await fw.restore(op.counters.start, op.counters.count, { keysetId: op.counters.keysetId })).proofs;
      }
      return this.meltPaid(row, change);
    }
    if (q.state === 'PENDING') {
      this.set(row.id, { next_check: now() + 10_000 });
      return;
    }
    // UNPAID: the payment failed or never started. Retry once if our inputs are still unspent, else refund what is left.
    const held = this.wallet.heldProofs(row.id);
    const states = held.length ? await fw.checkProofsStates(held) : [];
    const unspent = states.length > 0 && states.every((s) => s.state === 'UNSPENT');
    if (unspent && row.f_attempts < 2) {
      this.set(row.id, { f_melt_op: null, next_check: now() });
      return this.melt(this.get(row.id)!);
    }
    if (unspent) return this.refund(row, 'the token mint could not pay the Lightning invoice');
    this.set(row.id, { state: 'failed', error: 'melt inputs spent but the melt is unpaid' });
    log.error('fund_melt_inconsistent', { id: row.id });
  }

  /** Melt paid: hand the unused fee reserve back as eCash from the token's mint, then wait for the funding mint's quote. */
  private meltPaid(row: FundingRow, change: Proof[]) {
    const lock = row.f_lock_pubkey && change.length ? row.f_lock_pubkey : null;
    const token = change.length && !lock ? getEncodedToken({ mint: row.f_mint!, unit: row.f_unit!, proofs: change }) : null;
    tx(this.db, () => {
      const r = this.get(row.id)!;
      if (r.state !== 'melting') return;
      this.db.prepare("UPDATE proofs SET state = 'spent' WHERE op_id = ? AND state = 'reserved'").run(row.id);
      if (lock) this.wallet.owePinned({ mint: row.f_mint!, unit: row.f_unit!, purpose: 'change', requestId: row.id, lockPubkey: lock, proofs: change });
      // The funding mint's invoice is paid; it no longer expires from our side.
      this.db
        .prepare("UPDATE fundings SET state = 'pending', f_change_token = ?, f_melt_op = NULL, expires_at = NULL, error = NULL, next_check = ?, updated_at = ? WHERE id = ?")
        .run(token, now(), now(), row.id);
    });
    log.info('fund_melted', { id: row.id, change: change.reduce((s, p) => s + num(p.amount), 0) });
  }

  /** Locked change or refund tokens of a funding that are not issued yet. */
  private undeliveredPayouts(id: string) {
    return this.wallet.listOutgoing({ requestId: id }).filter((o) => o.pinned && o.status !== 'done' && o.status !== 'failed');
  }

  /**
   * Issues the locked change/refund tokens of a funding (a swap at the token's mint) and copies each
   * token onto the funding. Safe to repeat: wallet.issue() returns a stored token, recovers an
   * interrupted swap, and never pays a payout twice.
   */
  private async deliverPayouts(id: string): Promise<void> {
    for (const o of this.wallet.listOutgoing({ requestId: id }).filter((x) => x.pinned)) {
      if (o.status === 'failed') continue;
      let token = o.token;
      if (o.status !== 'done') {
        try {
          token = await this.wallet.issue(o.id);
        } catch (e) {
          log.warn('fund_payout_deferred', { id, out: o.id, err: errText(e) });
          continue;
        }
      }
      const cur = this.get(id)!;
      if (o.purpose === 'refund' && cur.f_refund_token !== token) this.set(id, { f_refund_token: token });
      if (o.purpose === 'change' && cur.f_change_token !== token) this.set(id, { f_change_token: token });
    }
  }

  // ------------------------------------------------------------------ esplora (optional)

  private async esplora(address: string): Promise<Pick<Observed, 'seen_sat' | 'confirmed_sat' | 'confirmations'>> {
    const base = this.env.BELLOWS_ESPLORA_URL?.replace(/\/+$/, '');
    if (!base) return {};
    try {
      const [txsRes, tipRes] = await Promise.all([
        fetch(`${base}/address/${encodeURIComponent(address)}/txs`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(8000) }),
      ]);
      if (!txsRes.ok || !tipRes.ok) return {};
      const txs = (await txsRes.json()) as any[];
      const tip = Number(await tipRes.text());
      let seen = 0;
      let confirmed = 0;
      let minConf: number | null = null;
      for (const t of txs) {
        const v = (t.vout ?? []).filter((o: any) => o.scriptpubkey_address === address).reduce((s: number, o: any) => s + Number(o.value ?? 0), 0);
        if (!v) continue;
        seen += v;
        if (t.status?.confirmed) {
          confirmed += v;
          const c = tip - Number(t.status.block_height) + 1;
          minConf = minConf === null ? c : Math.min(minConf, c);
        } else minConf = 0;
      }
      return { seen_sat: seen, confirmed_sat: confirmed, confirmations: minConf };
    } catch {
      return {};
    }
  }
}
