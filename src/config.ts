import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { type Measurement, measurementEquals, measurementProblems } from '../client/builds.ts';
import { STORAGE_KINDS, type Storage } from '../client/identity.ts';
import { parseOperatorAnnouncement } from '../client/operator.ts';
import { DEFAULT_MAX_MESSAGE_BYTES } from '../client/ohttp.ts';
import { devMeasurement } from './attest/dev.ts';
import { TINFOIL_ATTESTATION_SOCKET } from './attest/tinfoil.ts';
import { log } from './log.ts';
import { MEMORY_FS_TYPES, type MountTable, procMounts, sealedMountOf } from './sealed.ts';
import {
  ADMIN_TOKEN,
  ADMIN_TOKEN_HASH,
  FIXED_SECRET_NAMES,
  fileSecrets,
  LEGACY_WALLET_SEED,
  memorySecrets,
  newWalletSecret,
  type PendingSecretsFile,
  pendingDevSecrets,
  platformSecrets,
  type SecretsSource,
  WALLET_SECRET,
} from './secrets.ts';
import { LEGACY_SEED_RE, WALLET_SECRET_RE } from './wallet-seed.ts';

export const UNITS = ['usd', 'sat'] as const;
export type Unit = (typeof UNITS)[number];

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

export const EnvSchema = z.object({
  /**
   * development: secrets from a local file, database anywhere. sealed: secrets released by the platform (or
   * a file on the encrypted volume), and startup refuses a database that is not on a mount named in
   * BELLOWS_SEALED_MOUNTS.
   */
  BELLOWS_MODE: z.enum(['development', 'sealed']).default('development'),
  /** Where secrets come from. Default: file in development, platform in sealed mode. See src/secrets.ts. */
  BELLOWS_SECRETS: z.enum(['file', 'platform']).optional(),
  /** The secrets file. Default: secrets.json next to the database (created in development for a new database). */
  BELLOWS_SECRETS_FILE: z.string().trim().min(1).optional(),
  /** Mount points of the encrypted volume. Sealed mode refuses a database (or secrets file) anywhere else. */
  BELLOWS_SEALED_MOUNTS: csv.default([]),
  /**
   * Where the database lives, published in /.well-known/bellows (docs/OPERATE.md, Running without a volume).
   * volume: on the encrypted volume, so balances survive a restart. memory: on a tmpfs inside the sealed
   * machine, for a deployment that has no volume yet; every restart loses every balance. Sealed mode refuses
   * volume when the database's mount is in memory.
   */
  BELLOWS_STORAGE: z.enum(STORAGE_KINDS).default('volume'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  BELLOWS_DB_PATH: z.string().default('data/bellows.db'),
  BELLOWS_MODELS_FILE: z.string().default('config/models.json'),
  /** Mints whose eCash is accepted. Required: there is no built-in mint. */
  BELLOWS_TRUSTED_MINTS: csv.pipe(z.array(z.string()).min(1, 'set at least one mint URL')),
  /**
   * Other addresses of the same mint, as alias=main pairs. Tokens under an alias are handled under the main
   * address: one wallet pile and one counter per keyset. Two piles would restart the deterministic counter
   * and re-derive outputs the mint has already signed.
   */
  BELLOWS_MINT_ALIASES: csv.default([]),
  BELLOWS_UNITS: csv.pipe(z.array(z.enum(UNITS)).min(1)).default(['usd', 'sat']),
  BELLOWS_DEFAULT_UNIT: z.enum(UNITS).default('usd'),
  /** Name shown in NUT-18 payment requests ("<name>: <model>"). */
  BELLOWS_SERVICE_NAME: z.string().trim().min(1).max(60).default('Bellows'),
  /** Optional gate: a new balance or a NUT-24 request needs an invite code. Off by default. */
  BELLOWS_INVITE_ONLY: bool.default(false),
  BELLOWS_MARKUP: z.coerce.number().min(1).max(10).default(1.25),
  /**
   * Serve models whose catalog price is not checked against the supplier's rate card (price_verified false).
   * Off by default: such a model is neither listed nor routable, whatever supplier keys are present, because
   * a placeholder price can overcharge customers or leave the operator paying the difference. On, startup
   * logs the models it serves this way at error level.
   */
  BELLOWS_SERVE_UNVERIFIED_PRICES: bool.default(false),
  BELLOWS_BYTES_PER_TOKEN: z.coerce.number().min(0.5).max(8).default(2),
  BELLOWS_RATE_SOURCES: csv.default(['coinbase', 'kraken', 'bitstamp']),
  BELLOWS_RATE_MIN_SOURCES: z.coerce.number().int().min(1).default(2),
  BELLOWS_RATE_TTL_SECONDS: z.coerce.number().int().min(5).default(60),
  BELLOWS_RATE_MAX_STALE_SECONDS: z.coerce.number().int().min(30).default(900),
  BELLOWS_SAT_PRICE_BUFFER: z.coerce.number().min(1).max(2).default(1.02),
  /** Requests per minute per balance key. Never per client address: Bellows does not look at addresses. */
  BELLOWS_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(60),
  /** Requests per minute shared by every request without a known balance key (NUT-24 payments, 402 asks). */
  BELLOWS_ANON_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(600),
  /**
   * Proof of work a request must carry to open a new balance (topup or funding without a known key), in
   * leading zero bits of SHA-256: 16 is about 65,000 hashes on average. 0 turns it off; those requests then
   * share the anonymous budget above.
   */
  BELLOWS_POW_BITS: z.coerce.number().int().min(0).max(32).default(16),
  BELLOWS_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_000_000),
  BELLOWS_MAX_TOKEN_BYTES: z.coerce.number().int().min(256).default(64_000),
  BELLOWS_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  BELLOWS_UPSTREAM_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  BELLOWS_STALE_RESERVATION_SECONDS: z.coerce.number().int().min(60).default(900),
  /** Mint used for Lightning / on-chain / other-mint funding. Default: the first trusted mint. */
  BELLOWS_FUND_MINT: z.string().optional(),
  BELLOWS_LIGHTNING_ENABLED: bool.default(true),
  /** Per-funding limits for Lightning, in whole units. */
  // Mint quote checks per minute across all fundings: the gateway's one IP shares Nutshell's 20/min limit.
  BELLOWS_MINT_QUOTE_CHECKS_PER_MIN: z.coerce.number().int().min(1).default(12),
  // The Tinfoil admin key (read-only billing calls from the admin API) is a secret (TINFOIL_ADMIN_KEY in the
  // secrets source). The opening credit is the credit Tinfoil granted at sign-up, which its transaction
  // history does not list.
  BELLOWS_TINFOIL_ADMIN_URL: z.string().url().default('https://api.tinfoil.sh'),
  BELLOWS_TINFOIL_OPENING_CREDIT_USD: z.coerce.number().min(0).default(5),
  BELLOWS_TINFOIL_LOW_USD: z.coerce.number().min(0).default(1),
  BELLOWS_FUND_MAX_SAT: z.coerce.number().int().min(1).default(1_000_000),
  BELLOWS_FUND_MAX_USD: z.coerce.number().int().min(1).default(50_000),
  /** On-chain (NUT-30) funding. Off by default: request and response shapes come from a Nutshell branch with NUT-30, not a live test. */
  BELLOWS_ONCHAIN_ENABLED: bool.default(false),
  /** Confirmations shown to users; the mint decides when a deposit is paid. */
  BELLOWS_ONCHAIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  BELLOWS_ONCHAIN_WATCH_DAYS: z.coerce.number().int().min(1).default(30),
  /** Optional Esplora API (e.g. a self-hosted mempool) for showing unconfirmed deposits. Unset: not used. */
  BELLOWS_ESPLORA_URL: z.string().url().optional(),
  /** eCash from other mints, melted into a Lightning quote at the funding mint. */
  BELLOWS_FOREIGN_ENABLED: bool.default(true),
  BELLOWS_FOREIGN_ALLOW: csv.default([]),
  BELLOWS_FOREIGN_DENY: csv.default([]),
  BELLOWS_FOREIGN_MAX_SAT: z.coerce.number().int().min(1).default(100_000),
  BELLOWS_FOREIGN_MAX_USD: z.coerce.number().int().min(1).default(5_000),
  /** Tests only: allow http:// and private-address foreign mints. */
  BELLOWS_FOREIGN_ALLOW_INSECURE: bool.default(false),
  /**
   * Which other mints' eCash is accepted for funding. BELLOWS_FOREIGN_DENY always wins, and the gateway's own
   * mints always answer 'use_topup'.
   * Mints the operator adds through the admin API (the operator_mints table) count as BELLOWS_FOREIGN_ALLOW.
   *  - discovered (default): BELLOWS_FOREIGN_ALLOW and admin-added mints plus the mints found through NIP-87 discovery.
   *  - allowlist: BELLOWS_FOREIGN_ALLOW and admin-added mints only (empty: no other mint is accepted).
   *  - any: every mint, unless BELLOWS_FOREIGN_ALLOW is set, which then limits it (the behaviour before discovery).
   *    Admin-added mints are also accepted then; they never limit it on their own.
   */
  BELLOWS_FOREIGN_POLICY: z.enum(['discovered', 'allowlist', 'any']).default('discovered'),
  /**
   * Under the discovered and allowlist policies, a customer may still fund with eCash from a mint that
   * is not accepted (not denied and not one of the gateway's own): the server answers 'mint_unlisted' first,
   * and a request resent with accept_unlisted: true goes ahead after the same live probe discovery uses,
   * capped at the amounts below. false: such a mint is refused with 'mint_not_allowed'.
   */
  BELLOWS_FOREIGN_UNLISTED: bool.default(true),
  /** Largest token from an unlisted mint, in sat. BELLOWS_FOREIGN_MAX_SAT still applies when lower. */
  BELLOWS_FOREIGN_UNLISTED_MAX_SAT: z.coerce.number().int().min(1).default(5_000),
  /** Largest token from an unlisted mint, in cents (500 = $5). BELLOWS_FOREIGN_MAX_USD still applies when lower. */
  BELLOWS_FOREIGN_UNLISTED_MAX_USD: z.coerce.number().int().min(1).default(500),
  /** Distinct verified NIP-87 reviewers a discovered mint needs. */
  BELLOWS_FOREIGN_MIN_REVIEWERS: z.coerce.number().int().min(1).max(100).default(2),
  /** Also require the mint's own NIP-87 announcement (the card provisioner's rule). Few mints publish one today. */
  BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT: bool.default(false),
  /** Nostr relays read for NIP-87 mint announcements and reviews. Empty: no discovery (tests). */
  BELLOWS_FOREIGN_DISCOVERY_RELAYS: csv
    .pipe(z.array(z.string().regex(/^wss?:\/\/[^\s]+$/, 'relays must be ws:// or wss:// URLs')).max(10))
    .default(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']),
  /** How long a successful discovery is served before the next background refresh. */
  BELLOWS_FOREIGN_DISCOVERY_TTL_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(60),
  /** Most discovered mints accepted at once (the best reviewed first). */
  BELLOWS_FOREIGN_MAX_DISCOVERED: z.coerce.number().int().min(1).max(100).default(25),
  /** Unfinished fundings (quotes not yet paid) per balance. */
  BELLOWS_FUND_MAX_PENDING: z.coerce.number().int().min(1).default(5),
  BELLOWS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // The admin token is a secret: BELLOWS_ADMIN_TOKEN (or its SHA-256 as BELLOWS_ADMIN_TOKEN_HASH) in the
  // secrets source. Neither set: the admin API answers 404.
  /** Origin admin POSTs must come from (e.g. https://ai.example.com). Unset: the request's own Host. */
  BELLOWS_ADMIN_ORIGIN: z.string().url().optional(),
  BELLOWS_ADMIN_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(120),
  /**
   * Who attests /.well-known/bellows (docs/ATTESTATION.md). dev: a signed stand-in clients refuse unless they
   * opt into development mode. tinfoil: the Tinfoil Containers attestation socket. Default: dev in
   * development, tinfoil in sealed mode, which refuses dev.
   */
  BELLOWS_ATTESTER: z.enum(['dev', 'tinfoil']).optional(),
  /** The Tinfoil attestation socket (needs `attestation: true` on the container in tinfoil-config.yml). */
  BELLOWS_TINFOIL_ATTESTATION_SOCKET: z.string().trim().min(1).default(TINFOIL_ATTESTATION_SOCKET),
  /** Make the attestation again after this many minutes (platform collateral ages). */
  BELLOWS_ATTEST_REFRESH_MINUTES: z.coerce.number().int().min(1).max(7 * 24 * 60).default(360),
  /** dev attester only: the one register of the development measurement (64 lowercase hex). */
  BELLOWS_DEV_MEASUREMENT: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters').optional(),
  /**
   * Hardware attesters: the measurement this build claims, as JSON {"type": ..., "registers": [...]}, from
   * builds.json. Clients trust only the measurement the attestation proves and refuse a claim that differs.
   * Unset: no claim.
   */
  BELLOWS_BUILD_MEASUREMENT: z.string().optional(),
  /** Oblivious HTTP relays for this Bellows, published in /.well-known/bellows. */
  BELLOWS_RELAYS: csv.pipe(z.array(z.string().regex(/^https?:\/\/[^\s,]+$/, 'relays must be http(s) URLs'))).default([]),
  /** A JSON file holding the operator's announcement, published as is in /.well-known/bellows. */
  BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: z.string().trim().min(1).optional(),
  /**
   * The announcement itself, as JSON. For a sealed deployment, where the operator cannot write a file on the
   * encrypted volume and the measured config cannot hold it (it names the build the config is measured
   * into): the keyserver releases it with the secrets (docs/OPERATE.md). Not with BELLOWS_OPERATOR_ANNOUNCEMENT_FILE.
   */
  BELLOWS_OPERATOR_ANNOUNCEMENT: z.string().trim().min(1).optional(),
  /**
   * Oblivious HTTP (docs/OHTTP.md): an encapsulated request must carry a Date (or Bellows-Date) within this
   * many seconds of the gateway's clock. Each request's encapsulated key is remembered for that long, so a
   * replayed request is refused.
   */
  BELLOWS_OHTTP_MAX_SKEW_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  /** Most encapsulated keys remembered at once for replay refusal; past this the gateway answers 503. */
  BELLOWS_OHTTP_REPLAY_CACHE_MAX: z.coerce.number().int().min(1000).default(200_000),
  /**
   * Most new encapsulated requests admitted per second, across all clients (anonymous traffic has no
   * identity to limit by). Past it the gateway answers 503 with Retry-After. Unset, it is the most the replay
   * cache can hold for the whole time a key is kept (ohttpAdmitPerSecond), so the cache cannot fill; a set
   * value above that is refused at startup.
   */
  BELLOWS_OHTTP_ADMIT_PER_SECOND: z.coerce.number().positive().optional(),
  /**
   * Largest Binary HTTP message (padding included) in an OHTTP request, and in a plain (not chunked) answer.
   * Chunked answers stream and are bounded only by what the client accepts (1 GiB). The client's plain-mode
   * default is the same value, so it opens every answer this gateway sends.
   */
  BELLOWS_OHTTP_MAX_MESSAGE_BYTES: z.coerce.number().int().min(65_536).default(DEFAULT_MAX_MESSAGE_BYTES),
});
export type Env = z.infer<typeof EnvSchema>;

const FlatSchema = z.object({
  /** Request body size buckets, ascending. The first bucket whose maxBytes >= body size applies. */
  buckets: z.array(z.object({ maxBytes: z.number().int().positive(), usd: z.number().nonnegative() })).min(1),
  /** Price per million declared max output tokens, in USD. */
  output_usd_per_mtok: z.number().nonnegative().default(0),
});
export type FlatPricing = z.infer<typeof FlatSchema>;

const SupplierSchema = z.object({
  type: z.enum(['openai', 'tinfoil', 'mock']),
  baseUrl: z.string().url().optional(),
  /** Name of the supplier's API key in the secrets source. */
  apiKeySecret: z.string().min(1).optional(),
  /** The old name, refused: supplier keys no longer come from the environment. */
  apiKeyEnv: z.undefined({ error: 'apiKeyEnv is now apiKeySecret: supplier keys come from the secrets source, not the environment' }).optional(),
  tier: z.enum(['enclave', 'standard']),
  /** metered: settle on upstream usage. flat: settle on the flat schedule below. */
  pricing: z.enum(['metered', 'flat']).default('metered'),
  flat: FlatSchema.optional(),
  /** tinfoil only: accept plaintext (non-EHBP) requests. The gateway can read those. */
  allowPlaintext: z.boolean().default(true),
  /** tinfoil only: hosts allowed in X-Tinfoil-Enclave-Url (exact or subdomain). */
  enclaveHosts: z.array(z.string()).default(['tinfoil.sh']),
  /** tinfoil only: where the gateway sends EHBP ciphertext by default. */
  enclaveUrl: z.string().url().optional(),
  attestationUrl: z.string().url().optional(),
  /** tinfoil only: permit http:// enclave URLs (tests only). */
  allowInsecureEnclave: z.boolean().default(false),
});
export type SupplierConfig = z.infer<typeof SupplierSchema>;

const ModelSchema = z.object({
  id: z.string().min(1),
  supplier: z.string(),
  upstream: z.string(),
  name: z.string().optional(),
  input_usd_per_mtok: z.number().nonnegative(),
  output_usd_per_mtok: z.number().nonnegative(),
  /** true once the cost above has been checked against the supplier's rate card. */
  price_verified: z.boolean().default(false),
  max_output_tokens: z.number().int().positive().default(4096),
  context_length: z.number().int().positive().optional(),
  uncensored: z.boolean().default(false),
  /** Accepts image parts in messages (OpenAI image_url content). */
  vision: z.boolean().default(false),
  /** Streams reasoning (reasoning_content / reasoning deltas). */
  reasoning: z.boolean().default(false),
  /** Values the chat page may send as reasoning_effort; empty means the control is hidden. */
  reasoning_efforts: z.array(z.string()).default([]),
  /** Rough speed hint for the chat page. */
  speed: z.enum(['fast', 'balanced', 'slow']).optional(),
});
export type ModelConfig = z.infer<typeof ModelSchema>;

export const CatalogSchema = z
  .object({
    suppliers: z.record(z.string(), SupplierSchema),
    models: z.array(ModelSchema).min(1),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const m of c.models) {
      if (ids.has(m.id)) ctx.addIssue({ code: 'custom', message: `duplicate model id ${m.id}` });
      ids.add(m.id);
      if (!c.suppliers[m.supplier]) ctx.addIssue({ code: 'custom', message: `model ${m.id}: unknown supplier ${m.supplier}` });
    }
    for (const [id, s] of Object.entries(c.suppliers)) {
      if (s.pricing === 'flat' && !s.flat) ctx.addIssue({ code: 'custom', message: `supplier ${id}: flat pricing needs a flat schedule` });
    }
  });
