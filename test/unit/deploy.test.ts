/**
 * The deploy kit (docs/DESIGN.md, S7): the Tinfoil configs, the hardened images, the release workflows, the
 * keyserver policy example and the scripts that pin images and add measured builds to builds.json.
 *
 * The release runs this suite in each operator's deploy repository, after the operator has edited
 * tinfoil-config.yml and once builds.json lists their builds. So the tests that depend on example values read
 * the templates in deploy/, and the tests on tinfoil-config.yml assert only what holds for any valid operator
 * config. 'an operator's deploy repository passes the unit suite' checks exactly that.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { checkBuilds } from '../../client/builds.ts';
import { signOperatorAnnouncement } from '../../client/operator.ts';
import { TINFOIL_RELEASE_MEASUREMENT_TYPE } from '../../client/tinfoil.ts';
import { BELLOWS_VERSION, loadConfig } from '../../src/config.ts';
import { setLogSilent } from '../../src/log.ts';
import { BUILTIN_SOURCES } from '../../src/rates.ts';
import type { MountTable } from '../../src/sealed.ts';
import {
  addBuild,
  buildFromDeployment,
  checkTinfoilConfig,
  configFromDeployment,
  declaredSecretNames,
  measurementFromDeployment,
  parseTinfoilConfig,
  pinImage,
  pinImages,
  readEnv,
  unpinnedContainers,
} from '../../scripts/lib/deploy.ts';

setLogSilent(true);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The operator's deployment: in this repository a copy of the template, in a deploy repository their own. */
const CONFIG = read('tinfoil-config.yml');
/** The shipped templates, which keep their example values. */
const EXAMPLE = read('deploy/tinfoil-config.example.yml');
const ONION = read('deploy/tinfoil-config.onion.example.yml');
const TEMPLATES: Record<string, string> = { 'deploy/tinfoil-config.example.yml': EXAMPLE, 'deploy/tinfoil-config.onion.example.yml': ONION };
const CONFIGS: Record<string, string> = { 'tinfoil-config.yml': CONFIG, ...TEMPLATES };
/** Set in the nested run of 'an operator's deploy repository passes the unit suite', which must not recurse. */
const NESTED = process.env.BELLOWS_OPERATOR_COPY === '1';

type Obj = Record<string, any>;
const cfgOf = (text: string) => parseTinfoilConfig(text) as Obj;
const container = (cfg: Obj, name: string) => (cfg.containers as Obj[]).find((c) => c.name === name)!;
const envOf = (c: Obj) => {
  const out: Record<string, string> = {};
  for (const [k, v] of readEnv(c.env, c.name).literals) out[k] = String(v);
  return out;
};

/** A config edited as YAML data, as text again (comments are dropped; only the data matters here). */
const yamlOf = (data: Obj) => stringifyYaml(data);
const mutate = (text: string, fn: (cfg: Obj) => void) => {
  const data = cfgOf(text);
  fn(data);
  return yamlOf(data);
};

/** A throwaway Nostr key for test announcements. */
const TEST_OPERATOR_KEY = new Uint8Array(32).fill(7);
const DIGEST_A = 'ab'.repeat(32);
const DIGEST_B = 'cd'.repeat(32);
/** The edits an operator makes by hand (docs/OPERATE.md, step 1): their keyserver and their mint. */
const operatorEdits = (text: string) => text.replaceAll('https://keys.example.com', 'https://keys.operator.test').replaceAll('mint.example.com', 'mint.operator.test');
/** A config as an operator fills it in: no example values, images pinned. */
function filledIn(text: string): string {
  const t = operatorEdits(text)
    .replace(/ghcr\.io\/example\/bellows-tor@sha256:0{64}/, `ghcr.io/operator/bellows-tor@sha256:${DIGEST_B}`)
    .replace(/ghcr\.io\/example\/bellows@sha256:0{64}/, `ghcr.io/operator/bellows@sha256:${DIGEST_A}`);
  expect(JSON.stringify(parseTinfoilConfig(t))).not.toMatch(/example/);
  return t;
}

