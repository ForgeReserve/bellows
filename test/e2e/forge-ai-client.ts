/**
 * The calls the Forge AI clients make to a gateway, copied without change: the same paths, methods, headers
 * and bodies, and the same response fields read back. docs/DESIGN.md, S8 runs them against a Bellows.
 *
 * Copied from the Forge AI web app (public/js/ui.js `api`, public/app.js `loadModels`, `refreshBalance`,
 * `generate` and `readStream`, public/js/wallet.js funding, refund and history steps) and from its agent
 * example (examples/agent-pays.ts, which pays per request and takes its change back).
 *
 * One thing is swapped: `fetch`. The app calls a path on its own origin, so `send(path, init)` delivers the
 * same path and init to a Bellows, either straight over HTTP or as Oblivious HTTP through a relay.
 *
 * The encrypted chat mode goes through Tinfoil's browser SDK, which cannot run here. `encryptedChat` sends
 * what the app hands the SDK's fetch plus the EHBP framing the SDK adds (an encapsulated key header and an
 * opaque body), so the gateway's side of that exchange is exercised; the SDK itself is not.
 */
import { getEncodedToken, PaymentRequest, type Proof, Wallet } from '@cashu/cashu-ts';

export type Send = (path: string, init: RequestInit) => Promise<Response>;

export interface ApiResult {
  res: Response;
  body: any;
}

/** The app's per-page state that the calls below read and write (public/app.js `S`). */
export interface AppState {
  key: string | null;
  invite: string | null;
  inviteOnly: boolean;
  unit: string | null;
  balanceMsub: number | null;
  availableMsub: number | null;
  models: any[];
  units: string[];
  mints: string[];
  /** A balance key the gateway stopped recognizing, kept aside (the app stores it as forge.unrecognizedKey). */
  unrecognizedKey: string | null;
}

/** The page's own cap on output tokens (public/app.js MAX_OUT). */
export const MAX_OUT = 4096;

export interface Reply {
  content: string;
  reasoning: string;
  usage: any;
  forge: any;
  error?: { message: string; code?: string; status?: number };
  /** The app offers "Add funds" for these errors. */
  fund?: boolean;
}