export type Catalog = z.infer<typeof CatalogSchema>;

export type Mode = Env['BELLOWS_MODE'];

export interface Config {
  env: Env;
  catalog: Catalog;
  trustedMints: string[];
  mode: Mode;
  /** The one place secrets are read from. */
  secrets: SecretsSource;
  /** SHA-256 (hex, lower case) of the admin token, or undefined when the admin API is off. */
  adminTokenHash?: string;
  /** Sealed mode: the mount the database is on. */
  sealedMount?: string;
  /** Where the database lives (BELLOWS_STORAGE): volume, or memory, which every restart empties. */
  storage: Storage;
  /** Development, new database: the secrets file buildDeps writes before it creates the database. */
  pendingSecretsFile?: PendingSecretsFile;
  /** This Bellows' release version (package.json). */
  version: string;
  /** Who attests /.well-known/bellows. */
  attester: 'dev' | 'tinfoil';
  /** The measurement /.well-known/bellows claims (dev: the development measurement), or null for none. */
  buildMeasurement: Measurement | null;
  /** The operator announcement published in /.well-known/bellows, or null. */
  operatorAnnouncement: unknown;
  /**
   * Models of available suppliers (key present, or none needed) whose price is not verified, and whether
   * they are served (BELLOWS_SERVE_UNVERIFIED_PRICES). When not served they are absent from catalog.models.
   */
  unverifiedPrices: { served: boolean; models: string[] };
}

