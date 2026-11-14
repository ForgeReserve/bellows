/**
 * The deploy kit's checks and edits, shared by the scripts and the tests (docs/OPERATE.md):
 *
 *  - checkTinfoilConfig: the rules a Bellows `tinfoil-config.yml` keeps. Above all, only the `bellows`
 *    container may have `attestation: true`: any container that can reach the attestation socket can obtain
 *    a quote over any nonce, and so could attest a statement with its own key (docs/ATTESTATION.md).
 *  - pinImage, pinImages: write container image references, pinned by digest, and change nothing else.
 *  - measurementFromDeployment, buildFromDeployment: read the release Tinfoil's measure workflow publishes
 *    (`tinfoil-deployment.json`) and make the builds.json entry for it.
 *  - addBuild: appends that entry to a builds file and checks the result.
 *
 * The platform rules here follow Tinfoil's public documentation for `tinfoil-config.yml`. Tinfoil enforces
 * its own runtime policy at deploy time; these checks are Bellows' own, stricter rules on top.
 */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { checkBuilds, type ApprovedBuild, type BuildsFile, type Measurement } from '../../client/builds.ts';
import { isLowerHex } from '../../client/bytes.ts';
import { TINFOIL_RELEASE_MEASUREMENT_TYPE } from '../../client/tinfoil.ts';
import { EnvSchema } from '../../src/config.ts';
import { FIXED_SECRET_NAMES } from '../../src/secrets.ts';

/** The one container that may attest, and that must. */
export const BELLOWS_CONTAINER = 'bellows';

/** The oldest CVM version with keyserver delivery of private secrets (Tinfoil docs, Private secrets). */
export const MIN_CVM_VERSION = '0.13.0';

const IMAGE_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const ZERO_DIGEST = '0'.repeat(64);
const VOLUME_NAME_RE = /^[a-z][a-z0-9-]*$/;
const NETWORK_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names that look like a secret. A value for one of these belongs in the keyserver, not in `env`. */
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|SEED|PRIVATE|CREDENTIAL|API_KEY|_KEY$)/i;
/** Bellows settings whose names match SECRET_NAME_RE but hold no secret. */
const NOT_SECRETS = new Set(['BELLOWS_SECRETS', 'BELLOWS_SECRETS_FILE']);
/** A value that is still an example. A release refuses it. */
const PLACEHOLDER_RE = /(^|[^a-z0-9-])example([^a-z0-9-]|$)/i;

type Obj = Record<string, unknown>;
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface CheckOptions {
  /** Also refuse what a release must not carry: example values and an unpinned (all-zero) digest. */
  release?: boolean;
}

/** A container's `env`, read: measured literals by name, and the bare names (unmeasured instance variables). */
export interface ContainerEnv {
  literals: Map<string, unknown>;
  bare: string[];
  problems: string[];
}

export function readEnv(env: unknown, at: string): ContainerEnv {
  const out: ContainerEnv = { literals: new Map(), bare: [], problems: [] };
  if (env === undefined) return out;
  if (!Array.isArray(env)) {
    out.problems.push(`${at}.env: must be a list`);
    return out;
  }
  env.forEach((item, i) => {
    if (typeof item === 'string') {
      out.bare.push(item);
      return;
    }
    if (!isObject(item) || Object.keys(item).length !== 1) {
      out.problems.push(`${at}.env[${i}]: must be NAME: "value"`);
      return;
    }
    const [name, value] = Object.entries(item)[0]!;
    if (out.literals.has(name)) out.problems.push(`${at}.env: ${name} is set twice`);
    out.literals.set(name, value);
  });
  return out;
}

/** "major.minor.patch" compared numerically; -1, 0 or 1. Anything else compares as lowest. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : [-1, -1, -1]);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

function stringsIn(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) stringsIn(v, out);
  else if (isObject(x)) for (const [k, v] of Object.entries(x)) stringsIn(k, out), stringsIn(v, out);
  return out;
}

const within = (path: string, mount: string) => path === mount || path.startsWith(mount.replace(/\/+$/, '') + '/');

/** Parses YAML text into plain data. Throws on a syntax error or a repeated key. */
export function parseTinfoilConfig(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message.split('\n')[0]).join('; '));
  return doc.toJS();
}

