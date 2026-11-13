import { decodePaymentRequest } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { openDb } from '../../src/db.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

function app(env: Record<string, string> = {}) {
  const e = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  return createApp(buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)] }));
}

describe('engine only: no web app', () => {
  it('serves no page, service worker, manifest or static files', async () => {
    const a = app();
    for (const path of ['/', '/index.html', '/app.js', '/sw.js', '/manifest.webmanifest', '/offline.html', '/js/files.js', '/vendor/tinfoil.js', '/icons/icon-192.png']) {
      const res = await a.request(`http://gw.test${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('x-forge-sw-version'), path).toBeNull();
    }
  });

  it('still serves the client API', async () => {
    const a = app();
    expect((await a.request('http://gw.test/healthz')).status).toBe(200);
    const models = await a.request('http://gw.test/v1/models');
    expect(models.status).toBe(200);
    expect(((await models.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['mock-echo']);
  });
});

describe('no beta waitlist', () => {
  it('has no signup route or page', async () => {
    const a = app();
    const post = await a.request('http://gw.test/v1/beta/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact: 'a@example.org' }) });
    expect(post.status).toBe(404);
    expect((await a.request('http://gw.test/beta')).status).toBe(404);
    expect((await a.request('http://gw.test/beta/')).status).toBe(404);
  });

  it('creates no table for contacts', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).not.toContain('beta_signups');
    expect(tables).toContain('accounts');
  });
});

describe('NUT-18 payment requests', () => {
  const ask = async (a: ReturnType<typeof app>) => {
    const res = await a.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    });
    expect(res.status).toBe(402);
    return decodePaymentRequest(res.headers.get('x-cashu')!);
  };

  it('name the service Bellows by default, with no invite needed', async () => {
    const pr = await ask(app());
    expect(pr.description).toBe('Bellows: mock-echo');
    expect(pr.mints).toEqual(['http://127.0.0.1:1']);
  });

  it('use BELLOWS_SERVICE_NAME when set', async () => {
    expect((await ask(app({ BELLOWS_SERVICE_NAME: 'Example AI' }))).description).toBe('Example AI: mock-echo');
  });
});

describe('client API surface (unchanged from Forge AI)', () => {
  // Every client route answers with JSON from its own handler, never the router's plain-text 404.
  const routes: Array<[string, string]> = [
    ['GET', '/healthz'],
    ['GET', '/v1/models'],
    ['POST', '/v1/chat/completions'],
    ['POST', '/v1/wallet/topup'],
    ['GET', '/v1/wallet'],
    ['GET', '/v1/wallet/refunds'],
    ['POST', '/v1/wallet/refund'],
    ['GET', '/v1/wallet/fund/methods'],
    ['GET', '/v1/wallet/fund/mints'],
    ['POST', '/v1/wallet/fund/lightning'],
    ['POST', '/v1/wallet/fund/onchain'],
    ['POST', '/v1/wallet/fund/foreign/quote'],
    ['POST', '/v1/wallet/fund/foreign/confirm'],
    ['GET', '/v1/wallet/fund'],
    ['GET', '/v1/wallet/fund/fund_x'],
    ['GET', '/v1/change/req_x'],
    ['GET', '/attestation'],
    ['GET', '/.well-known/hpke-keys'],
    // Added by S4 (attested identity); new, not part of the Forge AI surface.
    ['GET', '/.well-known/bellows'],
  ];
  it('an unknown route is the router\'s plain 404 (the check below can tell them apart)', async () => {
    const res = await app().request('http://gw.test/v1/no-such-route', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/application\/json/);
  });

  it.each(routes)('%s %s exists', async (method, path) => {
    const res = await app().request(`http://gw.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
  });

  it('keeps the X-Forge-* header names clients read', async () => {
    const res = await app().request('http://gw.test/v1/models', { headers: { origin: 'https://app.example' } });
    const pre = await app().request('http://gw.test/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Forge-Request-Id');
    expect(pre.headers.get('access-control-allow-headers')).toContain('X-Forge-Invite');
  });
});