/** The release version, from package.json. */
export const BELLOWS_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface LoadOptions {
  /** A ready secrets source (tests). Default: built from BELLOWS_SECRETS and BELLOWS_SECRETS_FILE. */
  secrets?: SecretsSource;
  /** The mount table sealed mode checks against. Default: /proc/self/mountinfo. */
  mounts?: MountTable;
}

let mintAliases = new Map<string, string>();

/** Sets the alias=main mint address pairs that normalizeMintUrl folds together. */
export function setMintAliases(pairs: string[]): void {
  const clean = (u: string) => u.trim().replace(/\/+$/, '');
  mintAliases = new Map(
    pairs.map((p) => {
      const [alias, main] = p.split('=');
      if (!alias || !main) throw new Error(`BELLOWS_MINT_ALIASES entry must be alias=main: ${p}`);
      return [clean(alias), clean(main)];
    }),
  );
}

export function normalizeMintUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  return mintAliases.get(u) ?? u;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, catalogOverride?: unknown, opts: LoadOptions = {}): Config {
  // The old names are refused, not aliased: a FORGE_* variable left unrenamed would otherwise fall back
  // to its default (a fresh wallet seed, an open invite gate, an empty deny list) without a word.
  const stale = Object.keys(source).filter((k) => k.startsWith('FORGE_'));
  if (stale.length) {
    throw new Error(
      `FORGE_* variables are no longer read: ${stale.sort().join(', ')}. Rename them to BELLOWS_* (docs/MIGRATE-FROM-FORGE-AI.md)`,
    );
  }
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  setMintAliases(env.BELLOWS_MINT_ALIASES);
  if (!env.BELLOWS_UNITS.includes(env.BELLOWS_DEFAULT_UNIT)) {
    throw new Error('BELLOWS_DEFAULT_UNIT must be one of BELLOWS_UNITS');
  }
  ohttpAdmitPerSecond(env);
  const raw = catalogOverride ?? JSON.parse(readFileSync(resolve(env.BELLOWS_MODELS_FILE), 'utf8'));
  const cat = CatalogSchema.safeParse(raw);
  if (!cat.success) throw new Error(`invalid model catalog: ${z.prettifyError(cat.error)}`);

  const mode = env.BELLOWS_MODE;
  const mounts = opts.mounts ?? procMounts();
  const sealedMount = mode === 'sealed' ? sealedMountOf('the database', env.BELLOWS_DB_PATH, env.BELLOWS_SEALED_MOUNTS, mounts) : undefined;
  if (sealedMount !== undefined) checkStorage(env.BELLOWS_STORAGE, sealedMount, mounts);
  const { secrets, pending } = opts.secrets ? { secrets: opts.secrets, pending: undefined } : openSecrets(env, source, mounts);

  // One source: a secret also set in the environment is refused rather than silently preferred or ignored.
  // Under the platform source the environment is where the platform puts them.
  const names = new Set<string>([...FIXED_SECRET_NAMES, ...Object.values(cat.data.suppliers).flatMap((s) => (s.apiKeySecret ? [s.apiKeySecret] : []))]);
  if (secrets.kind !== 'platform') {
    const inEnv = [...names].filter((n) => typeof source[n] === 'string' && source[n] !== '').sort();
    if (inEnv.length) {
      throw new Error(`secrets set in the environment: ${inEnv.join(', ')}. Put them in the secrets source (${secrets.where}) instead`);
    }
  }
  const walletSecret = secrets.get(WALLET_SECRET);
  const legacySeed = secrets.get(LEGACY_WALLET_SEED);
  if (walletSecret && legacySeed) throw new Error(`set ${WALLET_SECRET} or ${LEGACY_WALLET_SEED}, not both`);
  if (walletSecret && !WALLET_SECRET_RE.test(walletSecret)) throw new Error(`${WALLET_SECRET} must be at least 32 bytes of hex`);
  if (legacySeed && !LEGACY_SEED_RE.test(legacySeed)) throw new Error(`${LEGACY_WALLET_SEED} must be 64 bytes of hex`);
  const adminToken = secrets.get(ADMIN_TOKEN);
  const adminHash = secrets.get(ADMIN_TOKEN_HASH);
  if (adminToken && adminHash) throw new Error(`set ${ADMIN_TOKEN} or ${ADMIN_TOKEN_HASH}, not both`);
  if (adminHash && !/^[0-9a-f]{64}$/i.test(adminHash)) throw new Error(`${ADMIN_TOKEN_HASH} must be the sha256 hex of the admin token`);
  if (adminToken && adminToken.length < 16) throw new Error(`${ADMIN_TOKEN} must be at least 16 characters`);
  if (adminToken && /\s/.test(adminToken)) throw new Error(`${ADMIN_TOKEN} must be a random token without spaces`);
  const adminTokenHash = adminToken ? createHash('sha256').update(adminToken).digest('hex') : adminHash?.toLowerCase();

  // A supplier whose API key is not in the secrets source is left out, so its models are neither listed nor routable.
  const keyless = new Set(
    Object.entries(cat.data.suppliers)
      .filter(([, s]) => s.apiKeySecret && !secrets.get(s.apiKeySecret))
      .map(([id]) => id),
  );
  const available = cat.data.models.filter((m) => !keyless.has(m.supplier));
  // A price not checked against the supplier's rate card is never charged unless the operator says so.
  const serveUnverified = env.BELLOWS_SERVE_UNVERIFIED_PRICES;
  const unverified = available.filter((m) => !m.price_verified).map((m) => m.id);
  const models = serveUnverified ? available : available.filter((m) => m.price_verified);
  if (models.length === 0) {
    throw new Error(
      available.length === 0
        ? 'no models left: put the API key of at least one supplier in the secrets source'
        : 'no models left: every model with a supplier key has price_verified false. Check the prices against the rate card and set price_verified, or set BELLOWS_SERVE_UNVERIFIED_PRICES=true',
    );
  }
  const { attester, buildMeasurement } = attestationSettings(env);
  const trustedMints = env.BELLOWS_TRUSTED_MINTS.map(normalizeMintUrl);
  return {
    env,
    catalog: { ...cat.data, models },
    trustedMints,
    mode,
    secrets,
    adminTokenHash,
    sealedMount,
    storage: env.BELLOWS_STORAGE,
    pendingSecretsFile: pending,
    version: BELLOWS_VERSION,
    attester,
    buildMeasurement,
    operatorAnnouncement: operatorAnnouncementOf({ env, trustedMints, buildMeasurement }),
    unverifiedPrices: { served: serveUnverified, models: unverified },
  };
}

