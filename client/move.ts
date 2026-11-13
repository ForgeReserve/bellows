/**
 * Moving a balance between operators. Balances do not move by themselves: the client withdraws the
 * remaining balance from one operator as eCash and funds a new balance at another with it.
 *
 *   const moved = await moveBalance(pool, { from: oldId, key, onToken: (t) => saveSomewhere(t) });
 *   // moved.key is the new balance key at moved.to
 *
 * Withdrawals are whole units, so a remainder below one unit stays behind. The token is handed to
 * `onToken` as soon as the old operator issues it, before anything else can fail, so the caller can keep it
 * until the move is done: if anything fails after the withdrawal, the error carries the token and it can be
 * redeemed in any Cashu wallet or passed back as `token` to finish the move. The new key is chosen here before funding, and every error that carries the
 * token carries the key too. Finishing a move takes both: pass the error's `token` (with its unit and
 * mint) and `key` as `newKey`, with the same `to`. A retry with the same key and token is credited once.
 *
 * Only operators whose attested announcement takes the token's unit and mint are asked. Without `newKey`
 * each one is asked with a key of its own, so an operator that refuses never learns the key of the balance
 * that is funded in the end.
 */
import { toBase64 } from './bytes.ts';
import { OperatorError } from './errors.ts';
import type { OperatorPool, ReadyOperator } from './pool.ts';
import { POW_CHALLENGE_HEADER, POW_HEADER, solvePow } from './pow.ts';

export type MoveErrorCode =
  /** The balance at the old operator is below one whole unit. */
  | 'nothing_to_move'
  /** The withdrawal was accepted but its token is not issued yet; GET /v1/wallet/refunds at the old operator delivers it later. */
  | 'withdraw_pending'
  /** The old operator refused the withdrawal or could not be reached. Nothing was withdrawn, or it is listed at GET /v1/wallet/refunds. */
  | 'withdraw_failed'
  /**
   * The balance was withdrawn, but the old operator did not say which mint the token is from, so no
   * destination can be checked against it. The token is in the error (and went to `onToken`): redeem it in
   * any Cashu wallet, or finish the move with `token` (its unit and mint) and the error's `key` as `newKey`.
   */
  | 'withdrawn_unroutable'
  /** No other operator would take the token. The token is in the error. */
  | 'no_destination'
  /**
   * The funding may have reached the new operator and its outcome is not known: it could not be reached,
   * answered that the funding is pending, or answered with a server error. Retry with the same `to`,
   * `newKey` and token.
   */
  | 'fund_unknown'
  /**
   * The new operator is limiting requests (429) and did not run the funding, even after waiting as asked.
   * The token is untouched. Retry later with the same `to`, `newKey` and token, or fund another operator.
   */
  | 'fund_retry'
  /** The new operator refused the token for good with a 4xx answer (for example it was already spent). */
  | 'fund_failed';

export class MoveBalanceError extends Error {
  readonly code: MoveErrorCode;
  /** The withdrawn token, once there is one. Keep it: it is the balance. */
  readonly token?: string;
  /** The operator the funding was sent to, and the key it was sent with. */
  readonly to?: string;
  readonly key?: string;
  constructor(code: MoveErrorCode, message: string, extra: { token?: string; to?: string; key?: string; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'MoveBalanceError';
    this.code = code;
    this.token = extra.token;
    this.to = extra.to;
    this.key = extra.key;
  }
}

export interface Withdrawn {
  token: string;
  /** Whole units. */
  amount: number;
  unit: string;
  /** The mint that issued it. Unset when the old operator did not say (the move then stops with withdrawn_unroutable). */
  mint?: string;
  /** The operator it came from. */
  from: string;
}

export interface MoveOptions {
  /** The operator holding the balance. */
  from: string;
  /** The balance key there. */
  key: string;
  /** The operator to move to. Unset: every other listed operator that keeps balances in the unit, in pool order. */
  to?: string;
  /** The new balance key. Unset: a new random one for each operator asked. Required with `token`. */
  newKey?: string;
  /** An invite, for an operator that opens balances by invite only. */
  invite?: string;
  /** Called with the withdrawn token before it is spent. Store it until the move returns. */
  onToken?: (w: Withdrawn) => void | Promise<void>;
  /**
   * Finish an earlier move: fund with this token instead of withdrawing. Pass the unit and mint it is in,
   * and the `key` from the MoveBalanceError as `newKey`.
   */
  token?: { token: string; unit: string; mint: string };
  /** Most retries of a funding the new operator reports as pending (default 3). */
  pendingRetries?: number;
  /** Most retries of a funding the new operator answers 429 to, each after its Retry-After (default 2). */
  rateLimitRetries?: number;
  /** Longest Retry-After waited out, in seconds (default 10). A longer one ends the attempt at that operator at once. */
  maxRetryAfterSeconds?: number;
}

export interface MoveResult {
  from: string;
  to: string;
  /** The balance key at the new operator. */
  key: string;
  unit: string;
  /** Units withdrawn (0 when finishing with `token`). */
  withdrawn: number;
  /** Units credited at the new operator. */
  credited: number;
  /** Balance at the new operator, in msub (thousandths of the unit). */
  balanceMsub: number;
  /** The token that was moved. Spent now; kept for the record. */
  token: string;
}

/** A new balance key: sk-forge- and 43 random URL-safe characters (256 bits). */
export function newBalanceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'sk-forge-' + toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const errorCode = (body: unknown): string | undefined => (isObject(body) && isObject(body.error) && typeof body.error.code === 'string' ? body.error.code : undefined);
const errorText = (status: number, body: unknown) => (isObject(body) && isObject(body.error) && typeof body.error.message === 'string' ? `HTTP ${status}: ${body.error.message}` : `HTTP ${status}`);

const jsonPost = (body: unknown, key: string, extra: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra },
  body: JSON.stringify(body),
});