export function forgeAiApp(send: Send) {
  const S: AppState = { key: null, invite: null, inviteOnly: false, unit: null, balanceMsub: null, availableMsub: null, models: [], units: [], mints: [], unrecognizedKey: null };

  // ---------------------------------------------------------------- public/js/ui.js
  /** Fetch JSON from the gateway; returns {res, body}. Never throws for HTTP errors. */
  async function api(path: string, { key, json, method, signal }: { key?: string | null; json?: unknown; method?: string; signal?: AbortSignal } = {}): Promise<ApiResult> {
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await send(path, { method: method ?? (json !== undefined ? 'POST' : 'GET'), headers, body: json !== undefined ? JSON.stringify(json) : undefined, signal, cache: 'no-store' });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { res, body };
  }
  const errMsg = (r: ApiResult): string => r.body?.error?.message ?? `The gateway answered HTTP ${r.res.status}.`;

  // ---------------------------------------------------------------- public/app.js
  const setKey = (key: string | null) => {
    S.key = key;
    if (!key) S.unit = S.balanceMsub = S.availableMsub = null;
  };

  async function loadModels(): Promise<ApiResult> {
    const r = await api('/v1/models');
    const body = r.res.ok && r.body?.data ? r.body : null;
    S.models = body?.data ?? [];
    S.inviteOnly = !!body?.invite_only;
    S.units = body?.units ?? [];
    S.mints = body?.mints ?? [];
    return r;
  }

  async function refreshBalance(): Promise<ApiResult | undefined> {
    if (!S.key) return undefined;
    const r = await api('/v1/wallet', { key: S.key });
    if (r.res.ok) {
      S.unit = r.body.unit;
      S.balanceMsub = r.body.balance_msub;
      S.availableMsub = r.body.available_msub;
    } else if (r.res.status === 401) {
      // The gateway no longer knows this key: keep a copy aside, then start over.
      S.unrecognizedKey = S.key;
      setKey(null);
    }
    return r;
  }

  const isEncrypted = (m: any) => m?.tier === 'enclave' && m?.encrypted_passthrough;

  /** One chat turn as generate() sends it (plaintext mode): always streamed, usage included. */
  async function generate(modelId: string, messages: unknown[], { effort }: { effort?: string } = {}): Promise<Reply> {
    const model = S.models.find((m) => m.id === modelId);
    if (!model) throw new Error(`the gateway does not list ${modelId}`);
    const reply: Reply = { content: '', reasoning: '', usage: null, forge: null };
    const maxTokens = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
    const payload: Record<string, unknown> = { model: model.id, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens };
    if (effort) payload.reasoning_effort = effort;
    const body = JSON.stringify(payload);
    try {
      const res = await send('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${S.key}` }, body });
      if (!res.ok) {
        let e: any = {};
        try {
          e = ((await res.json()) as any).error ?? {};
        } catch {
          /* not JSON */
        }
        const err: any = new Error(e.message ?? `The gateway answered HTTP ${res.status}.`);
        err.code = e.code;
        err.status = res.status;
        throw err;
      }
      await readStream(
        res,
        (d) => (reply.content += d),
        (r) => (reply.reasoning += r),
        (u) => (reply.usage = u),
        (f) => (reply.forge = f),
      );
    } catch (e: any) {
      reply.error = { message: e.message, code: e.code, status: e.status };
      reply.fund = e.code === 'insufficient_balance' || e.status === 402 || e.code === 'invalid_key';
    }
    if (reply.forge?.balance_msub != null) S.balanceMsub = reply.forge.balance_msub;
    await refreshBalance();
    return reply;
  }

  /**
   * Encrypted mode: the app calls the Tinfoil SDK's fetch('chat/completions', ...) with baseURL
   * `${origin}/v1/`, and the SDK sends the body HPKE-sealed (EHBP) with its encapsulated key in a header.
   */
  function encryptedChat(model: any, ehbp: { encapsulatedKey: string; body: Uint8Array; accept?: string }): Promise<Response> {
    const maxTokens = Math.min(MAX_OUT, model.max_output_tokens ?? MAX_OUT);
    const appHeaders = { 'content-type': 'application/json', authorization: `Bearer ${S.key}`, 'X-Tinfoil-Model': model.upstream_model, 'X-Tinfoil-Max-Output-Tokens': String(maxTokens) };
    const sdkHeaders = { 'Ehbp-Encapsulated-Key': ehbp.encapsulatedKey, ...(ehbp.accept ? { accept: ehbp.accept } : {}) };
    return send('/v1/chat/completions', { method: 'POST', headers: { ...appHeaders, ...sdkHeaders }, body: ehbp.body as BodyInit });
  }

  // ---------------------------------------------------------------- public/js/wallet.js
  const inviteFor = () => (!S.key && S.inviteOnly ? S.invite || undefined : undefined);
  /** A funding answer that carries a key opens the balance in the app. */
  const absorb = (f: any) => {
    if (f?.key && f.key !== S.key) setKey(f.key);
  };

  const wallet = {
    methods: () => api('/v1/wallet/fund/methods'),

    /** The eCash step: paste a token. */
    async topup(token: string): Promise<ApiResult> {
      const r = await api('/v1/wallet/topup', { key: S.key, json: { token, invite: inviteFor() } });
      if (r.body?.key) setKey(r.body.key);
      if (r.res.ok) await refreshBalance();
      return r;
    },

    /** Paste a balance key. */
    async useKey(k: string): Promise<ApiResult> {
      const r = await api('/v1/wallet', { key: k });
      if (r.res.ok) {
        setKey(k);
        await refreshBalance();
      }
      return r;
    },

    async lightning(amount: number, unit: string): Promise<ApiResult> {
      const r = await api('/v1/wallet/fund/lightning', { key: S.key, json: { amount, unit, invite: inviteFor() } });
      if (r.body?.key) setKey(r.body.key);
      if (r.res.ok) absorb(r.body);
      return r;
    },

    async onchain(): Promise<ApiResult> {
      const r = await api('/v1/wallet/fund/onchain', { key: S.key, json: { invite: inviteFor() } });
      if (r.body?.key) setKey(r.body.key);
      if (r.res.ok) absorb(r.body);
      return r;
    },

    /** One tick of poll(): GET /v1/wallet/fund/:id. */
    async status(id: string): Promise<ApiResult> {
      const r = await api(`/v1/wallet/fund/${encodeURIComponent(id)}`, { key: S.key });
      if (r.res.ok && r.body) absorb(r.body);
      return r;
    },

    /** The "Accepted mints" list of the Other mint step. */
    acceptedMints: (F: any) => api(F.mints_url || '/v1/wallet/fund/mints'),

    async foreignQuote(token: string, unit: string, { lockKey, acceptUnlisted }: { lockKey?: string; acceptUnlisted?: boolean } = {}): Promise<ApiResult> {
      const r = await api('/v1/wallet/fund/foreign/quote', { key: S.key, json: { token, unit, invite: inviteFor(), pubkey: lockKey || undefined, ...(acceptUnlisted ? { accept_unlisted: true } : {}) } });
      if (r.body?.key) setKey(r.body.key);
      if (r.res.ok) absorb(r.body);
      return r;
    },

    async foreignConfirm(id: string, token: string): Promise<ApiResult> {
      const r = await api('/v1/wallet/fund/foreign/confirm', { key: S.key, json: { id, token } });
      if (r.res.ok) absorb(r.body);
      return r;
    },

    refundableNow: () => Math.floor((S.availableMsub ?? S.balanceMsub ?? 0) / 1000),

    async refund(n: number, lockKey?: string): Promise<ApiResult> {
      const pk = lockKey;
      const r = await api('/v1/wallet/refund', { key: S.key, json: { amount: n, pubkey: pk || undefined } });
      if (r.res.ok || r.res.status === 202) await refreshBalance();
      return r;
    },

    /** "Recent activity": fundings and refunds side by side. */
    history: () => Promise.all([api('/v1/wallet/fund', { key: S.key }).catch(() => null), api('/v1/wallet/refunds', { key: S.key }).catch(() => null)]),
  };

  /** Polls a funding the way poll() does until it reaches a terminal state, and returns the last answer. */
  async function pollUntil(id: string, terminal: (x: any) => boolean, { everyMs = 100, tries = 150, between }: { everyMs?: number; tries?: number; between?: () => Promise<void> } = {}): Promise<any> {
    for (let i = 0; i < tries; i++) {
      const r = await wallet.status(id);
      if (r.res.ok && r.body && terminal(r.body)) return r.body;
      await between?.();
      await new Promise((ok) => setTimeout(ok, everyMs));
    }
    throw new Error(`funding ${id} did not reach the state the app waits for`);
  }

  return { S, api, errMsg, loadModels, refreshBalance, isEncrypted, generate, encryptedChat, wallet, pollUntil, setInvite: (code: string) => (S.invite = code) };
}

/** public/app.js readStream: OpenAI deltas, reasoning, usage, and the gateway's `event: forge`. */
export async function readStream(res: Response, onDelta: (d: string) => void, onReasoning: (r: string) => void, onUsage: (u: any) => void, onForge: (f: any) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const lines = block.split(/\r?\n/);
      const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let o: any;
      try {
        o = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev === 'forge') {
        onForge(o);
        continue;
      }
      if (o.error) throw new Error(o.error.message ?? 'The stream failed.');
      if (o.usage) onUsage(o.usage);
      const d = o.choices?.[0]?.delta;
      if (!d) continue;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) onReasoning(r);
      if (typeof d.content === 'string' && d.content) onDelta(d.content);
    }
  }
}