/** At boot: one warning line when balances live in memory. Nothing for a volume. */
export function warnStorage(config: Pick<Config, 'storage' | 'env'>): void {
  if (config.storage !== 'memory') return;
  log.warn('storage_memory', {
    db: config.env.BELLOWS_DB_PATH,
    note: 'BELLOWS_STORAGE=memory: no encrypted volume, balances live in memory and every restart loses all of them',
  });
}

/**
 * Sealed mode: what BELLOWS_STORAGE says must not overstate what the database's mount keeps. A database on a
 * memory file system under BELLOWS_STORAGE=volume is refused, since /.well-known/bellows would tell clients
 * their balances survive a restart. The other way round only understates it, and is a warning.
 */
function checkStorage(storage: Storage, mount: string, mounts: MountTable): void {
  const type = mounts.fsType?.(mount);
  if (type === undefined) return;
  const inMemory = MEMORY_FS_TYPES.includes(type);
  if (storage === 'volume' && inMemory) {
    throw new Error(
      `sealed mode: the database is on ${mount}, a ${type} mount that every restart empties, and BELLOWS_STORAGE is volume. Put it on the encrypted volume, or set BELLOWS_STORAGE=memory to say it lives in memory`,
    );
  }
  if (storage === 'memory' && !inMemory) log.warn('storage_mount_not_memory', { mount, fs_type: type, storage });
}