/** Codes for which a different operator may still take the token. */
const TRY_NEXT = new Set(['untrusted_mint', 'wrong_unit', 'invite_required', 'invite_invalid', 'invite_used', 'pow_required']);

async function withdraw(pool: OperatorPool, o: MoveOptions): Promise<Withdrawn> {
  const call = async (path: string, init?: RequestInit) => {
    try {
      const { response } = await pool.fetch(path, init, { operator: o.from });
      return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
    } catch (e) {
      throw new MoveBalanceError('withdraw_failed', `could not reach ${o.from}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  };
  const wallet = await call('/v1/wallet', { headers: { authorization: `Bearer ${o.key}` } });
  if (wallet.status !== 200 || !isObject(wallet.body)) throw new MoveBalanceError('withdraw_failed', `could not read the balance at ${o.from} (${errorText(wallet.status, wallet.body)})`);
  const refundable = Number(wallet.body.refundable);
  if (!Number.isInteger(refundable) || refundable < 1) throw new MoveBalanceError('nothing_to_move', `the balance at ${o.from} is below one ${String(wallet.body.unit)}`);
  const r = await call('/v1/wallet/refund', jsonPost({}, o.key));
  if (r.status === 202) throw new MoveBalanceError('withdraw_pending', `${o.from} owes the withdrawal but has not issued it yet; GET /v1/wallet/refunds there delivers it`);
  if (r.status !== 200 || !isObject(r.body) || typeof r.body.token !== 'string') throw new MoveBalanceError('withdraw_failed', `${o.from} refused the withdrawal (${errorText(r.status, r.body)})`);
  // Withdrawn even when the mint is missing: moveBalance hands the token to onToken before it stops.
  const w: Withdrawn = { token: r.body.token, amount: Number(r.body.amount), unit: String(r.body.unit), from: o.from };
  if (typeof r.body.mint === 'string') w.mint = r.body.mint;
  return w;
}

/** Seconds a Retry-After header asks for (delta-seconds or an HTTP date); 1 when absent or unreadable. */
function retryAfterSeconds(value: string | null): number {
  if (value === null) return 1;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 1 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

interface FundLimits {
  pendingRetries: number;
  rateLimitRetries: number;
  maxRetryAfterSeconds: number;
}

/** `retry`: the operator was limiting requests and did not run the funding; the token is untouched. */
type FundOutcome = { ok: true; body: Record<string, unknown> } | { ok: false; next: boolean; retry?: boolean; reason: string; code?: string };

async function fund(pool: OperatorPool, op: ReadyOperator, token: string, key: string, invite: string | undefined, limits: FundLimits): Promise<FundOutcome> {
  let pow: string | undefined;
  let pending = 0;
  let limited = 0;
  for (let attempt = 0; attempt < 4 + limits.pendingRetries + limits.rateLimitRetries; attempt++) {
    let response: Response;
    try {
      ({ response } = await pool.fetch('/v1/wallet/topup', jsonPost({ token, ...(invite ? { invite } : {}) }, key, pow ? { [POW_HEADER]: pow } : {}), { operator: op.id }));
    } catch (e) {
      // The request may have reached the operator and spent the token there: never take it elsewhere.
      throw new MoveBalanceError('fund_unknown', `could not reach ${op.id}; retry the move with the same to, newKey and token: ${e instanceof Error ? e.message : String(e)}`, { token, to: op.id, key, cause: e });
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.status === 200 && isObject(body)) return { ok: true, body };
    const code = errorCode(body);
    // 429: this request was turned away before it ran. After a pending answer the funding may still complete here, so the outcome stays unknown.
    if (response.status === 429 && pending > 0) {
      throw new MoveBalanceError('fund_unknown', `${op.id} reported the funding as pending and then limited requests (${errorText(response.status, body)}); retry the move with the same to, newKey and token`, { token, to: op.id, key });
    }
    // 429 with nothing pending: the token is untouched. Never final.
    if (response.status === 429) {
      const wait = retryAfterSeconds(response.headers.get('retry-after'));
      if (limited < limits.rateLimitRetries && wait <= limits.maxRetryAfterSeconds) {
        limited++;
        // A proof of work may have been spent before the limit turned the request away: solve a new one if asked.
        pow = undefined;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      return { ok: false, next: true, retry: true, reason: `${errorText(response.status, body)}, retry after ${wait} s`, code: code ?? 'rate_limited' };
    }
    if (response.status === 428 && code === 'pow_required' && pow === undefined) {
      const p = isObject(body) && isObject(body.pow) ? body.pow : {};
      const challenge = response.headers.get(POW_CHALLENGE_HEADER) ?? (typeof p.challenge === 'string' ? p.challenge : '');
      const bits = Number(p.bits);
      if (!challenge || !Number.isInteger(bits)) return { ok: false, next: true, reason: 'proof of work asked without a challenge', code };
      pow = await solvePow(challenge, bits);
      continue;
    }
    if (response.status === 503 && code === 'topup_pending' && pending < limits.pendingRetries) {
      pending++;
      await new Promise((r) => setTimeout(r, 500 * pending));
      continue;
    }
    if (response.status === 503 && code === 'topup_pending') {
      throw new MoveBalanceError('fund_unknown', `${op.id} reports the funding as pending; retry the move with the same to, newKey and token`, { token, to: op.id, key });
    }
    // A server error, or an answer that is not JSON, says nothing final: the swap may still complete there.
    if (response.status >= 500 || body === null) {
      throw new MoveBalanceError('fund_unknown', `${op.id} answered ${errorText(response.status, body)}; the funding may still complete: retry the move with the same to, newKey and token`, { token, to: op.id, key });
    }
    return { ok: false, next: code !== undefined && TRY_NEXT.has(code), reason: errorText(response.status, body), code };
  }
  return { ok: false, next: true, retry: limited > 0 && pending === 0, reason: 'gave up after repeated proof of work or rate limit refusals' };
}

/** Withdraws the balance at `from` and funds a new balance with it at another operator. See the module comment. */
export async function moveBalance(pool: OperatorPool, o: MoveOptions): Promise<MoveResult> {
  if (o.to !== undefined && o.to === o.from) throw new OperatorError('not_accepted', 'the destination is the same operator');
  if (o.token && o.newKey === undefined) throw new OperatorError('not_accepted', 'finishing a move needs the newKey from the MoveBalanceError');
  let w: Withdrawn;
  if (o.token) {
    w = { token: o.token.token, amount: 0, unit: o.token.unit, mint: o.token.mint, from: o.from };
  } else {
    w = await withdraw(pool, o);
    if (o.onToken) await o.onToken(w);
  }
  const mint = w.mint;
  if (mint === undefined) {
    // Withdrawn, but no destination can be checked against the mint: hand the token back unspent.
    throw new MoveBalanceError('withdrawn_unroutable', `${o.from} did not say which mint the withdrawn token is from; the token is in this error: redeem it, or finish the move with token (unit and mint) and newKey`, {
      token: w.token,
      key: o.newKey ?? newBalanceKey(),
    });
  }
  const limits: FundLimits = { pendingRetries: o.pendingRetries ?? 3, rateLimitRetries: o.rateLimitRetries ?? 2, maxRetryAfterSeconds: o.maxRetryAfterSeconds ?? 10 };

  const candidates = o.to !== undefined ? [o.to] : (await pool.order()).filter((id) => id !== o.from);
  const failures: string[] = [];
  for (const id of candidates) {
    let op: ReadyOperator;
    try {
      // Checked against the attested announcement before anything is sent: an operator that does not take
      // this unit or mint never sees the token or a key.
      op = await pool.prepare(id, { unit: w.unit, mint });
    } catch (e) {
      if (!(e instanceof OperatorError && e.code === 'not_accepted')) pool.markFailed(id);
      failures.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const key = o.newKey ?? newBalanceKey();
    const out = await fund(pool, op, w.token, key, o.invite, limits);
    if (out.ok) {
      return {
        from: o.from,
        to: op.id,
        key,
        unit: String(out.body.unit ?? w.unit),
        withdrawn: w.amount,
        credited: Number(out.body.credited ?? 0),
        balanceMsub: Number(out.body.balance_msub ?? 0),
        token: w.token,
      };
    }
    failures.push(`${id}: ${out.reason}`);
    if (out.retry) {
      // Turned away before it ran: the token is untouched. With a destination named, say so; otherwise ask the next one.
      if (o.to !== undefined) throw new MoveBalanceError('fund_retry', `${id} is limiting requests and did not run the funding (${out.reason}); retry later with the same to, newKey and token`, { token: w.token, to: id, key });
      continue;
    }
    if (!out.next || o.to !== undefined) {
      throw new MoveBalanceError(o.to !== undefined && out.next ? 'no_destination' : 'fund_failed', `${id} refused the token (${out.reason})`, { token: w.token, to: id, key });
    }
  }
  // A key no refusing operator has seen, to pass back as newKey.
  throw new MoveBalanceError('no_destination', `no operator took the token${failures.length ? `: ${failures.join('; ')}` : ''}`, { token: w.token, key: o.newKey ?? newBalanceKey() });
}
