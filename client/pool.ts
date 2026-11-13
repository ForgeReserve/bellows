/**
 * OperatorPool: a list of Bellows operators a client can use. It verifies each one before use (attested
 * build on the approved list, and the attested statement carries the same operator's signed announcement),
 * checks its health through Oblivious HTTP, picks one, fails over to the next on error, and remembers the
 * last one that worked.
 *
 *   const pool = new OperatorPool({ operators: announcements, approvedBuilds, verifier, memory: storageMemory(localStorage) });
 *   const { response } = await pool.fetch('/v1/models');
 *
 * Balances do not move between operators: a balance key works only at the operator that issued it. Calls
 * that use a balance name that operator (`{ operator: id }`) and never fail over; moveBalance (move.ts)
 * takes a balance from one operator to another.
 */
import { BellowsFetchError, bellowsFetch, type BellowsOperator } from './ohttp.ts';
import { OperatorError } from './errors.ts';
import { normalizeMint, type OperatorAnnouncement, parseOperatorAnnouncement } from './operator.ts';
import type { AttestationVerifier } from './verifier.ts';
import { type VerifiedBellows, verifyBellows } from './verify.ts';

/** Where the pool keeps the id of the last operator that worked. */
export interface OperatorMemory {
  get(): string | null | undefined | Promise<string | null | undefined>;
  set(id: string): void | Promise<void>;
}

/** Memory that lasts as long as the object. */
export function memoryInProcess(initial?: string): OperatorMemory {
  let v = initial ?? null;
  return { get: () => v, set: (id) => void (v = id) };
}