/**
 * Startup notice for models with unverified prices. Served (the operator setting is on): logged at error
 * level, so no BELLOWS_LOG_LEVEL hides it. Withheld: a warning naming them, so a missing model is explained.
 */
export function announceUnverifiedPrices(config: Pick<Config, 'unverifiedPrices'>): void {
  const { served, models } = config.unverifiedPrices;
  if (models.length === 0) return;
  const fields = { models: models.join(','), count: models.length };
  if (served) log.error('unverified_prices_served', { ...fields, setting: 'BELLOWS_SERVE_UNVERIFIED_PRICES' });
  else log.warn('unverified_prices_withheld', fields);
}

/** The burst of the OHTTP admission bucket: one second's worth, and at least one request. */
export function ohttpAdmitBurst(perSecond: number): number {
  return Math.max(1, perSecond);
}

/**
 * New encapsulated requests admitted per second. A key is kept for at most 2 * skew + 1 s (a request dated at
 * the far edge of the window, kept until its date leaves it), so a bucket of `perSecond` with burst
 * ohttpAdmitBurst admits at most burst + perSecond * that many requests while one key lives. The default is
 * the most that keeps this within BELLOWS_OHTTP_REPLAY_CACHE_MAX, so the cache cannot fill; a set value that
 * would let it fill is refused.
 */
