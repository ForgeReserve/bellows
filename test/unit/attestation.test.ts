/**
 * Attested identity (docs/DESIGN.md, S4): HPKE key configuration, the development and Tinfoil attesters,
 * the identity document and its refresh, builds.json and its checker, and the client's verifyBellows.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BellowsVerifyError,
  bindingFor,
  checkBuilds,
  checkTinfoilBinding,
  DEV_ATTESTATION_FORMAT,
  DEV_MEASUREMENT_TYPE,
  devVerifier,
  encodeKeyConfig,
  findBuild,
  IDENTITY_FORMAT,
  type IdentityDocument,
  KEM_X25519_HKDF_SHA256,
  parseBuilds,
  parseKeyConfig,
  TINFOIL_V3_FORMAT,
  tinfoilReportData,
  tinfoilVerifier,
  verifyBellows,
} from '../../client/index.ts';
import { fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from '../../client/bytes.ts';
import { devAttester, devMeasurement, DEFAULT_DEV_REGISTER } from '../../src/attest/dev.ts';
import { AttestationUnavailable, tinfoilAttester } from '../../src/attest/tinfoil.ts';
import { BELLOWS_VERSION, loadConfig } from '../../src/config.ts';
import { type Attester, generateHpkeKeyPair, Identity } from '../../src/identity.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { memorySecrets, newWalletSecret, WALLET_SECRET } from '../../src/secrets.ts';
import { signOperatorAnnouncement } from '../../client/operator.ts';
import { FAKE_TINFOIL_MEASUREMENT, fakeAuthenticate, fakeTinfoilDocument, type FakeTinfoilSocket, startFakeTinfoilSocket } from '../tinfoil-fake.ts';

const IMAGE = `example/bellows@sha256:${'ab'.repeat(32)}`;
const devBuild = (version = BELLOWS_VERSION) => ({ version, image: IMAGE, measurement: devMeasurement() });

function devIdentity(o: Partial<ConstructorParameters<typeof Identity>[0]> = {}) {
  return new Identity({ attester: devAttester({ measurement: devMeasurement() }), version: BELLOWS_VERSION, measurement: devMeasurement(), relays: [], operator: null, refreshMs: 60_000, ...o });
}

/** A fetch that serves this identity document, after `edit` when given. */
function serve(doc: IdentityDocument | unknown, status = 200) {
  const seen: string[] = [];
  const f = async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(f, { seen });
}

async function expectRefusal(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(BellowsVerifyError);
  await expect(p).rejects.toMatchObject({ code });
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSink(undefined));

