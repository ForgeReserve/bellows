/**
 * Sealed mode: the database must sit on the encrypted volume. The operator names the volume's mount point
 * (BELLOWS_SEALED_MOUNTS) and startup refuses to run unless the database resolves, after symlinks, to a
 * path whose own mount is one of those. The mount table comes from /proc/self/mountinfo, so sealed mode
 * runs on Linux only, which is what a confidential VM runs.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface MountTable {
  /** Every current mount point, or undefined when the table cannot be read. */
  mountPoints(): string[] | undefined;
  /** The file system type of a mount point (such as tmpfs), or undefined when unknown. */
  fsType?(mountPoint: string): string | undefined;
}

/** File systems that live in memory: what is on them is gone after a restart. */
export const MEMORY_FS_TYPES: readonly string[] = ['tmpfs', 'ramfs'];

/** Decodes the octal escapes mountinfo uses for space, tab, newline and backslash. */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** Parses /proc/self/mountinfo: the fifth field of each line is the mount point. */
export function parseMountInfo(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');
    if (fields.length >= 5 && fields[4]) out.push(unescapeMount(fields[4]));
  }
  return out;
}

/**
 * Parses /proc/self/mountinfo into mount point and file system type: the type is the first field after the
 * lone "-" separator. A later line for the same mount point (a mount on top of another) wins.
 */
export function parseMountTypes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');
    const sep = fields.indexOf('-', 6);
    if (fields.length >= 5 && fields[4] && sep > 0 && fields[sep + 1]) out.set(unescapeMount(fields[4]), fields[sep + 1]!);
  }
  return out;
}

export function procMounts(path = '/proc/self/mountinfo'): MountTable {
  const read = () => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    mountPoints() {
      const text = read();
      return text === undefined ? undefined : parseMountInfo(text);
    },
    fsType(mountPoint) {
      const text = read();
      return text === undefined ? undefined : parseMountTypes(text).get(trimSlash(mountPoint));
    },
  };
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** The real path of p: symlinks resolved for the part that exists, the rest appended as written. */
export function realPathOf(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

const within = (path: string, mount: string) => mount === '/' || path === mount || path.startsWith(mount + '/');

/**
 * Checks that `path` is on one of the named mounts and returns that mount. The deepest mount that holds the
 * path decides, so another file system mounted inside a named volume does not count as sealed.
 */
export function sealedMountOf(what: string, path: string, named: string[], table: MountTable): string {
  if (path === ':memory:') throw new Error(`sealed mode: ${what} cannot be in memory; put it on the encrypted volume`);
  if (named.length === 0) throw new Error('sealed mode: set BELLOWS_SEALED_MOUNTS to the mount point of the encrypted volume');
  const points = table.mountPoints();
  if (!points) throw new Error('sealed mode: cannot read the mount table (/proc/self/mountinfo); sealed mode runs on Linux');
  const mounted = new Set(points.map(trimSlash));
  const sealed = named.map((m) => {
    if (!isAbsolute(m)) throw new Error(`sealed mode: BELLOWS_SEALED_MOUNTS entries must be absolute paths: ${m}`);
    const real = trimSlash(existsSync(m) ? realpathSync(m) : m);
    if (!mounted.has(real)) throw new Error(`sealed mode: ${m} is not a mount point`);
    return real;
  });
  const real = realPathOf(path);
  let deepest = '';
  for (const p of mounted) if (within(real, p) && p.length > deepest.length) deepest = p;
  if (!sealed.includes(deepest)) {
    throw new Error(`sealed mode: ${what} ${path} is on ${deepest || 'no mount'}, not on a mount named in BELLOWS_SEALED_MOUNTS`);
  }
  return deepest;
}