export function ohttpAdmitPerSecond(env: Pick<Env, 'BELLOWS_OHTTP_MAX_SKEW_SECONDS' | 'BELLOWS_OHTTP_REPLAY_CACHE_MAX' | 'BELLOWS_OHTTP_ADMIT_PER_SECOND'>): number {
  const keptS = 2 * env.BELLOWS_OHTTP_MAX_SKEW_SECONDS + 1;
  const max = env.BELLOWS_OHTTP_REPLAY_CACHE_MAX;
  const fits = (r: number) => ohttpAdmitBurst(r) + r * keptS <= max + 1e-9;
  const most = max / (keptS + 1) >= 1 ? max / (keptS + 1) : (max - 1) / keptS;
  const set = env.BELLOWS_OHTTP_ADMIT_PER_SECOND;
  if (set === undefined) return most;
  if (!fits(set)) {
    throw new Error(
      `BELLOWS_OHTTP_ADMIT_PER_SECOND=${set} could fill the replay cache (BELLOWS_OHTTP_REPLAY_CACHE_MAX=${max}, keys kept up to ${keptS} s): ` +
        `set it to at most ${Math.floor(most * 1000) / 1000}, or raise BELLOWS_OHTTP_REPLAY_CACHE_MAX`,
    );
  }
  return set;
}