describe('HPKE key configuration (RFC 9458)', () => {
  it('encodes and parses DHKEM(X25519, HKDF-SHA256) with its cipher suites', () => {
    const pair = generateHpkeKeyPair(7);
    expect(pair.keyConfig.length).toBe(1 + 2 + 32 + 2 + 4);
    expect(pair.keyConfig[0]).toBe(7);
    const k = parseKeyConfig(pair.keyConfig);
    expect(k).toMatchObject({ keyId: 7, kemId: KEM_X25519_HKDF_SHA256, suites: [{ kdfId: 1, aeadId: 1 }] });
    expect(toHex(k.publicKey)).toBe(toHex(pair.config.publicKey));
    // The public key is the X25519 key of the private key held in memory.
    expect(Buffer.from(pair.privateKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex')).toBe(toHex(k.publicKey));
  });

  it('a new key pair each time', () => {
    expect(toHex(generateHpkeKeyPair().config.publicKey)).not.toBe(toHex(generateHpkeKeyPair().config.publicKey));
  });

  it('refuses unknown KEMs, short input, trailing bytes and empty suites', () => {
    const good = generateHpkeKeyPair(1).keyConfig;
    const unknownKem = good.slice();
    unknownKem[2] = 0x10;
    expect(() => parseKeyConfig(unknownKem)).toThrow(/unsupported KEM/);
    expect(() => parseKeyConfig(good.slice(0, 20))).toThrow(/too short/);
    expect(() => parseKeyConfig(new Uint8Array([...good, 0]))).toThrow(/length/);
    const noSuites = good.slice(0, 1 + 2 + 32 + 2);
    noSuites[35] = 0;
    noSuites[36] = 0;
    expect(() => parseKeyConfig(noSuites)).toThrow(/cipher suites/);
    expect(() => encodeKeyConfig({ keyId: 1, kemId: KEM_X25519_HKDF_SHA256, publicKey: new Uint8Array(31), suites: [{ kdfId: 1, aeadId: 1 }] })).toThrow(/32 bytes/);
  });
});

describe('builds.json and its checker', () => {
  it('the repository builds.json is valid', () => {
    const file = JSON.parse(readFileSync(new URL('../../builds.json', import.meta.url), 'utf8'));
    // An operator's deploy repository lists its own builds here, so only validity is checked.
    expect(checkBuilds(file)).toEqual([]);
    expect(parseBuilds(file).builds).toHaveLength(file.builds.length);
  });

  it('accepts a well-formed file and finds a build by measurement', () => {
    const f = parseBuilds({ format: 'bellows-builds/v1', builds: [{ ...devBuild('1.0.0'), released: '2026-12-01', notes: 'first' }, { version: '1.0.1', image: IMAGE, measurement: FAKE_TINFOIL_MEASUREMENT }] });
    expect(findBuild(f, FAKE_TINFOIL_MEASUREMENT)?.version).toBe('1.0.1');
    expect(findBuild(f, { type: DEV_MEASUREMENT_TYPE, registers: ['00'.repeat(32)] })).toBeUndefined();
    expect(findBuild(f.builds, devMeasurement())?.version).toBe('1.0.0');
  });

  it('lists every problem', () => {
    const problems = checkBuilds({
      format: 'bellows-builds/v2',
      extra: 1,
      builds: [
        { version: '1.0', image: 'example/bellows:latest', measurement: { type: 'x', registers: ['ABCD'] } },
        { version: '1.0.0', image: IMAGE, measurement: devMeasurement(), released: '1 Dec 2026', colour: 'red' },
        { version: '1.0.0', image: IMAGE, measurement: devMeasurement() },
        { version: '1.0.2', image: IMAGE, measurement: { type: 'x', registers: [] } },
        'nope',
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'unknown member extra',
        'format must be "bellows-builds/v1"',
        'builds[0].version: must be a version such as 1.2.3',
        'builds[0].image: must be pinned by digest (name@sha256:<64 hex>)',
        'builds[0].measurement.registers[0]: must be lowercase hex',
        'builds[1]: unknown member colour',
        'builds[1].released: must be YYYY-MM-DD',
        'builds[2].version: 1.0.0 is listed twice',
        'builds[2].measurement: same as version 1.0.0; one measurement names one build',
        'builds[3].measurement.registers: must be a non-empty array',
        'builds[4]: must be an object',
      ]),
    );
    expect(() => parseBuilds({ format: 'bellows-builds/v1', builds: 'x' })).toThrow(BellowsVerifyError);
  });

  it('one version may be listed once per deployment, and a deployment is owner/repo@tag', () => {
    const other = { type: FAKE_TINFOIL_MEASUREMENT.type, registers: ['55'.repeat(48)] };
    const f = parseBuilds({
      format: 'bellows-builds/v1',
      builds: [
        { version: '1.0.0', image: IMAGE, measurement: FAKE_TINFOIL_MEASUREMENT, deployment: 'alice/bellows-deploy@v1.0.0' },
        { version: '1.0.0', image: IMAGE, measurement: other, deployment: 'bob/bellows-deploy@v1.0.0' },
      ],
    });
    expect(findBuild(f, other)?.deployment).toBe('bob/bellows-deploy@v1.0.0');
    const problems = checkBuilds({
      format: 'bellows-builds/v1',
      builds: [
        { version: '1.0.0', image: IMAGE, measurement: FAKE_TINFOIL_MEASUREMENT, deployment: 'alice/bellows-deploy@v1.0.0' },
        { version: '1.0.0', image: IMAGE, measurement: other, deployment: 'alice/bellows-deploy@v1.0.0' },
        { version: '1.0.1', image: IMAGE, measurement: devMeasurement(), deployment: 'not a repo' },
        { version: '1.0.2', image: IMAGE, measurement: { ...other, registers: ['66'.repeat(48)] }, deployment: 7 },
      ],
    });
    expect(problems).toEqual([
      'builds[1].version: 1.0.0 is listed twice for alice/bellows-deploy@v1.0.0',
      'builds[2].deployment: must be owner/repo@tag',
      'builds[3].deployment: must be owner/repo@tag',
    ]);
  });

  it('pnpm builds:check finds the default builds.json from a checkout whose path has a space', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'bellows check '));
    try {
      for (const f of ['client', 'scripts', 'builds.json']) cpSync(join(root, f), join(dir, f), { recursive: true });
      const out = execFileSync(process.execPath, [join(dir, 'scripts', 'check-builds.ts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const count = JSON.parse(readFileSync(join(dir, 'builds.json'), 'utf8')).builds.length;
      expect(out).toContain(`valid, ${count} approved build${count === 1 ? '' : 's'}`);
      expect(out).toContain(join(dir, 'builds.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('development attester', () => {
  it('signs a stand-in that binds the report data, clearly marked', async () => {
    const att = await devAttester({ measurement: devMeasurement() }).attest(new Uint8Array(32).fill(9));
    expect(att.format).toBe(DEV_ATTESTATION_FORMAT);
    expect(att.warning).toMatch(/NOT HARDWARE ATTESTATION/);
    const payload = JSON.parse(utf8Decode(fromBase64(att.payload as string)));
    expect(payload).toMatchObject({ report_data: '09'.repeat(32), measurement: { type: DEV_MEASUREMENT_TYPE, registers: [DEFAULT_DEV_REGISTER] } });
    expect(await devVerifier().verify(att, new Uint8Array(32).fill(9))).toEqual({ measurement: devMeasurement() });
  });

  it('the verifier refuses another binding, a changed payload, a bad signature and an untrusted key', async () => {
    const att = await devAttester({ measurement: devMeasurement() }).attest(new Uint8Array(32).fill(1));
    const b = new Uint8Array(32).fill(1);
    await expect(devVerifier().verify(att, new Uint8Array(32).fill(2))).rejects.toThrow(/does not bind/);
    const payload = JSON.parse(utf8Decode(fromBase64(att.payload as string)));
    const changed = { ...att, payload: toBase64(utf8Encode(JSON.stringify({ ...payload, measurement: devMeasurement('cd'.repeat(32)) }))) };
    await expect(devVerifier().verify(changed, b)).rejects.toThrow(/bad signature/);
    const sig = fromBase64(att.signature as string);
    sig[0] = sig[0]! ^ 1;
    await expect(devVerifier().verify({ ...att, signature: toBase64(sig) }, b)).rejects.toThrow(/bad signature/);
    await expect(devVerifier({ trustedKeys: ['AAAA'] }).verify(att, b)).rejects.toThrow(/not trusted/);
    expect(await devVerifier({ trustedKeys: [att.public_key as string] }).verify(att, b)).toEqual({ measurement: devMeasurement() });
    await expect(devVerifier().verify({ ...att, warning: undefined }, b)).rejects.toThrow(/warning/);
  });

  it('a signed payload with a malformed measurement is an invalid attestation, not a bad builds file', async () => {
    const b = new Uint8Array(32).fill(4);
    const att = await devAttester({ measurement: { type: DEV_MEASUREMENT_TYPE, registers: ['NOT HEX'] } }).attest(b);
    await expect(devVerifier().verify(att, b)).rejects.toMatchObject({ code: 'attestation_invalid', message: expect.stringMatching(/malformed measurement/) });
  });
});

describe('Tinfoil attestation (V3 document format)', () => {
  it('REPORT_DATA derivation matches the vector published with Tinfoil’s open-source verifier', async () => {
    // Vector: nonce 00..1f, its crypto_material and device_evidence section hashes, and the REPORT_DATA.
    const rd = await tinfoilReportData(
      fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
      fromHex('004580594693e8f98ab0537d7e408f55f691bad5e55b0bd83f0bc32f2a05abc6'),
      fromHex('5e84f632e01293bff4596cf72c45de0f9e1037e5cda3232b850c478d1a6b592b'),
    );
    expect(toHex(rd)).toBe('e134a51739248a669e7d75a94c242d2b2b973684061d1885205cea0e1b40ec58' + '00'.repeat(32));
  });

  it('binding checks: nonce, endorsed section hashes, REPORT_DATA, format', async () => {
    const nonce = new Uint8Array(32).fill(5);
    const doc = (await fakeTinfoilDocument(nonce)) as { format: string } & Record<string, any>;
    const check = await checkTinfoilBinding(doc, nonce);
    expect(check.cpuFormat).toBe('https://tinfoil.sh/format/tdx-quote/v1');
    expect(toHex(check.reportData)).toBe(doc.challenge.report_data);

    await expect(checkTinfoilBinding(doc, new Uint8Array(32).fill(6))).rejects.toThrow(/nonce does not bind/);
    const clone = () => JSON.parse(JSON.stringify(doc));
    const d1 = clone();
    d1.device_evidence = toBase64(utf8Encode('{"format":"https://tinfoil.sh/device-evidence/v1","items":[{"id":"gpu"}]}'));
    await expect(checkTinfoilBinding(d1, nonce)).rejects.toThrow(/device_evidence hash/);
    const d2 = clone();
    d2.crypto_material = toBase64(utf8Encode('{}'));
    await expect(checkTinfoilBinding(d2, nonce)).rejects.toThrow(/crypto_material hash/);
    const d3 = clone();
    d3.challenge.report_data = 'ff'.repeat(64);
    await expect(checkTinfoilBinding(d3, nonce)).rejects.toThrow(/report_data does not match/);
    const d4 = clone();
    d4.challenge.report_data_algorithm = 'https://tinfoil.sh/report-data/v9';
    await expect(checkTinfoilBinding(d4, nonce)).rejects.toThrow(/report_data_algorithm/);
    await expect(checkTinfoilBinding({ ...clone(), format: 'https://tinfoil.sh/predicate/tdx-guest/v2' }, nonce)).rejects.toThrow(/unsupported format/);
  });

  it('the verifier hands the quote to the app’s authenticate and returns its measurement', async () => {
    const nonce = new Uint8Array(32).fill(3);
    const doc = (await fakeTinfoilDocument(nonce)) as { format: string };
    expect(await tinfoilVerifier({ authenticate: fakeAuthenticate }).verify(doc, nonce)).toEqual({ measurement: FAKE_TINFOIL_MEASUREMENT });
    const refused = tinfoilVerifier({ authenticate: async () => Promise.reject(new Error('VCEK chain invalid')) });
    await expect(refused.verify(doc, nonce)).rejects.toMatchObject({ code: 'attestation_invalid', message: expect.stringMatching(/VCEK chain invalid/) });
  });

  it('refuses unless the REPORT_DATA authenticate read from the quote is the recomputed one', async () => {
    const nonce = new Uint8Array(32).fill(7);
    const doc = (await fakeTinfoilDocument(nonce)) as { format: string };
    const rd = (await checkTinfoilBinding(doc, nonce)).reportData;
    const returning = (reportData: unknown) => tinfoilVerifier({ authenticate: async () => ({ measurement: FAKE_TINFOIL_MEASUREMENT, reportData }) as never });
    const mismatch = { code: 'attestation_invalid', message: expect.stringMatching(/does not carry this REPORT_DATA/) };
    await expect(returning(new Uint8Array(64)).verify(doc, nonce)).rejects.toMatchObject(mismatch);
    await expect(returning(rd.subarray(0, 32)).verify(doc, nonce)).rejects.toMatchObject(mismatch);
    await expect(returning(undefined).verify(doc, nonce)).rejects.toMatchObject(mismatch);
    await expect(returning(toHex(rd)).verify(doc, nonce)).rejects.toMatchObject(mismatch);
    expect(await returning(rd.slice()).verify(doc, nonce)).toEqual({ measurement: FAKE_TINFOIL_MEASUREMENT });

    // A genuine quote moved into a document for another statement: the forged JSON is self-consistent and
    // the quote authenticates, but the quote's REPORT_DATA binds the original nonce, so it is refused.
    const other = new Uint8Array(32).fill(8);
    const forged = (await fakeTinfoilDocument(other)) as { format: string; cpu_evidence: { report_base64: string } };
    forged.cpu_evidence.report_base64 = (doc as unknown as { cpu_evidence: { report_base64: string } }).cpu_evidence.report_base64;
    await expect(tinfoilVerifier({ authenticate: fakeAuthenticate }).verify(forged, other)).rejects.toMatchObject(mismatch);
  });

  describe('attester over the container socket (stand-in socket)', () => {
    let sock: FakeTinfoilSocket;
    beforeEach(async () => {
      sock = await startFakeTinfoilSocket();
    });
    afterEach(() => sock.close());

    it('asks for a fresh attestation with the binding as the nonce', async () => {
      const nonce = new Uint8Array(32).fill(0xa5);
      const doc = await tinfoilAttester({ socketPath: sock.path }).attest(nonce);
      expect(sock.requests).toEqual([`/.well-known/tinfoil-attestation?nonce=${'a5'.repeat(32)}`]);
      expect(doc.format).toBe(TINFOIL_V3_FORMAT);
      expect((doc.challenge as { nonce: string }).nonce).toBe('a5'.repeat(32));
    });

    it('refuses not ready, not JSON, a document for another nonce and a tampered document', async () => {
      const a = tinfoilAttester({ socketPath: sock.path });
      const nonce = new Uint8Array(32).fill(1);
      sock.mode = 'not_ready';
      await expect(a.attest(nonce)).rejects.toMatchObject({ name: 'AttestationUnavailable', status: 503, message: expect.stringMatching(/not ready/) });
      sock.mode = 'not_json';
      await expect(a.attest(nonce)).rejects.toThrow(/other than JSON/);
      sock.mode = 'wrong_nonce';
      await expect(a.attest(nonce)).rejects.toThrow(/nonce does not bind/);
      sock.mode = 'tampered';
      await expect(a.attest(nonce)).rejects.toThrow(/device_evidence hash/);
    });

    it('a missing socket is an unavailable attestation, not a crash', async () => {
      await expect(tinfoilAttester({ socketPath: join(sock.path, '..', 'none.sock') }).attest(new Uint8Array(32))).rejects.toBeInstanceOf(AttestationUnavailable);
    });
  });
});

describe('identity document', () => {
  it('binds the statement: version, claimed measurement, key config, relays and operator', async () => {
    const id = devIdentity({ relays: ['https://relay.example/ohttp'], operator: { name: 'example' } });
    const doc = await id.document();
    expect(doc.format).toBe(IDENTITY_FORMAT);
    const st = JSON.parse(utf8Decode(fromBase64(doc.statement)));
    expect(st).toEqual({ version: BELLOWS_VERSION, measurement: devMeasurement(), hpke: { key_config: toBase64(id.keyConfig) }, relays: ['https://relay.example/ohttp'], operator: { name: 'example' } });
    const payload = JSON.parse(utf8Decode(fromBase64(doc.attestation.payload as string)));
    expect(payload.report_data).toBe(toHex(await bindingFor(fromBase64(doc.statement))));
  });

  it('never carries the private key', async () => {
    const id = devIdentity();
    const d = id.hpkePrivateKey().export({ format: 'jwk' }).d!;
    const text = JSON.stringify(await id.document());
    expect(text).not.toContain(d);
    expect(text).not.toContain(Buffer.from(d, 'base64url').toString('hex'));
    expect(text).not.toContain(Buffer.from(d, 'base64url').toString('base64'));
  });

  it('attests once, refreshes after the interval, serves the last good document while a refresh fails', async () => {
    let t = 1_000_000;
    let calls = 0;
    let fail = false;
    const inner = devAttester({ measurement: devMeasurement() });
    const attester: Attester = {
      kind: 'dev',
      attest: async (rd) => {
        calls++;
        if (fail) throw new Error('platform says no');
        return inner.attest(rd);
      },
    };
    const id = devIdentity({ attester, refreshMs: 60_000, retryMs: 5_000, now: () => t });
    const first = await id.document();
    await id.document();
    expect(calls).toBe(1);
    t += 60_000;
    const second = await id.document(); // served while the refresh runs
    expect(second).toBe(first);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
    const refreshed = await id.document();
    expect(refreshed).not.toBe(first);
    expect(refreshed.statement).toBe(first.statement); // same key and statement, new attestation
    fail = true;
    t += 60_000;
    expect(await id.document()).toBe(refreshed);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(3);
    expect(await id.document()).toBe(refreshed); // within the retry wait: no new call
    expect(calls).toBe(3);
    expect(id.status()).toMatchObject({ attested: true, lastError: 'platform says no' });
  });

  it('with no document yet, a failure is AttestationUnavailable and is retried after the wait', async () => {
    let t = 0;
    let calls = 0;
    const attester: Attester = {
      kind: 'tinfoil',
      attest: async () => {
        calls++;
        throw new AttestationUnavailable('Tinfoil attestation is not ready yet');
      },
    };
    const id = devIdentity({ attester, retryMs: 5_000, now: () => t });
    await expect(id.document()).rejects.toThrow(/not ready/);
    await expect(id.document()).rejects.toThrow(/not attested yet/);
    expect(calls).toBe(1);
    t += 5_000;
    await expect(id.document()).rejects.toThrow(/not ready/);
    expect(calls).toBe(2);
    expect(id.status()).toMatchObject({ attested: false, attester: 'tinfoil' });
  });
});

describe('verifyBellows', () => {
  const opts = (extra: object = {}) => ({ approvedBuilds: [devBuild()], verifier: devVerifier(), allowDevelopment: true, ...extra });

  it('returns the attested key configuration for an approved build', async () => {
    const id = devIdentity({ relays: ['https://relay.example/ohttp'] });
    const f = serve(await id.document());
    const v = await verifyBellows('https://bellows.example/some/path', opts({ fetch: f }));
    expect(f.seen).toEqual(['https://bellows.example/.well-known/bellows']);
    expect(toHex(v.keyConfig)).toBe(toHex(id.keyConfig));
    expect(v.key.keyId).toBe(id.keyId);
    expect(v).toMatchObject({ origin: 'https://bellows.example', development: true, relays: ['https://relay.example/ohttp'], operator: null, build: { version: BELLOWS_VERSION } });
    expect(v.binding).toBe(toHex(await bindingFor(id.statementBytes)));
    // A builds.json object works as well as a list.
    await expect(verifyBellows('https://bellows.example', opts({ fetch: f, approvedBuilds: { format: 'bellows-builds/v1', builds: [devBuild()] } }))).resolves.toBeTruthy();
  });

  it('refuses the development stand-in unless development mode is opted into', async () => {
    const f = serve(await devIdentity().document());
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: f, allowDevelopment: false })), 'development_refused');
    await expectRefusal(verifyBellows('https://bellows.example', { approvedBuilds: [devBuild()], verifier: devVerifier(), fetch: f }), 'development_refused');
  });

  it('refuses a build that is not approved, and a version or measurement claim that differs from the attested build', async () => {
    const f = serve(await devIdentity().document());
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: f, approvedBuilds: [] })), 'build_not_approved');
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: f, approvedBuilds: [devBuild('9.9.9')] })), 'build_mismatch');
    // The server claims one measurement while its attestation proves another.
    const liar = devIdentity({ measurement: devMeasurement('ee'.repeat(32)) });
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve(await liar.document()) })), 'build_mismatch');
  });

  it('refuses a statement changed in transit (key, relays or operator swapped)', async () => {
    const id = devIdentity({ relays: ['https://relay.example/ohttp'] });
    const doc = await id.document();
    const st = JSON.parse(utf8Decode(fromBase64(doc.statement)));
    for (const change of [{ relays: ['https://operator-relay.example/ohttp'] }, { operator: { name: 'someone else' } }, { hpke: { key_config: toBase64(generateHpkeKeyPair().keyConfig) } }]) {
      const tampered = { ...doc, statement: toBase64(utf8Encode(JSON.stringify({ ...st, ...change }))) };
      await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve(tampered) })), 'attestation_invalid');
    }
  });

  it('refuses unknown attestation formats, malformed documents and failed fetches', async () => {
    const doc = await devIdentity().document();
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve({ ...doc, attestation: { format: 'urn:other' } }) })), 'no_verifier');
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve({ ...doc, format: 'bellows-identity/v0' }) })), 'bad_document');
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve({ ...doc, statement: 'not base64!' }) })), 'bad_document');
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve(doc, 503) })), 'fetch_failed');
    await expectRefusal(verifyBellows('not a url', opts({ fetch: serve(doc) })), 'fetch_failed');
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: async () => Promise.reject(new Error('offline')) })), 'fetch_failed');
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve(doc), approvedBuilds: { format: 'nope' } })), 'bad_builds');
  });

  it('refuses a verifier result without a well-formed measurement as attestation_invalid', async () => {
    const f = serve(await devIdentity().document());
    const returning = (out: unknown) => ({ formats: [DEV_ATTESTATION_FORMAT], verify: async () => out as never });
    for (const out of [{}, undefined, null, { measurement: undefined }, { measurement: { type: DEV_MEASUREMENT_TYPE, registers: ['XYZ'] } }]) {
      await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: f, verifier: returning(out) })), 'attestation_invalid');
    }
    // The development verifier, given a signed payload with a malformed measurement.
    const badDev = devIdentity({ attester: devAttester({ measurement: { type: DEV_MEASUREMENT_TYPE, registers: ['NOT HEX'] } }) });
    await expectRefusal(verifyBellows('https://bellows.example', opts({ fetch: serve(await badDev.document()) })), 'attestation_invalid');
  });

  it('verifies a Tinfoil-attested Bellows with the app’s hardware check', async () => {
    const sock = await startFakeTinfoilSocket();
    try {
      const id = new Identity({ attester: tinfoilAttester({ socketPath: sock.path }), version: '1.2.3', measurement: FAKE_TINFOIL_MEASUREMENT, relays: [], operator: null, refreshMs: 60_000 });
      const f = serve(await id.document());
      const build = { version: '1.2.3', image: IMAGE, measurement: FAKE_TINFOIL_MEASUREMENT };
      const v = await verifyBellows('https://bellows.example', { approvedBuilds: [build], verifier: [devVerifier(), tinfoilVerifier({ authenticate: fakeAuthenticate })], fetch: f });
      expect(v.development).toBe(false);
      expect(v.build.version).toBe('1.2.3');
      expect(toHex(v.keyConfig)).toBe(toHex(id.keyConfig));
      // Without a Tinfoil verifier there is nothing to check it with.
      await expectRefusal(verifyBellows('https://bellows.example', { approvedBuilds: [build], verifier: devVerifier(), fetch: f }), 'no_verifier');
      // The app's hardware check refuses the quote.
      const refuse = tinfoilVerifier({ authenticate: async () => Promise.reject(new Error('unknown platform key')) });
      await expectRefusal(verifyBellows('https://bellows.example', { approvedBuilds: [build], verifier: refuse, fetch: f }), 'attestation_invalid');
    } finally {
      await sock.close();
    }
  });
});