export interface AgentRun {
  first: Response;
  pr: PaymentRequest;
  paid: Response;
  json: any;
  changeToken: string | null;
  /** Change redeemed back into the agent's wallet, in whole units. */
  change: number;
  /** What the agent's wallet holds at the end, in whole units (examples/agent-pays.ts hands it back). */
  kept: number;
  wallet: Wallet;
}

/**
 * examples/agent-pays.ts with DEMO_FAKE_MINT (eCash minted at a FakeWallet test mint named in the 402):
 * ask without paying, pay the NUT-18 request with X-Cashu, read the answer and take the change back.
 * With lockPub the change is locked to that key (X-Cashu-Pubkey) and redeemed with lockPriv. maxTokens is
 * the example's MAX_TOKENS (default 512).
 */
export async function agentPays(send: Send, opts: { model: string; prompt: string; invite?: string; unit?: string; lockPub?: string; lockPriv?: string; maxTokens?: number }): Promise<AgentRun> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.invite) headers['X-Forge-Invite'] = opts.invite;
  if (opts.unit) headers['X-Forge-Unit'] = opts.unit;
  if (opts.lockPub) headers['X-Cashu-Pubkey'] = opts.lockPub;
  const body = JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: opts.prompt }], max_tokens: opts.maxTokens ?? 512 });

  // 1. Ask without paying.
  const first = await send('/v1/chat/completions', { method: 'POST', headers, body });
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}: ${await first.text()}`);
  const pr = PaymentRequest.fromEncodedRequest(first.headers.get('x-cashu')!);
  await first.body?.cancel().catch(() => {});
  const amount = pr.amount!.toNumber();

  // 2. Get proofs worth exactly `amount` at an accepted mint (DEMO_FAKE_MINT).
  const wallet = new Wallet(pr.mints![0]!, { unit: pr.unit });
  await wallet.loadMint();
  const q = await wallet.createMintQuoteBolt11(amount + 10);
  await new Promise((r) => setTimeout(r, 300)); // FakeWallet pays the quote itself
  const proofs: Proof[] = await wallet.mintProofsBolt11(amount + 10, q.quote);
  const { send: toSend, keep } = await wallet.send(amount, proofs, { includeFees: true });
  const payment = getEncodedToken({ mint: wallet.mint.mintUrl, unit: pr.unit, proofs: toSend });

  // 3. Retry with the payment.
  const paid = await send('/v1/chat/completions', { method: 'POST', headers: { ...headers, 'X-Cashu': payment }, body });
  const json = await paid.json();
  if (!paid.ok) throw new Error(`payment rejected: ${paid.status} ${JSON.stringify(json)}`);

  // 4. Take the change back.
  let change = 0;
  const changeToken = paid.headers.get('x-cashu-change');
  if (changeToken && !(opts.lockPub && !opts.lockPriv)) {
    const back = await wallet.receive(changeToken, opts.lockPriv ? { privkey: opts.lockPriv } : undefined);
    change = back.reduce((s, p) => s + p.amount.toNumber(), 0);
    keep.push(...back);
  }
  const kept = keep.reduce((s, p) => s + p.amount.toNumber(), 0);
  return { first, pr, paid, json, changeToken, change, kept, wallet };
}
