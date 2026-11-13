/**
 * Forge AI fit (docs/DESIGN.md, S8): the Forge AI clients' calls, unchanged (forge-ai-client.ts), against a
 * Bellows directly and through Oblivious HTTP, on the local test mints.
 *
 * Each transport runs the same story: the app boots (models, funding methods), opens a balance with eCash,
 * loads a key, funds by Lightning, by eCash from another mint (with change) and on-chain, chats (streamed, with
 * reasoning, and encrypted pass-through), refunds (plain and locked to the user's key), shows its history and
 * handles an unknown key and an empty balance; the agent example pays per request and takes its change back,
 * plain and locked. The Bellows is set up as a Forge AI deployment runs it: invite only, proof of work off.
 *
 * Through OHTTP the test also checks that every call really travelled encapsulated: the Bellows received
 * nothing but POST /ohttp from the relay.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bellowsFetch, devVerifier, verifyBellows } from '../../client/index.ts';
import { createRelay } from '../../relay/relay.ts';
import { devMeasurement } from '../../src/attest/dev.ts';
import { BELLOWS_VERSION } from '../../src/config.ts';
import { solvePow } from '../../client/pow.ts';
import { agentPays, forgeAiApp, type Send } from './forge-ai-client.ts';
import { createInvite, expectedMsub, type Gateway, MINT_A, MINT_C, mintToken, mintsUp, redeem, startGateway, userWallet } from './helpers.ts';
import { type OnchainMock, startOnchainMock } from './onchain-mock.ts';

const up = (await mintsUp()) && (await fetch(`${MINT_C}/v1/info`).then((r) => r.ok).catch(() => false));
const devBuilds = { format: 'bellows-builds/v1', builds: [{ version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement() }] };
/** A Forge AI deployment: invite only (the startGateway default), proof of work off, other-mint funding from the local plain-http mint. */
const FORGE_ENV = { BELLOWS_POW_BITS: '0', BELLOWS_FOREIGN_ALLOW_INSECURE: 'true', BELLOWS_ONCHAIN_ENABLED: 'true' };
const TERMINAL = new Set(['done', 'expired', 'failed', 'refunded']);
const messages = [{ role: 'user', content: 'Say hello' }];

function keypair() {
  const priv = randomBytes(32);
  return { priv: priv.toString('hex'), pub: Buffer.from(getPubKeyFromPrivKey(priv)).toString('hex') };
}

