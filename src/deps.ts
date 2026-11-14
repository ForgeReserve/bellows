import { GatewayWallet, type WalletOptions } from './cashu/wallet.ts';
import { type Config, normalizeMintUrl } from './config.ts';
import { BalanceCap } from './accounts.ts';
import { openDb, refuseOrphanedForgeDb } from './db.ts';
import { Invites, Ledger } from './ledger.ts';
import { BUILTIN_SOURCES, RateOracle, type RateSource } from './rates.ts';
import { checkForeignMintUrl, type FundingFaults, FundingService } from './funding.ts';
import { type Attester, createIdentity, type Identity } from './identity.ts';
import { log } from './log.ts';
import { createDiscovery, createRelayQuery, type MintProbe, type RelayQuery, sqliteStore } from './mint-discovery.ts';
import { buildSuppliers } from './suppliers/index.ts';
import { hasWalletState, resolveWalletSeed, type WalletSeedSource } from './wallet-seed.ts';
import type { Deps } from './app.ts';

export function buildDeps(
  config: Config,
  opts: {
    rateSources?: RateSource[];
    faults?: { afterReceiveSwap?: boolean; afterSendSwap?: boolean; noReplayOnRecovery?: boolean; noRestoreOnRecovery?: boolean };
    fundingFaults?: FundingFaults;
    /** Tests: stand-ins for the Nostr relays and the mint probe used by other-mint discovery. */
    discovery?: { query?: RelayQuery; probe?: (url: string) => Promise<MintProbe>; now?: () => number };
    /** Tests: an attester in place of the one the configuration names. */
    attester?: Attester;
    /** Tests: shorter counter scans and retries (src/cashu/counter-scan.ts). */
    counterScan?: WalletOptions['counterScan'];
  } = {},
): Deps {
  const env = config.env;
  refuseOrphanedForgeDb(env.BELLOWS_DB_PATH);
  // Development, new database: write the secrets file holding its wallet secret before the database exists.
  config.pendingSecretsFile?.write();
  const db = openDb(env.BELLOWS_DB_PATH);
  // No wallet state: a new database (memory storage after any restart, or a lost volume). The NUT-13
  // counters start at 0 under the same seed, so startupRecovery scans the mints before anything is served.
  const freshWallet = !hasWalletState(db);
  const { seed, source: seedSource } = resolveWalletSeed(db, config.secrets);
  // A new HPKE key pair on every boot; attested lazily (and eagerly by index.ts) for /.well-known/bellows.
  const identity = createIdentity(config, opts.attester);
  logStartup(config, seedSource, identity);
  const sources =
    opts.rateSources ??
    env.BELLOWS_RATE_SOURCES.map((n) => {
      const s = BUILTIN_SOURCES[n];
      if (!s) throw new Error(`unknown rate source ${n}; known: ${Object.keys(BUILTIN_SOURCES).join(', ')}`);
      return s;
    });
  const ledger = new Ledger(db);
  const fundMint = env.BELLOWS_FUND_MINT ?? config.trustedMints[0]!;
  const wallet = new GatewayWallet(db, {
    trustedMints: config.trustedMints,
    units: env.BELLOWS_UNITS,
    maxTokenBytes: env.BELLOWS_MAX_TOKEN_BYTES,
    seed,
    // eCash from other mints: the mint actually contacted passes the same URL safety check as the quoted one.
    // The operator's funding mint is configuration, not customer input, like the trusted mints.
    vetMint: async (m) => (m === normalizeMintUrl(fundMint) ? undefined : checkForeignMintUrl(m, env.BELLOWS_FOREIGN_ALLOW_INSECURE)),
    faults: opts.faults,
    counterScan: opts.counterScan,
  });
  wallet.needsCounterScan = freshWallet;
  const rates = new RateOracle(sources, {
    minSources: Math.min(env.BELLOWS_RATE_MIN_SOURCES, sources.length),
    ttlMs: env.BELLOWS_RATE_TTL_SECONDS * 1000,
    maxStaleMs: env.BELLOWS_RATE_MAX_STALE_SECONDS * 1000,
  });
  const discovery = createDiscovery({
    query: opts.discovery?.query ?? createRelayQuery(),
    relays: env.BELLOWS_FOREIGN_DISCOVERY_RELAYS,
    minReviewers: env.BELLOWS_FOREIGN_MIN_REVIEWERS,
    requireAnnouncement: env.BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT,
    maxDiscovered: env.BELLOWS_FOREIGN_MAX_DISCOVERED,
    units: env.BELLOWS_UNITS,
    // The gateway's own mints and denied mints are never discovered (read once: both come from the env).
    excluded: [...config.trustedMints, ...env.BELLOWS_FOREIGN_DENY],
    probe: opts.discovery?.probe,
    now: opts.discovery?.now,
    store: sqliteStore(db),
    ttlOkMs: env.BELLOWS_FOREIGN_DISCOVERY_TTL_MINUTES * 60_000,
    allowInsecure: env.BELLOWS_FOREIGN_ALLOW_INSECURE,
    log: (msg, fields) => (msg === 'mint_discovery_refreshed' ? log.info(msg, fields) : log.warn(msg, fields)),
  });
  const funding = new FundingService({
    db,
    ledger,
    wallet,
    env,
    rates,
    mint: fundMint,
    faults: opts.fundingFaults,
    discovery,
    probe: opts.discovery?.probe,
    cap: new BalanceCap(db, config.balanceMax),
  });
  const deps: Deps = {
    config,
    db,
    ledger,
    invites: new Invites(db),
    wallet,
    rates,
    funding,
    discovery,
    suppliers: buildSuppliers(config),
    identity,
  };
  return deps;
}

/** Says which mode this is and where state and secrets come from. Never a secret or a seed. */
function logStartup(config: Config, walletSeed: WalletSeedSource, identity: Identity): void {
  log.info('startup', {
    mode: config.mode,
    secrets: config.secrets.kind,
    secrets_from: config.secrets.where,
    secrets_file_created: config.pendingSecretsFile ? true : undefined,
    db_path: config.env.BELLOWS_DB_PATH,
    sealed_mount: config.sealedMount,
    storage: config.storage,
    wallet_seed: walletSeed,
    admin_api: config.adminTokenHash ? 'on' : 'off',
    version: config.version,
    attester: config.attester,
    hpke_key_sha256: identity.keyConfigSha256,
    note:
      config.mode === 'development'
        ? 'development mode: the database and the secrets are not sealed, and the dev attester proves nothing; do not hold real funds this way'
        : 'sealed mode: database on the encrypted volume, secrets from the secrets source',
  });
  if (walletSeed === 'stored') {
    log.warn('wallet_seed_stored', {
      note: 'this database holds a wallet seed stored by an earlier version; it stays in use and BELLOWS_WALLET_SECRET does not replace it',
    });
  }
}
