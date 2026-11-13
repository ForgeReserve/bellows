/**
 * Attested identity end to end: a running Bellows serves /.well-known/bellows over HTTP, and the client
 * library verifies it, for the development stand-in and for the Tinfoil attester against a stand-in socket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BellowsVerifyError, devVerifier, tinfoilVerifier, verifyBellows } from '../../client/index.ts';
import { toHex } from '../../client/bytes.ts';
import { devMeasurement } from '../../src/attest/dev.ts';
import { BELLOWS_VERSION } from '../../src/config.ts';
import { FAKE_TINFOIL_MEASUREMENT, fakeAuthenticate, type FakeTinfoilSocket, startFakeTinfoilSocket } from '../tinfoil-fake.ts';
import { captureLogs, type Gateway, mintsUp, startGateway } from './helpers.ts';

const up = await mintsUp();
const IMAGE = `example/bellows@sha256:${'ab'.repeat(32)}`;
const devBuilds = { format: 'bellows-builds/v1', builds: [{ version: BELLOWS_VERSION, image: IMAGE, measurement: devMeasurement() }] };

describe.skipIf(!up)('attested identity: development attester', () => {
  let g: Gateway;
  let logs: ReturnType<typeof captureLogs>;
  beforeAll(async () => {
    logs = captureLogs();
    g = await startGateway({ inviteOnly: false, env: { BELLOWS_RELAYS: 'https://relay.example/ohttp' } });
  });
  afterAll(async () => {
    logs.stop();
    await g?.close();
  });

  it('serves the identity document, readable from any origin', async () => {
    const r = await fetch(`${g.url}/.well-known/bellows`, { headers: { origin: 'https://app.example' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('cache-control')).toBe('no-cache');
    const doc = await r.json();
    expect(doc.format).toBe('bellows-identity/v1');
    expect(doc.attestation.format).toBe('urn:bellows:attestation:dev:v1');
  });

  it('the client verifies it in development mode and gets the key the server holds', async () => {
    const v = await verifyBellows(g.url, { approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true });
    expect(toHex(v.keyConfig)).toBe(toHex(g.deps.identity.keyConfig));
    expect(v).toMatchObject({ development: true, relays: ['https://relay.example/ohttp'], build: { version: BELLOWS_VERSION } });
  });

  it('the client refuses it without development mode', async () => {
    const p = verifyBellows(g.url, { approvedBuilds: devBuilds, verifier: devVerifier() });
    await expect(p).rejects.toBeInstanceOf(BellowsVerifyError);
    await expect(p).rejects.toMatchObject({ code: 'development_refused' });
  });

  it('startup names the attester and the public key hash, and nothing in the logs or the document holds the private key', async () => {
    const startup = logs.entries().find((e) => e.msg === 'startup');
    expect(startup).toMatchObject({ attester: 'dev', version: BELLOWS_VERSION, hpke_key_sha256: g.deps.identity.keyConfigSha256 });
    const d = g.deps.identity.hpkePrivateKey().export({ format: 'jwk' }).d!;
    const forms = [d, Buffer.from(d, 'base64url').toString('hex'), Buffer.from(d, 'base64url').toString('base64')];
    const doc = await (await fetch(`${g.url}/.well-known/bellows`)).text();
    for (const f of forms) {
      expect(doc).not.toContain(f);
      expect(logs.lines.join('\n')).not.toContain(f);
    }
  });

  it('a restart on the same database makes a new key', async () => {
    const before = toHex(g.deps.identity.keyConfig);
    const again = await startGateway({ inviteOnly: false, dbPath: g.dbPath });
    try {
      const v = await verifyBellows(again.url, { approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true });
      expect(toHex(v.keyConfig)).not.toBe(before);
      expect(toHex(v.keyConfig)).toBe(toHex(again.deps.identity.keyConfig));
    } finally {
      await again.close();
    }
  });
});

describe.skipIf(!up)('attested identity: Tinfoil attester (stand-in socket)', () => {
  let sock: FakeTinfoilSocket;
  let g: Gateway;
  const builds = [{ version: BELLOWS_VERSION, image: IMAGE, measurement: FAKE_TINFOIL_MEASUREMENT }];
  beforeAll(async () => {
    sock = await startFakeTinfoilSocket('not_ready');
    g = await startGateway({
      inviteOnly: false,
      env: { BELLOWS_ATTESTER: 'tinfoil', BELLOWS_TINFOIL_ATTESTATION_SOCKET: sock.path, BELLOWS_BUILD_MEASUREMENT: JSON.stringify(FAKE_TINFOIL_MEASUREMENT) },
    });
  });
  afterAll(async () => {
    await g?.close();
    await sock?.close();
  });

  it('answers 503 until the platform attestation is ready, and the client sends nothing', async () => {
    const r = await fetch(`${g.url}/.well-known/bellows`);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe('not_attested');
    expect(r.headers.get('retry-after')).toBe('5');
    await expect(verifyBellows(g.url, { approvedBuilds: builds, verifier: tinfoilVerifier({ authenticate: fakeAuthenticate }) })).rejects.toMatchObject({ code: 'fetch_failed' });
  });

  it('once ready, serves a Tinfoil document bound to its statement, which the client verifies', async () => {
    sock.mode = 'ok';
    // The identity waits before trying again after a failure (5 s); start a fresh gateway instead of sleeping.
    const fresh = await startGateway({
      inviteOnly: false,
      env: { BELLOWS_ATTESTER: 'tinfoil', BELLOWS_TINFOIL_ATTESTATION_SOCKET: sock.path, BELLOWS_BUILD_MEASUREMENT: JSON.stringify(FAKE_TINFOIL_MEASUREMENT) },
    });
    try {
      const v = await verifyBellows(fresh.url, { approvedBuilds: builds, verifier: tinfoilVerifier({ authenticate: fakeAuthenticate }) });
      expect(v.development).toBe(false);
      expect(toHex(v.keyConfig)).toBe(toHex(fresh.deps.identity.keyConfig));
      expect(sock.requests.at(-1)).toBe(`/.well-known/tinfoil-attestation?nonce=${v.binding}`);
      // A build list without this measurement refuses it.
      await expect(verifyBellows(fresh.url, { approvedBuilds: devBuilds, verifier: tinfoilVerifier({ authenticate: fakeAuthenticate }) })).rejects.toMatchObject({ code: 'build_not_approved' });
    } finally {
      await fresh.close();
    }
  });
});