describe('configuration', () => {
  const catalog = { suppliers: { mock: { type: 'mock', tier: 'standard' } }, models: [{ id: 'm', supplier: 'mock', upstream: 'm', input_usd_per_mtok: 1, output_usd_per_mtok: 1 }] };
  const base = { BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_DB_PATH: ':memory:' };
  const load = (env: Record<string, string>) => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv, catalog);
  const sealedOpts = { secrets: memorySecrets({ [WALLET_SECRET]: newWalletSecret() }), mounts: { mountPoints: () => ['/', '/sealed'] } };
  const loadSealed = (env: Record<string, string>) =>
    loadConfig({ ...base, BELLOWS_MODE: 'sealed', BELLOWS_SEALED_MOUNTS: '/sealed', BELLOWS_DB_PATH: '/sealed/bellows.db', ...env } as NodeJS.ProcessEnv, catalog, sealedOpts);

  it('development defaults to the dev attester and its measurement; sealed mode to tinfoil', () => {
    const c = load({});
    expect(c).toMatchObject({ attester: 'dev', buildMeasurement: devMeasurement(), operatorAnnouncement: null, version: BELLOWS_VERSION });
    expect(c.env.BELLOWS_RELAYS).toEqual([]);
    expect(c.env.BELLOWS_TINFOIL_ATTESTATION_SOCKET).toBe('/tinfoil/attestation.sock');
    expect(load({ BELLOWS_DEV_MEASUREMENT: 'cd'.repeat(32) }).buildMeasurement).toEqual(devMeasurement('cd'.repeat(32)));
    expect(loadSealed({})).toMatchObject({ attester: 'tinfoil', buildMeasurement: null });
  });

  it('sealed mode refuses the dev attester', () => {
    expect(() => loadSealed({ BELLOWS_ATTESTER: 'dev' })).toThrow(/sealed mode needs a hardware attester/);
  });

  it('reads a claimed build measurement for a hardware attester and refuses a malformed one', () => {
    const json = JSON.stringify(FAKE_TINFOIL_MEASUREMENT);
    expect(load({ BELLOWS_ATTESTER: 'tinfoil', BELLOWS_BUILD_MEASUREMENT: json }).buildMeasurement).toEqual(FAKE_TINFOIL_MEASUREMENT);
    expect(() => load({ BELLOWS_ATTESTER: 'tinfoil', BELLOWS_BUILD_MEASUREMENT: 'not json' })).toThrow(/must be JSON/);
    expect(() => load({ BELLOWS_ATTESTER: 'tinfoil', BELLOWS_BUILD_MEASUREMENT: '{"type":"x","registers":["XY"]}' })).toThrow(/lowercase hex/);
    expect(() => load({ BELLOWS_BUILD_MEASUREMENT: json })).toThrow(/hardware attester/);
    expect(() => load({ BELLOWS_ATTESTER: 'tinfoil', BELLOWS_DEV_MEASUREMENT: 'cd'.repeat(32) })).toThrow(/dev attester only/);
  });

  it('reads relays and the operator announcement file', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'bellows-ann-'));
    // S6: the announcement is a signed operator announcement that matches the configuration (test/unit/operators.test.ts).
    const announcement = signOperatorAnnouncement(
      { url: 'https://bellows.example', relays: ['https://r1.example/ohttp', 'https://r2.example/ohttp'], version: BELLOWS_VERSION, units: ['usd'], mints: ['http://127.0.0.1:1'] },
      new Uint8Array(32).fill(7),
    );
    writeFileSync(join(dir, 'a.json'), JSON.stringify(announcement));
    writeFileSync(join(dir, 'unsigned.json'), JSON.stringify({ kind: 30078, content: 'x' }));
    writeFileSync(join(dir, 'list.json'), '[]');
    const c = load({ BELLOWS_RELAYS: 'https://r1.example/ohttp, https://r2.example/ohttp', BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: join(dir, 'a.json') });
    expect(c.env.BELLOWS_RELAYS).toEqual(['https://r1.example/ohttp', 'https://r2.example/ohttp']);
    expect(c.operatorAnnouncement).toEqual(announcement);
    expect(() => load({ BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: join(dir, 'unsigned.json') })).toThrow(/not a signed Bellows announcement/);
    expect(() => load({ BELLOWS_RELAYS: 'wss://r.example' })).toThrow(/http\(s\) URLs/);
    expect(() => load({ BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: join(dir, 'missing.json') })).toThrow(/missing or not JSON/);
    expect(() => load({ BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: join(dir, 'list.json') })).toThrow(/JSON object/);
  });
});

