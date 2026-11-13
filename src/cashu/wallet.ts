import { randomUUID } from 'node:crypto';
import {
  Amount,
  type CounterSource,
  deserializeProofs,
  deserializeSwapPreview,
  getEncodedToken,
  getTokenMetadata,
  MintOperationError,
  type OperationCounters,
  type OutputDataLike,
  type OutputType,
  type Proof,
  serializeProofs,
  serializeSwapPreview,
  type SwapPreview,
  Wallet,
} from '@cashu/cashu-ts';
import { normalizeMintUrl, type Unit } from '../config.ts';
import { COUNTER_SCAN_DEFAULTS, type ScanLimits, scanCounters } from './counter-scan.ts';
import { type DB, now, tx } from '../db.ts';
import { sha256 } from '../ledger.ts';
import { errText, log } from '../log.ts';

/** NUT error codes we treat as definitive rejections of the inputs. */
const SPENT = 11001;
/** The mint has signed these outputs before: our NUT-13 counter is behind what the mint has seen. */
const OUTPUTS_ALREADY_SIGNED = 11003;

export class PaymentError extends Error {
  readonly code: string;
  readonly status: number;
  /** Extra top-level fields for the error response (e.g. the unlisted mint and its cap). */
  readonly extra?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    if (extra) this.extra = extra;
  }
}

export interface InspectedToken {
  mint: string;
  unit: Unit;
  amount: number;
  hash: string;
  proofs: Proof[];
}

export interface ReceiveOptions {
  purpose: 'topup' | 'nut24' | 'foreign';
  /** Accept a token from a mint outside BELLOWS_TRUSTED_MINTS (the caller applies its own policy). */
  foreign?: boolean;
  expectUnit?: Unit;
  minAmount?: number;
  accountId?: string;
  requestId?: string;
  /** Runs inside the same SQLite transaction that stores the received proofs. */
  onFinalize?: (amount: number) => void;
}

export interface ReceiveResult {
  incomingId: string;
  mint: string;
  unit: Unit;
  amount: number;
  /** true when the same token was already redeemed for the same purpose/account (idempotent replay). */
  replay: boolean;
}

interface IncomingRow {
  id: string;
  token_hash: string;
  mint: string;
  unit: Unit;
  amount: number;
  purpose: 'topup' | 'nut24' | 'foreign';
  account_id: string | null;
  request_id: string | null;
  status: 'new' | 'prepared' | 'done' | 'rejected';
  preview: string | null;
  counters: string | null;
  error: string | null;
}

interface OutgoingRow {
  id: string;
  mint: string;
  unit: Unit;
  amount: number;
  purpose: 'change' | 'refund' | 'export';
  account_id: string | null;
  request_id: string | null;
  status: 'owed' | 'reserved' | 'prepared' | 'done' | 'failed';
  inputs: string | null;
  preview: string | null;
  counters: string | null;
  token: string | null;
  error: string | null;
  /** NUT-11: the send outputs are P2PK-locked to this compressed key (random secrets, not NUT-13). */
  lock_pubkey: string | null;
  /** 1: pays out exactly the proofs reserved under op_id = id (other-mint change and refunds). */
  pinned: number;
}

export interface WalletOptions {
  trustedMints: string[];
  units: Unit[];
  maxTokenBytes: number;
  /** NUT-13 seed: derived from the wallet secret (src/wallet-seed.ts), never generated here or stored. */
  seed: Uint8Array;
  /** Test-only fault injection: throw after the mint swap, before the DB write. */
  faults?: { afterReceiveSwap?: boolean; afterSendSwap?: boolean; noReplayOnRecovery?: boolean; noRestoreOnRecovery?: boolean };
  /** Counter scans (src/cashu/counter-scan.ts). Tests shorten them. */
  counterScan?: Partial<{ batchSize: number; gap: number; maxBatches: number; timeoutMs: number; retryBaseMs: number; retryMaxMs: number }>;
}

/** Totals of one counter recovery at boot (no per-proof detail). */
export interface CounterRecovery {
  /** Mints whose every keyset was scanned to the gap. */
  scanned: string[];
  /** Mints left closed until a retry completes their scan. */
  pending: string[];
  batches: number;
  ms: number;
  /** Unspent eCash recovered, per unit, in whole units, and how many proofs. */
  recovered: Record<string, { proofs: number; amount: number }>;
}

class SqliteCounterSource implements CounterSource {
  private readonly db: DB;
  private readonly mint: string;
  /** Resolves once no counter scan is running on the keyset, so no counter is handed out under a scan. */
  private readonly idle: (keysetId: string) => Promise<void>;
  constructor(db: DB, mint: string, idle: (keysetId: string) => Promise<void> = async () => {}) {
    this.db = db;
    this.mint = mint;
    this.idle = idle;
  }
  private cur(keysetId: string): number {
    const r = this.db.prepare('SELECT next FROM counters WHERE mint = ? AND keyset_id = ?').get(this.mint, keysetId) as { next: number } | undefined;
    return r?.next ?? 0;
  }
  private set(keysetId: string, next: number) {
    this.db
      .prepare('INSERT INTO counters (mint, keyset_id, next) VALUES (?, ?, ?) ON CONFLICT (mint, keyset_id) DO UPDATE SET next = excluded.next')
      .run(this.mint, keysetId, next);
  }
  async reserve(keysetId: string, n: number) {
    await this.idle(keysetId);
    // Synchronous read-modify-write: no await between them, so no interleaving in this process.
    const start = this.cur(keysetId);
    if (n > 0) this.set(keysetId, start + n);
    return { start, count: n };
  }
  async advanceToAtLeast(keysetId: string, minNext: number) {
    if (this.cur(keysetId) < minNext) this.set(keysetId, minNext);
  }
  async snapshot() {
    const rows = this.db.prepare('SELECT keyset_id, next FROM counters WHERE mint = ?').all(this.mint) as Array<{ keyset_id: string; next: number }>;
    return Object.fromEntries(rows.map((r) => [r.keyset_id, r.next]));
  }
}

function isDefinitiveSpent(e: unknown): boolean {
  return e instanceof MintOperationError && e.code === SPENT;
}

function isOutputsAlreadySigned(e: unknown): boolean {
  return e instanceof MintOperationError && (e.code === OUTPUTS_ALREADY_SIGNED || /outputs (have )?already (been )?signed/i.test(e.message));
}

