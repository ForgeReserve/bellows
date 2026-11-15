/**
 * Optional live smoke test against Token Factory. Runs only when TOKENFACTORY_API_KEY is set
 * (pnpm test:live loads .env if present). Keeps calls tiny: glm-5.3-flash, max_tokens 16.
 * Never prints the key, prompts or completions; asserts on shapes and usage numbers only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import catalogJson from '../../config/models.json' with { type: 'json' };
import { captureLogs, createInvite, type Gateway, MINT_A, mintToken, mintsUp, readSse, startGatewayWithCatalog } from '../e2e/helpers.ts';

const KEY = process.env.TOKENFACTORY_API_KEY;
const BASE = 'https://gateway.trytokenfactory.dev/v1';
const MODEL = 'glm-5.3-flash';
const up = KEY ? await mintsUp() : false;
if (!KEY) console.warn('TOKENFACTORY_API_KEY not set: skipping live Token Factory tests');

describe.skipIf(!KEY)('Token Factory live: upstream', () => {
  it('GET /v1/models lists the configured models', async () => {
    const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const ids: string[] = (await res.json()).data.map((m: any) => m.id);
    const configured = catalogJson.models.filter((m) => m.supplier === 'tokenfactory').map((m) => m.upstream);
    const missing = configured.filter((id) => !ids.includes(id));
    console.log(`upstream lists ${ids.length} models; configured missing upstream: ${missing.length ? missing.join(', ') : 'none'}`);
    expect(ids).toContain(MODEL);
  });
});

describe.skipIf(!KEY || !up)('Token Factory live: through the gateway', () => {
  let g: Gateway;
  let key: string;
  beforeAll(async () => {
    const tf = catalogJson.models.find((m) => m.id === MODEL)!;
    // The shipped Token Factory models are free (Token Factory charges nothing during its beta): served
    // without the unverified-prices setting, to a balance key, with nothing charged.
    g = await startGatewayWithCatalog({ suppliers: { tokenfactory: catalogJson.suppliers.tokenfactory }, models: [tf] }, { TOKENFACTORY_API_KEY: KEY! });
    const invite = createInvite(g);
    const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite }) });
    key = (await r.json()).key;
  });
  afterAll(() => g?.close());

  // A settled request leaves no row of its own (balance requests never have one), so these assert on what
  // survives settlement: the charge the client is told (0: the model is free), the usage the upstream
  // reported, the request's log line, and the model's daily aggregates.
  const daily = () =>
    g.deps.db.prepare('SELECT requests, ok, input_tokens, output_tokens, charged_msub, supplier_reported FROM usage_daily WHERE model = ?').get(MODEL) as
      | { requests: number; ok: number; input_tokens: number; output_tokens: number; charged_msub: number; supplier_reported: number }
      | undefined;
  const zero = { requests: 0, ok: 0, input_tokens: 0, output_tokens: 0, charged_msub: 0, supplier_reported: 0 };

  const body = (extra: object = {}) => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 16, ...extra });

  const balance = async () => (await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_msub as number;

  it('non-streaming completion is counted on upstream usage and charged nothing', async () => {
    const start = await balance();
    const before = daily() ?? zero;
    const logs = captureLogs();
    try {
      const res = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body() });
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.usage.prompt_tokens).toBeGreaterThan(0);
      expect(j.usage.completion_tokens).toBeGreaterThan(0);
      const charged = Number(res.headers.get('x-forge-charged-msub'));
      expect(charged).toBe(0);
      expect(await balance()).toBe(start);
      const line = await logs.waitForRequest(res.headers.get('x-forge-request-id')!);
      expect(line).toMatchObject({ payment: 'free', usage_source: 'upstream', input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens, charged_msub: 0, cost_source: 'free' });
      const after = daily()!;
      console.log(`non-stream: in=${j.usage.prompt_tokens} out=${j.usage.completion_tokens} charged_msub=${charged} supplier_reported=${after.supplier_reported - before.supplier_reported}`);
      expect(after.requests - before.requests).toBe(1);
      expect(after.ok - before.ok).toBe(1);
      expect(after.input_tokens - before.input_tokens).toBe(j.usage.prompt_tokens);
      expect(after.output_tokens - before.output_tokens).toBe(j.usage.completion_tokens);
      expect(after.charged_msub - before.charged_msub).toBe(charged);
      // A free model's cost is 0, never the supplier's figure.
      expect(after.supplier_reported - before.supplier_reported).toBe(0);
    } finally {
      logs.stop();
    }
  });

  it('streaming completion gets usage via stream_options and is charged nothing', async () => {
    const before = daily() ?? zero;
    const logs = captureLogs();
    try {
      const res = await fetch(`${g.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: body({ stream: true, stream_options: { include_usage: true } }),
      });
      expect(res.status).toBe(200);
      const s = await readSse(res);
      expect(s.forge).toBeTruthy();
      expect(s.forge.charged_msub).toBe(0);
      const usage = s.data.find((d) => d.usage)?.usage;
      expect(usage?.prompt_tokens).toBeGreaterThan(0);
      const line = await logs.waitForRequest(s.forge.request_id);
      expect(line).toMatchObject({ payment: 'free', usage_source: 'upstream', input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, charged_msub: 0, cost_source: 'free' });
      const after = daily()!;
      console.log(`stream: chunks=${s.data.length} in=${usage.prompt_tokens} out=${usage.completion_tokens} charged_msub=${s.forge.charged_msub}`);
      expect(after.requests - before.requests).toBe(1);
      expect(after.ok - before.ok).toBe(1);
      expect(after.input_tokens - before.input_tokens).toBe(usage.prompt_tokens);
      expect(after.output_tokens - before.output_tokens).toBe(usage.completion_tokens);
      expect(after.charged_msub - before.charged_msub).toBe(s.forge.charged_msub);
      expect(after.supplier_reported - before.supplier_reported).toBe(0);
    } finally {
      logs.stop();
    }
  });
});