/**
 * The only packages the client library may import, checked below: the OHTTP and HPKE libraries, and (S6, for
 * Nostr operator announcements) audited pure-JS secp256k1 Schnorr signatures and SHA-256.
 */
const CLIENT_PACKAGES = new Set(['hpke', 'ohttp-ts', '@noble/curves/secp256k1.js', '@noble/hashes/sha2.js']);

describe('client library', () => {
  it('imports no Node-only module (it also typechecks without Node types: client/tsconfig.json)', () => {
    const dir = new URL('../../client/', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from ['"]node:|require\(|\bBuffer\b|\bprocess\./);
      for (const m of src.matchAll(/from '([^']+)'/g)) {
        if (CLIENT_PACKAGES.has(m[1]!)) continue;
        expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\/[a-z-]+\.ts$/);
      }
    }
  });

  it('the packages it imports, and theirs, use no Node-only module either', () => {
    // Comments are not code: noble's sources mention Buffer in comments only.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const seen = new Set<string>();
    const files = new Set<string>();
    const scanFile = (file: string, pkgDir: string, name: string) => {
      if (files.has(file)) return;
      files.add(file);
      const src = code(readFileSync(file, 'utf8'));
      expect(src, `${name}: ${file}`).not.toMatch(/from ?['"]node:|require\(|\bBuffer\b|\bprocess\.|import\(['"]node:/);
      for (const m of src.matchAll(/(?:from|import) ?["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith('.')) {
          // A file of the same package (noble ships many small ES modules).
          const target = join(dirname(file), spec);
          expect(target.startsWith(pkgDir + '/'), `${name} imports ${spec} outside itself`).toBe(true);
          scanFile(target, pkgDir, name);
        } else {
          walk(spec, pkgDir);
        }
      }
    };
    const walk = (spec: string, fromPkgDir: string | null) => {
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      const sub = spec.slice(name.length);
      // pnpm: a package's dependencies sit beside it in the node_modules directory that holds it.
      const nodeModules = fromPkgDir ? (fromPkgDir.split('/').at(-2)!.startsWith('@') ? dirname(dirname(fromPkgDir)) : dirname(fromPkgDir)) : root;
      const pkgDir = realpathSync(join(nodeModules, name));
      seen.add(pkgDir);
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
      const exp = sub ? pkg.exports?.[`.${sub}`] : pkg.exports?.['.'];
      expect(exp ?? (sub ? undefined : pkg.module ?? pkg.main), `${spec} is not exported`).toBeDefined();
      const entry: string = typeof exp === 'string' ? exp : (exp?.import?.default ?? exp?.import ?? exp?.default ?? pkg.module ?? pkg.main);
      scanFile(join(pkgDir, entry), pkgDir, name);
    };
    const root = new URL('../../node_modules/', import.meta.url).pathname;
    for (const p of CLIENT_PACKAGES) walk(p, null);
    expect([...seen].map((d) => basename(d)).sort()).toEqual(['bhttp-ts', 'curves', 'hashes', 'hpke', 'ohttp-ts', 'quicvarint']);
  });
});