function isMintRejection(e: unknown): boolean {
  // A 4xx-class protocol error from the mint (bad proofs, unknown keyset, ...). Network errors are not.
  return e instanceof MintOperationError;
}

function proofAmount(p: { amount: unknown }): number {
  const a = p.amount as any;
  return typeof a === 'number' ? a : typeof a?.toNumber === 'function' ? a.toNumber() : Number(a);
}

function sumProofs(proofs: Array<{ amount: unknown }>): number {
  return proofs.reduce((s, p) => s + proofAmount(p), 0);
}

function outputSecret(o: { secret: Uint8Array }): string {
  return new TextDecoder().decode(o.secret);
}

export class GatewayWallet {
  private readonly db: DB;
  private readonly opts: WalletOptions;
  private readonly seed: Uint8Array;
  private readonly wallets = new Map<string, Promise<Wallet>>();
  private readonly inflight = new Set<string>();
  /** Mints closed until their counter scan completes (mint to reason). */
  private readonly closed = new Map<string, string>();
  /** Running counter scans, by mint|keyset. Counter reservations on that keyset wait for them. */
  private readonly scans = new Map<string, Promise<unknown>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Mints recoverCounters was given (the trusted mints and the funding mint). */
  private readonly scannedMints = new Set<string>();

  constructor(db: DB, opts: WalletOptions) {
    this.db = db;
    this.opts = { ...opts, trustedMints: opts.trustedMints.map(normalizeMintUrl) };
    this.seed = opts.seed;
  }

  isTrusted(mint: string): boolean {
    return this.opts.trustedMints.includes(normalizeMintUrl(mint));
  }

  get trustedMints(): string[] {
    return this.opts.trustedMints;
  }

  /**
   * The cashu-ts wallet for a mint and unit. Refused (503) while the mint is closed: its counters are not yet
   * known to be past what the mint has signed (recoverCounters).
   */
  async wallet(mint: string, unit: Unit): Promise<Wallet> {
    const m = normalizeMintUrl(mint);
    const why = this.closed.get(m);
    if (why !== undefined) throw new PaymentError('mint_unavailable', `this mint is not open yet: ${why}. Retry shortly`, 503);
    return this.openWallet(m, unit);
  }

  private async openWallet(mint: string, unit: Unit): Promise<Wallet> {
    const m = normalizeMintUrl(mint);
    const key = `${m}|${unit}`;
    let p = this.wallets.get(key);
    if (!p) {
      p = (async () => {
        const idle = async (keysetId: string) => {
          // A scan may start while this one is awaited; wait until none runs.
          for (let s = this.scans.get(`${m}|${keysetId}`); s; s = this.scans.get(`${m}|${keysetId}`)) await s.catch(() => {});
        };
        const w = new Wallet(m, { unit, bip39seed: this.seed, counterSource: new SqliteCounterSource(this.db, m, idle) });
        await w.loadMint();
        return w;
      })();
      p.catch(() => this.wallets.delete(key));
      this.wallets.set(key, p);
    }
    return p;
  }

  /**
   * Decodes and validates a token without contacting the mint beyond loading its keysets.
   * With opts.foreign the trusted-mint check is skipped: the caller must vet the mint URL first.
   */
  async inspect(token: string, expectUnit?: Unit, opts: { foreign?: boolean } = {}): Promise<InspectedToken> {
    if (typeof token !== 'string' || !token.startsWith('cashuB')) throw new PaymentError('invalid_token', 'expected a cashuB token');
    if (token.length > this.opts.maxTokenBytes) throw new PaymentError('invalid_token', 'token too large');
    let meta: { mint: string; unit: string };
    try {
      meta = getTokenMetadata(token);
    } catch {
      throw new PaymentError('invalid_token', 'could not decode token');
    }
    const mint = normalizeMintUrl(meta.mint);
    if (!opts.foreign && !this.isTrusted(mint)) throw new PaymentError('untrusted_mint', `mint not accepted: ${mint}. Accepted: ${this.trustedMints.join(', ')}`);
    const unit = (meta.unit ?? 'sat') as Unit;
    if (opts.foreign ? unit !== 'sat' && unit !== 'usd' : !this.opts.units.includes(unit)) throw new PaymentError('wrong_unit', `unit not accepted: ${unit}`);
    if (expectUnit && unit !== expectUnit) throw new PaymentError('wrong_unit', `expected unit ${expectUnit}, got ${unit}`);
    let w: Wallet;
    try {
      w = await this.wallet(mint, unit);
    } catch (e) {
      throw new PaymentError('mint_unavailable', `could not reach mint: ${errText(e)}`, 503);
    }
    let proofs: Proof[];
    try {
      proofs = w.decodeToken(token).proofs;
    } catch {
      throw new PaymentError('invalid_token', 'token keysets do not match the mint/unit');
    }
    if (!proofs.length) throw new PaymentError('invalid_token', 'empty token');
    for (const p of proofs) {
      try {
        const ks = w.getKeyset(p.id);
        if (ks.unit !== unit) throw new Error('unit');
      } catch {
        throw new PaymentError('wrong_unit', 'token proofs are not from this mint/unit keyset');
      }
    }
    const hash = sha256(
      proofs
        .map((p) => p.secret)
        .sort()
        .join('|'),
    );
    const fees = w.getFeesForProofs(proofs).toNumber();
    return { mint, unit, amount: sumProofs(proofs) - fees, hash, proofs };
  }