/** Memory in a Web Storage object (localStorage). Storage that throws (private mode, blocked) is ignored. */
export function storageMemory(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void }, key = 'bellows.last-operator'): OperatorMemory {
  return {
    get: () => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (id) => {
      try {
        storage.setItem(key, id);
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * How requests reach a Bellows.
 * - relay-or-direct (default): through the first relay the Bellows lists, straight to it when it lists none.
 * - relay: only through a relay; a Bellows that lists none is passed over.
 * - direct: straight to the Bellows. Its host sees the client's address.
 * - onion: to the onion address the operator announces, with a fetch that reaches Tor (the `fetch` option).
 */
export type Route = 'relay-or-direct' | 'relay' | 'direct' | 'onion';

export interface Requirements {
  /** The operator must keep balances in this unit. */
  unit?: string;
  /** The operator must take eCash from this mint. */
  mint?: string;
}

export interface OperatorPoolOptions extends Requirements {
  /** Operator announcements: signed events, or announcements already parsed (they are checked again). */
  operators: readonly unknown[];
  /** The approved builds (builds.json). */
  approvedBuilds: unknown;
  verifier: AttestationVerifier | readonly AttestationVerifier[];
  /** Accept the development stand-in attestation. Never for real use. */
  allowDevelopment?: boolean;
  route?: Route;
  memory?: OperatorMemory;
  /** fetch to use (default: the global one). With route onion, it must reach onion addresses. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** An operator that failed is tried again only after this long, unless every other one failed too (default 60 s). */
  retryAfterMs?: number;
  now?: () => number;
}

/** An operator that passed every check, ready for requests. */
export interface ReadyOperator {
  id: string;
  /** The announcement the Bellows itself serves in its attested statement. */
  announcement: OperatorAnnouncement;
  verified: VerifiedBellows;
  /** What bellowsFetch needs: origin, attested key and the relay used. */
  endpoint: BellowsOperator;
}

export interface PoolFetchOptions {
  /** Send to this operator only. No failover, and the pool's unit and mint do not apply. Required for any call that carries a balance key. */
  operator?: string;
  /**
   * Fail over to the next operator when this one cannot be reached or answers 502, 503 or 504. Default: true
   * for GET and HEAD, false otherwise, since a request that reached a Bellows may have run there (and been
   * paid). Set true only for a request that is safe to send twice to different operators.
   */
  failover?: boolean;
}

const FAILOVER_STATUSES = new Set([502, 503, 504]);

const reasonOf = (e: unknown) => (e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : String(e));

/** The order operators are tried in: the remembered one first, then list order; ones that failed recently go last. */
export function tryOrder(ids: readonly string[], remembered: string | null | undefined, failedAt: ReadonlyMap<string, number>, now: number, retryAfterMs: number): string[] {
  const fresh = (id: string) => {
    const t = failedAt.get(id);
    return t === undefined || now - t >= retryAfterMs;
  };
  const listed = remembered && ids.includes(remembered) ? [remembered, ...ids.filter((i) => i !== remembered)] : [...ids];
  const cooling = listed.filter((i) => !fresh(i)).sort((a, b) => failedAt.get(a)! - failedAt.get(b)!);
  return [...listed.filter(fresh), ...cooling];
}

export class OperatorPool {
  readonly #listed = new Map<string, OperatorAnnouncement>();
  readonly #ready = new Map<string, ReadyOperator>();
  readonly #failedAt = new Map<string, number>();
  readonly #opts: OperatorPoolOptions;
  readonly #memory: OperatorMemory;
  readonly #now: () => number;
  /** Listed entries that are not valid announcements, with the reason. */
  readonly rejected: { event: unknown; reason: string }[] = [];

  constructor(opts: OperatorPoolOptions) {
    this.#opts = opts;
    this.#memory = opts.memory ?? memoryInProcess();
    this.#now = opts.now ?? Date.now;
    for (const entry of opts.operators) {
      const ev = typeof entry === 'object' && entry !== null && 'event' in entry ? (entry as OperatorAnnouncement).event : entry;
      try {
        const a = parseOperatorAnnouncement(ev);
        const prev = this.#listed.get(a.id);
        if (!prev || a.createdAt > prev.createdAt) this.#listed.set(a.id, a);
      } catch (e) {
        this.rejected.push({ event: entry, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** The listed operators, in list order. */
  get operators(): OperatorAnnouncement[] {
    return [...this.#listed.values()];
  }

  /** The operators in the order the next request would try them. */
  async order(): Promise<string[]> {
    let remembered: string | null | undefined;
    try {
      remembered = await this.#memory.get();
    } catch {
      remembered = null;
    }
    return tryOrder([...this.#listed.keys()], remembered, this.#failedAt, this.#now(), this.#opts.retryAfterMs ?? 60_000);
  }

  /** Marks an operator as failed: it is verified again before its next use and goes to the back of the order. */
  markFailed(id: string): void {
    this.#ready.delete(id);
    this.#failedAt.set(id, this.#now());
  }

  async #remember(id: string): Promise<void> {
    this.#failedAt.delete(id);
    try {
      await this.#memory.set(id);
    } catch {
      /* best effort */
    }
  }

  /**
   * Verifies one operator and checks its health, or returns it from the cache. Throws OperatorError or
   * BellowsVerifyError saying why it cannot be used. `need` overrides the pool's unit and mint: a key
   * present in `need` is used as given, so `{ unit: undefined }` asks for no unit at all.
   */
  async prepare(id: string, need: Requirements = {}): Promise<ReadyOperator> {
    const listed = this.#listed.get(id);
    if (!listed) throw new OperatorError('unknown_operator', `no operator ${id} in the list`);
    const unit = 'unit' in need ? need.unit : this.#opts.unit;
    const mint = 'mint' in need ? need.mint : this.#opts.mint;
    let ready = this.#ready.get(id);
    if (!ready) {
      ready = await this.#verify(listed);
      this.#ready.set(id, ready);
    }
    const a = ready.announcement;
    if (unit !== undefined && !a.units.includes(unit)) throw new OperatorError('not_accepted', `${a.url} does not keep balances in ${unit}`);
    if (mint !== undefined && !a.mints.includes(normalizeMint(mint))) throw new OperatorError('not_accepted', `${a.url} does not take eCash from ${mint}`);
    return ready;
  }

  async #verify(listed: OperatorAnnouncement): Promise<ReadyOperator> {
    const o = this.#opts;
    const route = o.route ?? 'relay-or-direct';
    if (route === 'onion' && !listed.onion) throw new OperatorError('not_accepted', `${listed.url} announces no onion address`);
    const at = route === 'onion' ? listed.onion! : listed.url;
    const verified = await verifyBellows(at, { approvedBuilds: o.approvedBuilds, verifier: o.verifier, allowDevelopment: o.allowDevelopment, fetch: o.fetch });

    // The attested statement must carry this operator's own announcement for this address.
    let attested: OperatorAnnouncement;
    try {
      attested = parseOperatorAnnouncement(verified.operator);
    } catch (e) {
      throw new OperatorError('announcement_mismatch', `${listed.url} serves no valid signed announcement in its attested identity (${e instanceof Error ? e.message : String(e)})`);
    }
    if (attested.pubkey !== listed.pubkey) throw new OperatorError('announcement_mismatch', `${listed.url} is announced by a different operator key than the one listed`);
    if (attested.url !== listed.url) throw new OperatorError('announcement_mismatch', `${listed.url} serves an announcement for ${attested.url}`);
    if (route === 'onion' && attested.onion !== listed.onion) throw new OperatorError('announcement_mismatch', `${listed.onion} serves an announcement for another onion address`);

    let relay: string | null = null;
    if (route === 'relay' || route === 'relay-or-direct') {
      relay = verified.relays[0] ?? null;
      if (route === 'relay' && !relay) throw new OperatorError('not_accepted', `${listed.url} lists no Oblivious HTTP relay`);
    }
    const endpoint: BellowsOperator = { origin: verified.origin, keyConfig: verified.keyConfig, relay };

    // Health, through the same path real requests take.
    let healthy = false;
    let why = '';
    try {
      const res = await bellowsFetch(endpoint, '/healthz', {}, { fetch: o.fetch });
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      healthy = res.status === 200 && body?.ok === true;
      why = `HTTP ${res.status}`;
    } catch (e) {
      why = reasonOf(e);
    }
    if (!healthy) throw new OperatorError('unhealthy', `${listed.url} failed its health check (${why})`);
    return { id: listed.id, announcement: attested, verified, endpoint };
  }

  /**
   * The first operator that passes every check, trying the remembered one first. Throws
   * OperatorError('no_operator') listing why each one was passed over.
   */
  async pick(need: Requirements = {}, o: { exclude?: readonly string[] } = {}): Promise<ReadyOperator> {
    const failures: { id: string; reason: string }[] = [];
    for (const id of await this.order()) {
      if (o.exclude?.includes(id)) continue;
      try {
        return await this.prepare(id, need);
      } catch (e) {
        if (!(e instanceof OperatorError && e.code === 'not_accepted')) this.markFailed(id);
        failures.push({ id, reason: reasonOf(e) });
      }
    }
    throw new OperatorError('no_operator', `no operator could be used${failures.length ? `: ${failures.map((f) => f.reason).join('; ')}` : ''}`, failures);
  }

  /**
   * Sends one API call through Oblivious HTTP to an operator. Returns the answer and the operator that gave
   * it, and remembers that operator. See PoolFetchOptions for when it fails over.
   *
   * A call pinned to an operator skips the pool's unit and mint: it reaches a balance that operator
   * already holds. A call that carries an authorization header (a balance key) must be pinned, so the key
   * never reaches an operator that did not issue it.
   */
  async fetch(path: string, init: RequestInit = {}, o: PoolFetchOptions = {}): Promise<{ response: Response; operator: ReadyOperator }> {
    if (!o.operator && new Headers(init.headers).has('authorization')) {
      throw new OperatorError('not_accepted', 'a call that carries a balance key must name its operator ({ operator: id })');
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const failover = o.operator ? false : (o.failover ?? (method === 'GET' || method === 'HEAD'));
    const failures: { id: string; reason: string }[] = [];
    const ids = o.operator ? [o.operator] : await this.order();
    for (const id of ids) {
      let op: ReadyOperator;
      try {
        op = await this.prepare(id, o.operator ? { unit: undefined, mint: undefined } : {});
      } catch (e) {
        // Nothing of the request was sent: always safe to go on to the next operator.
        if (!(e instanceof OperatorError && e.code === 'not_accepted')) this.markFailed(id);
        if (o.operator) throw e;
        failures.push({ id, reason: reasonOf(e) });
        continue;
      }
      let response: Response;
      try {
        response = await bellowsFetch(op.endpoint, path, init, { fetch: this.#opts.fetch });
      } catch (e) {
        if (e instanceof BellowsFetchError && (e.code === 'bad_path' || e.code === 'bad_request')) throw e;
        // The Bellows may have restarted with a new key: verify it again before its next use.
        this.markFailed(id);
        if (!failover) throw e;
        failures.push({ id, reason: reasonOf(e) });
        continue;
      }
      if (failover && FAILOVER_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        this.markFailed(id);
        failures.push({ id, reason: `HTTP ${response.status}` });
        continue;
      }
      if (response.status < 500) await this.#remember(id);
      return { response, operator: op };
    }
    throw new OperatorError('no_operator', `no operator answered${failures.length ? `: ${failures.map((f) => f.reason).join('; ')}` : ''}`, failures);
  }
}
