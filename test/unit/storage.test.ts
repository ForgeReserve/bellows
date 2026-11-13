/**
 * BELLOWS_STORAGE (docs/OPERATE.md, Running without a volume): the setting, the sealed-mode check that it
 * does not overstate what the database's mount keeps, the boot warning, and the storage field of the
 * attested statement at /.well-known/bellows.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { devVerifier, type IdentityDocument, verifyBellows } from '../../client/index.ts';
import { fromBase64, utf8Decode } from '../../client/bytes.ts';
import { devMeasurement } from '../../src/attest/dev.ts';
import { createApp } from '../../src/app.ts';
import { BELLOWS_VERSION, loadConfig, warnStorage } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent, setLogSink } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { type MountTable, parseMountTypes, procMounts } from '../../src/sealed.ts';
import { memorySecrets, newWalletSecret, WALLET_SECRET } from '../../src/secrets.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};
const base = { BELLOWS_DB_PATH: ':memory:', BELLOWS_TRUSTED_MINTS: 'http://127.0.0.1:1', BELLOWS_FOREIGN_DISCOVERY_RELAYS: '' };
const load = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv, catalog);

describe('the setting', () => {
  it('defaults to volume, takes memory, and refuses anything else', () => {
    expect(load().storage).toBe('volume');
    expect(load({ BELLOWS_STORAGE: 'volume' }).storage).toBe('volume');
    expect(load({ BELLOWS_STORAGE: 'memory' }).storage).toBe('memory');
    expect(() => load({ BELLOWS_STORAGE: 'disk' })).toThrow(/BELLOWS_STORAGE/);
    expect(() => load({ BELLOWS_STORAGE: '' })).toThrow(/BELLOWS_STORAGE/);
  });
});

describe('sealed mode checks the mount against the setting', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A sealed config with the database on `dir`, mounted as a file system of type `type`. */
  function loadSealed(storage: string | undefined, type: string | undefined) {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bellows-storage-')));
    const mounts: MountTable = { mountPoints: () => ['/', dir], fsType: type === undefined ? undefined : (m) => (m === dir ? type : 'overlay') };
    const env: Record<string, string> = { BELLOWS_MODE: 'sealed', BELLOWS_SEALED_MOUNTS: dir, BELLOWS_DB_PATH: join(dir, 'bellows.db') };
    if (storage) env.BELLOWS_STORAGE = storage;
    return loadConfig({ ...base, ...env } as NodeJS.ProcessEnv, catalog, { secrets: memorySecrets({ [WALLET_SECRET]: newWalletSecret() }), mounts });
  }

  it('accepts memory on a tmpfs and volume on a disk', () => {
    expect(loadSealed('memory', 'tmpfs').storage).toBe('memory');
    rmSync(dir, { recursive: true, force: true });
    expect(loadSealed('volume', 'ext4').storage).toBe('volume');
  });

  it('refuses volume (said or by default) on a memory file system', () => {
    for (const [storage, type] of [
      ['volume', 'tmpfs'],
      [undefined, 'tmpfs'],
      ['volume', 'ramfs'],
    ] as const) {
      expect(() => loadSealed(storage, type), `${storage} ${type}`).toThrow(/every restart empties, and BELLOWS_STORAGE is volume/);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns, and starts, when memory is said and the mount is not in memory', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      expect(loadSealed('memory', 'ext4').storage).toBe('memory');
    } finally {
      setLogSink(undefined);
    }
    expect(lines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ level: 'warn', msg: 'storage_mount_not_memory', fs_type: 'ext4', storage: 'memory' })]);
  });

  it('checks nothing more when the mount table has no file system types', () => {
    expect(loadSealed('volume', undefined).storage).toBe('volume');
  });
});

describe('mount types', () => {
  const MOUNTINFO = [
    '22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/l',
    '30 22 0:40 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw,size=262144k,mode=1777',
    '31 22 253:1 / /data rw,relatime shared:5 master:1 - ext4 /dev/mapper/data rw',
    '32 22 0:41 / /mnt/with\\040space rw - tmpfs tmpfs rw',
    'garbage',
  ].join('\n');

  it('reads the file system type of each mount point, optional fields and escapes included', () => {
    expect([...parseMountTypes(MOUNTINFO)]).toEqual([
      ['/', 'overlay'],
      ['/tmp', 'tmpfs'],
      ['/data', 'ext4'],
      ['/mnt/with space', 'tmpfs'],
    ]);
  });

  it('procMounts reads them from the mountinfo file, and nothing from a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bellows-mountinfo-'));
    try {
      const file = join(dir, 'mountinfo');
      writeFileSync(file, MOUNTINFO);
      const table = procMounts(file);
      expect(table.fsType?.('/tmp/')).toBe('tmpfs');
      expect(table.fsType?.('/data')).toBe('ext4');
      expect(table.fsType?.('/nowhere')).toBeUndefined();
      expect(procMounts(join(dir, 'none')).fsType?.('/tmp')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('boot warning', () => {
  it('logs one warning line for memory, and nothing for a volume', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    try {
      warnStorage(load({ BELLOWS_STORAGE: 'volume' }));
      expect(lines).toEqual([]);
      warnStorage(load({ BELLOWS_STORAGE: 'memory' }));
    } finally {
      setLogSink(undefined);
    }
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: 'warn', msg: 'storage_memory', db: ':memory:' });
    expect(line.note).toMatch(/every restart loses all of them/);
  });
});

describe('/.well-known/bellows', () => {
  const builds = [{ version: BELLOWS_VERSION, image: `example/bellows@sha256:${'ab'.repeat(32)}`, measurement: devMeasurement() }];

  for (const storage of ['volume', 'memory'] as const) {
    it(`says storage ${storage} in the attested statement, and the client reads it`, async () => {
      const app = createApp(buildDeps(load({ BELLOWS_STORAGE: storage }), { rateSources: [fixedRateSource('fixed', 100_000)] }));
      const res = await app.request('http://gw.test/.well-known/bellows');
      expect(res.status).toBe(200);
      const doc = (await res.json()) as IdentityDocument;
      expect(JSON.parse(utf8Decode(fromBase64(doc.statement))).storage).toBe(storage);
      const v = await verifyBellows('http://gw.test', { approvedBuilds: builds, verifier: devVerifier(), allowDevelopment: true, fetch: (u, i) => app.request(u, i) as Promise<Response> });
      expect(v.storage).toBe(storage);
    });
  }
});