  /**
   * Swaps a token into the gateway wallet. Crash safety, step by step:
   *  1. INSERT incoming(status=new) keyed by token hash (UNIQUE). A second submission of the same proofs
   *     finds the row and never reaches the mint twice.
   *  2. Prepare the swap with deterministic (NUT-13) outputs; the counter range is persisted by the
   *     counter source before any request, then the serialized preview is stored (status=prepared).
   *  3. Swap at the mint.
   *  4. One transaction: store new proofs, status=done, run onFinalize (ledger credit).
   * A crash between 3 and 4 leaves status=prepared; recover() replays the identical swap (NUT-19) or
   * restores the signatures from the counter range (NUT-09), then finalizes exactly once.
   */
  async receive(token: string, o: ReceiveOptions): Promise<ReceiveResult> {
    const t = await this.inspect(token, o.expectUnit, { foreign: o.foreign });
    if (o.minAmount !== undefined && t.amount < o.minAmount) {
      throw new PaymentError('insufficient_amount', `token is worth ${t.amount} ${t.unit} after fees, need ${o.minAmount}`);
    }
    if (this.inflight.has(t.hash)) throw new PaymentError('token_in_flight', 'this token is already being processed', 409);
    this.inflight.add(t.hash);
    try {
      let row = this.db.prepare('SELECT * FROM incoming WHERE token_hash = ?').get(t.hash) as IncomingRow | undefined;
      if (row) {
        if (row.status === 'prepared') {
          await this.recoverIncoming(row);
          row = this.db.prepare('SELECT * FROM incoming WHERE id = ?').get(row.id) as unknown as IncomingRow;
        }
        if (row.status === 'done') {
          const same =
            row.purpose === o.purpose &&
            ((row.purpose === 'topup' && row.account_id === (o.accountId ?? null)) || (row.purpose === 'foreign' && row.request_id === (o.requestId ?? null)));
          if (same) return { incomingId: row.id, mint: row.mint, unit: row.unit, amount: row.amount, replay: true };
          throw new PaymentError('token_spent', 'token was already redeemed');
        }
        if (row.status === 'rejected') throw new PaymentError('token_spent', `token rejected by mint: ${row.error ?? 'spent'}`);
        // status=new: nothing reached the mint; reuse the row with this caller's context.
        this.db
          .prepare('UPDATE incoming SET purpose = ?, account_id = ?, request_id = ?, updated_at = ? WHERE id = ?')
          .run(o.purpose, o.accountId ?? null, o.requestId ?? null, now(), row.id);
      } else {
        const id = 'in_' + randomUUID();
        this.db
          .prepare(
            "INSERT INTO incoming (id, token_hash, mint, unit, amount, purpose, account_id, request_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)",
          )
          .run(id, t.hash, t.mint, t.unit, t.amount, o.purpose, o.accountId ?? null, o.requestId ?? null, now(), now());
        row = this.db.prepare('SELECT * FROM incoming WHERE id = ?').get(id) as unknown as IncomingRow;
      }

      const w = await this.wallet(t.mint, t.unit);
      let proofs: Proof[];
      for (let attempt = 0; ; attempt++) {
        let counters: OperationCounters | undefined;
        let preview: SwapPreview;
        try {
          preview = await w.prepareSwapToReceive(t.proofs, { onCountersReserved: (c) => (counters = c) }, { type: 'deterministic', counter: 0 });
        } catch (e) {
          throw new PaymentError('invalid_token', `could not prepare swap: ${errText(e)}`);
        }
        this.db
          .prepare("UPDATE incoming SET status = 'prepared', preview = ?, counters = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(serializeSwapPreview(preview)), JSON.stringify(counters ?? null), now(), row.id);
        try {
          proofs = (await w.completeSwap(preview)).keep;
          break;
        } catch (e) {
          if (attempt === 0 && counters && isOutputsAlreadySigned(e)) {
            // The mint refused the whole swap, so the token is unspent and nothing was signed for it. Catch
            // the counter up with what the mint has signed, then try once more with new outputs.
            await this.skipSignedCounters(w, t.mint, t.unit, counters);
            this.db.prepare("UPDATE incoming SET status = 'new', preview = NULL, counters = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
            continue;
          }
          throw this.receiveFailure(row.id, e);
        }
      }
      if (this.opts.faults?.afterReceiveSwap) throw new Error('fault injected after receive swap');
      this.finalizeIncoming(row.id, proofs, o.onFinalize);
      return { incomingId: row.id, mint: t.mint, unit: t.unit, amount: t.amount, replay: false };
    } finally {
      this.inflight.delete(t.hash);
    }
  }

  /** The error a refused or unanswered receive swap becomes. */
  private receiveFailure(id: string, e: unknown): PaymentError {
    if (isMintRejection(e)) {
      this.markRejected(id, errText(e));
      return new PaymentError(isDefinitiveSpent(e) ? 'token_spent' : 'invalid_token', `mint rejected token: ${errText(e)}`);
    }
    // Unknown outcome (network). Leave it prepared; recover() settles it.
    return new PaymentError('mint_unavailable', `mint did not answer; retry with the same token: ${errText(e)}`, 503);
  }

  private markRejected(id: string, error: string) {
    this.db.prepare("UPDATE incoming SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  }

  /** Stores proofs in the gateway wallet. Caller provides the transaction when combined with other writes. */
  insertProofs(proofs: Proof[], mint: string, unit: Unit, state: 'unspent' | 'reserved' | 'spent' = 'unspent', opId: string | null = null) {
    const stmt = this.db.prepare(
      'INSERT INTO proofs (secret, mint, unit, keyset_id, amount, proof, state, op_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (secret) DO NOTHING',
    );
    for (const p of proofs) stmt.run(p.secret, normalizeMintUrl(mint), unit, p.id, proofAmount(p), serializeProofs(p)[0]!, state, opId, now());
  }

  /** Proofs held for an operation (state reserved, op_id = opId). */
  heldProofs(opId: string): Proof[] {
    const rows = this.db.prepare("SELECT proof FROM proofs WHERE op_id = ? AND state = 'reserved'").all(opId) as Array<{ proof: string }>;
    return deserializeProofs(rows.map((r) => r.proof));
  }

  /** NUT-13 seed, for operations outside this class that need deterministic outputs. */
  get bip39seed(): Uint8Array {
    return this.seed;
  }

  private finalizeIncoming(id: string, proofs: Proof[], onFinalize?: (amount: number) => void) {
    tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM incoming WHERE id = ?').get(id) as unknown as IncomingRow;
      if (row.status === 'done') return;
      // Foreign-mint tokens are held for the funding that will melt them, never used for payouts.
      if (row.purpose === 'foreign') this.insertProofs(proofs, row.mint, row.unit, 'reserved', row.request_id);
      else this.insertProofs(proofs, row.mint, row.unit);
      this.db.prepare("UPDATE incoming SET status = 'done', updated_at = ? WHERE id = ?").run(now(), id);
      onFinalize?.(row.amount);
    });
  }

  /** Hook used by recover() to credit a topup/nut24 whose original request is gone. */
  onRecoveredIncoming?: (row: { purpose: string; account_id: string | null; request_id: string | null; amount: number; unit: Unit; mint: string }) => void;

  private async recoverIncoming(row: IncomingRow): Promise<void> {
    if (!row.preview) {
      this.markRejected(row.id, 'no preview');
      return;
    }
    const w = await this.wallet(row.mint, row.unit);
    const preview = deserializeSwapPreview(JSON.parse(row.preview));
    const finalize = (proofs: Proof[]) => this.finalizeIncoming(row.id, proofs, () => this.onRecoveredIncoming?.(row));
    // 1) Replay the identical swap. With NUT-19 caching the mint returns the same signatures.
    if (!this.opts.faults?.noReplayOnRecovery) {
      try {
        const res = await w.completeSwap(preview);
        finalize(res.keep);
        log.info('incoming_recovered', { id: row.id, via: 'replay' });
        return;
      } catch (e) {
        if (!isMintRejection(e)) throw e; // still offline: try later
      }
    }
    // 2) Outputs may already be signed: restore them from the persisted counter range (NUT-09).
    const c = row.counters ? (JSON.parse(row.counters) as OperationCounters | null) : null;
    if (c && c.count > 0) {
      const { proofs } = await w.restore(c.start, c.count, { keysetId: c.keysetId });
      if (proofs.length) {
        finalize(proofs);
        log.info('incoming_recovered', { id: row.id, via: 'restore' });
        return;
      }
    }
    // 3) No signatures for our outputs: the inputs were spent elsewhere (or never swapped).
    const states = await w.checkProofsStates(preview.inputs);
    if (states.every((s) => s.state === 'UNSPENT')) {
      const res = await w.completeSwap(preview);
      finalize(res.keep);
      log.info('incoming_recovered', { id: row.id, via: 'retry' });
      return;
    }
    this.markRejected(row.id, 'inputs spent elsewhere');
    log.warn('incoming_rejected_on_recovery', { id: row.id });
  }

  /** Settles an interrupted receive (status prepared) for a request id now, instead of at the next startup. */
  async recoverIncomingFor(requestId: string): Promise<void> {
    const row = this.db.prepare("SELECT * FROM incoming WHERE request_id = ? AND status = 'prepared'").get(requestId) as IncomingRow | undefined;
    if (!row || this.inflight.has(row.token_hash)) return;
    this.inflight.add(row.token_hash);
    try {
      await this.recoverIncoming(row);
    } finally {
      this.inflight.delete(row.token_hash);
    }
  }

  // ---------------------------------------------------------------- outgoing

  /** Records an amount owed to someone; caller provides the transaction. */
  oweRaw(p: {
    mint: string;
    unit: Unit;
    amount: number;
    purpose: OutgoingRow['purpose'];
    accountId?: string | null;
    requestId?: string | null;
    /** NUT-11: lock the token to this compressed key (from parseLockPubkey). */
    lockPubkey?: string | null;
    pinned?: boolean;
  }): string {
    const id = 'out_' + randomUUID();
    this.db
      .prepare(
        "INSERT INTO outgoing (id, mint, unit, amount, purpose, account_id, request_id, status, lock_pubkey, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'owed', ?, ?, ?, ?)",
      )
      .run(id, normalizeMintUrl(p.mint), p.unit, p.amount, p.purpose, p.accountId ?? null, p.requestId ?? null, p.lockPubkey ?? null, p.pinned ? 1 : 0, now(), now());
    return id;
  }

  /**
   * Owes exactly a given set of proofs, re-issued locked to lockPubkey (other-mint change and refunds,
   * which the gateway must not mix with its own eCash). Pass `proofs` not yet stored, or `fromOpId` to
   * take over the proofs another operation holds. The payout is the proofs' value less the lock swap's
   * input fee; issue() works it out. Caller provides the transaction.
   */
  owePinned(p: {
    mint: string;
    unit: Unit;
    purpose: OutgoingRow['purpose'];
    requestId: string;
    lockPubkey: string;
    proofs?: Proof[];
    fromOpId?: string;
  }): string {
    const id = this.oweRaw({ mint: p.mint, unit: p.unit, amount: 0, purpose: p.purpose, requestId: p.requestId, lockPubkey: p.lockPubkey, pinned: true });
    if (p.proofs?.length) this.insertProofs(p.proofs, p.mint, p.unit, 'reserved', id);
    if (p.fromOpId) this.db.prepare("UPDATE proofs SET op_id = ? WHERE op_id = ? AND state = 'reserved'").run(id, p.fromOpId);
    const amount = sumProofs(this.heldProofs(id));
    this.db.prepare('UPDATE outgoing SET amount = ? WHERE id = ?').run(amount, id);
    return id;
  }

  getOutgoing(id: string): OutgoingRow | undefined {
    return this.db.prepare('SELECT * FROM outgoing WHERE id = ?').get(id) as OutgoingRow | undefined;
  }

  listOutgoing(where: { requestId?: string; accountId?: string }): OutgoingRow[] {
    if (where.requestId) return this.db.prepare('SELECT * FROM outgoing WHERE request_id = ? ORDER BY created_at').all(where.requestId) as unknown as OutgoingRow[];
    return this.db.prepare('SELECT * FROM outgoing WHERE account_id = ? ORDER BY created_at').all(where.accountId ?? '') as unknown as OutgoingRow[];
  }

  /**
   * Turns an owed row into a token. Steps:
   *  1. Transaction: pick unspent proofs, mark them reserved for this row (status=reserved).
   *  2. Exact match: the token is those proofs (no mint call). Otherwise prepare a swap with
   *     deterministic outputs, persist preview + counters (status=prepared), swap.
   *  3. Transaction: inputs spent, keep proofs stored, token stored (status=done).
   * The stored token is returned on every later call, so a lost HTTP response can be re-fetched.
   */
  async issue(id: string): Promise<string> {
    let row = this.getOutgoing(id);
    if (!row) throw new Error('unknown outgoing');
    if (row.status === 'done') return row.token!;
    if (row.status === 'failed') throw new PaymentError('issue_failed', 'this payout failed');
    if (this.inflight.has(id)) throw new PaymentError('in_flight', 'payout in progress, retry shortly', 409);
    this.inflight.add(id);
    try {
      if (row.status === 'prepared' || row.status === 'reserved') {
        await this.recoverOutgoing(row);
        row = this.getOutgoing(id)!;
        if (row.status === 'done') return row.token!;
      }
      const w = await this.wallet(row.mint, row.unit);
      const lock = row.lock_pubkey;
      if (row.pinned) return await this.issuePinned(row, w);
      const amount = row.amount;
      const selected = tx(this.db, () => {
        const rows = this.db.prepare("SELECT proof FROM proofs WHERE mint = ? AND unit = ? AND state = 'unspent'").all(row!.mint, row!.unit) as Array<{
          proof: string;
        }>;
        const avail = deserializeProofs(rows.map((r) => r.proof));
        const pick = w.selectProofsToSend(avail, amount, true);
        if (!pick.send.length || sumProofs(pick.send) < amount) throw new PaymentError('wallet_insufficient', 'gateway wallet cannot cover this payout', 503);
        const mark = this.db.prepare("UPDATE proofs SET state = 'reserved', op_id = ? WHERE secret = ? AND state = 'unspent'");
        for (const p of pick.send) {
          if (Number(mark.run(id, p.secret).changes) !== 1) throw new Error('proof race');
        }
        this.db
          .prepare("UPDATE outgoing SET status = 'reserved', inputs = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(pick.send.map((p) => p.secret)), now(), id);
        return pick.send;
      });

      const fees = w.getFeesForProofs(selected).toNumber();
      // An exact match hands over our own (NUT-13) proofs; a locked payout always needs the swap.
      if (!lock && sumProofs(selected) - fees === amount) {
        const token = getEncodedToken({ mint: row.mint, unit: row.unit, proofs: selected });
        this.finalizeOutgoing(id, token, []);
        return token;
      }

      return await this.swapOut(row, w, amount, selected, true);
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * Swaps the reserved inputs into a payout. Send outputs are NUT-13 deterministic, or P2PK-locked
   * with random secrets when the row has a lock key; keep outputs are always deterministic. The whole
   * preview (secrets and blinding factors included) is stored before the mint sees the request, so
   * recovery can replay it (NUT-19) or restore its signatures (NUT-09).
   */
  private async swapOut(row: OutgoingRow, w: Wallet, amount: number, inputs: Proof[], includeFees: boolean): Promise<string> {
    const id = row.id;
    const send: OutputType = row.lock_pubkey ? { type: 'p2pk', options: { pubkey: row.lock_pubkey } } : { type: 'deterministic', counter: 0 };
    let res;
    for (let attempt = 0; ; attempt++) {
      let counters: OperationCounters | undefined;
      const preview = await w.prepareSwapToSend(
        amount,
        inputs,
        { includeFees, onCountersReserved: (c) => (counters = c) },
        { send, keep: { type: 'deterministic', counter: 0 } },
      );
      this.db
        .prepare("UPDATE outgoing SET status = 'prepared', preview = ?, counters = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(serializeSwapPreview(preview)), JSON.stringify(counters ?? null), now(), id);
      try {
        res = await w.completeSwap(preview);
        break;
      } catch (e) {
        if (attempt === 0 && counters && isOutputsAlreadySigned(e)) {
          // Refused as a whole: the inputs are unspent and still reserved for this row. Catch the counter
          // up, then try once more with new outputs.
          await this.skipSignedCounters(w, row.mint, row.unit, counters);
          continue;
        }
        throw this.swapOutFailure(id, e);
      }
    }
    if (this.opts.faults?.afterSendSwap) throw new Error('fault injected after send swap');
    const token = getEncodedToken({ mint: row.mint, unit: row.unit, proofs: res.send });
    this.finalizeOutgoing(id, token, res.keep);
    return token;
  }

  /** The error a refused or unanswered payout swap becomes. */
  private swapOutFailure(id: string, e: unknown): PaymentError {
    if (isDefinitiveSpent(e)) {
      // Our own proofs were spent elsewhere (should not happen). Burn them and re-owe.
      this.reowe(id, true);
      return new PaymentError('wallet_inconsistent', 'gateway proofs were already spent; retry', 503);
    }
    return new PaymentError('mint_unavailable', `mint did not answer; payout is saved and can be retried: ${errText(e)}`, 503);
  }

  /** A pinned payout: exactly the proofs held under op_id = row.id, less the swap's input fee. */
  private async issuePinned(row: OutgoingRow, w: Wallet): Promise<string> {
    const held = this.heldProofs(row.id);
    if (!held.length) {
      this.db.prepare("UPDATE outgoing SET status = 'failed', error = 'no proofs held for this payout', updated_at = ? WHERE id = ?").run(now(), row.id);
      throw new PaymentError('issue_failed', 'this payout failed');
    }
    const amount = sumProofs(held) - w.getFeesForProofs(held).toNumber();
    if (!row.lock_pubkey || amount < 1) {
      // Nothing to lock, or the lock swap's fee would take it all: hand the proofs over as they are.
      const token = getEncodedToken({ mint: row.mint, unit: row.unit, proofs: held });
      this.db.prepare('UPDATE outgoing SET amount = ? WHERE id = ?').run(sumProofs(held), row.id);
      this.finalizeOutgoing(row.id, token, []);
      if (row.lock_pubkey) log.warn('outgoing_lock_skipped', { id: row.id, reason: 'fee exceeds value' });
      return token;
    }
    this.db.prepare('UPDATE outgoing SET amount = ? WHERE id = ?').run(amount, row.id);
    return this.swapOut({ ...row, amount }, w, amount, held, false);
  }

  private finalizeOutgoing(id: string, token: string, keep: Proof[]) {
    tx(this.db, () => {
      const row = this.getOutgoing(id)!;
      if (row.status === 'done') return;
      this.db.prepare("UPDATE proofs SET state = 'spent' WHERE op_id = ? AND state = 'reserved'").run(id);
      this.insertProofs(keep, row.mint, row.unit);
      this.db.prepare("UPDATE outgoing SET status = 'done', token = ?, updated_at = ? WHERE id = ?").run(token, now(), id);
    });
  }

  private reowe(id: string, inputsSpent: boolean) {
    const row = this.getOutgoing(id);
    if (row?.pinned) {
      // Pinned proofs stay with this payout. If they are gone there is nothing left to pay from.
      tx(this.db, () => {
        if (inputsSpent) {
          this.db.prepare("UPDATE proofs SET state = 'spent' WHERE op_id = ? AND state = 'reserved'").run(id);
          this.db.prepare("UPDATE outgoing SET status = 'failed', error = 'inputs spent elsewhere', updated_at = ? WHERE id = ?").run(now(), id);
        } else {
          this.db.prepare("UPDATE outgoing SET status = 'owed', preview = NULL, counters = NULL, updated_at = ? WHERE id = ?").run(now(), id);
        }
      });
      return;
    }
    tx(this.db, () => {
      this.db.prepare(`UPDATE proofs SET state = ?, op_id = NULL WHERE op_id = ? AND state = 'reserved'`).run(inputsSpent ? 'spent' : 'unspent', id);
      this.db.prepare("UPDATE outgoing SET status = 'owed', inputs = NULL, preview = NULL, counters = NULL, updated_at = ? WHERE id = ?").run(now(), id);
    });
  }

  private async recoverOutgoing(row: OutgoingRow): Promise<void> {
    if (row.status === 'reserved' || !row.preview) {
      // Crash before the swap was prepared: nothing reached the mint.
      this.reowe(row.id, false);
      return;
    }
    const w = await this.wallet(row.mint, row.unit);
    const preview = deserializeSwapPreview(JSON.parse(row.preview));
    if (!this.opts.faults?.noReplayOnRecovery) {
      try {
        const res = await w.completeSwap(preview);
        this.finalizeOutgoing(row.id, getEncodedToken({ mint: row.mint, unit: row.unit, proofs: res.send }), res.keep);
        log.info('outgoing_recovered', { id: row.id, via: 'replay', locked: !!row.lock_pubkey });
        return;
      } catch (e) {
        if (!isMintRejection(e)) throw e;
      }
    }
    if (row.lock_pubkey) return this.recoverLockedOutgoing(row, w, preview);
    const c = row.counters ? (JSON.parse(row.counters) as OperationCounters | null) : null;
    if (c && c.count > 0) {
      const { proofs } = await w.restore(c.start, c.count, { keysetId: c.keysetId });
      if (proofs.length) {
        const sendSecrets = new Set((preview.sendOutputs ?? []).map(outputSecret));
        const send = proofs.filter((p) => sendSecrets.has(p.secret));
        const keep = proofs.filter((p) => !sendSecrets.has(p.secret));
        this.finalizeOutgoing(row.id, getEncodedToken({ mint: row.mint, unit: row.unit, proofs: send }), keep);
        log.info('outgoing_recovered', { id: row.id, via: 'restore' });
        return;
      }
    }
    const states = await w.checkProofsStates(preview.inputs);
    this.reowe(row.id, !states.every((s) => s.state === 'UNSPENT'));
    log.warn('outgoing_reowed', { id: row.id });
  }

  /**
   * Recovery of a locked payout whose replay was refused. Its send secrets are random, so the counter
   * range cannot find them; the stored blinded messages can: NUT-09 restore returns the signatures the
   * mint made for exactly those outputs. The mint either signed all outputs of the swap or none.
   *  - all signed: build the proofs from the stored secrets and blinding factors, finalize once.
   *  - none signed: the swap never happened with these outputs; re-owe like an unlocked payout.
   *  - anything else (restore refused or unsupported, partial answer): the outcome is unknown. The row
   *    stays prepared and owed, is never paid a second time, and is retried on the next issue/startup.
   */
  private async recoverLockedOutgoing(row: OutgoingRow, w: Wallet, preview: SwapPreview): Promise<void> {
    const sendOut = preview.sendOutputs ?? [];
    const keepOut = preview.keepOutputs ?? [];
    let restored: Array<Proof | null> | null = null;
    if (!this.opts.faults?.noRestoreOnRecovery) {
      try {
        restored = await this.restoreOutputs(w, [...sendOut, ...keepOut]);
      } catch (e) {
        if (!isMintRejection(e)) throw e; // offline: try later
      }
    }
    if (restored && restored.every((p) => p !== null)) {
      const proofs = restored as Proof[];
      const send = proofs.slice(0, sendOut.length);
      const keep = proofs.slice(sendOut.length);
      this.finalizeOutgoing(row.id, getEncodedToken({ mint: row.mint, unit: row.unit, proofs: send }), keep);
      log.info('outgoing_recovered', { id: row.id, via: 'restore', locked: true });
      return;
    }
    if (restored && restored.every((p) => p === null)) {
      const states = await w.checkProofsStates(preview.inputs);
      this.reowe(row.id, !states.every((s) => s.state === 'UNSPENT'));
      log.warn('outgoing_reowed', { id: row.id, locked: true });
      return;
    }
    const why = restored ? 'the mint restored only part of the locked outputs' : 'the mint would neither replay the swap nor restore its signatures';
    this.db.prepare('UPDATE outgoing SET error = ?, updated_at = ? WHERE id = ?').run(`outcome unknown: ${why}`, now(), row.id);
    log.error('outgoing_outcome_unknown', { id: row.id, locked: true });
    throw new PaymentError('payout_unknown', 'the mint has not confirmed whether this payout was made; it stays owed and is never paid twice. Retry later', 503);
  }

  /** NUT-09 restore of specific outputs: the proof for each output the mint signed, else null. */
  private async restoreOutputs(w: Wallet, outputs: OutputDataLike[]): Promise<Array<Proof | null>> {
    if (!outputs.length) return [];
    const res = await w.mint.restore({ outputs: outputs.map((o) => o.blindedMessage) });
    const sigs = new Map<string, (typeof res.signatures)[number]>();
    res.outputs.forEach((o, i) => {
      const sig = res.signatures[i];
      if (sig) sigs.set(o.B_, sig);
    });
    const ids = [...new Set([...sigs.values()].map((s) => s.id))];
    if (ids.length) await w.ensureOperableKeysets(ids);
    return outputs.map((o) => {
      const sig = sigs.get(o.blindedMessage.B_);
      return sig ? o.toProof(sig, w.getKeyset(sig.id)) : null;
    });
  }

  /** Startup recovery for every interrupted mint operation. */
  async recover(): Promise<{ incoming: number; outgoing: number; errors: number }> {
    let errors = 0;
    const inc = this.db.prepare("SELECT * FROM incoming WHERE status = 'prepared'").all() as unknown as IncomingRow[];
    for (const r of inc) {
      try {
        await this.recoverIncoming(r);
      } catch (e) {
        errors++;
        log.warn('recover_incoming_failed', { id: r.id, err: errText(e) });
      }
    }
    // status=new rows never reached the mint; the client still holds a valid token, so forget them.
    this.db.prepare("DELETE FROM incoming WHERE status = 'new'").run();
    const out = this.db.prepare("SELECT * FROM outgoing WHERE status IN ('reserved', 'prepared')").all() as unknown as OutgoingRow[];
    for (const r of out) {
      try {
        await this.recoverOutgoing(r);
      } catch (e) {
        errors++;
        log.warn('recover_outgoing_failed', { id: r.id, err: errText(e) });
      }
    }
    return { incoming: inc.length, outgoing: out.length, errors };
  }

  /** Set at startup when the database held no wallet state: counters must be recovered before any use. */
  needsCounterScan = false;

  private scanSettings() {
    const c = this.opts.counterScan ?? {};
    return {
      batchSize: c.batchSize ?? COUNTER_SCAN_DEFAULTS.batchSize,
      gap: c.gap ?? COUNTER_SCAN_DEFAULTS.gap,
      maxBatches: c.maxBatches ?? COUNTER_SCAN_DEFAULTS.maxBatches,
      timeoutMs: c.timeoutMs ?? COUNTER_SCAN_DEFAULTS.timeoutMs,
      retryBaseMs: c.retryBaseMs ?? 5_000,
      retryMaxMs: c.retryMaxMs ?? 300_000,
    };
  }

  /** Mints closed until their counter scan completes. */
  get closedMints(): string[] {
    return [...this.closed.keys()];
  }

  /**
   * At boot, on a database with no wallet state: for every mint, every unit and every keyset (active or
   * not), scan from counter 0 for what the mint has signed under this seed, move each counter past it, and
   * keep the unspent eCash found, aside, as recovered funds (recordRecovered). Each mint is closed (wallet() refuses
   * it with 503) until its scan completes. A mint that cannot be scanned stays closed and is retried with
   * backoff, so no output is ever made there with a counter the mint may have signed.
   */
  async recoverCounters(mints: string[]): Promise<CounterRecovery> {
    const t0 = Date.now();
    const list = [...new Set(mints.map(normalizeMintUrl))];
    for (const m of list) {
      this.scannedMints.add(m);
      this.closed.set(m, 'its wallet counters are being recovered after a restart');
    }
    const results = await Promise.all(list.map((m) => this.scanMint(m)));
    const out: CounterRecovery = { scanned: [], pending: [], batches: 0, ms: 0, recovered: {} };
    results.forEach((r, i) => {
      out.batches += r.batches;
      if (r.ok) out.scanned.push(list[i]!);
      else out.pending.push(list[i]!);
      addRecovered(out.recovered, r.recovered);
    });
    out.ms = Date.now() - t0;
    const fields: Record<string, number | string> = { mints: list.length, scanned: out.scanned.length, pending: out.pending.length, batches: out.batches, ms: out.ms };
    for (const [unit, v] of Object.entries(out.recovered)) {
      fields[`recovered_${unit}`] = v.amount;
      fields[`recovered_${unit}_proofs`] = v.proofs;
    }
    log.info('counter_recovery', fields);
    results.forEach((r, i) => {
      if (!r.ok) {
        log.warn('counter_recovery_pending', { mint: list[i]!, err: r.error ?? 'incomplete', retry_s: Math.round(this.retryDelay(0) / 1000) });
        this.scheduleRetry(list[i]!, 0);
      }
    });
    return out;
  }

  private retryDelay(attempt: number): number {
    const s = this.scanSettings();
    return Math.min(s.retryMaxMs, s.retryBaseMs * 2 ** attempt);
  }

  private scheduleRetry(mint: string, attempt: number) {
    const t = setTimeout(async () => {
      this.retryTimers.delete(mint);
      const r = await this.scanMint(mint);
      if (r.ok) {
        const fields: Record<string, number | string> = { mint, attempt: attempt + 1, batches: r.batches };
        for (const [unit, v] of Object.entries(r.recovered)) fields[`recovered_${unit}`] = v.amount;
        log.info('counter_recovery_retry_ok', fields);
      } else {
        log.warn('counter_recovery_pending', { mint, err: r.error ?? 'incomplete', retry_s: Math.round(this.retryDelay(attempt + 1) / 1000) });
        this.scheduleRetry(mint, attempt + 1);
      }
    }, this.retryDelay(attempt));
    t.unref?.();
    this.retryTimers.set(mint, t);
  }

  /** Stops the retry timers (shutdown). */
  stop(): void {
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  /** Scans every keyset of a closed mint from 0. Opens the mint only when every scan completed. */
  async scanMint(mint: string): Promise<{ ok: boolean; batches: number; recovered: Record<string, { proofs: number; amount: number }>; error?: string }> {
    const m = normalizeMintUrl(mint);
    const s = this.scanSettings();
    const deadline = Date.now() + s.timeoutMs;
    const recovered: Record<string, { proofs: number; amount: number }> = {};
    let batches = 0;
    try {
      for (const unit of this.opts.units) {
        const w = await this.openWallet(m, unit);
        let keysets: Array<{ id: string }>;
        try {
          keysets = w.keyChain.getKeysets();
        } catch {
          continue; // this mint has no keyset in this unit
        }
        for (const ks of keysets) {
          const r = await this.scanKeyset(w, m, unit, ks.id, 0, deadline);
          batches += r.batches;
          addRecovered(recovered, { [unit]: { proofs: r.proofs, amount: r.amount } });
          if (!r.complete) return { ok: false, batches, recovered, error: `scan of keyset ${ks.id} reached its bound before the gap` };
        }
      }
    } catch (e) {
      return { ok: false, batches, recovered, error: errText(e) };
    }
    this.closed.delete(m);
    return { ok: true, batches, recovered };
  }

  /**
   * Scans one keyset from `from` (or from its stored counter when that is higher), with every reservation
   * of counters on the keyset waiting until it is done. Stores the unspent proofs found as recovered funds
   * and moves the counter past the highest one the mint signed.
   */
  private async scanKeyset(
    w: Wallet,
    mint: string,
    unit: Unit,
    keysetId: string,
    from: number | 'current',
    deadline: number,
    /** Also restore this range: an operation's own outputs the mint refused as already signed. */
    collided?: OperationCounters,
  ): Promise<{ batches: number; proofs: number; amount: number; complete: boolean; next: number }> {
    const key = `${mint}|${keysetId}`;
    for (let r = this.scans.get(key); r; r = this.scans.get(key)) await r.catch(() => {});
    const run = (async () => {
      const cur = (this.db.prepare('SELECT next FROM counters WHERE mint = ? AND keyset_id = ?').get(mint, keysetId) as { next: number } | undefined)?.next ?? 0;
      const start = from === 'current' ? cur : from;
      const s = this.scanSettings();
      const limits: ScanLimits = { batchSize: Math.max(1, Math.min(s.batchSize, w.getMintInfo().maxArrayLength)), gap: s.gap, maxBatches: s.maxBatches, deadline };
      const scan = await scanCounters((st, n) => restoreWithRetry(() => w.restore(st, n, { keysetId }), deadline), start, limits);
      if (!scan.complete) return { batches: scan.batches, proofs: 0, amount: 0, complete: false, next: cur };
      if (collided && collided.count > 0 && collided.start < start) {
        // Below the stored counter, so the forward scan does not cover it. The mint signed these outputs
        // before this database existed: what it returns is from an earlier life, not this one.
        const old = await restoreWithRetry(() => w.restore(collided.start, collided.count, { keysetId }), deadline);
        scan.proofs.push(...old.proofs);
        scan.batches++;
      }
      // NUT-07: only what is still unspent is worth keeping. checkProofsStates answers in order, in batches.
      const states = scan.proofs.length ? await w.checkProofsStates(scan.proofs) : [];
      const unspent = scan.proofs.filter((_, j) => states[j]?.state === 'UNSPENT');
      const stored = tx(this.db, () => {
        const got = this.recordRecovered(unspent, mint, unit);
        this.db
          .prepare('INSERT INTO counters (mint, keyset_id, next) VALUES (?, ?, ?) ON CONFLICT (mint, keyset_id) DO UPDATE SET next = MAX(next, excluded.next)')
          .run(mint, keysetId, scan.next);
        return got;
      });
      return { batches: scan.batches, proofs: stored.proofs, amount: stored.amount, complete: true, next: Math.max(cur, scan.next) };
    })();
    this.scans.set(key, run);
    try {
      return await run;
    } finally {
      if (this.scans.get(key) === run) this.scans.delete(key);
    }
  }

  /**
   * The mint refused our outputs as already signed: the counter is behind (a database that lost its
   * counters, and a scan that stopped at a gap). Scans forward from the stored counter and moves it on.
   */
  private async skipSignedCounters(w: Wallet, mint: string, unit: Unit, collided: OperationCounters): Promise<void> {
    const r = await this.scanKeyset(w, normalizeMintUrl(mint), unit, collided.keysetId, 'current', Date.now() + this.scanSettings().timeoutMs, collided);
    log.warn('counters_behind', { mint: normalizeMintUrl(mint), keyset: collided.keysetId, batches: r.batches, next: r.next, complete: r.complete, recovered: r.amount });
    if (!r.complete) throw new PaymentError('mint_unavailable', 'the mint has signed outputs this wallet has not caught up with yet; retry shortly', 503);
  }

  /**
   * Stores unspent proofs no row accounts for, in state 'recovered', and adds what was new to the recovered
   * funds. 'recovered' is never picked for a payout and is not part of the wallet's holdings or of what is
   * sweepable: among these proofs may be payouts already handed to people (a refund or change token they
   * have not redeemed yet), which are derived from the same seed and cannot be told apart. Spending one
   * would take it from them. The operator decides what to do with them (docs/OPERATE.md).
   * Only for the mints this wallet scans at boot; what a forward scan finds at another mint is left alone.
   */
  private recordRecovered(proofs: Proof[], mint: string, unit: Unit): { proofs: number; amount: number } {
    if (!this.isTrusted(mint) && !this.scannedMints.has(mint)) return { proofs: 0, amount: 0 };
    const stmt = this.db.prepare(
      "INSERT INTO proofs (secret, mint, unit, keyset_id, amount, proof, state, op_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recovered', NULL, ?) ON CONFLICT (secret) DO NOTHING",
    );
    let n = 0;
    let amount = 0;
    for (const p of proofs) {
      if (Number(stmt.run(p.secret, mint, unit, p.id, proofAmount(p), serializeProofs(p)[0]!, now()).changes) === 1) {
        n++;
        amount += proofAmount(p);
      }
    }
    if (n > 0) this.db.prepare('INSERT INTO recovered_funds (mint, unit, proofs, amount, created_at) VALUES (?, ?, ?, ?, ?)').run(mint, unit, n, amount, now());
    return { proofs: n, amount };
  }

  /** Recovered funds per mint and unit: eCash found by counter scans that no balance is owed. */
  recovered(): Array<{ mint: string; unit: string; proofs: number; amount: number }> {
    return this.db
      .prepare('SELECT mint, unit, SUM(proofs) AS proofs, SUM(amount) AS amount FROM recovered_funds GROUP BY mint, unit ORDER BY mint, unit')
      .all() as Array<{ mint: string; unit: string; proofs: number; amount: number }>;
  }

  /** Holdings and obligations per mint+unit, in whole units. */
  holdings(): Array<{ mint: string; unit: string; unspent: number; reserved: number; owed: number }> {
    const rows = this.db
      .prepare(
        "SELECT mint, unit, SUM(CASE WHEN state = 'unspent' THEN amount ELSE 0 END) AS unspent, SUM(CASE WHEN state = 'reserved' THEN amount ELSE 0 END) AS reserved FROM proofs GROUP BY mint, unit",
      )
      .all() as Array<{ mint: string; unit: string; unspent: number; reserved: number }>;
    const owed = this.db
      .prepare("SELECT mint, unit, SUM(amount) AS owed FROM outgoing WHERE status IN ('owed', 'reserved', 'prepared') GROUP BY mint, unit")
      .all() as Array<{ mint: string; unit: string; owed: number }>;
    return rows.map((r) => ({ ...r, owed: owed.find((o) => o.mint === r.mint && o.unit === r.unit)?.owed ?? 0 }));
  }
}

function addRecovered(into: Record<string, { proofs: number; amount: number }>, add: Record<string, { proofs: number; amount: number }>) {
  for (const [unit, v] of Object.entries(add)) {
    const cur = (into[unit] ??= { proofs: 0, amount: 0 });
    cur.proofs += v.proofs;
    cur.amount += v.amount;
  }
}

/** A restore request, tried again after a network error or a rate limit while the deadline allows. */
async function restoreWithRetry<T>(f: () => Promise<T>, deadline: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      const wait = 500 * 2 ** attempt;
      if (attempt >= 3 || Date.now() + wait >= deadline || (e instanceof MintOperationError && !/rate/i.test(e.message))) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export { Amount };