function attestationSettings(env: Env): { attester: 'dev' | 'tinfoil'; buildMeasurement: Measurement | null } {
  const sealed = env.BELLOWS_MODE === 'sealed';
  const attester = env.BELLOWS_ATTESTER ?? (sealed ? 'tinfoil' : 'dev');
  if (sealed && attester === 'dev') {
    throw new Error('sealed mode needs a hardware attester: BELLOWS_ATTESTER=dev is a development stand-in that clients refuse');
  }
  if (attester === 'dev') {
    if (env.BELLOWS_BUILD_MEASUREMENT) throw new Error('BELLOWS_BUILD_MEASUREMENT is for a hardware attester; the dev attester uses BELLOWS_DEV_MEASUREMENT');
    return { attester, buildMeasurement: devMeasurement(env.BELLOWS_DEV_MEASUREMENT) };
  }
  if (env.BELLOWS_DEV_MEASUREMENT) throw new Error('BELLOWS_DEV_MEASUREMENT is for the dev attester only');
  if (!env.BELLOWS_BUILD_MEASUREMENT) return { attester, buildMeasurement: null };
  let m: unknown;
  try {
    m = JSON.parse(env.BELLOWS_BUILD_MEASUREMENT);
  } catch {
    throw new Error('BELLOWS_BUILD_MEASUREMENT must be JSON: {"type": "...", "registers": ["<hex>", ...]}');
  }
  const problems = measurementProblems(m, 'BELLOWS_BUILD_MEASUREMENT');
  if (problems.length) throw new Error(problems.join('; '));
  return { attester, buildMeasurement: m as Measurement };
}

