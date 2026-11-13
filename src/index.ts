import { serve } from '@hono/node-server';
import { setGlobalRequestOptions } from '@cashu/cashu-ts';
import { createApp, startupRecovery } from './app.ts';
import { loadConfig, warnStorage } from './config.ts';
import { buildDeps } from './deps.ts';
import { errText, log, setLogLevel } from './log.ts';

// Mint calls give up after 60 s (cashu-ts default: 5 min). A timeout is an unknown outcome; every
// mint operation is persisted first and finished by replay or restore, so a slow mint cannot hold a request open.
setGlobalRequestOptions({ requestTimeout: 60_000 });
const config = loadConfig();
setLogLevel(config.env.BELLOWS_LOG_LEVEL);
warnStorage(config);
const deps = buildDeps(config);
await startupRecovery(deps).catch((e) => log.error('startup_recovery_failed', { err: errText(e) }));
if (config.env.BELLOWS_UNITS.includes('sat')) {
  deps.rates.get().catch(() => {});
}
// Periodic sweep for reservations orphaned by bugs (never for in-flight ones: those are younger).
setInterval(() => deps.ledger.releaseStale(config.env.BELLOWS_STALE_RESERVATION_SECONDS * 1000), 60_000).unref();
// Funding poller: watches unpaid quotes, finishes interrupted mints and melts (crash recovery included).
deps.funding.start();
// Other-mint discovery: serves the stored set at once, refreshes from the Nostr relays in the background.
deps.discovery.start();
// Attested identity: attest now and keep the document fresh (served at /.well-known/bellows).
deps.identity.start();

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: config.env.PORT, hostname: config.env.HOST }, (info) => {
  log.info('listening', { host: info.address, port: info.port, invite_only: config.env.BELLOWS_INVITE_ONLY, mints: config.trustedMints.join(',') });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('shutdown', { signal: sig });
    deps.funding.stop();
    deps.discovery.stop();
    deps.identity.stop();
    server.close(() => {
      deps.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
