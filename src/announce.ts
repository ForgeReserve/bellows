/**
 * Makes, signs and publishes an operator announcement (docs/OPERATORS.md). The operator's Nostr secret key
 * is read from a hidden prompt (or, when stdin is not a terminal, from its first line), never from the
 * command line or the environment, and is never printed or written anywhere.
 *
 *   pnpm announce --url https://bellows.example --unit sat --mint https://mint.example \
 *     [--relay https://relay.example/relay/bellows.example] [--onion http://<56 chars>.onion] \
 *     [--version 0.1.0] [--measurement '{"type": ..., "registers": [...]}'] [--builds builds.json] \
 *     [--deployment owner/repo@tag] \
 *     [--description "..."] [--out announcement.json] [--nostr wss://nostr-relay.example ...] [--dry-run]
 *
 * Without --measurement the build is looked up in builds.json by version. A version can be listed once per
 * operator deployment (docs/OPERATE.md); --deployment picks yours, and is required when there are several.
 *
 * --out writes the signed event for BELLOWS_OPERATOR_ANNOUNCEMENT_FILE. --nostr publishes it to those Nostr
 * relays (unless --dry-run). Exit status 0 when it was written and every relay accepted it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Measurement, parseBuilds, parseMeasurement } from '../client/builds.ts';
import { fromHex } from '../client/bytes.ts';
import type { NostrEvent, PublishResult, SocketConnect } from '../client/nostr.ts';
import { publicKeyOf, publishEvent } from '../client/nostr.ts';
import { operatorEventTemplate, signOperatorAnnouncement } from '../client/operator.ts';
import { BELLOWS_VERSION } from './config.ts';

// ── bech32 (BIP-173), for nsec keys (NIP-19) ───────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

/** Decodes a bech32 string to its prefix and 8-bit data. Throws on a bad checksum or encoding. */
export function bech32Decode(s: string): { prefix: string; bytes: Uint8Array } {
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) throw new Error('mixed case');
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length || lower.length > 200) throw new Error('not bech32');
  const prefix = lower.slice(0, sep);
  const data: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error('not bech32');
    data.push(v);
  }
  if (polymod([...hrpExpand(prefix), ...data]) !== 1) throw new Error('bad bech32 checksum');
  const words = data.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) throw new Error('bad bech32 padding');
  return { prefix, bytes: new Uint8Array(out) };
}

/** A Nostr secret key from 64 hex characters or an nsec1 string. Throws without echoing the input. */
export function decodeSecretKey(text: string): Uint8Array {
  const t = text.trim();
  let key: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    key = fromHex(t.toLowerCase(), 32);
  } else if (t.toLowerCase().startsWith('nsec1')) {
    let d: { prefix: string; bytes: Uint8Array };
    try {
      d = bech32Decode(t);
    } catch (e) {
      throw new Error(`the key is not a valid nsec (${e instanceof Error ? e.message : 'decode failed'})`);
    }
    if (d.prefix !== 'nsec' || d.bytes.length !== 32) throw new Error('the key is not a valid nsec');
    key = d.bytes;
  } else {
    throw new Error('the key must be 64 hex characters or an nsec1 string');
  }
  try {
    publicKeyOf(key);
  } catch {
    throw new Error('the key is not a valid secp256k1 secret key');
  }
  return key;
}

// ── hidden prompt ──────────────────────────────────────────────────────────

/** What readHiddenLine needs of stdin and stdout. */
export interface PromptInput {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  setEncoding?(enc: 'utf8'): unknown;
  on(ev: 'data', fn: (chunk: string | Uint8Array) => void): unknown;
  on(ev: 'end' | 'close', fn: () => void): unknown;
  off(ev: 'data', fn: (chunk: string | Uint8Array) => void): unknown;
  off(ev: 'end' | 'close', fn: () => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}
export interface PromptOutput {
  write(s: string): unknown;
}

/**
 * Reads one line without echoing it. On a terminal it shows `prompt` and switches the terminal to raw mode
 * so typed characters are not shown; Ctrl-C cancels. Otherwise it reads the first line of the input (a key
 * piped from a password manager). Raw mode is always switched back off.
 */
export function readHiddenLine(prompt: string, input: PromptInput, output: PromptOutput): Promise<string> {
  return new Promise((resolve, reject) => {
    const tty = !!input.isTTY && typeof input.setRawMode === 'function';
    let line = '';
    const done = (err?: Error) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      if (tty) {
        input.setRawMode!(false);
        output.write('\n');
      }
      input.pause?.();
      if (err) reject(err);
      else resolve(line);
    };
    const onEnd = () => done();
    const onData = (chunk: string | Uint8Array) => {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return done();
        if (tty && ch === '\u0003') return done(new Error('cancelled'));
        if (tty && ch === '\u0004' && line === '') return done();
        if (tty && (ch === '\u007f' || ch === '\b')) {
          line = line.slice(0, -1);
          continue;
        }
        line += ch;
      }
    };
    if (tty) {
      output.write(prompt);
      input.setRawMode!(true);
    }
    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.resume?.();
  });
}