/** Every problem with a Bellows `tinfoil-config.yml`. Empty when it is valid. */
export function checkTinfoilConfig(text: string, opts: CheckOptions = {}): string[] {
  let cfg: unknown;
  try {
    cfg = parseTinfoilConfig(text);
  } catch (e) {
    return [`not valid YAML: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (!isObject(cfg)) return ['must be a YAML mapping'];
  const out: string[] = [];

  // Platform basics.
  const cvm = cfg['cvm-version'];
  if (typeof cvm !== 'string' || !/^\d+\.\d+\.\d+$/.test(cvm)) {
    out.push('cvm-version: must be a quoted version such as "0.14.17"');
  } else if (compareVersions(cvm, MIN_CVM_VERSION) < 0) {
    out.push(`cvm-version: must be ${MIN_CVM_VERSION} or newer, for secrets released by your keyserver`);
  }
  if (cfg['cvm-network'] !== undefined) out.push('cvm-network: must not be set; it opens inbound ports into the enclave');

  // Secrets: only from the operator's keyserver, never from Tinfoil's store.
  const ks = cfg['keyserver-url'];
  let ksUrl: URL | undefined;
  try {
    ksUrl = typeof ks === 'string' ? new URL(ks) : undefined;
  } catch {
    ksUrl = undefined;
  }
  if (!ksUrl) {
    out.push('keyserver-url: required; secrets must come from your own keyserver, which Tinfoil never sees');
  } else if (ksUrl.protocol !== 'https:' || !ksUrl.hostname || ksUrl.username || ksUrl.password || ksUrl.search || ksUrl.hash) {
    out.push('keyserver-url: must be https with a host, and no credentials, query or fragment');
  }

  // Networks.
  const networks = new Map<string, string>();
  if (cfg.networks !== undefined) {
    if (!isObject(cfg.networks)) {
      out.push('networks: must be a mapping of name to network');
    } else {
      for (const [name, n] of Object.entries(cfg.networks)) {
        const at = `networks.${name}`;
        if (name === 'shim-net') out.push(`${at}: the name shim-net is reserved by the platform`);
        else if (!NETWORK_NAME_RE.test(name)) out.push(`${at}: names are lowercase letters, digits and hyphens, at most 15 characters`);
        const net = n ?? {};
        if (!isObject(net)) {
          out.push(`${at}: must be a mapping`);
          continue;
        }
        const egress = net.egress ?? 'closed';
        if (egress !== 'closed' && egress !== 'allowlist' && egress !== 'open') out.push(`${at}.egress: must be closed, allowlist or open`);
        networks.set(name, String(egress));
        if (net.allow !== undefined) {
          if (egress !== 'allowlist') out.push(`${at}.allow: only with egress: allowlist`);
          if (!Array.isArray(net.allow)) out.push(`${at}.allow: must be a list of hostnames`);
          else
            net.allow.forEach((h, i) => {
              if (typeof h !== 'string' || !HOSTNAME_RE.test(h)) out.push(`${at}.allow[${i}]: must be a hostname (no scheme, port, address or wildcard)`);
            });
        } else if (egress === 'allowlist') {
          out.push(`${at}.allow: an allowlist network needs its hostnames`);
        }
      }
    }
  }

  // Volumes: every one encrypted under a key the keyserver releases at boot.
  const volumes = new Map<string, Obj>();
  const secretNames = new Set<string>();
  if (cfg.volumes !== undefined) {
    if (!Array.isArray(cfg.volumes)) {
      out.push('volumes: must be a list');
    } else {
      cfg.volumes.forEach((v, i) => {
        const at = `volumes[${i}]`;
        if (!isObject(v) || typeof v.name !== 'string') {
          out.push(`${at}: must have a name`);
          return;
        }
        if (!VOLUME_NAME_RE.test(v.name)) out.push(`${at}.name: lowercase letters, digits and hyphens, starting with a letter`);
        if (volumes.has(v.name)) out.push(`${at}.name: ${v.name} is declared twice`);
        volumes.set(v.name, v);
        if (typeof v['key-secret'] !== 'string' || !ENV_NAME_RE.test(v['key-secret'])) {
          out.push(`${at}.key-secret: required; the volume is unlocked at boot with a key your keyserver releases`);
        } else {
          secretNames.add(v['key-secret']);
        }
        if (v.exec === true) out.push(`${at}.exec: must not allow executables on the volume`);
      });
    }
  }

  // Containers.
  if (!Array.isArray(cfg.containers) || cfg.containers.length === 0) {
    out.push('containers: must list at least the bellows container');
    return out;
  }
  const names = new Set<string>();
  let bellows: Obj | undefined;
  const envs = new Map<string, ContainerEnv>();
  /** Which container mounts each volume. */
  const mountedBy = new Map<string, string>();
  cfg.containers.forEach((c, i) => {
    if (!isObject(c) || typeof c.name !== 'string' || c.name === '') {
      out.push(`containers[${i}]: must have a name`);
      return;
    }
    const at = `containers[${i}] (${c.name})`;
    if (names.has(c.name)) out.push(`${at}: the name ${c.name} is used twice`);
    names.add(c.name);
    if (c.name === BELLOWS_CONTAINER) bellows = c;

    if (typeof c.image !== 'string' || !IMAGE_RE.test(c.image)) {
      out.push(`${at}.image: must be pinned by digest (name@sha256:<64 hex>)`);
    } else if (opts.release && c.image.endsWith(ZERO_DIGEST)) {
      out.push(`${at}.image: the digest is a placeholder; pin the released image (pnpm deploy:pin)`);
    }

    if (c.attestation !== undefined && typeof c.attestation !== 'boolean') out.push(`${at}.attestation: must be true or false`);
    if (c.attestation === true && c.name !== BELLOWS_CONTAINER) {
      out.push(
        `${at}.attestation: only the ${BELLOWS_CONTAINER} container may have attestation: true; any container that can reach the attestation socket can obtain a quote over any nonce`,
      );
    }
    if (c.cvm_admin !== undefined && c.cvm_admin !== false) out.push(`${at}.cvm_admin: must not be set; it grants administration of the whole enclave and its secrets`);
    if (c.ports !== undefined && !(Array.isArray(c.ports) && c.ports.length === 0)) out.push(`${at}.ports: must not be set; requests reach Bellows through the shim only`);
    if (c.read_only !== true) out.push(`${at}.read_only: must be true; mount writable space with tmpfs or a volume`);
    if (c.cap_add !== undefined && !(Array.isArray(c.cap_add) && c.cap_add.length === 0)) out.push(`${at}.cap_add: no capabilities are needed`);
    if (typeof c.user !== 'string' || !/^\d+(:\d+)?$/.test(c.user)) {
      out.push(`${at}.user: must be a numeric uid:gid`);
    } else if (c.user.split(':').some((id) => id === '0')) {
      out.push(`${at}.user: must not be root`);
    }

    const env = readEnv(c.env, at);
    envs.set(c.name, env);
    out.push(...env.problems);
    for (const name of env.bare) out.push(`${at}.env: ${name} has no value here; every setting must be a measured literal, not an instance variable`);
    for (const [name, value] of env.literals) {
      if (!ENV_NAME_RE.test(name)) out.push(`${at}.env: ${name} is not a valid variable name`);
      if (typeof value !== 'string') out.push(`${at}.env.${name}: quote the value; it must be a string`);
      if (name === 'DOMAIN') out.push(`${at}.env.DOMAIN: reserved; the platform sets it`);
      if ((FIXED_SECRET_NAMES as readonly string[]).includes(name) || (SECRET_NAME_RE.test(name) && !NOT_SECRETS.has(name))) {
        out.push(`${at}.env.${name}: looks like a secret; secrets come from the keyserver (list the name under secrets), never from env`);
      }
    }

    if (c.secrets !== undefined) {
      if (!Array.isArray(c.secrets) || c.secrets.some((s) => typeof s !== 'string' || !ENV_NAME_RE.test(s))) {
        out.push(`${at}.secrets: must be a list of variable names`);
      } else if (c.name !== BELLOWS_CONTAINER && c.secrets.length > 0) {
        // A sidecar with a secret could carry it off the enclave: the tor sidecar has open egress.
        out.push(`${at}.secrets: only the ${BELLOWS_CONTAINER} container receives secrets`);
      } else {
        for (const s of c.secrets as string[]) {
          if (env.literals.has(s)) out.push(`${at}: ${s} is both a secret and an env value`);
          // Released secrets reach the process env, where loadConfig reads settings too, so a setting listed
          // here would be unmeasured. The announcement is the one setting the keyserver releases (it names the build).
          if (s in EnvSchema.shape && s !== 'BELLOWS_OPERATOR_ANNOUNCEMENT') {
            out.push(`${at}.secrets: ${s} is a setting; set it as a measured env literal, never from the keyserver`);
          }
          secretNames.add(s);
        }
      }
    }

    const nets = c.networks === undefined ? [] : c.networks;
    if (!Array.isArray(nets)) {
      out.push(`${at}.networks: must be a list`);
    } else {
      for (const n of nets) if (typeof n !== 'string' || !networks.has(n)) out.push(`${at}.networks: ${String(n)} is not declared under networks`);
      const egressNets = nets.filter((n) => typeof n === 'string' && networks.has(n) && networks.get(n) !== 'closed');
      if (egressNets.length > 1) out.push(`${at}.networks: at most one network with egress`);
    }

    if (c.persistent_volumes !== undefined) {
      if (!Array.isArray(c.persistent_volumes)) {
        out.push(`${at}.persistent_volumes: must be a list of name:/path`);
      } else {
        for (const pv of c.persistent_volumes) {
          const m = typeof pv === 'string' ? /^([^:]+):(\/.*)$/.exec(pv) : null;
          if (!m) out.push(`${at}.persistent_volumes: ${String(pv)} must be name:/absolute/path`);
          else if (!volumes.has(m[1]!)) out.push(`${at}.persistent_volumes: ${m[1]} is not declared under volumes`);
          else {
            // A second container on a volume could read it, and bellows' volume holds the ledger.
            const owner = mountedBy.get(m[1]!);
            if (owner === undefined) mountedBy.set(m[1]!, c.name);
            else if (owner !== c.name) out.push(`${at}.persistent_volumes: ${m[1]} is mounted by ${owner}; a volume belongs to one container`);
          }
        }
      }
    }
  });

  for (const [name, env] of envs) {
    for (const s of secretNames) if (env.literals.has(s)) out.push(`containers (${name}).env.${s}: is a secret name; it must not be in env`);
  }

  if (!bellows) {
    out.push(`containers: no container named ${BELLOWS_CONTAINER}`);
  } else {
    out.push(...checkBellowsContainer(bellows, envs.get(BELLOWS_CONTAINER)!, networks, volumes));
  }

  // Requests reach Bellows only.
  const shim = cfg.shim;
  if (!isObject(shim)) {
    out.push('shim: required');
  } else {
    const first = isObject(cfg.containers[0]) ? cfg.containers[0].name : undefined;
    const upstream = shim['upstream-container'] ?? first;
    if (upstream !== BELLOWS_CONTAINER) out.push(`shim.upstream-container: must be ${BELLOWS_CONTAINER}`);
    const port = bellows ? (envs.get(BELLOWS_CONTAINER)?.literals.get('PORT') ?? '8787') : undefined;
    if (port !== undefined && String(shim['upstream-port']) !== String(port)) out.push(`shim.upstream-port: must be the bellows PORT (${String(port)})`);
    if (!Array.isArray(shim.paths) || shim.paths.length === 0) out.push('shim.paths: list the paths Bellows serves');
    else if (shim.paths.some((p) => p === '/*' || p === '*')) out.push('shim.paths: list the paths Bellows serves, not everything');
  }

  if (opts.release) {
    const placeholders = [...new Set(stringsIn(cfg).filter((s) => PLACEHOLDER_RE.test(s)))];
    for (const p of placeholders) out.push(`release: ${p} is an example value; replace it with your own`);
  }
  return out;
}

function checkBellowsContainer(c: Obj, env: ContainerEnv, networks: Map<string, string>, volumes: Map<string, Obj>): string[] {
  const at = `containers (${BELLOWS_CONTAINER})`;
  const out: string[] = [];
  const lit = (name: string) => {
    const v = env.literals.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  if (c.attestation !== true) out.push(`${at}.attestation: must be true; Bellows attests its identity through the attestation socket`);
  if (lit('BELLOWS_MODE') !== 'sealed') out.push(`${at}.env.BELLOWS_MODE: must be "sealed"`);
  const secrets = lit('BELLOWS_SECRETS');
  if (env.literals.has('BELLOWS_SECRETS') && secrets !== 'platform') out.push(`${at}.env.BELLOWS_SECRETS: must be "platform"; the keyserver releases the secrets`);
  if (env.literals.has('BELLOWS_SECRETS_FILE')) out.push(`${at}.env.BELLOWS_SECRETS_FILE: must not be set; the keyserver releases the secrets`);
  const attester = lit('BELLOWS_ATTESTER');
  if (env.literals.has('BELLOWS_ATTESTER') && attester !== 'tinfoil') out.push(`${at}.env.BELLOWS_ATTESTER: must be "tinfoil"`);
  if (env.literals.has('BELLOWS_BUILD_MEASUREMENT')) {
    out.push(`${at}.env.BELLOWS_BUILD_MEASUREMENT: must not be set; this file is what is measured, so it cannot hold its own measurement`);
  }

  // The database is on a sealed mount, and each sealed mount is an encrypted volume of this container.
  const mountsByPath = new Map<string, string>();
  if (Array.isArray(c.persistent_volumes)) {
    for (const pv of c.persistent_volumes) {
      const m = typeof pv === 'string' ? /^([^:]+):(\/.*)$/.exec(pv) : null;
      if (m) mountsByPath.set(m[2]!.replace(/\/+$/, '') || '/', m[1]!);
    }
  }
  const sealed = (lit('BELLOWS_SEALED_MOUNTS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (sealed.length === 0) out.push(`${at}.env.BELLOWS_SEALED_MOUNTS: name the encrypted volume's mount path`);
  for (const m of sealed) {
    const vol = mountsByPath.get(m.replace(/\/+$/, '') || '/');
    if (!vol) out.push(`${at}.env.BELLOWS_SEALED_MOUNTS: ${m} is not one of this container's persistent_volumes`);
    else if (!volumes.get(vol)?.['key-secret']) out.push(`${at}.env.BELLOWS_SEALED_MOUNTS: the volume at ${m} has no key-secret`);
  }
  const db = lit('BELLOWS_DB_PATH');
  if (!db || !db.startsWith('/')) out.push(`${at}.env.BELLOWS_DB_PATH: must be an absolute path on the encrypted volume`);
  else if (!sealed.some((m) => within(db, m))) out.push(`${at}.env.BELLOWS_DB_PATH: ${db} is not under BELLOWS_SEALED_MOUNTS`);

  if (!Array.isArray(c.secrets) || !c.secrets.includes('BELLOWS_WALLET_SECRET')) {
    out.push(`${at}.secrets: must list BELLOWS_WALLET_SECRET; the wallet seed is derived from it`);
  }
  if (Array.isArray(c.networks)) {
    for (const n of c.networks) {
      if (networks.get(String(n)) === 'open') out.push(`${at}.networks: ${String(n)} has open egress; Bellows reaches only an allowlist of hosts`);
    }
  }
  return out;
}

/** The private secret names the config asks the keyserver for: containers' secrets and volume keys. */
export function declaredSecretNames(text: string): string[] {
  const cfg = parseTinfoilConfig(text);
  const out = new Set<string>();
  if (!isObject(cfg)) return [];
  if (Array.isArray(cfg.volumes)) for (const v of cfg.volumes) if (isObject(v) && typeof v['key-secret'] === 'string') out.add(v['key-secret']);
  if (Array.isArray(cfg.containers)) {
    for (const c of cfg.containers) if (isObject(c) && Array.isArray(c.secrets)) for (const s of c.secrets) if (typeof s === 'string') out.add(s);
  }
  return [...out].sort();
}

/**
 * Sets one container's image to `image` (pinned by digest) and returns the new text. Only that value
 * changes: comments, order and every other byte stay as they were.
 */
export function pinImage(text: string, container: string, image: string): string {
  if (!IMAGE_RE.test(image)) throw new Error(`${image}: must be pinned by digest (name@sha256:<64 hex>)`);
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`not valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`);
  const containers = doc.get('containers', true);
  if (!isSeq(containers)) throw new Error('containers: must be a list');
  const item = containers.items.find((it) => isMap(it) && it.get('name') === container);
  if (!isMap(item)) throw new Error(`no container named ${container}`);
  const node = item.get('image', true);
  if (!isScalar(node) || !node.range) throw new Error(`container ${container} has no image to pin`);
  const [start, end] = node.range;
  return text.slice(0, start) + JSON.stringify(image) + text.slice(end);
}

/** The names of the containers whose image digest is still the all-zero placeholder. */
export function unpinnedContainers(text: string): string[] {
  const cfg = parseTinfoilConfig(text);
  if (!isObject(cfg) || !Array.isArray(cfg.containers)) return [];
  return cfg.containers.filter((c) => isObject(c) && typeof c.image === 'string' && c.image.endsWith(`@sha256:${ZERO_DIGEST}`)).map((c) => String((c as Obj).name));
}

export interface PinResult {
  text: string;
  /** The named containers the file has, now pinned. */
  pinned: string[];
  /** The named containers the file does not have (the tor sidecar in a config without the onion service). */
  absent: string[];
}

/**
 * Pins every named container the config has (container name to image, each pinned by digest) and skips a
 * name the config does not have. Throws when an image is not pinned by digest, or when a container is left
 * with a placeholder digest: a release must pin every container in the file Tinfoil measures.
 */
export function pinImages(text: string, images: Record<string, string>): PinResult {
  for (const [name, image] of Object.entries(images)) {
    if (!IMAGE_RE.test(image)) throw new Error(`${name}=${image}: must be pinned by digest (name@sha256:<64 hex>)`);
  }
  const cfg = parseTinfoilConfig(text);
  const present = new Set(isObject(cfg) && Array.isArray(cfg.containers) ? cfg.containers.filter(isObject).map((c) => c.name) : []);
  const out: PinResult = { text, pinned: [], absent: [] };
  for (const [name, image] of Object.entries(images)) {
    if (!present.has(name)) {
      out.absent.push(name);
      continue;
    }
    out.text = pinImage(out.text, name, image);
    out.pinned.push(name);
  }
  const left = unpinnedContainers(out.text);
  if (left.length) throw new Error(`${left.join(', ')}: still a placeholder digest; pin every container in the file (name=image)`);
  return out;
}

/** A register from tinfoil-deployment.json: lowercase hex of a 48-byte measurement. */
function register(v: unknown, what: string): string {
  if (typeof v !== 'string' || !isLowerHex(v) || v.length !== 96) throw new Error(`tinfoil-deployment.json: ${what} must be 96 lowercase hex characters`);
  return v;
}

/**
 * The release measurement in the form builds.json lists it: Tinfoil's multiplatform predicate type, with the
 * SEV-SNP launch measurement and the TDX RTMR1 and RTMR2 as its registers.
 */
export function measurementFromDeployment(manifest: unknown): Measurement {
  if (!isObject(manifest)) throw new Error('tinfoil-deployment.json: must be a JSON object');
  const tdx = manifest.tdx_measurement;
  if (!isObject(tdx)) throw new Error('tinfoil-deployment.json: tdx_measurement must be an object');
  return {
    type: TINFOIL_RELEASE_MEASUREMENT_TYPE,
    registers: [register(manifest.snp_measurement, 'snp_measurement'), register(tdx.rtmr1, 'tdx_measurement.rtmr1'), register(tdx.rtmr2, 'tdx_measurement.rtmr2')],
  };
}

/** The config text the release measured, carried in tinfoil-deployment.json as base64. */
export function configFromDeployment(manifest: unknown): string {
  if (!isObject(manifest) || typeof manifest.config !== 'string') throw new Error('tinfoil-deployment.json: config must be base64 text');
  return Buffer.from(manifest.config, 'base64').toString('utf8');
}

export interface BuildEntryOptions {
  /** The Bellows release, such as 1.2.3 (a leading v is dropped). */
  version: string;
  /** The measured config: owner/repo@tag. */
  deployment: string;
  /** Release date, YYYY-MM-DD. */
  released: string;
  notes?: string;
}

/**
 * The builds.json entry for a measured release. The image comes from the measured config itself, so the
 * entry names exactly the image the measurement covers. The config must pass the release checks.
 */
export function buildFromDeployment(manifest: unknown, o: BuildEntryOptions): ApprovedBuild {
  const measurement = measurementFromDeployment(manifest);
  const text = configFromDeployment(manifest);
  const problems = checkTinfoilConfig(text, { release: true });
  if (problems.length) throw new Error(`the measured tinfoil-config.yml does not pass the release checks:\n  ${problems.join('\n  ')}`);
  const cfg = parseTinfoilConfig(text) as { containers: Obj[] };
  const image = cfg.containers.find((c) => c.name === BELLOWS_CONTAINER)!.image as string;
  const build: ApprovedBuild = { version: o.version.replace(/^v/, ''), image, measurement, released: o.released, deployment: o.deployment };
  if (o.notes) build.notes = o.notes;
  return build;
}

/** `builds` with `build` appended. Throws listing every problem when the result is not a valid builds file. */
export function addBuild(builds: unknown, build: ApprovedBuild): BuildsFile {
  if (!isObject(builds) || !Array.isArray(builds.builds)) throw new Error('builds file must be a JSON object with a builds list');
  const next = { ...builds, builds: [...builds.builds, build] };
  const problems = checkBuilds(next);
  if (problems.length) throw new Error(`the builds file would be invalid: ${problems.join('; ')}`);
  return next as unknown as BuildsFile;
}