describe('tinfoil-config.yml', () => {
  it('tinfoil-config.yml and both templates pass the checks', () => {
    for (const [name, text] of Object.entries(CONFIGS)) expect(checkTinfoilConfig(text), name).toEqual([]);
  });

  it('no container other than bellows has attestation: true', () => {
    for (const [name, text] of Object.entries(CONFIGS)) {
      const cfg = cfgOf(text);
      const attesting = (cfg.containers as Obj[]).filter((c) => c.attestation === true).map((c) => c.name);
      expect(attesting, name).toEqual(['bellows']);
      for (const c of cfg.containers as Obj[]) {
        expect(c.attestation === undefined || typeof c.attestation === 'boolean', `${name} ${c.name}`).toBe(true);
      }
    }
  });

  it('refuses attestation on any other container, a non-boolean attestation and a bellows container without it', () => {
    const torAttests = mutate(ONION, (c) => (container(c, 'tor').attestation = true));
    expect(checkTinfoilConfig(torAttests)).toEqual([expect.stringMatching(/containers\[1\] \(tor\)\.attestation: only the bellows container may have attestation: true/)]);
    const sidecar = mutate(EXAMPLE, (c) =>
      c.containers.push({ name: 'helper', image: `ghcr.io/operator/helper@sha256:${DIGEST_B}`, user: '2000:2000', read_only: true, attestation: true }),
    );
    expect(checkTinfoilConfig(sidecar).join('\n')).toMatch(/\(helper\)\.attestation: only the bellows container/);
    const stringy = mutate(ONION, (c) => (container(c, 'tor').attestation = 'true'));
    expect(checkTinfoilConfig(stringy).join('\n')).toMatch(/\(tor\)\.attestation: must be true or false/);
    const none = mutate(EXAMPLE, (c) => delete container(c, 'bellows').attestation);
    expect(checkTinfoilConfig(none).join('\n')).toMatch(/\(bellows\)\.attestation: must be true/);
  });

  it('refuses secrets on any other container, and any other container on a volume bellows mounts', () => {
    const torSecrets = mutate(ONION, (c) => (container(c, 'tor').secrets = ['BELLOWS_WALLET_SECRET', 'BELLOWS_DATA_VOLUME_KEY']));
    expect(checkTinfoilConfig(torSecrets)).toEqual(['containers[1] (tor).secrets: only the bellows container receives secrets']);
    const torData = mutate(ONION, (c) => (container(c, 'tor').persistent_volumes = ['onion:/onion', 'data:/stolen']));
    expect(checkTinfoilConfig(torData)).toEqual(['containers[1] (tor).persistent_volumes: data is mounted by bellows; a volume belongs to one container']);
    // The reproduction from review: both at once, on a sidecar with open egress.
    const both = mutate(ONION, (c) => {
      container(c, 'tor').secrets = ['BELLOWS_WALLET_SECRET', 'BELLOWS_DATA_VOLUME_KEY'];
      container(c, 'tor').persistent_volumes = ['onion:/onion', 'data:/stolen'];
    });
    expect(checkTinfoilConfig(both)).toHaveLength(2);
    // Mounted first by the sidecar, then by bellows: still one volume, two containers.
    const sidecarFirst = mutate(ONION, (c) => {
      container(c, 'tor').persistent_volumes = ['onion:/onion', 'data:/stolen'];
      c.containers.reverse();
      c.shim['upstream-container'] = 'bellows';
    });
    expect(checkTinfoilConfig(sidecarFirst).join('\n')).toMatch(/\(bellows\)\.persistent_volumes: data is mounted by tor; a volume belongs to one container/);
    const helper = mutate(EXAMPLE, (c) =>
      c.containers.push({ name: 'helper', image: `ghcr.io/operator/helper@sha256:${DIGEST_B}`, user: '2000:2000', read_only: true, secrets: ['TINFOIL_API_KEY'] }),
    );
    expect(checkTinfoilConfig(helper)).toEqual(['containers[1] (helper).secrets: only the bellows container receives secrets']);
    // An empty list gives nothing, and bellows itself may mount its volume at two paths.
    expect(checkTinfoilConfig(mutate(ONION, (c) => (container(c, 'tor').secrets = [])))).toEqual([]);
    expect(checkTinfoilConfig(mutate(EXAMPLE, (c) => container(c, 'bellows').persistent_volumes.push('data:/data2')))).toEqual([]);
  });

  it('refuses admin access, open ports, a writable root, root users, capabilities and inbound ports', () => {
    const cases: [string, (c: Obj) => void, RegExp][] = [
      ['cvm_admin', (c) => (container(c, 'bellows').cvm_admin = true), /cvm_admin: must not be set/],
      ['ports', (c) => (container(c, 'bellows').ports = ['22:22']), /ports: must not be set/],
      ['read_only', (c) => (container(c, 'bellows').read_only = false), /\(bellows\)\.read_only: must be true/],
      ['read_only unset', (c) => delete container(c, 'bellows').read_only, /\(bellows\)\.read_only: must be true/],
      ['read_only not a boolean', (c) => (container(c, 'bellows').read_only = 'true'), /\(bellows\)\.read_only: must be true/],
      ['root', (c) => (container(c, 'bellows').user = '0:0'), /user: must not be root/],
      ['no user', (c) => delete container(c, 'bellows').user, /user: must be a numeric uid:gid/],
      ['cap_add', (c) => (container(c, 'bellows').cap_add = ['NET_BIND_SERVICE']), /cap_add: no capabilities/],
      ['cvm-network', (c) => (c['cvm-network'] = { 'inbound-ports': [22] }), /cvm-network: must not be set/],
    ];
    for (const [name, fn, re] of cases) expect(checkTinfoilConfig(mutate(EXAMPLE, fn)).join('\n'), name).toMatch(re);
    const torWritable = mutate(ONION, (c) => delete container(c, 'tor').read_only);
    expect(checkTinfoilConfig(torWritable)).toEqual(['containers[1] (tor).read_only: must be true; mount writable space with tmpfs or a volume']);
  });

  it('refuses secrets in env, unmeasured settings and a secret listed twice', () => {
    const cases: [string, (c: Obj) => void, RegExp][] = [
      ['wallet secret', (c) => container(c, 'bellows').env.push({ BELLOWS_WALLET_SECRET: '00'.repeat(32) }), /env\.BELLOWS_WALLET_SECRET: looks like a secret/],
      ['supplier key', (c) => container(c, 'bellows').env.push({ OTHER_API_KEY: 'x' }), /env\.OTHER_API_KEY: looks like a secret/],
      ['admin hash', (c) => container(c, 'bellows').env.push({ BELLOWS_ADMIN_TOKEN_HASH: 'ab'.repeat(32) }), /BELLOWS_ADMIN_TOKEN_HASH: looks like a secret/],
      ['bare name', (c) => container(c, 'bellows').env.push('BELLOWS_MARKUP'), /BELLOWS_MARKUP has no value here; every setting must be a measured literal/],
      ['number', (c) => container(c, 'bellows').env.push({ BELLOWS_POW_BITS: 16 }), /BELLOWS_POW_BITS: quote the value/],
      ['twice', (c) => container(c, 'bellows').env.push({ BELLOWS_MARKUP: '2' }), /BELLOWS_MARKUP is set twice/],
      ['domain', (c) => container(c, 'bellows').env.push({ DOMAIN: 'bellows.operator.test' }), /DOMAIN: reserved/],
      ['secrets file', (c) => container(c, 'bellows').env.push({ BELLOWS_SECRETS_FILE: '/data/secrets.json' }), /BELLOWS_SECRETS_FILE: must not be set/],
      ['file source', (c) => (container(c, 'bellows').env.find((e: Obj) => 'BELLOWS_SECRETS' in e).BELLOWS_SECRETS = 'file'), /BELLOWS_SECRETS: must be "platform"/],
      ['no wallet secret', (c) => (container(c, 'bellows').secrets = ['TINFOIL_API_KEY']), /must list BELLOWS_WALLET_SECRET/],
      ['no keyserver', (c) => delete c['keyserver-url'], /keyserver-url: required/],
      ['http keyserver', (c) => (c['keyserver-url'] = 'http://keys.operator.test'), /keyserver-url: must be https/],
      ['old cvm', (c) => (c['cvm-version'] = '0.12.4'), /cvm-version: must be 0\.13\.0 or newer/],
    ];
    for (const [name, fn, re] of cases) expect(checkTinfoilConfig(mutate(EXAMPLE, fn)).join('\n'), name).toMatch(re);
  });

  it('refuses a database or a sealed mount off the encrypted volume, and a volume without a key', () => {
    const setEnv = (c: Obj, name: string, value: string) => {
      const env = container(c, 'bellows').env as Obj[];
      const item = env.find((e) => name in e);
      if (item) item[name] = value;
      else env.push({ [name]: value });
    };
    const cases: [string, (c: Obj) => void, RegExp][] = [
      ['development', (c) => setEnv(c, 'BELLOWS_MODE', 'development'), /BELLOWS_MODE: must be "sealed"/],
      ['db elsewhere', (c) => setEnv(c, 'BELLOWS_DB_PATH', '/tmp/bellows.db'), /BELLOWS_DB_PATH: \/tmp\/bellows\.db is not under BELLOWS_SEALED_MOUNTS/],
      ['db relative', (c) => setEnv(c, 'BELLOWS_DB_PATH', 'data/bellows.db'), /BELLOWS_DB_PATH: must be an absolute path/],
      ['mount not a volume', (c) => setEnv(c, 'BELLOWS_SEALED_MOUNTS', '/tmp'), /BELLOWS_SEALED_MOUNTS: \/tmp is not one of this container's persistent_volumes/],
      ['no mounts', (c) => setEnv(c, 'BELLOWS_SEALED_MOUNTS', ''), /BELLOWS_SEALED_MOUNTS: name the encrypted volume/],
      ['no key', (c) => delete c.volumes[0]['key-secret'], /volumes\[0\]\.key-secret: required/],
      ['exec', (c) => (c.volumes[0].exec = true), /volumes\[0\]\.exec: must not allow executables/],
      ['undeclared volume', (c) => (container(c, 'bellows').persistent_volumes = ['other:/data']), /other is not declared under volumes/],
      ['dev attester', (c) => setEnv(c, 'BELLOWS_ATTESTER', 'dev'), /BELLOWS_ATTESTER: must be "tinfoil"/],
      ['own measurement', (c) => setEnv(c, 'BELLOWS_BUILD_MEASUREMENT', '{}'), /cannot hold its own measurement/],
    ];
    for (const [name, fn, re] of cases) expect(checkTinfoilConfig(mutate(EXAMPLE, fn)).join('\n'), name).toMatch(re);
  });

  describe('BELLOWS_STORAGE memory: no volume', () => {
    const setEnv = (c: Obj, name: string, value: string) => {
      const env = container(c, 'bellows').env as Obj[];
      const item = env.find((e) => name in e);
      if (item) item[name] = value;
      else env.push({ [name]: value });
    };
    /** The plain template run without a volume, as docs/OPERATE.md says. */
    const toMemory = (c: Obj) => {
      delete c.volumes;
      const b = container(c, 'bellows');
      delete b.persistent_volumes;
      b.tmpfs = { '/tmp': 'size=256m,mode=1777' };
      setEnv(c, 'BELLOWS_STORAGE', 'memory');
      setEnv(c, 'BELLOWS_SEALED_MOUNTS', '/tmp');
      setEnv(c, 'BELLOWS_DB_PATH', '/tmp/bellows.db');
    };
    const MEMORY = mutate(EXAMPLE, toMemory);
    const memoryWith = (fn: (c: Obj) => void) => mutate(MEMORY, fn);

    it('accepts a config with no volume, the database on a tmpfs the sealed mounts cover, and no volume key', () => {
      expect(checkTinfoilConfig(MEMORY)).toEqual([]);
      expect(checkTinfoilConfig(filledIn(MEMORY), { release: true })).toEqual([]);
      // tmpfs as a list of "path:options", an empty volume list and a sealed mount with a trailing slash.
      expect(checkTinfoilConfig(memoryWith((c) => (container(c, 'bellows').tmpfs = ['/tmp:size=256m'])))).toEqual([]);
      expect(checkTinfoilConfig(memoryWith((c) => (c.volumes = [])))).toEqual([]);
      expect(checkTinfoilConfig(memoryWith((c) => setEnv(c, 'BELLOWS_SEALED_MOUNTS', '/tmp/')))).toEqual([]);
      // Volume, said out loud, is the template as it is.
      expect(checkTinfoilConfig(mutate(EXAMPLE, (c) => setEnv(c, 'BELLOWS_STORAGE', 'volume')))).toEqual([]);
    });

    it('refuses each way a memory config can go wrong', () => {
      const cases: [string, (c: Obj) => void, RegExp][] = [
        ['a volume', (c) => (c.volumes = cfgOf(EXAMPLE).volumes), /^volumes: must not be set; BELLOWS_STORAGE is "memory"/],
        [
          'a mounted volume',
          (c) => {
            c.volumes = cfgOf(EXAMPLE).volumes;
            container(c, 'bellows').persistent_volumes = ['data:/data'];
          },
          /\(bellows\)\.persistent_volumes: must not be set; BELLOWS_STORAGE is "memory"/,
        ],
        ['a volume key', (c) => container(c, 'bellows').secrets.push('BELLOWS_DATA_VOLUME_KEY'), /secrets: BELLOWS_DATA_VOLUME_KEY is a volume key; with BELLOWS_STORAGE "memory" there is no volume/],
        ['no tmpfs', (c) => delete container(c, 'bellows').tmpfs, /BELLOWS_SEALED_MOUNTS: \/tmp is not one of this container's tmpfs mounts/],
        ['db off the tmpfs', (c) => setEnv(c, 'BELLOWS_DB_PATH', '/var/bellows.db'), /BELLOWS_DB_PATH: \/var\/bellows\.db is not on a tmpfs mount of this container/],
        ['db relative', (c) => setEnv(c, 'BELLOWS_DB_PATH', 'bellows.db'), /BELLOWS_DB_PATH: must be an absolute path on a tmpfs mount/],
        ['no sealed mounts', (c) => setEnv(c, 'BELLOWS_SEALED_MOUNTS', ''), /BELLOWS_SEALED_MOUNTS: name the tmpfs mount path that holds the database/],
        ['sealed mount not a tmpfs', (c) => setEnv(c, 'BELLOWS_SEALED_MOUNTS', '/run'), /BELLOWS_SEALED_MOUNTS: \/run is not one of this container's tmpfs mounts/],
        [
          'db on a tmpfs the sealed mounts miss',
          (c) => {
            container(c, 'bellows').tmpfs = { '/tmp': 'size=256m', '/run': 'size=16m' };
            setEnv(c, 'BELLOWS_DB_PATH', '/run/bellows.db');
          },
          /BELLOWS_DB_PATH: \/run\/bellows\.db is not under BELLOWS_SEALED_MOUNTS/,
        ],
        ['an unknown storage', (c) => setEnv(c, 'BELLOWS_STORAGE', 'disk'), /BELLOWS_STORAGE: must be "volume" or "memory"/],
      ];
      for (const [name, fn, re] of cases) {
        const problems = checkTinfoilConfig(memoryWith(fn));
        expect(problems.join('\n'), name).toMatch(re);
      }
    });

    it('refuses volume storage with the database on a tmpfs, and keeps every volume rule', () => {
      // The volume-less config without BELLOWS_STORAGE, or with it set to volume.
      for (const storage of [undefined, 'volume']) {
        const text = memoryWith((c) => {
          const env = container(c, 'bellows').env as Obj[];
          container(c, 'bellows').env = env.filter((e) => !('BELLOWS_STORAGE' in e));
          if (storage) setEnv(c, 'BELLOWS_STORAGE', storage);
        });
        const problems = checkTinfoilConfig(text).join('\n');
        expect(problems, String(storage)).toMatch(/BELLOWS_DB_PATH: \/tmp\/bellows\.db is on the tmpfs \/tmp, which every restart empties, and BELLOWS_STORAGE is "volume" \(the default\)/);
        expect(problems, String(storage)).toMatch(/BELLOWS_SEALED_MOUNTS: \/tmp is not one of this container's persistent_volumes/);
      }
      // The template with its database moved to /tmp: the old refusal and the new, clearer one.
      const moved = checkTinfoilConfig(mutate(EXAMPLE, (c) => setEnv(c, 'BELLOWS_DB_PATH', '/tmp/bellows.db'))).join('\n');
      expect(moved).toMatch(/is not under BELLOWS_SEALED_MOUNTS/);
      expect(moved).toMatch(/is on the tmpfs \/tmp/);
    });

    it('Bellows starts from the memory env with storage memory on the tmpfs, and refuses volume there', () => {
      const env: Record<string, string> = envOf(container(cfgOf(MEMORY), 'bellows'));
      env.BELLOWS_WALLET_SECRET = '11'.repeat(32);
      env.TINFOIL_API_KEY = 'test-only';
      env.TOKENFACTORY_API_KEY = 'test-only';
      // /tmp as this machine resolves it (macOS links it to /private/tmp).
      const tmp = realpathSync('/tmp');
      const mounts: MountTable = { mountPoints: () => ['/', tmp], fsType: (m) => (m === tmp ? 'tmpfs' : 'overlay') };
      const config = loadConfig(env as NodeJS.ProcessEnv, undefined, { mounts });
      expect(config).toMatchObject({ mode: 'sealed', storage: 'memory', sealedMount: tmp });
      expect(() => loadConfig({ ...env, BELLOWS_STORAGE: 'volume' } as NodeJS.ProcessEnv, undefined, { mounts })).toThrow(/a tmpfs mount that every restart empties, and BELLOWS_STORAGE is volume/);
    });
  });

  it('refuses open egress for bellows, bad allowlists, two egress networks and routes to anything but bellows', () => {
    const cases: [string, (c: Obj) => void, RegExp][] = [
      ['open', (c) => (c.networks.egress = { egress: 'open' }), /\(bellows\)\.networks: egress has open egress/],
      ['scheme', (c) => c.networks.egress.allow.push('https://api.operator.test'), /allow\[\d+\]: must be a hostname/],
      ['wildcard', (c) => c.networks.egress.allow.push('*.tinfoil.sh'), /allow\[\d+\]: must be a hostname/],
      ['empty allowlist', (c) => delete c.networks.egress.allow, /an allowlist network needs its hostnames/],
      ['reserved', (c) => (c.networks['shim-net'] = {}), /shim-net is reserved/],
      [
        'two egress',
        (c) => {
          c.networks.more = { egress: 'allowlist', allow: ['api.operator.test'] };
          container(c, 'bellows').networks.push('more');
        },
        /at most one network with egress/,
      ],
      ['undeclared', (c) => container(c, 'bellows').networks.push('nowhere'), /nowhere is not declared under networks/],
      ['upstream', (c) => (c.shim['upstream-container'] = 'tor'), /shim\.upstream-container: must be bellows/],
      ['port', (c) => (c.shim['upstream-port'] = 8080), /shim\.upstream-port: must be the bellows PORT \(8787\)/],
      ['everything', (c) => (c.shim.paths = ['/*']), /shim\.paths: list the paths Bellows serves, not everything/],
      ['unpinned', (c) => (container(c, 'bellows').image = 'ghcr.io/operator/bellows:latest'), /image: must be pinned by digest/],
    ];
    for (const [name, fn, re] of cases) expect(checkTinfoilConfig(mutate(name === 'upstream' ? ONION : EXAMPLE, fn)).join('\n'), name).toMatch(re);
    expect(checkTinfoilConfig('a: [1\n')).toEqual([expect.stringMatching(/^not valid YAML/)]);
    expect(checkTinfoilConfig('a: 1\na: 2\n')).toEqual([expect.stringMatching(/^not valid YAML/)]);
  });

  it('a release refuses example values and placeholder digests, and accepts the filled-in templates', () => {
    for (const [name, text] of Object.entries(TEMPLATES)) {
      const problems = checkTinfoilConfig(text, { release: true }).join('\n');
      expect(problems, name).toMatch(/the digest is a placeholder/);
      expect(problems, name).toMatch(/https:\/\/keys\.example\.com is an example value/);
      expect(problems, name).toMatch(/mint\.example\.com is an example value/);
      expect(checkTinfoilConfig(filledIn(text), { release: true }), name).toEqual([]);
    }
  });

  it('the onion template is the plain template plus the tor sidecar, its volume and its networks', () => {
    const onion = cfgOf(ONION);
    const tor = container(onion, 'tor');
    expect(tor.attestation).toBeUndefined();
    expect(tor.secrets).toBeUndefined();
    expect(tor.persistent_volumes).toEqual(['onion:/onion']);
    expect(onion.volumes.find((v: Obj) => v.name === 'onion')['key-secret']).toBe('BELLOWS_ONION_VOLUME_KEY');
    expect(onion.networks['tor-out']).toEqual({ egress: 'open' });
    expect(onion.networks.onion).toEqual({});
    onion.containers = onion.containers.filter((c: Obj) => c.name !== 'tor');
    onion.volumes = onion.volumes.filter((v: Obj) => v.name !== 'onion');
    delete onion.networks['tor-out'];
    delete onion.networks.onion;
    container(onion, 'bellows').networks = container(onion, 'bellows').networks.filter((n: string) => n !== 'onion');
    expect(onion).toEqual(cfgOf(EXAMPLE));
  });

  it('Bellows starts in sealed mode from the bellows container env, with secrets from the platform and the database on /data', () => {
    for (const [name, text] of Object.entries(TEMPLATES)) {
      const cfg = cfgOf(text);
      const env: Record<string, string> = envOf(container(cfg, 'bellows'));
      // What the keyserver releases (stand-in values, never real ones).
      env.BELLOWS_WALLET_SECRET = '11'.repeat(32);
      env.BELLOWS_ADMIN_TOKEN_HASH = '22'.repeat(32);
      env.TINFOIL_API_KEY = 'test-only';
      env.TOKENFACTORY_API_KEY = 'test-only';
      const announcement = signOperatorAnnouncement(
        { url: 'https://bellows.operator.test', version: BELLOWS_VERSION, units: env.BELLOWS_UNITS!.split(','), mints: env.BELLOWS_TRUSTED_MINTS!.split(',') },
        TEST_OPERATOR_KEY,
      );
      env.BELLOWS_OPERATOR_ANNOUNCEMENT = JSON.stringify(announcement);
      const mounts: MountTable = { mountPoints: () => ['/', '/tmp', '/data', '/onion'] };
      const config = loadConfig(env as NodeJS.ProcessEnv, undefined, { mounts });
      expect(config.mode, name).toBe('sealed');
      expect(config.secrets.kind, name).toBe('platform');
      expect(config.sealedMount, name).toBe('/data');
      expect(config.attester, name).toBe('tinfoil');
      expect(config.buildMeasurement, name).toBeNull();
      expect(config.env.PORT, name).toBe(8787);
      expect(config.env.BELLOWS_DB_PATH, name).toBe('/data/bellows.db');
      expect(config.catalog.models.length, name).toBeGreaterThan(0);
      expect(config.operatorAnnouncement, name).toEqual(announcement);
      // The same env without its volume mounted is refused.
      expect(() => loadConfig(env as NodeJS.ProcessEnv, undefined, { mounts: { mountPoints: () => ['/'] } }), name).toThrow(/\/data is not a mount point/);
    }
  });

  it('declares exactly the secrets Bellows reads from the platform', () => {
    expect(declaredSecretNames(EXAMPLE)).toEqual([
      'BELLOWS_ADMIN_TOKEN_HASH',
      'BELLOWS_DATA_VOLUME_KEY',
      'BELLOWS_OPERATOR_ANNOUNCEMENT',
      'BELLOWS_WALLET_SECRET',
      'TINFOIL_API_KEY',
      'TOKENFACTORY_API_KEY',
    ]);
    expect(declaredSecretNames(ONION)).toEqual([...declaredSecretNames(EXAMPLE), 'BELLOWS_ONION_VOLUME_KEY'].sort());
  });

  it('bellows asks the keyserver for the API key of every supplier in config/models.json', () => {
    const catalog = JSON.parse(read('config/models.json'));
    const supplierKeys = Object.values(catalog.suppliers as Record<string, Obj>).map((s) => s.apiKeySecret).filter(Boolean);
    expect(supplierKeys.length).toBeGreaterThan(0);
    for (const [name, text] of Object.entries(CONFIGS)) expect(container(cfgOf(text), 'bellows').secrets, name).toEqual(expect.arrayContaining(supplierKeys));
  });

  describe('egress allowlist', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('covers the mints, the suppliers, the rate sources and the discovery relays the config uses', async () => {
      for (const [name, text] of Object.entries(CONFIGS)) {
        const cfg = cfgOf(text);
        const allow = new Set<string>(cfg.networks.egress.allow);
        const env = envOf(container(cfg, 'bellows'));
        const hosts = new Set<string>();
        for (const m of env.BELLOWS_TRUSTED_MINTS!.split(',')) hosts.add(new URL(m).hostname);
        for (const r of env.BELLOWS_FOREIGN_DISCOVERY_RELAYS!.split(',')) hosts.add(new URL(r).hostname);
        const catalog = JSON.parse(read('config/models.json'));
        for (const s of Object.values(catalog.suppliers as Record<string, Obj>)) {
          for (const u of [s.baseUrl, s.enclaveUrl, s.attestationUrl]) if (u) hosts.add(new URL(u).hostname);
        }
        // The rate sources' hosts, from the requests they actually make.
        const seen: string[] = [];
        vi.stubGlobal('fetch', async (url: string | URL) => {
          seen.push(new URL(String(url)).hostname);
          return new Response('{}', { status: 500 });
        });
        for (const src of env.BELLOWS_RATE_SOURCES!.split(',')) {
          await BUILTIN_SOURCES[src]!.fetchBtcUsd(AbortSignal.timeout(1000)).catch(() => {});
        }
        expect(seen.length, name).toBe(env.BELLOWS_RATE_SOURCES!.split(',').length);
        for (const h of seen) hosts.add(h);
        for (const h of hosts) expect(allow.has(h), `${name}: ${h}`).toBe(true);
      }
    });
  });

  it("the templates' shim exposes every path Bellows serves to clients and operators", () => {
    for (const [name, text] of Object.entries(TEMPLATES)) {
      const paths: string[] = cfgOf(text).shim.paths;
      const matches = (p: string) => paths.some((pat) => (pat.endsWith('*') ? p.startsWith(pat.slice(0, -1)) : p === pat));
      for (const p of [
        '/healthz',
        '/v1/models',
        '/v1/chat/completions',
        '/v1/wallet',
        '/v1/wallet/fund/lightning',
        '/v1/change/abc',
        '/v1/pow',
        '/.well-known/bellows',
        '/.well-known/hpke-keys',
        '/attestation',
        '/ohttp',
        '/ohttp-keys',
        '/admin/api',
        '/admin/api/overview',
      ]) {
        expect(matches(p), `${name}: ${p}`).toBe(true);
      }
      expect(matches('/'), `${name}: /`).toBe(false);
    }
  });

  it('the docs match the kit: in a sealed deployment the admin API is on the public origin, guarded only by a generated token', () => {
    for (const [name, text] of Object.entries(TEMPLATES)) {
      expect(cfgOf(text).shim.paths, name).toEqual(expect.arrayContaining(['/admin/api', '/admin/api/*']));
      expect(text, name).toMatch(/operator API, on the public origin/);
    }
    const readme = read('README.md');
    const admin = readme.slice(readme.indexOf('## Admin API'), readme.indexOf('## Admin CLI'));
    expect(admin).toMatch(/\*\*Sealed \(the Tinfoil deploy kit\)\.\*\*[^\n]*same public origin[^\n]*the token is its only protection/);
    expect(admin).toMatch(/remove `\/admin\/api` and `\/admin\/api\/\*` from the shim's `paths`/);
    expect(admin).toContain('openssl rand -hex 32');
    // The self-hosted advice no longer claims to cover the sealed kit.
    expect(admin).not.toMatch(/Keep `\/admin` off the public internet anyway/);
    const operate = read('docs/OPERATE.md');
    expect(operate).toMatch(/Generate the admin token with `openssl rand -hex 32` and nothing else\. The shim in `tinfoil-config\.yml` serves `\/admin\/api` at your public origin/);
    expect(read('src/admin-api.ts')).toMatch(/sealed deployment \(the Tinfoil kit\)/);
  });
});

describe('pinImage', () => {
  it('changes only the image of the named container', () => {
    const image = `ghcr.io/operator/bellows@sha256:${DIGEST_A}`;
    const pinned = pinImage(EXAMPLE, 'bellows', image);
    const before = EXAMPLE.split('\n');
    const after = pinned.split('\n');
    expect(after.length).toBe(before.length);
    const changed = after.map((l, i) => [l, before[i]]).filter(([a, b]) => a !== b);
    expect(changed).toEqual([[`    image: "${image}"`, expect.stringContaining('image: "ghcr.io/example/bellows@sha256:')]]);
    expect(container(cfgOf(pinned), 'bellows').image).toBe(image);
    expect(checkTinfoilConfig(pinned)).toEqual([]);
  });

  it('pins each container of the onion variant separately', () => {
    const a = `ghcr.io/operator/bellows@sha256:${DIGEST_A}`;
    const b = `ghcr.io/operator/bellows-tor@sha256:${DIGEST_B}`;
    const cfg = cfgOf(pinImage(pinImage(ONION, 'bellows', a), 'tor', b));
    expect(container(cfg, 'bellows').image).toBe(a);
    expect(container(cfg, 'tor').image).toBe(b);
  });

  it('refuses an unpinned image and an unknown container', () => {
    expect(() => pinImage(EXAMPLE, 'bellows', 'ghcr.io/operator/bellows:1.0.0')).toThrow(/pinned by digest/);
    expect(() => pinImage(EXAMPLE, 'bellows', `ghcr.io/operator/bellows@sha256:${'AB'.repeat(32)}`)).toThrow(/pinned by digest/);
    expect(() => pinImage(EXAMPLE, 'tor', `ghcr.io/operator/bellows-tor@sha256:${DIGEST_B}`)).toThrow(/no container named tor/);
  });

  it('pinImages pins every named container the file has, skips the others and refuses a placeholder left behind', () => {
    const a = `ghcr.io/operator/bellows@sha256:${DIGEST_A}`;
    const b = `ghcr.io/operator/bellows-tor@sha256:${DIGEST_B}`;
    expect(unpinnedContainers(ONION)).toEqual(['bellows', 'tor']);
    const onion = pinImages(ONION, { bellows: a, tor: b });
    expect(onion).toEqual({ text: pinImage(pinImage(ONION, 'bellows', a), 'tor', b), pinned: ['bellows', 'tor'], absent: [] });
    expect(unpinnedContainers(onion.text)).toEqual([]);
    const plain = pinImages(EXAMPLE, { bellows: a, tor: b });
    expect(plain).toEqual({ text: pinImage(EXAMPLE, 'bellows', a), pinned: ['bellows'], absent: ['tor'] });
    expect(() => pinImages(ONION, { bellows: a })).toThrow(/tor: still a placeholder digest/);
    expect(() => pinImages(EXAMPLE, { tor: b })).toThrow(/bellows: still a placeholder digest/);
    expect(() => pinImages(EXAMPLE, { bellows: a, tor: 'ghcr.io/operator/bellows-tor:1.0.0' })).toThrow(/tor=.*pinned by digest/);
  });

  it('pnpm deploy:pin writes the file, and writes nothing when it fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellows-pin-'));
    const pin = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts/pin-image.ts'), ...args], { encoding: 'utf8' });
    try {
      const file = join(dir, 'tinfoil-config.yml');
      writeFileSync(file, EXAMPLE);
      const image = `ghcr.io/operator/bellows@sha256:${DIGEST_A}`;
      const tor = `ghcr.io/operator/bellows-tor@sha256:${DIGEST_B}`;
      const ok = pin(file, `bellows=${image}`, `tor=${tor}`);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('no tor container; skipped');
      expect(readFileSync(file, 'utf8')).toBe(pinImage(EXAMPLE, 'bellows', image));
      for (const args of [[file, 'bellows=nope'], [file, 'bellows', image], [file, `=${image}`], [file, `bellows=${image}`, `bellows=${image}`], [file]]) {
        expect(pin(...args).status, args.join(' ')).toBe(1);
      }
      writeFileSync(file, ONION);
      const half = pin(file, `bellows=${image}`);
      expect(half.status).toBe(1);
      expect(half.stderr).toMatch(/tor: still a placeholder digest/);
      expect(readFileSync(file, 'utf8')).toBe(ONION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the release workflow pins the file Tinfoil measures', () => {
  const wf = parseYaml(read('.github/workflows/tinfoil-release.yml')) as Obj;
  const step = (name: string) => (wf.jobs.release.steps as Obj[]).find((s) => s.name === name)!.run as string;

  /** Runs a step's own shell script with `pnpm <script>` mapped onto this repository's scripts. */
  function runStep(name: string, cwd: string) {
    const shim = `pnpm() { s="$1"; shift; case "$s" in deploy:pin) "$NODE" "$ROOT/scripts/pin-image.ts" "$@";; deploy:check) "$NODE" "$ROOT/scripts/check-deploy.ts" "$@";; *) exit 99;; esac; }`;
    return spawnSync('sh', ['-ec', `${shim}\n${step(name)}`], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE: process.execPath,
        ROOT,
        BELLOWS_IMAGE: `ghcr.io/operator/bellows-deploy@sha256:${DIGEST_A}`,
        TOR_IMAGE: `ghcr.io/operator/bellows-deploy-tor@sha256:${DIGEST_B}`,
        GITHUB_STEP_SUMMARY: join(cwd, 'summary.md'),
      },
    });
  }

  for (const [name, template] of [
    ['the plain template', 'deploy/tinfoil-config.example.yml'],
    ['the onion template copied over tinfoil-config.yml', 'deploy/tinfoil-config.onion.example.yml'],
  ] as const) {
    it(`${name}, edited by the operator, passes the release check after the workflow's pin step`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'bellows-release-pin-'));
      try {
        writeFileSync(join(dir, 'tinfoil-config.yml'), operatorEdits(read(template)));
        // Before the pin step the release check refuses the placeholder digests.
        expect(runStep('Check the release config', dir).status).toBe(1);
        const pinned = runStep('Pin the image digests', dir);
        expect(pinned.status, pinned.stderr).toBe(0);
        const text = readFileSync(join(dir, 'tinfoil-config.yml'), 'utf8');
        expect(unpinnedContainers(text)).toEqual([]);
        const check = runStep('Check the release config', dir);
        expect(check.status, check.stderr).toBe(0);
        expect(check.stdout).toContain('valid for a release');
        const cfg = cfgOf(text);
        expect(container(cfg, 'bellows').image).toBe(`ghcr.io/operator/bellows-deploy@sha256:${DIGEST_A}`);
        if (template.includes('onion')) expect(container(cfg, 'tor').image).toBe(`ghcr.io/operator/bellows-deploy-tor@sha256:${DIGEST_B}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('pnpm deploy:check', () => {
  it('passes tinfoil-config.yml and the templates, and the release check refuses a template until it is filled in', () => {
    const ok = spawnSync(process.execPath, [join(ROOT, 'scripts/check-deploy.ts')], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`${join(ROOT, 'tinfoil-config.yml')}: valid`);
    expect(ok.stdout).toContain('tinfoil-config.example.yml: valid');
    expect(ok.stdout).toContain('tinfoil-config.onion.example.yml: valid');
    for (const template of Object.keys(TEMPLATES)) {
      const release = spawnSync(process.execPath, [join(ROOT, 'scripts/check-deploy.ts'), '--release', join(ROOT, template)], { encoding: 'utf8' });
      expect(release.status, template).toBe(1);
      expect(release.stderr, template).toContain('is an example value');
    }
    // With --release and no file, only tinfoil-config.yml: the templates keep their example values.
    const measured = spawnSync(process.execPath, [join(ROOT, 'scripts/check-deploy.ts'), '--release'], { encoding: 'utf8' });
    expect(measured.stdout + measured.stderr).toContain(join(ROOT, 'tinfoil-config.yml'));
    expect(measured.stdout + measured.stderr).not.toContain('example.yml');
    const dir = mkdtempSync(join(tmpdir(), 'bellows-check-'));
    try {
      const file = join(dir, 'tinfoil-config.yml');
      writeFileSync(file, filledIn(EXAMPLE));
      const filled = spawnSync(process.execPath, [join(ROOT, 'scripts/check-deploy.ts'), '--release', file], { encoding: 'utf8' });
      expect(filled.status).toBe(0);
      expect(filled.stdout).toContain('valid for a release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A tinfoil-deployment.json as Tinfoil's measure action publishes it (shape from a public release). */
function deploymentManifest(configText: string, over: Obj = {}): Obj {
  return {
    snp_measurement: '1a'.repeat(48),
    tdx_measurement: { rtmr1: '2b'.repeat(48), rtmr2: '3c'.repeat(48) },
    vm_shape: { cpus: 2, memory_mb: 8192, gpus: 0, disks: 4 },
    cmdline: 'readonly=on',
    hashes: { version: 'v0.14.17', root: '00'.repeat(32), initrd: '00'.repeat(32), kernel: '00'.repeat(32), raw: '00'.repeat(32) },
    config: Buffer.from(configText).toString('base64'),
    ...over,
  };
}

describe('measured releases and builds.json', () => {
  const RELEASED = '2026-12-01';

  it('reads the measurement in the form builds.json lists it', () => {
    const m = deploymentManifest(filledIn(EXAMPLE));
    expect(measurementFromDeployment(m)).toEqual({ type: TINFOIL_RELEASE_MEASUREMENT_TYPE, registers: ['1a'.repeat(48), '2b'.repeat(48), '3c'.repeat(48)] });
    expect(configFromDeployment(m)).toBe(filledIn(EXAMPLE));
    expect(() => measurementFromDeployment(deploymentManifest('', { snp_measurement: '1A'.repeat(48) }))).toThrow(/snp_measurement/);
    expect(() => measurementFromDeployment(deploymentManifest('', { snp_measurement: '1a'.repeat(32) }))).toThrow(/snp_measurement/);
    expect(() => measurementFromDeployment(deploymentManifest('', { tdx_measurement: { rtmr1: '2b'.repeat(48) } }))).toThrow(/rtmr2/);
    expect(() => measurementFromDeployment([])).toThrow(/JSON object/);
  });

  it('makes the entry from the measured config, which must pass the release checks', () => {
    const b = buildFromDeployment(deploymentManifest(filledIn(EXAMPLE)), { version: 'v1.0.0', deployment: 'operator/bellows-deploy@v1.0.0', released: RELEASED });
    expect(b).toEqual({
      version: '1.0.0',
      image: `ghcr.io/operator/bellows@sha256:${DIGEST_A}`,
      measurement: { type: TINFOIL_RELEASE_MEASUREMENT_TYPE, registers: ['1a'.repeat(48), '2b'.repeat(48), '3c'.repeat(48)] },
      released: RELEASED,
      deployment: 'operator/bellows-deploy@v1.0.0',
    });
    expect(() => buildFromDeployment(deploymentManifest(EXAMPLE), { version: '1.0.0', deployment: 'operator/bellows-deploy@v1.0.0', released: RELEASED })).toThrow(
      /does not pass the release checks[\s\S]*placeholder/,
    );
    const attestingTor = filledIn(mutate(ONION, (c) => (container(c, 'tor').attestation = true)));
    expect(() => buildFromDeployment(deploymentManifest(attestingTor), { version: '1.0.0', deployment: 'operator/bellows-deploy@v1.0.0', released: RELEASED })).toThrow(
      /only the bellows container may have attestation: true/,
    );
    const leakyTor = filledIn(
      mutate(ONION, (c) => {
        container(c, 'tor').secrets = ['BELLOWS_WALLET_SECRET', 'BELLOWS_DATA_VOLUME_KEY'];
        container(c, 'tor').persistent_volumes = ['onion:/onion', 'data:/stolen'];
      }),
    );
    expect(() => buildFromDeployment(deploymentManifest(leakyTor), { version: '1.0.0', deployment: 'operator/bellows-deploy@v1.0.0', released: RELEASED })).toThrow(
      /\(tor\)\.secrets: only the bellows container receives secrets[\s\S]*\(tor\)\.persistent_volumes: data is mounted by bellows/,
    );
    const writableTor = filledIn(mutate(ONION, (c) => delete container(c, 'tor').read_only));
    expect(() => buildFromDeployment(deploymentManifest(writableTor), { version: '1.0.0', deployment: 'operator/bellows-deploy@v1.0.0', released: RELEASED })).toThrow(
      /\(tor\)\.read_only: must be true/,
    );
  });

  it('adds builds: one per version and deployment, never one measurement twice', () => {
    const empty = { format: 'bellows-builds/v1', builds: [] };
    const first = buildFromDeployment(deploymentManifest(filledIn(EXAMPLE)), { version: '1.0.0', deployment: 'operator/bellows-deploy@v1.0.0', released: RELEASED });
    const one = addBuild(empty, first);
    expect(one.builds).toEqual([first]);
    expect(checkBuilds(one)).toEqual([]);
    // Another operator's deployment of the same release: a different config, so a different measurement.
    const other = { ...first, deployment: 'other/bellows-deploy@v1.0.0', measurement: { ...first.measurement, registers: ['4d'.repeat(48), '5e'.repeat(48), '6f'.repeat(48)] } };
    expect(addBuild(one, other).builds).toHaveLength(2);
    expect(() => addBuild(one, { ...other, deployment: first.deployment })).toThrow(/1\.0\.0 is listed twice for operator\/bellows-deploy@v1\.0\.0/);
    expect(() => addBuild(one, { ...first, deployment: 'other/bellows-deploy@v1.0.0' })).toThrow(/one measurement names one build/);
    expect(() => addBuild({ builds: 'x' }, first)).toThrow(/builds list/);
  });

  it('pnpm builds:add writes builds.json and refuses a placeholder config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellows builds add '));
    try {
      const builds = join(dir, 'builds.json');
      cpSync(join(ROOT, 'builds.json'), builds);
      const listed = JSON.parse(readFileSync(builds, 'utf8')).builds.length;
      const manifest = join(dir, 'tinfoil-deployment.json');
      writeFileSync(manifest, JSON.stringify(deploymentManifest(filledIn(EXAMPLE))));
      const args = ['--deployment-file', manifest, '--version', '1.0.0', '--deployment', 'operator/bellows-deploy@v1.0.0', '--released', RELEASED, '--builds', builds];
      execFileSync(process.execPath, [join(ROOT, 'scripts/add-build.ts'), ...args], { stdio: 'pipe' });
      const out = JSON.parse(readFileSync(builds, 'utf8'));
      expect(checkBuilds(out)).toEqual([]);
      expect(out.builds).toHaveLength(listed + 1);
      expect(out.builds.at(-1).deployment).toBe('operator/bellows-deploy@v1.0.0');
      const again = spawnSync(process.execPath, [join(ROOT, 'scripts/add-build.ts'), ...args], { encoding: 'utf8' });
      expect(again.status).toBe(1);
      expect(again.stderr).toMatch(/listed twice/);
      writeFileSync(manifest, JSON.stringify(deploymentManifest(EXAMPLE)));
      const placeholder = spawnSync(process.execPath, [join(ROOT, 'scripts/add-build.ts'), ...args], { encoding: 'utf8' });
      expect(placeholder.status).toBe(1);
      expect(JSON.parse(readFileSync(builds, 'utf8')).builds).toHaveLength(listed + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('keyserver policy example', () => {
  const policy = parseYaml(read('deploy/keyserver/policy.example.yaml')) as Obj;
  const store = JSON.parse(read('deploy/keyserver/store.example.json')) as Obj;

  it('maps every secret the configs ask for, and nothing else', () => {
    const workloads = Object.values(policy.workloads as Record<string, Obj>);
    expect(workloads).toHaveLength(1);
    const w = workloads[0]!;
    expect(w.repo).toMatch(/^[^/\s]+\/[^/\s]+$/);
    expect(w.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(typeof w.domain).toBe('string');
    const names = Object.keys(w.secrets).sort();
    expect(names).toEqual(declaredSecretNames(ONION));
    for (const n of declaredSecretNames(EXAMPLE)) expect(names).toContain(n);
    // Every mapping points at a path and field the file store example holds.
    for (const [name, ref] of Object.entries(w.secrets as Record<string, Obj>)) {
      expect(store[ref.path]?.[ref.field], name).toEqual(expect.stringMatching(/^replace with/));
    }
  });
});

describe('images', () => {
  const dockerfiles = { Dockerfile: read('Dockerfile'), 'deploy/tor/Dockerfile': read('deploy/tor/Dockerfile') };

  it('start from base images pinned by digest, run as a numeric non-root user and fetch nothing at ADD', () => {
    for (const [name, text] of Object.entries(dockerfiles)) {
      const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
      const args = new Map(lines.filter((l) => l.startsWith('ARG ')).map((l) => l.slice(4).split('=') as [string, string]));
      const froms = lines.filter((l) => l.startsWith('FROM '));
      expect(froms.length, name).toBeGreaterThan(0);
      for (const f of froms) {
        const ref = f.split(/\s+/)[1]!.replace(/^\$\{(\w+)\}$/, (_, a: string) => args.get(a) ?? '');
        expect(ref, `${name}: ${f}`).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
      const users = lines.filter((l) => l.startsWith('USER '));
      expect(users.at(-1), name).toMatch(/^USER [1-9]\d*:[1-9]\d*$/);
      const lastUser = lines.lastIndexOf(users.at(-1)!);
      const start = lines.findIndex((l) => l.startsWith('CMD ') || l.startsWith('ENTRYPOINT '));
      expect(start, name).toBeGreaterThan(lastUser);
      expect(lines.filter((l) => /^ADD\s+https?:/i.test(l)), name).toEqual([]);
      expect(lines.filter((l) => l.startsWith('ENV ') && /(SECRET|TOKEN|PASSWORD|API_KEY)/.test(l)), name).toEqual([]);
    }
  });

  it('the Bellows image carries no package manager and the user owns only /data', () => {
    const text = dockerfiles.Dockerfile;
    const final = text.slice(text.lastIndexOf('\nFROM '));
    for (const p of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack', '/usr/local/bin/npx', '/opt/yarn-*']) expect(final).toContain(p);
    expect(final.match(/chown\s+\S+\s+(\S+)/g)).toEqual(['chown 1000:1000 /data']);
    expect(final).not.toMatch(/COPY\s+--chown/);
    // The volume owner in the templates matches the image user.
    for (const text of Object.values(TEMPLATES)) {
      const cfg = cfgOf(text);
      expect(container(cfg, 'bellows').user).toBe('1000:1000');
      expect(cfg.volumes.find((v: Obj) => v.name === 'data').owner).toBe('1000:1000');
    }
    const onion = cfgOf(ONION);
    expect(container(onion, 'tor').user).toBe('10001:10001');
    expect(onion.volumes.find((v: Obj) => v.name === 'onion').owner).toBe('10001:10001');
    expect(dockerfiles['deploy/tor/Dockerfile']).toContain('USER 10001:10001');
  });

  it('the Tor entrypoint is valid POSIX shell', () => {
    const r = spawnSync('sh', ['-n', join(ROOT, 'deploy/tor/entrypoint.sh')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const text = read('deploy/tor/entrypoint.sh');
    expect(text).toContain('HiddenServiceDir $onion_dir/service');
    expect(text).toContain('SocksPort 0');
  });
});

describe('release workflows', () => {
  const workflows = { release: read('.github/workflows/tinfoil-release.yml'), publish: read('.github/workflows/tinfoil-release-publish.yml') };

  it('pin every action by commit and grant no permission by default', () => {
    for (const [name, text] of Object.entries(workflows)) {
      const wf = parseYaml(text) as Obj;
      expect(wf.permissions, name).toEqual({});
      const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]!);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const u of uses) expect(u, `${name}: ${u}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  it('release builds, pins, checks and tags; publish measures and proposes the build in a pull request', () => {
    const r = workflows.release;
    for (const step of [
      'pnpm install --frozen-lockfile',
      'pnpm typecheck',
      'pnpm test',
      'pnpm test:e2e',
      'pnpm deploy:pin tinfoil-config.yml bellows="$BELLOWS_IMAGE" tor="$TOR_IMAGE"',
      'pnpm deploy:check --release tinfoil-config.yml',
      'gh workflow run tinfoil-release-publish.yml',
    ]) {
      expect(r, step).toContain(step);
    }
    // Only the measured file is pinned and committed; the templates keep their example values for the tests.
    expect([...r.matchAll(/pnpm deploy:pin (\S+)/g)].map((m) => m[1])).toEqual(['tinfoil-config.yml']);
    expect(r.match(/git add [^\n]*/g)).toEqual(['git add tinfoil-config.yml']);
    expect(r).toMatch(/git push origin "refs\/tags\/\$VERSION"/);
    const p = workflows.publish;
    expect(p).toContain('tinfoilsh/measure-image-action@');
    expect(p).toContain('pnpm builds:add');
    expect(p).toContain('gh pr create');
    // Neither workflow pushes to a branch other than its own new one: approval is a reviewed merge.
    for (const [name, text] of Object.entries(workflows)) {
      for (const push of text.match(/git push[^\n]*/g) ?? []) expect(push, name).toMatch(/refs\/(tags\/\$VERSION|heads\/\$branch)"$/);
    }
  });

  it('a failed release can be finished by hand: OPERATE.md says how, and Publish may be started on the tag', () => {
    expect(workflows.publish).not.toMatch(/Do not run by hand/);
    expect(workflows.publish).toMatch(/run by hand only to recover \(docs\/OPERATE\.md/);
    const operate = read('docs/OPERATE.md');
    const recovery = operate.slice(operate.indexOf('### If a step fails'), operate.indexOf('NOT VERIFIED: the workflows'));
    expect(recovery).toContain('gh workflow run tinfoil-release-publish.yml --ref v<version>');
    expect(recovery).toContain('gh release download v<version> --pattern tinfoil-deployment.json');
    expect(recovery).toMatch(/pnpm builds:add --deployment-file \S+tinfoil-deployment\.json/);
    expect(recovery).toContain('--deployment <owner>/<repo>@v<version>');
  });
});

describe("an operator's deploy repository", () => {
  /**
   * A copy of this repository as an operator has it at their second release: tinfoil-config.yml edited as
   * docs/OPERATE.md says (from the plain or the onion template), pinned by the first release, and builds.json
   * listing that release. The release workflow runs the unit suite there, so it must pass.
   */
  function operatorRepository(template: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bellows-operator-'));
    const skip = new Set(['node_modules', '.git', '.tmp', 'data']);
    cpSync(ROOT, dir, { recursive: true, filter: (src) => !src.slice(ROOT.length).split(/[\\/]/).some((part) => skip.has(part)) });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const config = join(dir, 'tinfoil-config.yml');
    writeFileSync(config, operatorEdits(read(template)));
    const pin = spawnSync(
      process.execPath,
      [join(dir, 'scripts/pin-image.ts'), config, `bellows=ghcr.io/operator/my-bellows@sha256:${'ef'.repeat(32)}`, `tor=ghcr.io/operator/my-bellows-tor@sha256:${'12'.repeat(32)}`],
      { encoding: 'utf8' },
    );
    expect(pin.status, pin.stderr).toBe(0);
    // The first release's builds pull request, merged.
    const manifest = join(dir, 'tinfoil-deployment.json');
    const measured = deploymentManifest(readFileSync(config, 'utf8'), { snp_measurement: '7a'.repeat(48), tdx_measurement: { rtmr1: '7b'.repeat(48), rtmr2: '7c'.repeat(48) } });
    writeFileSync(manifest, JSON.stringify(measured));
    const add = spawnSync(
      process.execPath,
      [join(dir, 'scripts/add-build.ts'), '--deployment-file', manifest, '--version', '0.9.0', '--deployment', 'operator/my-bellows@v0.9.0', '--released', '2026-11-30'],
      { encoding: 'utf8' },
    );
    expect(add.status, add.stderr).toBe(0);
    rmSync(manifest);
    return dir;
  }

  for (const template of Object.keys(TEMPLATES)) {
    it.skipIf(NESTED)(`passes the unit suite with tinfoil-config.yml made from ${template}`, () => {
      const dir = operatorRepository(template);
      try {
        expect(checkTinfoilConfig(readFileSync(join(dir, 'tinfoil-config.yml'), 'utf8'), { release: true })).toEqual([]);
        expect(JSON.parse(readFileSync(join(dir, 'builds.json'), 'utf8')).builds).toHaveLength(JSON.parse(read('builds.json')).builds.length + 1);
        const run = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', 'test/unit'], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, BELLOWS_OPERATOR_COPY: '1' },
          timeout: 170_000,
        });
        expect(run.status, `${run.stdout}\n${run.stderr}`.slice(-6000)).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