/** A model enclave stand-in: answers EHBP requests with opaque bytes and reports usage as Tinfoil does. */
interface FakeEnclave {
  port: number;
  seen: Buffer[];
  reply: Buffer;
  hpkeKeys: Buffer;
  close(): Promise<void>;
}
const ENCLAVE_USAGE = 'prompt=50,completion=7,total=57,model=enc-model,cost_usd=0.0001';
async function startEnclave(): Promise<FakeEnclave> {
  const e = { seen: [] as Buffer[], reply: randomBytes(7 * 44), hpkeKeys: randomBytes(41) };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/hpke-keys') {
      res.writeHead(200, { 'content-type': 'application/ohttp-keys' });
      return res.end(e.hpkeKeys);
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      e.seen.push(Buffer.concat(chunks));
      if (String(req.headers.accept).includes('text/event-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'ehbp-response-nonce': 'ab'.repeat(32), trailer: 'X-Tinfoil-Usage-Metrics' });
        let i = 0;
        const tick = () => {
          if (i < 7) {
            res.write(e.reply.subarray(i * 44, (i + 1) * 44));
            i++;
            setTimeout(tick, 5);
          } else {
            res.addTrailers({ 'X-Tinfoil-Usage-Metrics': ENCLAVE_USAGE });
            res.end();
          }
        };
        tick();
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': ENCLAVE_USAGE });
        res.end(e.reply);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { ...e, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface Rig {
  /** The Bellows the app talks to, and the one with an on-chain funding mint. */
  g: Gateway;
  onchain: Gateway;
  mock: OnchainMock;
  enclave: FakeEnclave;
  send: Send;
  sendOnchain: Send;
  /** Method and path of every HTTP request each Bellows received after setup. */
  seen: Map<Gateway, string[]>;
  close(): Promise<void>;
}

/** An ordinary HTTP origin: the app's relative path on the Bellows' origin. */
const direct = (g: Gateway): Send => (path, init) => fetch(g.url + path, init);

async function startRig(mode: 'direct' | 'ohttp'): Promise<Rig> {
  const enclave = await startEnclave();
  const mock = await startOnchainMock(MINT_A);
  const g = await startGateway({ enclavePort: enclave.port, env: FORGE_ENV });
  const onchain = await startGateway({ env: { ...FORGE_ENV, BELLOWS_TRUSTED_MINTS: mock.url } });
  let relayServer: ServerType | undefined;
  let send = direct(g);
  let sendOnchain = direct(onchain);
  if (mode === 'ohttp') {
    const relay = createRelay({ targets: [`${g.url}/ohttp`, `${onchain.url}/ohttp`] });
    relayServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: relay, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    const relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;
    const through = async (b: Gateway): Promise<Send> => {
      const verified = await verifyBellows(b.url, { approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true });
      const operator = { ...verified, relay: `${relayUrl}/relay/${new URL(b.url).host}` };
      return (path, init) => bellowsFetch(operator, path, init);
    };
    send = await through(g);
    sendOnchain = await through(onchain);
  }
  const seen = new Map<Gateway, string[]>([
    [g, []],
    [onchain, []],
  ]);
  for (const [b, list] of seen) b.server.on('request', (req: http.IncomingMessage) => list.push(`${req.method} ${req.url}`));
  return {
    g,
    onchain,
    mock,
    enclave,
    send,
    sendOnchain,
    seen,
    async close() {
      await new Promise<void>((r) => (relayServer ? relayServer.close(() => r()) : r()));
      await g.close();
      await onchain.close();
      await mock.close();
      await enclave.close();
    },
  };
}

describe.skipIf(!up).each(['direct', 'ohttp'] as const)('Forge AI clients, unchanged, against a Bellows (%s)', (mode) => {
  let rig: Rig;
  let app: ReturnType<typeof forgeAiApp>;
  let balanceAfterTopup: number;

  beforeAll(async () => {
    rig = await startRig(mode);
    app = forgeAiApp(rig.send);
  });
  afterAll(() => rig?.close());

  it('boots: lists models with what the model picker reads', async () => {
    const r = await app.loadModels();
    expect(r.res.status).toBe(200);
    expect(app.S.inviteOnly).toBe(true);
    expect(app.S.units).toEqual(['usd', 'sat']);
    expect(app.S.mints).toEqual([MINT_A]);
    const echo = app.S.models.find((m) => m.id === 'mock-echo');
    expect(echo).toMatchObject({ tier: 'standard', uncensored: false, max_output_tokens: 256, capabilities: { vision: false, reasoning: false } });
    expect(echo.pricing.usd_per_mtok).toEqual({ input: 100, output: 1000 });
    expect(echo.pricing.sat_per_mtok.input).toBeGreaterThan(0);
    const think = app.S.models.find((m) => m.id === 'mock-think');
    expect(think.capabilities).toMatchObject({ reasoning: true, reasoning_efforts: ['low', 'high'] });
    const enc = app.S.models.find((m) => m.id === 'tinfoil/enc-model');
    expect(app.isEncrypted(enc)).toBe(true);
    expect(enc.upstream_model).toBe('enc-model');
  });

  it('reads the funding methods the wallet offers', async () => {
    const r = await app.wallet.methods();
    expect(r.res.status).toBe(200);
    const m = r.body;
    expect(m.invite_only).toBe(true);
    expect(m.ecash.mints).toEqual([MINT_A]);
    expect(m.lightning).toMatchObject({ enabled: true });
    expect([...m.lightning.units].sort()).toEqual(['sat', 'usd']);
    expect(m.lightning.min.usd).toBeGreaterThanOrEqual(1);
    expect(m.lightning.max.usd).toBeGreaterThan(m.lightning.min.usd);
    expect(m.foreign).toMatchObject({ enabled: true, policy: 'any', mints_url: '/v1/wallet/fund/mints' });
    expect(m.foreign.max.sat).toBeGreaterThan(0);
    // The test mint has no on-chain support, so the method is off here even though the operator enabled it.
    expect(m.onchain.enabled).toBe(false);
  });

  it('a new balance without an invite is refused with a message the app shows', async () => {
    const r = await app.wallet.topup(await mintToken(MINT_A, 'usd', 5));
    expect(r.res.status).toBe(403);
    expect(r.body.error.code).toBe('invite_required');
    expect(app.errMsg(r)).toMatch(/invite/);
    expect(app.S.key).toBeNull();
  });

  it('eCash: opens a balance with an invite and a token, and a second paste of it is a replay', async () => {
    app.setInvite(createInvite(rig.g));
    const token = await mintToken(MINT_A, 'usd', 100);
    const r = await app.wallet.topup(token);
    expect(r.res.status).toBe(200);
    expect(r.body).toMatchObject({ credited: 100, unit: 'usd', replay: false });
    expect(app.S.key).toMatch(/^sk-forge-[A-Za-z0-9_-]{24,64}$/);
    expect(app.S).toMatchObject({ unit: 'usd', balanceMsub: 100_000, availableMsub: 100_000 });
    const again = await app.wallet.topup(token);
    expect(again.res.status).toBe(200);
    expect(again.body).toMatchObject({ replay: true, credited: 0 });
    balanceAfterTopup = app.S.balanceMsub!;
  });

  it('loads a balance key pasted into another device', async () => {
    const other = forgeAiApp(rig.send);
    const r = await other.wallet.useKey(app.S.key!);
    expect(r.res.status).toBe(200);
    expect(other.S).toMatchObject({ key: app.S.key, unit: 'usd', balanceMsub: balanceAfterTopup });
    const bad = await other.wallet.useKey(`sk-forge-${'x'.repeat(40)}`);
    expect(bad.res.status).toBe(401);
  });

  it('Lightning: an invoice on the balance, paid, polled until credited', async () => {
    const r = await app.wallet.lightning(25, 'usd');
    expect(r.res.status).toBe(200);
    expect(r.body.key).toBeUndefined();
    expect(r.body).toMatchObject({ method: 'lightning', state: 'pending', unit: 'usd', amount: 25 });
    expect(r.body.request).toMatch(/^lnbc/);
    expect(r.body.expires_at).toBeGreaterThan(Date.now());
    const done = await app.pollUntil(r.body.id, (x) => TERMINAL.has(x.state));
    expect(done).toMatchObject({ state: 'done', credited: 25, unit: 'usd' });
    await app.refreshBalance();
    expect(app.S.balanceMsub).toBe(balanceAfterTopup + 25_000);
  });

  it('Lightning: a new balance opened by an invoice gets its key from the answer', async () => {
    const fresh = forgeAiApp(rig.send);
    await fresh.loadModels();
    fresh.setInvite(createInvite(rig.g));
    const r = await fresh.wallet.lightning(10, 'sat');
    expect(r.res.status).toBe(200);
    expect(r.body.key).toMatch(/^sk-forge-/);
    expect(fresh.S.key).toBe(r.body.key);
    const done = await fresh.pollUntil(r.body.id, (x) => TERMINAL.has(x.state));
    expect(done).toMatchObject({ state: 'done', credited: 10, unit: 'sat' });
  });

  it('other mint: lists accepted mints, quotes, confirms, credits, and returns the change as eCash', async () => {
    const F = (await app.wallet.methods()).body.foreign;
    const list = await app.wallet.acceptedMints(F);
    expect(list.res.status).toBe(200);
    expect(list.body).toMatchObject({ enabled: true, policy: 'any' });
    expect(Array.isArray(list.body.mints)).toBe(true);

    const before = app.S.balanceMsub!;
    const token = await mintToken(MINT_C, 'sat', 1000);
    const q = await app.wallet.foreignQuote(token, app.S.unit!);
    expect(q.res.status).toBe(200);
    expect(q.body).toMatchObject({ method: 'foreign', state: 'quoted', unit: 'usd' });
    const f = q.body.foreign;
    expect(f).toMatchObject({ mint: MINT_C, unit: 'sat', token_amount: 1000, unlisted: false, locked_to: null });
    expect(f.credit).toBeGreaterThan(0);
    expect(f.fee_max).toBeGreaterThan(0);
    expect(q.body.expires_at).toBeGreaterThan(Date.now());

    const c = await app.wallet.foreignConfirm(q.body.id, token);
    expect(c.res.status).toBe(200);
    const done = TERMINAL.has(c.body.state) && !c.body.foreign.payout_pending ? c.body : await app.pollUntil(q.body.id, (x) => TERMINAL.has(x.state) && !x.foreign?.payout_pending);
    expect(done).toMatchObject({ state: 'done', credited: f.credit, unit: 'usd' });
    expect(done.foreign.change_token).toMatch(/^cashuB/);
    expect(await redeem(done.foreign.change_token, MINT_C, 'sat')).toBeGreaterThan(0);
    await app.refreshBalance();
    expect(app.S.balanceMsub).toBe(before + f.credit * 1000);
  });

  it('on-chain: a deposit address opens a sat balance, and a deposit is credited', async () => {
    const chain = forgeAiApp(rig.sendOnchain);
    await chain.loadModels();
    const methods = (await chain.wallet.methods()).body;
    expect(methods.onchain).toMatchObject({ enabled: true, unit: 'sat', min_amount: 1000, confirmations: 3 });
    chain.setInvite(createInvite(rig.onchain));
    const r = await chain.wallet.onchain();
    expect(r.res.status).toBe(200);
    expect(r.body).toMatchObject({ method: 'onchain', state: 'pending', unit: 'sat', credited: 0, expires_at: null });
    expect(r.body.request).toMatch(/^bcrt1q/);
    expect(r.body.onchain.confirmations_required).toBe(3);
    expect(chain.S.key).toBe(r.body.key);
    // The deposit confirms at the mint, and the gateway's poller mints it.
    const quote = rig.onchain.deps.funding.get(r.body.id)!.quote!;
    rig.mock.pay(quote, 20_000);
    await rig.onchain.deps.funding.advance(r.body.id);
    const s = await chain.wallet.status(r.body.id);
    expect(s.body).toMatchObject({ state: 'pending', credited: 20_000 });
    expect(s.body.onchain.paid_sat).toBe(20_000);
    await chain.refreshBalance();
    expect(chain.S).toMatchObject({ unit: 'sat', balanceMsub: 20_000_000 });
  });

  it('chat: streams an answer, its usage and the settlement event, and the balance follows', async () => {
    const before = app.S.balanceMsub!;
    const reply = await app.generate('mock-echo', messages);
    expect(reply.error).toBeUndefined();
    expect(reply.content).toMatch(/^Hello( word)+$/);
    expect(reply.usage.completion_tokens).toBe(12);
    expect(reply.usage.prompt_tokens).toBeGreaterThan(0);
    expect(reply.forge).toMatchObject({ unit: 'usd' });
    expect(reply.forge.request_id).toMatch(/^req_/);
    expect(reply.forge.charged_msub).toBe(expectedMsub(reply.usage.prompt_tokens, reply.usage.completion_tokens));
    expect(reply.forge.balance_msub).toBe(before - reply.forge.charged_msub);
    expect(app.S.balanceMsub).toBe(reply.forge.balance_msub);
  });

  it('chat: a reasoning model streams its reasoning apart from the answer', async () => {
    const reply = await app.generate('mock-think', messages, { effort: 'low' });
    expect(reply.error).toBeUndefined();
    expect(reply.reasoning).toBe('The user asked a question. I will answer with a short example.');
    expect(reply.content.length).toBeGreaterThan(0);
    expect(reply.forge.charged_msub).toBeGreaterThan(0);
  });

  it('encrypted chat: the sealed body passes through unread, with the nonce, and is billed from usage', async () => {
    const keys = await rig.send('/.well-known/hpke-keys', {});
    expect(keys.status).toBe(200);
    expect(Buffer.from(await keys.arrayBuffer())).toEqual(rig.enclave.hpkeKeys);

    const model = app.S.models.find((m) => m.id === 'tinfoil/enc-model');
    const before = app.S.balanceMsub!;
    const sealed = randomBytes(300);
    const res = await app.encryptedChat(model, { encapsulatedKey: 'ee'.repeat(32), body: sealed });
    expect(res.status).toBe(200);
    expect(res.headers.get('ehbp-response-nonce')).toBe('cd'.repeat(32));
    expect(res.headers.get('x-forge-privacy')).toBe('enclave-encrypted');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(rig.enclave.reply);
    expect(rig.enclave.seen.at(-1)).toEqual(sealed);
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(expectedMsub(50, 7));
    await app.refreshBalance();
    expect(app.S.balanceMsub).toBe(before - expectedMsub(50, 7));

    const streamed = await app.encryptedChat(model, { encapsulatedKey: 'ee'.repeat(32), body: randomBytes(120), accept: 'text/event-stream' });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('ehbp-response-nonce')).toBe('ab'.repeat(32));
    expect(Buffer.from(await streamed.arrayBuffer())).toEqual(rig.enclave.reply);
  });

  it('refunds: plain and locked to the wallet key, both redeemable, and listed in the history', async () => {
    await app.refreshBalance();
    expect(app.wallet.refundableNow()).toBeGreaterThan(2);
    const plain = await app.wallet.refund(2);
    expect(plain.res.status).toBe(200);
    expect(plain.body).toMatchObject({ amount: 2, unit: 'usd', status: 'done', locked_to: null, mint: MINT_A });
    expect(await redeem(plain.body.token)).toBe(2);

    const k = keypair();
    const locked = await app.wallet.refund(1, k.pub);
    expect(locked.res.status).toBe(200);
    expect(locked.body).toMatchObject({ amount: 1, unit: 'usd', locked_to: k.pub });
    const w = await userWallet(MINT_A, 'usd');
    await expect(w.receive(locked.body.token)).rejects.toThrow();
    const got = await w.receive(locked.body.token, { privkey: k.priv });
    expect(got.reduce((s, p) => s + p.amount.toNumber(), 0)).toBe(1);

    const [fund, refunds] = await app.wallet.history();
    expect(fund!.res.status).toBe(200);
    const methods = fund!.body.data.map((x: any) => `${x.method}:${x.state}`);
    expect(methods).toEqual(expect.arrayContaining(['lightning:done', 'foreign:done']));
    expect(refunds!.res.status).toBe(200);
    const rows = refunds!.body.data.map((x: any) => ({ amount: x.amount, unit: x.unit, status: x.status, locked_to: x.locked_to }));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { amount: 2, unit: 'usd', status: 'done', locked_to: null },
        { amount: 1, unit: 'usd', status: 'done', locked_to: k.pub },
      ]),
    );
    expect(refunds!.body.data.every((x: any) => typeof x.token === 'string')).toBe(true);
  });

  it('an empty balance: the chat asks to add funds', async () => {
    const all = await app.wallet.refund(app.wallet.refundableNow());
    expect(all.res.status).toBe(200);
    expect(await redeem(all.body.token)).toBe(all.body.amount);
    expect(app.wallet.refundableNow()).toBe(0);
    const reply = await app.generate('mock-echo', messages);
    expect(reply.error).toMatchObject({ code: 'insufficient_balance', status: 402 });
    expect(reply.fund).toBe(true);
  });

  it('a key the gateway does not know: the app sets it aside and starts over', async () => {
    const lost = forgeAiApp(rig.send);
    await lost.loadModels();
    const key = `sk-forge-${randomBytes(24).toString('base64url')}`;
    lost.S.key = key;
    const reply = await lost.generate('mock-echo', messages);
    expect(reply.error).toMatchObject({ code: 'invalid_key', status: 401 });
    expect(reply.fund).toBe(true);
    expect(lost.S.key).toBeNull();
    expect(lost.S.unrecognizedKey).toBe(key);
  });

  it('agent example: pays one request with eCash and takes its change back', async () => {
    const run = await agentPays(rig.send, { model: 'mock-echo', prompt: 'What is eCash?', invite: createInvite(rig.g), maxTokens: 64 });
    expect(run.pr.unit).toBe('usd');
    expect(run.pr.mints).toEqual([MINT_A]);
    expect(run.paid.status).toBe(200);
    expect(run.json.choices[0].message.content).toMatch(/^Hello/);
    const charged = Number(run.paid.headers.get('x-forge-charged-msub'));
    expect(charged).toBeGreaterThan(0);
    expect(run.changeToken).toMatch(/^cashuB/);
    expect(run.change).toBe(run.pr.amount!.toNumber() - Math.ceil(charged / 1000));
    // Change is delivered again from the change URL to whoever holds the request id.
    const url = run.paid.headers.get('x-forge-change-url')!;
    expect(url).toBe(`/v1/change/${run.paid.headers.get('x-forge-request-id')}`);
    const again = await rig.send(url, {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).token).toBe(run.changeToken);
  });

  it('agent example: change locked to the agent key, redeemed with its private key', async () => {
    const k = keypair();
    const run = await agentPays(rig.send, { model: 'mock-echo', prompt: 'What is eCash?', invite: createInvite(rig.g), lockPub: k.pub, lockPriv: k.priv, maxTokens: 64 });
    expect(run.paid.status).toBe(200);
    expect(run.change).toBeGreaterThan(0);
    const w = await userWallet(MINT_A, 'usd');
    const secrets = w.decodeToken(run.changeToken!).proofs.map((p) => JSON.parse(p.secret));
    expect(secrets.every((s) => s[0] === 'P2PK' && s[1].data === k.pub)).toBe(true);
  });

  it(mode === 'ohttp' ? 'every call travelled encapsulated: the Bellows received only POST /ohttp' : 'every call reached the Bellows as plain HTTP', () => {
    const all = [...rig.seen.get(rig.g)!, ...rig.seen.get(rig.onchain)!];
    expect(all.length).toBeGreaterThan(20);
    if (mode === 'ohttp') expect(new Set(all)).toEqual(new Set(['POST /ohttp']));
    else expect(all.some((x) => x === 'POST /ohttp')).toBe(false);
  });
});