/**
 * Reads the operator announcement (docs/OPERATORS.md): a signed Nostr event that must agree with how this
 * Bellows is configured, since clients compare it with what the Bellows does. Refuses to start otherwise.
 */
type AnnouncementContext = { env: Env; trustedMints: string[]; buildMeasurement: Measurement | null };

/** The announcement from BELLOWS_OPERATOR_ANNOUNCEMENT or BELLOWS_OPERATOR_ANNOUNCEMENT_FILE, checked; null when neither is set. */
function operatorAnnouncementOf(c: AnnouncementContext): unknown {
  const { BELLOWS_OPERATOR_ANNOUNCEMENT: inline, BELLOWS_OPERATOR_ANNOUNCEMENT_FILE: path } = c.env;
  if (inline && path) throw new Error('set BELLOWS_OPERATOR_ANNOUNCEMENT or BELLOWS_OPERATOR_ANNOUNCEMENT_FILE, not both');
  if (inline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new Error('operator announcement in BELLOWS_OPERATOR_ANNOUNCEMENT is not JSON');
    }
    return readAnnouncement('operator announcement in BELLOWS_OPERATOR_ANNOUNCEMENT', parsed, c);
  }
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`operator announcement ${path} is missing or not JSON`);
  }
  return readAnnouncement(`operator announcement ${path}`, parsed, c);
}

function readAnnouncement(what: string, parsed: unknown, c: AnnouncementContext): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} must hold a JSON object`);
  let a;
  try {
    a = parseOperatorAnnouncement(parsed);
  } catch (e) {
    throw new Error(`${what} is not a signed Bellows announcement: ${e instanceof Error ? e.message : String(e)}. Make one with pnpm announce`);
  }
  const problems: string[] = [];
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (!same(a.relays, c.env.BELLOWS_RELAYS)) problems.push(`it lists the relays [${a.relays.join(', ')}] and BELLOWS_RELAYS is [${c.env.BELLOWS_RELAYS.join(', ')}]`);
  if (a.version !== BELLOWS_VERSION) problems.push(`it names version ${a.version} and this is version ${BELLOWS_VERSION}`);
  if (a.measurement && c.buildMeasurement && !measurementEquals(a.measurement, c.buildMeasurement)) problems.push('its build measurement is not the one this Bellows claims');
  for (const u of a.units) if (!c.env.BELLOWS_UNITS.includes(u as Unit)) problems.push(`it lists the unit ${u}, which BELLOWS_UNITS does not`);
  for (const m of a.mints) if (!c.trustedMints.includes(normalizeMintUrl(m))) problems.push(`it lists the mint ${m}, which BELLOWS_TRUSTED_MINTS does not`);
  if (problems.length) throw new Error(`${what} does not match this Bellows: ${problems.join('; ')}. Publish a new one with pnpm announce`);
  return parsed;
}

/**
 * Builds the secrets source the environment asks for. In development, a new database with no secrets file
 * gets one: a new wallet secret now, written to the file by buildDeps just before the database is created,
 * so loading the configuration alone writes nothing.
 */
function openSecrets(env: Env, source: NodeJS.ProcessEnv, mounts: MountTable): { secrets: SecretsSource; pending?: PendingSecretsFile } {
  const sealed = env.BELLOWS_MODE === 'sealed';
  const kind = env.BELLOWS_SECRETS ?? (sealed ? 'platform' : 'file');
  if (kind === 'platform') {
    if (!sealed) throw new Error('BELLOWS_SECRETS=platform needs BELLOWS_MODE=sealed: in development, secrets come from a file');
    return { secrets: platformSecrets(source) };
  }
  const db = env.BELLOWS_DB_PATH;
  const path = env.BELLOWS_SECRETS_FILE ?? (db === ':memory:' ? undefined : join(dirname(db), 'secrets.json'));
  if (!path) {
    // Development with an in-memory database: the wallet lives as long as the process, and so does its secret.
    return { secrets: memorySecrets({ [WALLET_SECRET]: newWalletSecret() }) };
  }
  if (sealed) sealedMountOf('the secrets file', path, env.BELLOWS_SEALED_MOUNTS, mounts);
  if (!sealed && !env.BELLOWS_SECRETS_FILE && !existsSync(path)) {
    // Only for a new database: an existing one may have been written under a seed a new file would not hold.
    if (existsSync(db)) throw new Error(`secrets file ${path} is missing, and the database ${db} already exists: create the file (README, Secrets)`);
    const pending = pendingDevSecrets(path);
    return { secrets: pending.source, pending };
  }
  return { secrets: fileSecrets(path) };
}
