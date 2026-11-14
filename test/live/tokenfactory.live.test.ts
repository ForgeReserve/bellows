/**
 * Optional live smoke test against Token Factory. Runs only when TOKENFACTORY_API_KEY is set
 * (pnpm test:live loads .env if present). Keeps calls tiny: glm-5.3-flash, max_tokens 16.
 * Never prints the key, prompts or completions; asserts on shapes and usage numbers only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import catalogJson from '../../config/models.json' with { type: 'json' };
import { createInvite, type Gateway, MINT_A, mintToken, mintsUp, readSse, startGatewayWithCatalog } from '../e2e/helpers.ts';

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
    // The shipped Token Factory prices are unverified placeholders, which the gateway withholds unless the
    // operator setting serves them. This suite talks to the supplier directly, so it opts in.
    g = await startGatewayWithCatalog(
      { suppliers: { tokenfactory: catalogJson.suppliers.tokenfactory }, models: [tf] },
      { TOKENFACTORY_API_KEY: KEY!, BELLOWS_SERVE_UNVERIFIED_PRICES: 'true' },
    );
    const invite = createInvite(g);
    const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite }) });
    key = (await r.json()).key;
  });
  afterAll(() => g?.close());

  const body = (extra: object = {}) => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 16, ...extra });

  it('non-streaming completion is charged on upstream usage', async () => {
    const res = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body() });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.usage.prompt_tokens).toBeGreaterThan(0);
    const row: any = g.deps.db.prepare('SELECT usage_source, input_tokens, output_tokens, charged_msub FROM requests WHERE id = ?').get(res.headers.get('x-forge-request-id'));
    console.log(`non-stream: source=${row.usage_source} in=${row.input_tokens} out=${row.output_tokens} charged_msub=${row.charged_msub}`);
    expect(row.usage_source).toBe('upstream');
    expect(row.charged_msub).toBeGreaterThan(0);
  });

  it('streaming completion gets usage via stream_options', async () => {
    const res = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body({ stream: true }) });
    expect(res.status).toBe(200);
    const s = await readSse(res);
    expect(s.forge).toBeTruthy();
    const row: any = g.deps.db.prepare('SELECT usage_source, input_tokens, output_tokens, charged_msub FROM requests WHERE id = ?').get(s.forge.request_id);
    console.log(`stream: chunks=${s.data.length} source=${row.usage_source} in=${row.input_tokens} out=${row.output_tokens} charged_msub=${row.charged_msub}`);
    expect(row.usage_source).toBe('upstream');
  });
});