describe.skipIf(!up)('Forge AI web app from another origin, directly (CORS)', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: FORGE_ENV });
  });
  afterAll(() => g.close());
  const ORIGIN = 'https://app.example';

  it('allows every header the app and its encryption SDK send, and exposes every header they read', async () => {
    const pre = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-tinfoil-model,x-tinfoil-max-output-tokens,ehbp-encapsulated-key,x-cashu,x-cashu-pubkey,x-forge-invite,x-forge-unit,x-bellows-pow',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const allowed = pre.headers.get('access-control-allow-headers')!.toLowerCase().split(',');
    for (const h of ['authorization', 'content-type', 'x-tinfoil-model', 'x-tinfoil-max-output-tokens', 'ehbp-encapsulated-key', 'x-cashu', 'x-cashu-pubkey', 'x-forge-invite', 'x-forge-unit', 'x-bellows-pow']) {
      expect(allowed, h).toContain(h);
    }
    const res = await fetch(`${g.url}/v1/models`, { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const chat = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forge-invite': createInvite(g) }, body: JSON.stringify({ model: 'mock-echo', messages, max_tokens: 64 }) });
    expect(chat.status).toBe(402);
    const exposed = chat.headers.get('access-control-expose-headers')!.toLowerCase().split(',');
    for (const h of ['x-cashu', 'x-cashu-change', 'x-forge-request-id', 'x-forge-unit', 'x-forge-charged-msub', 'x-forge-balance-msub', 'x-forge-change-url', 'x-forge-privacy', 'ehbp-response-nonce', 'retry-after', 'x-bellows-pow-challenge']) {
      expect(exposed, h).toContain(h);
    }
  });

  it('the enclave key and attestation paths the encryption SDK reads are open to any origin', async () => {
    for (const path of ['/.well-known/hpke-keys', '/attestation', '/.well-known/bellows']) {
      const res = await fetch(`${g.url}${path}`, { headers: { origin: ORIGIN } });
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });
});

describe.skipIf(!up)('Forge AI web app against the default proof of work', () => {
  let g: Gateway;
  beforeAll(async () => {
    // BELLOWS_POW_BITS left at its default (16).
    g = await startGateway({ env: { BELLOWS_POW_BITS: '16' } });
  });
  afterAll(() => g.close());

  it('cannot open a new balance (428 pow_required), and everything on an existing key works', async () => {
    const app = forgeAiApp(direct(g));
    await app.loadModels();
    app.setInvite(createInvite(g));
    const opened = await app.wallet.topup(await mintToken(MINT_A, 'usd', 20));
    expect(opened.res.status).toBe(428);
    expect(opened.body.error.code).toBe('pow_required');
    expect(app.errMsg(opened)).toMatch(/proof of work/);

    // A balance opened by a client that solves the proof of work, then used from the unchanged app.
    const body = JSON.stringify({ token: await mintToken(MINT_A, 'usd', 50), invite: createInvite(g) });
    const ask = (await (await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json()) as any;
    const solved = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bellows-pow': await solvePow(ask.pow.challenge, ask.pow.bits) }, body });
    const key = ((await solved.json()) as any).key as string;
    expect((await app.wallet.useKey(key)).res.status).toBe(200);
    expect((await app.wallet.topup(await mintToken(MINT_A, 'usd', 5))).res.status).toBe(200);
    const reply = await app.generate('mock-echo', messages);
    expect(reply.error).toBeUndefined();
    expect((await app.wallet.refund(1)).res.status).toBe(200);
  });
});
