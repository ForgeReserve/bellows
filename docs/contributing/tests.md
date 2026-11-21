# What the tests check

This page says what each test file covers, so you can find the one to run or extend. [CONTRIBUTING.md](../../CONTRIBUTING.md#run-the-tests) has the commands. Some docs also describe the tests for their own area: [Oblivious HTTP](../how-it-works/ohttp.md#tests), [Operators](../use/operators.md#tests) and [Payments](../how-it-works/payments.md#what-these-tests-prove).

The unit tests are in `test/unit/` and run without Docker. The end-to-end tests are in `test/e2e/` and run against local Nutshell test mints in Docker. The live test is in `test/live/`.

## Local test mints

`docker-compose.test.yml` runs three FakeWallet mints, whose Lightning invoices count as paid without any real payment: `mint-a` (the gateway's own mint in tests), `mint-b` (an untrusted mint) and `mint-c` (a "foreign" mint with input fees, for other-mint funding). On-chain funding is tested against `test/e2e/onchain-mock.ts`, a NUT-30 proxy over `mint-a` that follows the request and response shapes of a Nutshell branch with NUT-30.

## Standalone engine and configuration

`test/unit/standalone.test.ts` checks that no page or static file is served, that the waitlist is gone, that every client route still exists and that NUT-18 requests carry the service name. `test/unit/config.test.ts` checks the `BELLOWS_*` names, that startup refuses to run while any old `FORGE_*` name is set, and the defaults. `test/unit/forge-db.test.ts` checks that startup refuses to create a new database next to an existing `forge.db`.

## Sealed state

`test/unit/sealed-state.test.ts` checks the secrets file (mode 0600, content never echoed), that secrets set in the environment are refused by name, supplier and admin keys from the secrets source, the HKDF wallet seed against a test vector computed outside Node, a stored seed kept in use with a warning, a changed seed refused, sealed mode refusing a database off the named mounts (elsewhere, in memory, on a mount nested inside, through a symlink), and a startup line that names the mode and never a secret. `test/e2e/sealed-state.e2e.test.ts` tops up against a local mint, recovers the gateway's eCash from the mint with NUT-09 restore using only the wallet secret, and checks that neither the secret nor the seed appears in the database files or the logs. In the e2e suite each gateway reads its secrets from `secrets.json` next to its database, as a development install does.

## Attested identity

`test/unit/attestation.test.ts` checks the RFC 9458 key configuration, the dev attester and its verifier (another binding, a changed payload, a bad signature and an untrusted key refused), the Tinfoil REPORT_DATA derivation against the vector published with Tinfoil's verifier, the Tinfoil binding checks and the attester against a stand-in socket, the identity document's refresh and failure handling, the `builds.json` checker, and `verifyBellows` refusing development attestations without opt-in, unapproved builds, false claims and statements changed in transit. It also checks that `client/` imports no Node module. `test/e2e/identity.e2e.test.ts` verifies a running Bellows over HTTP with the dev attester and with the Tinfoil attester against a stand-in socket, and checks that the private key appears in neither the document nor the logs.

## Oblivious HTTP

`test/unit/ohttp.test.ts` checks that `/ohttp-keys` serves the attested key, round trips in both OHTTP modes, a chunked answer arriving piece by piece, and the refusal of tampered, replayed (a topup among them), stale, undated, cut-short and misdirected requests, with the client retrying once on the gateway's clock, and that a refused request never takes a place in the replay cache, a flood at the admission bound never fills it, and a clock stepping back does not shut new requests out. It also checks that the app receives none of the outer request. `test/unit/relay.test.ts` checks the relay's allowlist, that it forwards only the body and its content type, passes on a busy gateway's `Retry-After`, its refusals, that it writes nothing, the Worker entry point, and the Node server with the gateway seeing the relay's address only. `test/e2e/ohttp.e2e.test.ts` runs client, relay and Bellows against the local mints: topup, chat, streamed chat, a NUT-24 payment and a refund through the relay, with the relay's bytes holding none of the content, the Bellows never receiving the client's address or headers, and a replayed topup crediting nothing.

## Deploy kit

`test/unit/deploy.test.ts` checks the deploy kit:

- that no container but `bellows` may request attestations, receive secrets or mount Bellows' volume, in `tinfoil-config.yml` and in both templates in `deploy/`;
- every other rule `pnpm deploy:check` enforces, each one with a config that breaks it;
- that a release refuses example values and placeholder digests;
- that the release workflow's own pin step leaves an operator's edited config, plain or onion, ready for a release;
- that a copy of the repository as an operator has it (their config, their builds in `builds.json`) passes the unit suite;
- that the onion template is the plain template plus the sidecar;
- that Bellows starts in sealed mode from the measured env with secrets from the platform;
- that the egress allowlist covers every mint, supplier, price source and Nostr relay the config uses;
- that the shim exposes every route;
- image pinning, reading a measured release into `builds.json`, and the keyserver policy example;
- the Dockerfiles: pinned bases, numeric non-root users, no package manager;
- the release workflows (builds proposed by pull request) and the CI workflow (read-only, no credentials, the same checks as a release);
- for every workflow, actions pinned by commit and no default permissions.

It also reads the docs that describe the kit (the admin API's reach in a sealed deployment, and how to finish a failed release), so they stay in step with it.

## Operators

`test/unit/operators.test.ts` checks operator announcements (signing, every refusal, newest wins, Nostr relays against a stand-in), the publishing command (hidden prompt, the key never printed), startup refusing an announcement that does not match the configuration, and the operator pool against Bellows instances in the same process (verify, health, pick, remember, failover, routes). `test/e2e/operators.e2e.test.ts` runs three Bellows against the local mints, moves a balance from one to another (passing over one that takes another mint, solving proof of work at the next) and fails over when operators go down.

## Forge AI clients

`test/e2e/forge-ai-fit.e2e.test.ts` runs the Forge AI clients' calls, copied without change in `test/e2e/forge-ai-client.ts`, against a Bellows set up as Forge AI runs it, once directly and once through Oblivious HTTP: models, funding methods, a topup and its replay, a pasted key, Lightning, other-mint funding with change, on-chain funding against the mock, streamed chat with reasoning, encrypted pass-through, plain and locked refunds, history, an empty balance, an unknown key, and the agent example paying per request with plain and locked change. Through OHTTP it checks that the Bellows received nothing but `POST /ohttp`. It also checks the CORS headers a web app on another origin needs, and that an app that predates proof of work cannot open a balance while everything on an existing key works.

## Admin API and CLI

The admin tests (`test/unit/admin.test.ts`, `test/e2e/admin.e2e.test.ts`) cover:

- access control: 404 when off, no page, 401 on a missing or wrong token, a failed-login limit that never locks out the right token, Origin and JSON checks, no CORS;
- no per-balance, per-funding or per-request listing;
- invites and revoke;
- freeze: spending blocked, refunds allowed;
- revenue export: never above what can be swept, a locked export redeemable only with the key, history with the token hash and no token, and a crash after the swap finished once by recovery;
- overview numbers against the balances and the daily aggregates.

## Privacy

`test/unit/blind.test.ts` fails if the source reads a client's network address, user agent, referrer or forwarded-for value. `test/e2e/blind.e2e.test.ts` sends all of them with every request and fails if any shows up in a log line, a response, a database row or the raw database files. `test/e2e/files-privacy.e2e.test.ts` checks the logs and the database for file text on both the plaintext and the encrypted path.

## Payments, funding and recovery

The e2e suite covers:

- the 402 flow with change, sat pricing, topup, spend, refund, wrong mint, wrong unit, double spend, client disconnect mid-stream, upstream failure and retries, and flat pricing;
- invites off by default, and the optional invite gate;
- crash recovery, both NUT-19 replay and NUT-09 restore;
- a NUT-24 payment interrupted mid-receive and settled in the same process: a retry with the same token served once, or the whole payment back from the change URL;
- P2PK-locked change and refunds: locked to the key (a plain wallet and the gateway's own wallet cannot redeem them, the key holder can), invalid keys 400, and a crash after a locked swap recovered by replay, by NUT-09 restore of the stored blinded messages, and left owed when neither answers;
- funding by Lightning: quote, paid, minted, credited; a restart mid-quote; a crash after the mint, with replay and with restore; concurrent polls credit once;
- funding by other-mint eCash: fees shown, credit exact, change returned, cross-unit, a crash after the swap and after the melt, a refund when the melt no longer fits, quote expiry freeing the invite, the deny list, plain-http mints refused;
- on-chain funding against the mock: NUT-20 locked quotes, repeated deposits, a crash after the mint;
- EHBP pass-through against a fake enclave, with usage from a header and from an HTTP trailer;
- file text in messages never reaching the logs or the database.

## Site

`test/unit/site.test.ts` fails when the generated pages in `site/` are stale, when an internal link or anchor does not resolve, when a page loads anything from another host, when a header holds anything but the logo and the two menu items, when an old page address is gone, or when the landing page grows past its word limit. [Editing the docs](README.md#editing-the-docs) explains how the site is made from these docs.

## Live test

`test/live/tokenfactory.live.test.ts` is an optional smoke test against Token Factory. It runs only when `TOKENFACTORY_API_KEY` is set (`pnpm test:live` reads `.env` if present), keeps its calls tiny, and never prints the key, prompts or completions.