// ── the command ────────────────────────────────────────────────────────────

export interface AnnounceIo {
  /** Reads the secret key text (the hidden prompt). */
  readKey(): Promise<string>;
  stdout(line: string): void;
  stderr(line: string): void;
  writeFile(path: string, text: string): void;
  readFile(path: string): string;
  connect?: SocketConnect;
  now?: () => number;
  /** The default builds.json. */
  buildsPath?: string;
}

export const nodeIo = (): AnnounceIo => ({
  readKey: () => readHiddenLine('Operator Nostr secret key (nsec or hex, not shown): ', process.stdin as unknown as PromptInput, process.stderr),
  stdout: (l) => console.log(l),
  stderr: (l) => console.error(l),
  writeFile: (p, t) => writeFileSync(p, t, { mode: 0o644 }),
  readFile: (p) => readFileSync(p, 'utf8'),
});

const USAGE = 'usage: pnpm announce --url <origin> --unit <unit>... --mint <url>... [--relay <url>]... [--onion <url>] [--version <v>] [--measurement <json>] [--builds <path>] [--deployment <owner/repo@tag>] [--description <text>] [--out <file>] [--nostr <wss url>]... [--dry-run]';

/** Runs the command. Returns the exit status. */
export async function runAnnounce(argv: string[], io: AnnounceIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        relay: { type: 'string', multiple: true },
        onion: { type: 'string' },
        version: { type: 'string' },
        measurement: { type: 'string' },
        builds: { type: 'string' },
        deployment: { type: 'string' },
        unit: { type: 'string', multiple: true },
        mint: { type: 'string', multiple: true },
        description: { type: 'string' },
        out: { type: 'string' },
        nostr: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (!values.url || !values.unit?.length || !values.mint?.length) {
    io.stderr(`--url, --unit and --mint are required\n${USAGE}`);
    return 2;
  }
  if (!values.out && !values.nostr?.length) {
    io.stderr(`nothing to do: give --out, --nostr or both\n${USAGE}`);
    return 2;
  }
  const version = values.version ?? BELLOWS_VERSION;

  let measurement: Measurement | null = null;
  try {
    if (values.measurement) {
      measurement = parseMeasurement(JSON.parse(values.measurement), '--measurement');
    } else {
      const path = values.builds ?? io.buildsPath;
      if (path) {
        const listed = parseBuilds(JSON.parse(io.readFile(path))).builds.filter((b) => b.version === version);
        const matching = values.deployment ? listed.filter((b) => b.deployment === values.deployment) : listed;
        if (matching.length > 1) {
          const where = matching.map((b) => b.deployment ?? 'no deployment').join(', ');
          throw new Error(`version ${version} is listed for several deployments in ${path} (${where}); pass --deployment owner/repo@tag`);
        }
        const build = matching[0];
        if (build) measurement = build.measurement;
        else if (values.deployment) throw new Error(`version ${version} is not listed for ${values.deployment} in ${path}`);
        else io.stderr(`note: version ${version} is not in ${path}; the announcement names no measurement`);
      }
    }
  } catch (e) {
    io.stderr(`measurement: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let event: NostrEvent;
  try {
    const fields = { url: values.url, relays: values.relay ?? [], onion: values.onion ?? null, version, measurement, units: values.unit, mints: values.mint, description: values.description ?? '' };
    // Check the fields before asking for the key.
    operatorEventTemplate(fields, 0);
    let key: Uint8Array;
    try {
      key = decodeSecretKey(await io.readKey());
    } catch (e) {
      io.stderr(e instanceof Error ? e.message : String(e));
      return 2;
    }
    try {
      event = signOperatorAnnouncement(fields, key, Math.floor((io.now ?? Date.now)() / 1000));
    } finally {
      key.fill(0);
    }
  } catch (e) {
    io.stderr(`announcement: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const text = `${JSON.stringify(event, null, 2)}\n`;
  if (values.out) {
    io.writeFile(values.out, text);
    io.stdout(`wrote ${values.out}`);
  }
  io.stdout(`operator ${event.pubkey}`);
  io.stdout(`event ${event.id} (kind ${event.kind}, address ${values.url.replace(/\/+$/, '')})`);
  if (!values.nostr?.length) return 0;
  if (values['dry-run']) {
    io.stdout(`dry run: not published to ${values.nostr.join(', ')}`);
    return 0;
  }
  const results: PublishResult[] = await publishEvent(values.nostr, event, { connect: io.connect });
  for (const r of results) io.stdout(`${r.ok ? 'published' : 'refused  '} ${r.relay}${r.message ? `: ${r.message}` : ''}`);
  return results.every((r) => r.ok) ? 0 : 1;
}
