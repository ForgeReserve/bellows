import { serve } from '@hono/node-server';
import { createApp, startupRecovery } from './app.ts';
import { announceUnverifiedPrices, loadConfig } from './config.ts';
import { applyCashuRequestPolicy } from './cashu/wallet.ts';
import { buildDeps } from './deps.ts';
import { errText, log, setLogLevel } from './log.ts';

// Cashu transport policy (60 s timeout, no redirects): see CASHU_REQUEST_OPTIONS in src/cashu/wallet.ts.
applyCashuRequestPolicy();
const config = loadConfig();
setLogLevel(config.env.BELLOWS_LOG_LEVEL);
announceUnverifiedPrices(config);
const deps = buildDeps(config);
await startupRecovery(deps).catch((e) => log.error('startup_recovery_failed', { err: errText(e) }));
if (config.env.BELLOWS_UNITS.includes('sat')) {
  deps.rates.get().catch(() => {});
}
// Periodic sweep for abandoned reservations: older than the window and held by no request this process is
// still serving. A long stream keeps its reservation however old it is (src/ledger.ts).
setInterval(() => {
  const released = deps.ledger.releaseStale(config.env.BELLOWS_STALE_RESERVATION_SECONDS * 1000);
  if (released > 0) log.warn('stale_reservations_released', { released });
}, 60_000).unref();
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
