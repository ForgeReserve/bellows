/**
 * Approved builds: `builds.json` in the Bellows repository lists each release clients may talk to and
 * keyservers may release secrets to. A client accepts a Bellows only when the measurement its hardware
 * attestation proves is on this list.
 *
 * {
 *   "format": "bellows-builds/v1",
 *   "builds": [
 *     {
 *       "version": "1.0.0",
 *       "image": "ghcr.io/example/bellows@sha256:<64 hex>",
 *       "measurement": { "type": "<attestation format URI>", "registers": ["<lowercase hex>", ...] },
 *       "released": "2026-12-01",
 *       "deployment": "example/bellows-deploy@v1.0.0",
 *       "notes": "optional"
 *     }
 *   ]
 * }
 *
 * A Tinfoil measurement covers the whole measured `tinfoil-config.yml`, and each operator's config differs
 * (its keyserver address, its mints). So one release can have one approved build per operator deployment.
 * `deployment` names the measured config: the public repository and release tag (`owner/repo@tag`), the same
 * pair the operator's keyserver policy pins.
 *
 * The checker is strict: unknown members, a version repeated for the same deployment and the same
 * measurement under two builds are all refused.
 */
import { BellowsVerifyError } from './errors.ts';
import { isLowerHex } from './bytes.ts';

export const BUILDS_FORMAT = 'bellows-builds/v1';

/** What the hardware measured: a format URI and its registers, each lowercase hex. */
export interface Measurement {
  type: string;
  registers: string[];
}

export interface ApprovedBuild {
  version: string;
  /** The image the release workflow built, pinned by digest. */
  image: string;
  measurement: Measurement;
  /** Release date, YYYY-MM-DD. */
  released?: string;
  /** The measured deployment config, `owner/repo@tag`. Optional; one version may appear once per deployment. */
  deployment?: string;
  notes?: string;
}

export interface BuildsFile {
  format: typeof BUILDS_FORMAT;
  builds: ApprovedBuild[];
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IMAGE_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_RE = /^[^\s]{1,200}$/;
const DEPLOYMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}@[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

/** Problems with a measurement, prefixed with `where`. Empty when it is valid. */
export function measurementProblems(m: unknown, where: string): string[] {
  if (!isObject(m)) return [`${where}: must be an object with type and registers`];
  const out: string[] = [];
  for (const k of unknownKeys(m, ['type', 'registers'])) out.push(`${where}: unknown member ${k}`);
  if (typeof m.type !== 'string' || !TYPE_RE.test(m.type)) out.push(`${where}.type: must be a format URI without spaces`);
  if (!Array.isArray(m.registers) || m.registers.length === 0) {
    out.push(`${where}.registers: must be a non-empty array`);
  } else {
    m.registers.forEach((r, i) => {
      if (!isLowerHex(r) || r.length > 256) out.push(`${where}.registers[${i}]: must be lowercase hex`);
    });
  }
  return out;
}

export function parseMeasurement(m: unknown, where = 'measurement'): Measurement {
  const problems = measurementProblems(m, where);
  if (problems.length) throw new BellowsVerifyError('bad_builds', problems.join('; '));
  const v = m as Measurement;
  return { type: v.type, registers: [...v.registers] };
}

export function measurementEquals(a: Measurement, b: Measurement): boolean {
  return a.type === b.type && a.registers.length === b.registers.length && a.registers.every((r, i) => r === b.registers[i]);
}

const measurementKey = (m: Measurement) => `${m.type}|${m.registers.join(',')}`;

/** Every problem with a builds file. Empty when it is valid. */
export function checkBuilds(input: unknown): string[] {
  if (!isObject(input)) return ['builds file must be a JSON object'];
  const out: string[] = [];
  for (const k of unknownKeys(input, ['format', 'builds'])) out.push(`unknown member ${k}`);
  if (input.format !== BUILDS_FORMAT) out.push(`format must be "${BUILDS_FORMAT}"`);
  if (!Array.isArray(input.builds)) return [...out, 'builds must be an array'];
  const versions = new Set<string>();
  const measurements = new Map<string, string>();
  input.builds.forEach((b, i) => {
    const at = `builds[${i}]`;
    if (!isObject(b)) {
      out.push(`${at}: must be an object`);
      return;
    }
    for (const k of unknownKeys(b, ['version', 'image', 'measurement', 'released', 'deployment', 'notes'])) out.push(`${at}: unknown member ${k}`);
    const deploymentOk = b.deployment === undefined || (typeof b.deployment === 'string' && DEPLOYMENT_RE.test(b.deployment));
    if (!deploymentOk) out.push(`${at}.deployment: must be owner/repo@tag`);
    if (typeof b.version !== 'string' || !VERSION_RE.test(b.version)) {
      out.push(`${at}.version: must be a version such as 1.2.3`);
    } else if (deploymentOk) {
      const key = `${b.version}|${b.deployment ?? ''}`;
      if (versions.has(key)) {
        out.push(b.deployment === undefined ? `${at}.version: ${b.version} is listed twice` : `${at}.version: ${b.version} is listed twice for ${b.deployment}`);
      } else {
        versions.add(key);
      }
    }
    if (typeof b.image !== 'string' || !IMAGE_RE.test(b.image)) out.push(`${at}.image: must be pinned by digest (name@sha256:<64 hex>)`);
    const mp = measurementProblems(b.measurement, `${at}.measurement`);
    out.push(...mp);
    if (mp.length === 0) {
      const key = measurementKey(b.measurement as Measurement);
      const other = measurements.get(key);
      if (other !== undefined) out.push(`${at}.measurement: same as version ${other}; one measurement names one build`);
      else measurements.set(key, typeof b.deployment === 'string' ? `${String(b.version)} (${b.deployment})` : String(b.version));
    }
    if (b.released !== undefined && (typeof b.released !== 'string' || !DATE_RE.test(b.released))) out.push(`${at}.released: must be YYYY-MM-DD`);
    if (b.notes !== undefined && typeof b.notes !== 'string') out.push(`${at}.notes: must be a string`);
  });
  return out;
}

/** The builds file, checked. Throws BellowsVerifyError('bad_builds') listing every problem. */
export function parseBuilds(input: unknown): BuildsFile {
  const problems = checkBuilds(input);
  if (problems.length) throw new BellowsVerifyError('bad_builds', `invalid builds file: ${problems.join('; ')}`);
  const f = input as BuildsFile;
  return {
    format: BUILDS_FORMAT,
    builds: f.builds.map((b) => ({ ...b, measurement: parseMeasurement(b.measurement) })),
  };
}

/** The approved build with this measurement, or undefined. */
export function findBuild(builds: BuildsFile | readonly ApprovedBuild[], measurement: Measurement): ApprovedBuild | undefined {
  const list = Array.isArray(builds) ? builds : (builds as BuildsFile).builds;
  return list.find((b) => measurementEquals(b.measurement, measurement));
}
