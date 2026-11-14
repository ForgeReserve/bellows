<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/bellows-mark-dark.svg">
    <img src="docs/brand/bellows-mark-light.svg" alt="Bellows logo: a gold ring and a green ring around a closed lock" width="140">
  </picture>
</p>

# Bellows

Bellows is an open-source, OpenAI-compatible AI gateway that takes Cashu eCash per request and forwards the request to AI models. Point any OpenAI client at it, pay with eCash, and it forwards the request to a pluggable upstream supplier. Licensed MIT.

Bellows started as the engine inside Forge AI, which remains an example deployment, and is extracted here so anyone can run one. Its goal is to be **operator-blind**: the person who runs a Bellows learns nothing worth taking from it. That work is in progress; [docs/DESIGN.md](docs/DESIGN.md) has the plan and states what each step hides and what stays visible. This release is the standalone engine. It keeps every secret in one secrets source and can refuse to run unless its database sits on an encrypted volume ([Secrets and sealed state](#secrets-and-sealed-state)), but it does not yet run in sealed hardware, so today the operator of a Bellows can read plaintext requests in memory and can read its database. Encrypted requests to enclave models (below) are unreadable to the gateway already.

Two ways to pay:

- **Per request (NUT-24).** Call the API with no credentials. You get `HTTP 402` with an `X-Cashu` header holding a NUT-18 payment request. Retry with `X-Cashu: cashuB...`. The gateway runs the request, charges the actual cost, and returns the unused value as eCash change. No account, no key.
- **Prepaid balance.** Send an eCash token to `POST /v1/wallet/topup` and get an `sk-forge-...` key. Use it as a normal bearer key. Withdraw the remainder as eCash at any time.

A balance can also be funded without holding eCash from an accepted mint first: pay a Lightning invoice, send bitcoin on-chain (NUT-30, off by default), or hand over eCash from another Cashu mint, which the gateway melts into a Lightning quote at its funding mint. The gateway mints eCash for itself and credits the exact minted amount. See [Funding a balance](#funding-a-balance).

Bellows serves the API only. It has no web page; client apps (a chat app, an agent, a script) run elsewhere and call the API.

## How it differs from Routstr

[Routstr](https://github.com/routstr/routstr-core) is the established Cashu-paid AI proxy. Bellows makes different choices:

| | Bellows | Routstr (routstr-core, checked 2026-11-09) |
| - | - | - |
| License | MIT | GPL-3.0 |
| Units | USD eCash (`usd`, cents) and bitcoin eCash (`sat`). USD balances stay in USD, metered in milli-cents | Balances and 402 amounts in msat |
| Prices | Set in USD per million tokens; sat prices derive from a median BTC/USD rate | USD upstream prices converted to sats with an exchange buffer |
| Per-request payment | NUT-24: 402 with a NUT-18 `creqA` request, `X-Cashu` token, change returned | `X-Cashu` token header; its 402 body is a custom JSON error format |
| Private inference | Encrypted pass-through to Tinfoil enclaves (EHBP): the gateway forwards ciphertext and still meters it | Not in scope of this comparison |
| Suppliers | Small adapter interface (`src/suppliers/`), config-driven model catalog | Upstream providers configured in a dashboard |

The Routstr column comes from its README and docs on the date shown; check upstream for changes.

## Quickstart (local, with test mints)

Requirements: Node 22.18+ (24 recommended), pnpm, Docker.

```sh
pnpm install --frozen-lockfile
pnpm mint:up                                  # three local Nutshell mints with FakeWallet (usd + sat)
export BELLOWS_TRUSTED_MINTS=http://127.0.0.1:3338 BELLOWS_MODELS_FILE=config/models.dev.json BELLOWS_DB_PATH=data/dev.db
pnpm start &                                  # http://localhost:8787
pnpm test-token 50 usd                        # prints a test eCash token worth 50 cents
curl -s localhost:8787/v1/wallet/topup -H 'content-type: application/json' -d '{"token": "cashuB..."}'
```

The topup answer holds a new `sk-forge-...` key. Use it as a bearer key:

```sh
curl -s localhost:8787/v1/chat/completions -H "authorization: Bearer sk-forge-..." \
  -H 'content-type: application/json' -d '{"model": "mock-echo", "messages": [{"role": "user", "content": "Hello"}]}'
```

The agent demo pays for a request end to end over NUT-24:

```sh
BELLOWS_URL=http://localhost:8787 DEMO_FAKE_MINT=1 pnpm demo:agent "What is eCash?"
```

On first start Bellows creates `data/secrets.json` next to the new database, holding a fresh wallet secret (see [Secrets and sealed state](#secrets-and-sealed-state)). `config/models.dev.json` adds an in-process mock supplier (`mock-echo`, `mock-slow`) so everything works without upstream keys. To use the real suppliers, add `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY` to that file. Token Factory models in the dev catalog are marked `price_verified: false`, so they are served only with `BELLOWS_SERVE_UNVERIFIED_PRICES=true` (see [Model catalog](#model-catalog)).

## Running a Bellows

The `Dockerfile` builds an image that runs the TypeScript sources directly on Node (no build step), as a non-root user, with the database at `/data/bellows.db` on a volume:

```sh
docker build -t bellows .
docker run -d --name bellows -p 127.0.0.1:8787:8787 -v bellows-data:/data --env-file .env bellows
```

Copy `.env.example` to `.env` first and set at least `BELLOWS_TRUSTED_MINTS`. `.env` holds settings only, never a secret: the wallet secret, the admin token and the supplier keys go in `/data/secrets.json` on the volume (copy `secrets.example.json`, `chmod 600`, owned by the container user). Put a reverse proxy with TLS in front. Bellows never reads a client address, so the proxy needs no forwarded-for setup, and it should keep no access log of its own (see [Blind by default](#blind-by-default)).

**Back up the database and the wallet secret.** The SQLite file is the gateway's ledger and holds the state of its eCash wallet; the wallet secret is what the wallet's keys come from. Keep a copy of the wallet secret offline: with it, the gateway's eCash can be recovered from the mint even without the database. See [docs/PAYMENTS.md](docs/PAYMENTS.md).

### Sealed deployment

To run a Bellows that its operator cannot read, deploy it on Tinfoil Containers with the deploy kit: `tinfoil-config.yml` (the measured deployment, with an encrypted volume and secrets from your own keyserver), the hardened `Dockerfile`, an optional Tor onion sidecar (`deploy/`), a keyserver policy example and the release workflows that build, pin, measure and propose each build for `builds.json`. `pnpm deploy:check` checks a config against the kit's rules, among them that only the Bellows container may request attestations. [docs/OPERATE.md](docs/OPERATE.md) is the step-by-step guide, including what has not yet been run on sealed hardware. [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) says what each party can see.

### Secrets and sealed state

Every secret comes from one secrets source. None is read from an environment variable, and startup refuses to run while one is set there.

| Secret | Meaning |
| - | - |
| `BELLOWS_WALLET_SECRET` | At least 32 random bytes as hex (`openssl rand -hex 32`). The wallet seed for deterministic eCash outputs (NUT-13) is derived from it with HKDF-SHA256 and never stored, so a restored volume and a fresh one agree on the seed |
| `BELLOWS_ADMIN_TOKEN` or `BELLOWS_ADMIN_TOKEN_HASH` | The admin token (a random string of at least 16 characters, no spaces), or its SHA-256 in hex. Bellows cannot check the strength of a token it only has the hash of, so generate the token with `openssl rand -hex 32`. Neither, or an empty value: `/admin` answers 404. See [Admin API](#admin-api) |
| Supplier keys, such as `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY` | The names come from `apiKeySecret` in the model catalog. A supplier whose key is missing is left out with its models |
| `TINFOIL_ADMIN_KEY` | Optional Tinfoil admin key, for the credit figures in `GET /admin/api/overview` |
| `BELLOWS_WALLET_SEED` | Only for a database that ran with the old `BELLOWS_WALLET_SEED` variable: that 64-byte hex seed, used as is. Set it or `BELLOWS_WALLET_SECRET`, not both |

Sources (`BELLOWS_SECRETS`):

- `file` (the default in development): a JSON object of name to value, at `BELLOWS_SECRETS_FILE` or `secrets.json` next to the database. Bellows refuses a file other users can read. In development, a new database with no secrets file gets one with a fresh wallet secret; an existing database never does.
- `platform` (the default in sealed mode): the secrets the hosting platform releases to the sealed machine after it has proved which build runs. They reach the process as environment variables set by the platform, not by the deploy config.

Modes (`BELLOWS_MODE`):

- `development` (default): the database and the secrets file can be anywhere. Startup says that nothing is sealed.
- `sealed`: startup refuses to run unless the database, and the secrets file when there is one, resolve (after symlinks) to a mount named in `BELLOWS_SEALED_MOUNTS`, the encrypted volume. The mount table is read from `/proc/self/mountinfo`, so sealed mode runs on Linux. A file system mounted inside the named volume does not count.

The wallet seed in use, in order: `BELLOWS_WALLET_SEED` from the secrets source; a seed an earlier version stored in the database (it stays in use, and startup logs `wallet_seed_stored`); the seed derived from `BELLOWS_WALLET_SECRET`. The database keeps a check value for the seed (an HMAC under it, which reveals nothing about it), and a later start with a different seed is refused: outputs written under one seed cannot be restored under another.

The `startup` log line names the mode, the secrets source and where it reads from, the database path and mount, which seed is in use and whether the admin API is on. It never prints a secret.

Moving from a Forge AI deployment: [docs/MIGRATE-FROM-FORGE-AI.md](docs/MIGRATE-FROM-FORGE-AI.md).

### Attested identity

At boot Bellows makes an HPKE key pair in memory and serves `GET /.well-known/bellows`: its version, the build measurement it claims, the key configuration, its relays and the operator announcement, with a hardware attestation that binds all of them. Clients check that attestation, and that the attested build is listed in [`builds.json`](builds.json), before sending anything. The client library in [`client/`](client/) does this check (`verifyBellows`) in browsers and in Node. In development the attestation is a signed stand-in that clients refuse unless they opt into development mode. See [docs/ATTESTATION.md](docs/ATTESTATION.md), including what has not been verified on real sealed hardware.

### Oblivious HTTP

Bellows is an Oblivious HTTP gateway (RFC 9458) for its own client API. A client encrypts each call to the attested HPKE key with `bellowsFetch` from [`client/`](client/) and sends it to `POST /ohttp`, through a relay when it has one. The relay sees the client's address and ciphertext; Bellows sees the request and the relay's address. Who is asking is hidden from the operator when you use a relay run by someone else, or Tor. Chunked OHTTP streams chat answers as they are written. Each request carries its date and is refused if replayed. [`relay/`](relay/) is a small relay that runs as a Node server or a Cloudflare Worker, forwards only the opaque body and keeps no logs. See [docs/OHTTP.md](docs/OHTTP.md).

### Operators

Each operator publishes a signed announcement, a replaceable Nostr event (kind 38390) with the Bellows' address, its relays, its onion address, its build and the units and mints it takes. `pnpm announce` makes it, with the operator's key read from a hidden prompt, writes it for `BELLOWS_OPERATOR_ANNOUNCEMENT_FILE` and publishes it to Nostr relays. Bellows serves the same event in its attested identity and refuses to start if it does not match its configuration. The client library loads a list of operators, verifies each one (attested build, and an announcement by the same key for the same address), checks its health, picks one, fails over on error and remembers the last one that worked (`OperatorPool`). `moveBalance` withdraws a balance as eCash from one operator and funds a new balance at another. See [docs/OPERATORS.md](docs/OPERATORS.md).

## Configuration

Environment variables, validated with zod at startup (`src/config.ts`):

| Variable | Default | Meaning |
| - | - | - |
| `BELLOWS_TRUSTED_MINTS` | required | Comma-separated mints whose eCash is accepted. Tokens from other mints get HTTP 400. There is no built-in mint |
| `BELLOWS_MINT_ALIASES` | none | Other addresses of the same mint, as comma-separated `alias=main` pairs. Tokens under an alias are accepted and stored under the main address, so the wallet keeps one counter per keyset |
| `BELLOWS_UNITS` | `usd,sat` | Accepted units |
| `BELLOWS_DEFAULT_UNIT` | `usd` | Unit of a 402 request unless the client sends `X-Forge-Unit` |
| `BELLOWS_INVITE_ONLY` | `false` | Optional gate: require an invite code to open a balance or pay per request |
| `BELLOWS_SERVICE_NAME` | `Bellows` | Name in NUT-18 payment requests (`<name>: <model>`) |
| `BELLOWS_MARKUP` | `1.25` | Multiplier on supplier cost |
| `BELLOWS_SERVE_UNVERIFIED_PRICES` | `false` | Serve models whose catalog price has `price_verified: false`. Off, they are neither listed nor routable, whatever supplier keys are present. On, startup logs them at error level. See [Model catalog](#model-catalog) |
| `BELLOWS_MODELS_FILE` | `config/models.json` | Supplier and model catalog |
| `BELLOWS_DB_PATH` | `data/bellows.db` | SQLite ledger and wallet state. In sealed mode it must be on a mount in `BELLOWS_SEALED_MOUNTS` |
| `BELLOWS_MODE` | `development` | `development` or `sealed`. See [Secrets and sealed state](#secrets-and-sealed-state) |
| `BELLOWS_SECRETS` | `file` in development, `platform` in sealed mode | Where secrets come from |
| `BELLOWS_SECRETS_FILE` | `secrets.json` next to the database | The secrets file, for the `file` source |
| `BELLOWS_SEALED_MOUNTS` | none | Comma-separated mount points of the encrypted volume. Required in sealed mode |
| `BELLOWS_STORAGE` | `volume` | Where the database lives, said in `/.well-known/bellows`. `memory`: on a `tmpfs`, for a deployment without a volume, where every restart loses every balance. Memory needs `BELLOWS_INVITE_ONLY=true` and on-chain funding off, and caps every balance. See [docs/OPERATE.md](docs/OPERATE.md#running-without-a-volume) |
| `BELLOWS_MEMORY_MAX_BALANCE_USD` / `BELLOWS_MEMORY_MAX_BALANCE_SAT` | `2000` / `20000` | With `BELLOWS_STORAGE=memory` only: the most one balance may hold, in cents / sat, counting open fundings. A top-up or funding past it is refused (`400 balance_limit`) before any eCash is taken |
| `BELLOWS_RATE_SOURCES` | `coinbase,kraken,bitstamp` | BTC/USD sources (also `coingecko`); add one by implementing `RateSource` in `src/rates.ts` |
| `BELLOWS_RATE_MIN_SOURCES` | `2` | Sources that must answer for a rate to be used |
| `BELLOWS_RATE_TTL_SECONDS` / `BELLOWS_RATE_MAX_STALE_SECONDS` | `60` / `900` | Cache time; after max staleness sat pricing returns 503 instead of guessing |
| `BELLOWS_SAT_PRICE_BUFFER` | `1.02` | Headroom on sat 402 amounts so a rate move between quote and payment does not reject the token |
| `BELLOWS_BYTES_PER_TOKEN` | `2` | Conservative bytes per input token used to size the reservation |
| `BELLOWS_RATE_LIMIT_RPM` | `60` | Requests per minute per balance key |
| `BELLOWS_ANON_RATE_LIMIT_RPM` | `600` | Requests per minute shared by every request without a known balance key (NUT-24 payments and 402 asks) |
| `BELLOWS_POW_BITS` | `16` | Proof of work a request needs to open a new balance, in leading zero bits of SHA-256 (16 is about 65,000 hashes). `0` turns it off; those requests then share the anonymous budget |
| `BELLOWS_MAX_BODY_BYTES` | `1000000` | Request size limit |
| `BELLOWS_UPSTREAM_TIMEOUT_MS` / `BELLOWS_UPSTREAM_RETRIES` | `180000` / `2` | Time to upstream response headers (a timeout is final); retries on connection errors, 408, 429 and 5xx |
| `BELLOWS_FUND_MINT` | first trusted mint | Mint used for Lightning, on-chain and other-mint funding |
| `BELLOWS_LIGHTNING_ENABLED` | `true` | Lightning funding (NUT-04 bolt11 quotes) |
| `BELLOWS_FUND_MAX_SAT` / `BELLOWS_FUND_MAX_USD` | `1000000` / `50000` | Largest Lightning funding, in sat / cents (the mint's own limit also applies) |
| `BELLOWS_ONCHAIN_ENABLED` | `false` | On-chain funding (NUT-30). Leave off until tested against your funding mint |
| `BELLOWS_ONCHAIN_CONFIRMATIONS` | `3` | Confirmations shown to users; the mint decides when a deposit is paid |
| `BELLOWS_ONCHAIN_WATCH_DAYS` | `30` | How long an on-chain address is watched for deposits |
| `BELLOWS_ESPLORA_URL` | unset | Optional Esplora API used to show unconfirmed deposits. Unset: the gateway asks only the mint |
| `BELLOWS_FOREIGN_ENABLED` | `true` | Accept eCash from other mints (melted into a Lightning quote at the funding mint) |
| `BELLOWS_FOREIGN_POLICY` | `discovered` | Which other mints are accepted. `discovered`: the operator list (`BELLOWS_FOREIGN_ALLOW` and mints added through the admin API) plus mints found through NIP-87 reviews (below). `allowlist`: the operator list only. `any`: every https mint, limited to `BELLOWS_FOREIGN_ALLOW` when that is set. `BELLOWS_FOREIGN_DENY` always wins |
| `BELLOWS_FOREIGN_ALLOW` / `BELLOWS_FOREIGN_DENY` | empty | Operator list of accepted mints (the admin API can add more), and mints never accepted |
| `BELLOWS_FOREIGN_UNLISTED` | `true` | Under `discovered` and `allowlist`, let a customer fund from a mint that is not accepted after a warning (`mint_unlisted`, then `accept_unlisted: true`), with the lower cap below. `false`: such mints get `mint_not_allowed` |
| `BELLOWS_FOREIGN_UNLISTED_MAX_SAT` / `BELLOWS_FOREIGN_UNLISTED_MAX_USD` | `5000` / `500` | Largest token from an unlisted mint, in sat / cents. The other-mint cap still applies when lower |
| `BELLOWS_FOREIGN_MIN_REVIEWERS` | `2` | Distinct verified NIP-87 reviewers a discovered mint needs |
| `BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT` | `false` | Also require the mint's own verified kind 38172 announcement (few mints publish one today) |
| `BELLOWS_FOREIGN_DISCOVERY_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` | Nostr relays read for mint announcements (kind 38172) and reviews (kind 38000). Empty: no discovery |
| `BELLOWS_FOREIGN_DISCOVERY_TTL_MINUTES` | `60` | How long a discovered list is served before a background refresh (a failed refresh retries after a minute) |
| `BELLOWS_FOREIGN_MAX_DISCOVERED` | `25` | Most discovered mints accepted at once, best reviewed first |
| `BELLOWS_FOREIGN_MAX_SAT` / `BELLOWS_FOREIGN_MAX_USD` | `100000` / `5000` | Largest token from another mint, in sat / cents |
| `BELLOWS_FUND_MAX_PENDING` | `5` | Unfinished fundings per balance |
| `BELLOWS_ADMIN_ORIGIN` | request `Host` | Origin admin changes must come from |
| `BELLOWS_ADMIN_RATE_LIMIT_RPM` | `120` | Admin API requests per minute with the right token (failed logins have their own budget of 10 a minute) |
| `BELLOWS_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `BELLOWS_ATTESTER` | `dev` in development, `tinfoil` in sealed mode | Who attests `/.well-known/bellows`. `dev` is a stand-in clients refuse unless they opt into development mode; sealed mode refuses it. See [docs/ATTESTATION.md](docs/ATTESTATION.md) |
| `BELLOWS_TINFOIL_ATTESTATION_SOCKET` | `/tinfoil/attestation.sock` | The Tinfoil attestation socket (`attestation: true` on the container in `tinfoil-config.yml`) |
| `BELLOWS_ATTEST_REFRESH_MINUTES` | `360` | Make the attestation again after this long |
| `BELLOWS_DEV_MEASUREMENT` | fixed default | `dev` attester only: the development measurement's one register (64 lowercase hex) |
| `BELLOWS_BUILD_MEASUREMENT` | unset | Hardware attesters: the measurement this build claims, as JSON `{"type": ..., "registers": [...]}` from `builds.json` |
| `BELLOWS_RELAYS` | none | Comma-separated Oblivious HTTP relay URLs published in `/.well-known/bellows`: each the full URL a client posts to, for example `https://relay.example/relay/bellows.example` |
| `BELLOWS_OHTTP_MAX_SKEW_SECONDS` | `300` | How far an encapsulated request's date may be from this clock; also how long its key is remembered to refuse replays |
| `BELLOWS_OHTTP_REPLAY_CACHE_MAX` | `200000` | Most encapsulated keys remembered at once; past this `/ohttp` answers 503 |
| `BELLOWS_OHTTP_ADMIT_PER_SECOND` | the most the replay cache holds (about 332) | New encapsulated requests admitted per second, for all clients together; past this `/ohttp` answers 503 with `Retry-After`. Unset, the replay cache cannot fill; a value that could fill it is refused at startup (docs/OHTTP.md) |
| `BELLOWS_OHTTP_MAX_MESSAGE_BYTES` | `8388608` | Largest Binary HTTP request, and largest plain (not chunked) answer, in one OHTTP exchange. Chunked answers stream and are bounded at 1 GiB. A client in plain mode must accept at least this much (docs/OHTTP.md) |
| `BELLOWS_OPERATOR_ANNOUNCEMENT_FILE` | unset | The signed operator announcement (`pnpm announce --out`), published in `/.well-known/bellows`. Startup refuses one that is unsigned or does not match the relays, version, measurement, units and mints configured here ([docs/OPERATORS.md](docs/OPERATORS.md)) |
| `BELLOWS_OPERATOR_ANNOUNCEMENT` | unset | The same announcement as JSON text, instead of the file. A sealed deployment gets it from the keyserver with the secrets, because the operator cannot write to the encrypted volume ([docs/OPERATE.md](docs/OPERATE.md)). Set this or the file, not both |

Secrets are not environment variables: see [Secrets and sealed state](#secrets-and-sealed-state).

### Other mints (NIP-87 discovery)

Under `BELLOWS_FOREIGN_POLICY=discovered` the gateway accepts eCash from the mints the operator lists plus the mints Cashu wallets recommend, found the way wallet.cashu.me finds them: kind 38172 mint announcements and kind 38000 reviews (`#k=38172`) from `BELLOWS_FOREIGN_DISCOVERY_RELAYS`. Event ids and BIP-340 signatures are checked, reviews older than 24 months are ignored, and a reviewer counts once per mint. A mint is accepted when it has at least `BELLOWS_FOREIGN_MIN_REVIEWERS` distinct reviewers (plus a verified mainnet announcement when `BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT=true`) and passes a probe: `GET /v1/info` and `GET /v1/keysets` answer, an active keyset exists in a unit this gateway uses, and NUT-05 bolt11 melt is enabled in that unit (the gateway melts the eCash there). The list is kept in the database, served at once after a restart, and refreshed in the background; a request never waits on a relay. The URL safety check still runs on every accepted mint, and again whenever the gateway loads that mint's wallet; no Cashu request follows a redirect.

The operator can add mints through the admin API (`POST /admin/api/mints/allowed`). An added mint goes through the URL safety check and the same probe, keeps the name from its `/v1/info`, is stored in the `operator_mints` table and is accepted like `BELLOWS_FOREIGN_ALLOW` under every policy (under `any` it never limits the policy). The gateway's own mints and denied mints cannot be added. Both kinds are listed with `source: "operator"`.

A customer can still use a mint that is not on the list (`BELLOWS_FOREIGN_UNLISTED=true`, policy `discovered` or `allowlist`). The first quote answers 409 `mint_unlisted` with `{unlisted: {mint, max: {sat, usd}}}`; a client shows the warning and, if the user agrees, resends the quote with `accept_unlisted: true`. The mint must then pass the live probe (results are cached for 10 minutes, a failure for 1 minute), the token is capped at `BELLOWS_FOREIGN_UNLISTED_MAX_SAT` / `_USD`, and the funding is marked unlisted (`fundings.f_unlisted`, `foreign.unlisted` in the funding view, and counted as `health.fundings_unlisted` in `GET /admin/api/overview`). Denied mints are always refused.

### Model catalog

`config/models.json` lists suppliers and models. Each model has a public `id`, its `supplier`, the `upstream` model name, the supplier's cost in USD per million input and output tokens, `max_output_tokens`, and `uncensored` (clients may hide those behind an explicit opt-in). `price_verified: true` says the cost was checked against the supplier's rate card; it defaults to `false`.

A model whose price is not verified is not served: it is left out of `GET /v1/models` and a request for it gets `404 model_not_found`, even when its supplier's key is in the secrets source. A placeholder price would otherwise overcharge customers or leave you paying the difference. Startup logs `unverified_prices_withheld` with the models it left out, and refuses to start if no verified model is left. To serve them anyway, set `BELLOWS_SERVE_UNVERIFIED_PRICES=true`: startup then logs `unverified_prices_served` at error level, and `/v1/models` shows those models with `pricing.verified: false`. The admin settings (`GET /admin/api/settings`) show them as `unverified_prices`.

Tinfoil prices were read from `https://inference.tinfoil.sh/v1/models` on 2026-11-09. Token Factory prices in the shipped catalog are placeholders marked `price_verified: false`, so those models are not served until you set them from your rate card: on 2026-11-13 Token Factory published no prices that could be checked (its gateway's public model list is empty, and its `/v1/model/info` returned no cost fields on 2026-11-09).

A supplier sets `pricing: "metered"` (charge on reported usage) or `pricing: "flat"` (charge a schedule by request body size plus declared max output). A metered supplier may also carry a `flat` schedule, used only when no usage signal arrives.

### Suppliers

| Supplier | Tier | How |
| - | - | - |
| Token Factory | standard | OpenAI-compatible LiteLLM proxy at `https://gateway.trytokenfactory.dev/v1` |
| Tinfoil | enclave | Plaintext OpenAI-compatible calls, or EHBP encrypted pass-through (see [docs/PRIVACY.md](docs/PRIVACY.md)) |
| mock | standard | In-process, deterministic, for tests and local demos |

Add a supplier by implementing `Supplier` in `src/suppliers/types.ts` (one `chat()` method for OpenAI-compatible upstreams) and registering its `type` in `src/suppliers/index.ts`.

## API

This section is a summary. [docs/API.md](docs/API.md) is the full reference for the client API, the operator API and the discovery format, written so another app can use a Bellows without reading the code.

All amounts in `*_msub` fields are thousandths of the unit: milli-cents for `usd`, millisatoshi for `sat`.

### `POST /v1/chat/completions`

OpenAI chat completions, streaming and non-streaming. `tools`, `tool_choice` and other fields pass through untouched. `n` must be 1. `max_tokens` (or `max_completion_tokens`) is capped per model; if absent, the cap is applied.

Payment headers:

- `Authorization: Bearer sk-forge-...` spends from a balance.
- `X-Cashu: cashuB...` pays this request (NUT-24). Add `X-Forge-Invite` when `BELLOWS_INVITE_ONLY=true`.
- `X-Cashu-Pubkey: 02...` (optional) locks this request's change to your wallet key (NUT-11 P2PK). See [Locking tokens to your wallet key](#locking-tokens-to-your-wallet-key).
- Neither: `402 Payment Required` with `X-Cashu: creqA...` (NUT-18: amount, unit, accepted mints). The amount is the request's maximum cost. `X-Forge-Unit: sat` asks for a sat quote.

Response headers: `X-Forge-Request-Id`, `X-Forge-Unit`, `X-Forge-Charged-Msub`, `X-Forge-Balance-Msub` (balance payments), `X-Forge-Privacy` (`standard`, `enclave-plaintext`, `enclave-encrypted`), and for NUT-24 `X-Cashu-Change` plus `X-Forge-Change-Url`.

Streams end with the upstream's `data: [DONE]`, followed by one gateway event:

```
event: forge
data: {"request_id":"req_...","unit":"usd","charged_msub":1300,"balance_msub":98700,"change":"cashuB..."}
```

The OpenAI JavaScript SDK ignores events after `[DONE]` (checked in its `core/streaming.js`), so the extra event does not reach its callers; other clients that parse every event should skip `event: forge`. Clients that want the change token read it, or fetch `GET /v1/change/{request_id}`.

### `GET /v1/models`

The models this Bellows serves (see [Model catalog](#model-catalog)): the OpenAI model list plus `tier` (`enclave` or `standard`), `uncensored`, `max_output_tokens`, `context_length`, and `pricing` (`usd_per_mtok`, `sat_per_mtok` at the current rate, `mode`, `verified`). The response also lists accepted `mints`, `units` and `invite_only`.

### Wallet

| Endpoint | Body / auth | Result |
| - | - | - |
| `POST /v1/wallet/topup` | `{"token": "cashuB...", "invite": "inv-..."}` (`invite` only when invite-only); optional `Authorization: Bearer sk-forge-...` to top up an existing key, or to choose your own key for a new balance | `{key?, account_id, unit, credited, balance_msub}`. `key` is returned only when the gateway generated it |
| `GET /v1/wallet` | bearer key | `{unit, balance_msub, available_msub, refundable}` |
| `POST /v1/wallet/refund` | bearer key; optional `{"amount": N, "pubkey": "02..."}`, amount in whole units | `{token, amount, unit, mint, status, locked_to}`. Sub-unit remainders stay on the balance. With `pubkey` the token is P2PK-locked to it |
| `GET /v1/wallet/refunds` | bearer key | Every withdrawal with its token, `mint` and `locked_to`, for re-delivery |
| `GET /v1/change/{request_id}` | none (the id is an unguessable capability) | NUT-24 change for that request; for a request that failed while its payment was unconfirmed, the whole payment once the mint confirms it |

A balance has one unit, set by its first topup. Topping up with another unit is rejected.

A Bellows that keeps balances in memory (`storage: "memory"`) refuses a topup or a funding that would take a balance past `balance_max` (`400 balance_limit`, with `unit`, `balance_max` and `room`), before the mint sees the token. Both values appear in `GET /v1/wallet/fund/methods` and in the attested statement at `/.well-known/bellows`.

### Proof of work for a new balance

A request that opens a new balance (a topup or funding without a known balance key) carries a small proof of work instead of being limited per client address, which Bellows never reads. Requests on an existing key do not need one.

1. Send the request as usual. Without a solution the answer is `428 pow_required` with `{pow: {challenge, bits, expires_at, header}}` and the challenge in `X-Bellows-Pow-Challenge`. `GET /v1/pow` hands out a challenge ahead of time.
2. Find a nonce (1 to 32 characters from `A-Z a-z 0-9 _ -`) such that SHA-256 of the string `<challenge>:<nonce>` starts with `bits` zero bits.
3. Resend the same request with `X-Bellows-Pow: <challenge>:<nonce>`. A challenge is good for 5 minutes and for one request.

`solvePow(challenge, bits)` in the client library (`client/pow.ts`) finds a solution, in a browser or in Node. With `BELLOWS_POW_BITS=0` no proof is asked for.

### Funding a balance

Each method opens a balance on first use (an invite is required when `BELLOWS_INVITE_ONLY=true`, exactly as for a topup) and returns `key` once when the gateway generated it. Send `Authorization: Bearer sk-forge-...` to fund an existing balance, or to choose your own key for a new one. Every response is a funding object:

```
{id, method: "lightning"|"onchain"|"foreign", state, unit, amount, request, expires_at, credited, balance_msub, account_id,
 onchain?: {confirmations_required, paid_sat, seen_sat, confirmed_sat, confirmations, watch_until},
 foreign?: {mint, unit, token_amount, credit, fee_max, change_token, refund_token, locked_to, payout_pending}, error?, key?}
```

`credited` is the exact amount, in whole units of `unit`, added to the balance so far.

| Endpoint | Body | Result |
| - | - | - |
| `GET /v1/wallet/fund/methods` | | What the funding mint and config allow: `storage` and `balance_max` (the memory-storage cap, or `null`), Lightning units and limits, on-chain minimum and confirmations, other-mint limits |
| `POST /v1/wallet/fund/lightning` | `{amount, unit, invite?}` | `request` is a bolt11 invoice from the funding mint; `state` goes `pending` -> `minting` -> `done` (or `expired`) |
| `POST /v1/wallet/fund/onchain` | `{invite?}` | `request` is a bitcoin address (sat only). Each deposit the mint counts as paid is minted and credited; the address is watched for `BELLOWS_ONCHAIN_WATCH_DAYS` |
| `GET /v1/wallet/fund/mints` | | Other mints accepted for funding: `{enabled, policy, mints: [{url, name?, reviewers?, source: "discovered"\|"operator"}], updated_at}`. Denied mints are never listed. `GET /v1/wallet/fund/methods` carries the same URLs as `foreign.mints` |
| `POST /v1/wallet/fund/foreign/quote` | `{token, unit, invite?, pubkey?}` | Prices a token from another mint: `foreign.credit` is what the balance gets, `foreign.fee_max` the most the token's mint can keep. Nothing is spent yet. A token from an accepted mint gets `use_topup`; one from a denied mint, or any mint the policy does not accept while `BELLOWS_FOREIGN_UNLISTED=false`, gets `mint_not_allowed`. Otherwise an unaccepted mint gets 409 `mint_unlisted` until the request carries `accept_unlisted: true` |
| `POST /v1/wallet/fund/foreign/confirm` | `{id, token, pubkey?}` + bearer | Receives the token at its mint, melts it to pay the funding mint's invoice, mints and credits `credit`. Unused fee reserve comes back as `foreign.change_token`; if the melt cannot go through, the token's value comes back as `foreign.refund_token` (state `refunded`). With `pubkey` (here or at quote) both are locked to it; `payout_pending` is true until the locking swap at the token's mint is done, and polling the status finishes it |
| `GET /v1/wallet/fund/{id}` | bearer | Status; polling also moves the funding forward |
| `GET /v1/wallet/fund` | bearer | Recent fundings of this balance |

Fedimint eCash is not accepted yet; see [docs/PAYMENTS.md](docs/PAYMENTS.md#not-yet-fedimint).

### Locking tokens to your wallet key

Every token the gateway hands back (NUT-24 change, refunds, other-mint change and refunds) is by default ordinary eCash made from the gateway's seed, so until you redeem it the gateway could spend it too. Give a public key and the token is P2PK-locked to it (NUT-11, plain lock, no timelock or refund key): only the wallet holding the private key can redeem it, and the gateway cannot spend it at all.

- NUT-24: `X-Cashu-Pubkey` request header. Refunds: `"pubkey"` in the body. Other-mint funding: `"pubkey"` at quote or confirm.
- Accepted forms: a 33-byte compressed key in hex (`02...`/`03...`, 66 characters; cashu.me shows it as "P2PK Key" under Receive > eCash, and in Settings > P2PK), an `npub1...`, or a 64-hex x-only key. The last two become `"02" + x`, the convention cashu.me, Minibits and cashu-ts use for nostr keys. Anything else, including a point not on secp256k1 or an uncompressed key, is `400 invalid_pubkey` before any eCash moves.
- Redeem with any NUT-11 wallet that holds the key (cashu-ts: `wallet.receive(token, { privkey })`; `examples/agent-pays.ts` shows it with `CASHU_PUBKEY=generate`).
- A token locked to a key you do not hold is lost. Nobody, including the operator, can unlock it.

### Other

- `GET /healthz`: liveness, current BTC/USD rate and age.
- `GET /v1/pow`: a proof-of-work challenge (see [Proof of work for a new balance](#proof-of-work-for-a-new-balance)).
- `GET /.well-known/bellows`: this Bellows' attested identity (see [Attested identity](#attested-identity)). `503 not_attested` until the first attestation succeeds.
- `POST /ohttp`, `GET /ohttp-keys`: the Oblivious HTTP gateway and its key configuration (see [Oblivious HTTP](#oblivious-http)).
- `GET /attestation`, `GET /.well-known/hpke-keys`: Tinfoil attestation bundle and HPKE key config of the model enclaves, proxied so browser clients can verify and encrypt through the gateway's origin.

### Errors

OpenAI-style `{"error": {"message", "type", "code"}}`. Payment problems: `untrusted_mint`, `wrong_unit`, `insufficient_amount`, `token_spent`, `invalid_token`, `invalid_pubkey` (400, per NUT-24); `payout_unknown` (503: a locked payout whose outcome the mint has not confirmed; it stays owed and is never paid twice); `insufficient_balance` (402); `invite_required`, `invite_used` (403); `pow_required` (428); `rate_limited` (429); `mint_unavailable` (503, retry with the same token: a NUT-24 retry is served once from the recovered payment, or fetch the failed request's change to get the payment back). Topups and funding under memory storage add `balance_limit` (400). Funding adds `method_unavailable`, `invalid_amount`, `use_topup`, `mint_not_allowed`, `amount_too_large`, `token_mismatch`, `foreign_mint_error` (400), `quote_expired` (409) and `too_many_pending` (429). Upstream failures charge nothing and return all NUT-24 change.

## Admin API

`/admin/api/*` is the operator API. It is off (every `/admin` path answers 404) until the secrets source holds `BELLOWS_ADMIN_TOKEN`, a random token you generate, or `BELLOWS_ADMIN_TOKEN_HASH`, its SHA-256 in hex. `secrets.example.json` ships with the token empty, so the admin API stays off until you fill it in. Bellows refuses a token shorter than 16 characters or with spaces in it, so placeholder text cannot turn the API on. It cannot check a token it receives only as a hash, so always generate the token this way:

```sh
TOKEN=$(openssl rand -hex 32)
printf %s "$TOKEN" | shasum -a 256
```

Send the token as `X-Bellows-Admin-Token: <token>` (or `Authorization: Bearer <token>`). A missing or wrong token gets 401, and failed logins share one budget of 10 a minute, separate from the operator's own, so they cannot lock the operator out. Every request other than GET needs a same-origin `Origin` header (or `BELLOWS_ADMIN_ORIGIN`) and a JSON body. The admin API sends no CORS headers.

Where it is reachable depends on the deployment:

- **Self-hosted.** Keep `/admin` off the public internet: a private network, or a proxy with its own authentication in front of it.
- **Sealed (the Tinfoil deploy kit).** TLS ends inside the sealed machine, so no proxy of yours can sit in front of `/admin`. The kit's shim serves `/admin/api` at the same public origin as the client API, and the token is its only protection, together with the failed-login budget. Generate the token with `openssl rand -hex 32` and keep it in a password manager. If you do not need the admin API, remove `/admin/api` and `/admin/api/*` from the shim's `paths` in `tinfoil-config.yml`; every `/admin` path then stops at the shim, and you can add them back in a later release.

Every answer is an aggregate. There is no listing of balances, fundings or requests.

| Endpoint | What it does |
| - | - |
| `GET /admin/api/overview` | Revenue, total customer balances and how many there are, wallet holdings, owed payouts, activity by model, tier and supplier (today, 7 and 30 days, from the daily aggregates), funding counts by method and state, health |
| `POST /admin/api/export/preview`, `POST /admin/api/export` | Sweep revenue as an eCash token, optionally P2PK-locked; the second call confirms the exact amount, mint and key shown by the first |
| `GET /admin/api/exports`, `POST /admin/api/exports/{id}/finish` | Export history; finish an export that was interrupted |
| `GET`, `POST /admin/api/invites`, `POST /admin/api/invites/{id}/revoke` | List, create (codes shown once) and revoke invites. The list never says which balance redeemed an invite |
| `POST /admin/api/accounts/{id}/freeze` | Freeze spending on a balance whose id its owner gave you, for example after a lost key (refunds still work) |
| `POST /admin/api/fundings/{id}/recheck` | Re-check one funding by id (within the shared quote-check budget) |
| `GET /admin/api/costs` | Supplier cost and margin per model over whole UTC days, with per-million prices fitted to the supplier's reported costs |
| `GET /admin/api/mints/discovery`, `POST .../refresh`, `POST`/`DELETE /admin/api/mints/allowed` | Other-mint discovery and the operator's own list |
| `GET /admin/api/settings` | Read-only view of the configuration in force |

Every admin action is logged as `admin_action` with counts and amounts only. Tokens, invite codes and keys are never logged.

## Admin CLI

Runs against the database directly, on the gateway host or inside the container (`docker exec bellows node src/admin.ts ...`).

```sh
pnpm admin invites:create [--count N] [--label TEXT]   # codes shown once, stored hashed
pnpm admin invites:list
pnpm admin invites:revoke <invite-id|code>
pnpm admin balances:show                               # totals per unit; there is no per-balance listing
pnpm admin revenue:show                                # wallet holdings vs customer balances and owed payouts
pnpm admin revenue:export --unit usd [--mint URL] [--amount N]   # sweep revenue as an eCash token
pnpm admin prices:show [--unit sat]
```

`revenue:export` never exports eCash that backs customer balances or unpaid change. Exports are recorded in `revenue_exports` (amount, lock, token hash; never the token).

## Logs and privacy

Logs are JSON lines with request id, model, supplier, token counts, cost, status and latency. Prompt and completion content is never logged or stored. See [docs/PRIVACY.md](docs/PRIVACY.md).

### Blind by default

Nothing that identifies a client is stored, logged or shown:

- Bellows never reads a client's network address, user agent, referrer or forwarded-for value, so none can reach the logs, the database or an error. `test/unit/blind.test.ts` fails if the source reads one; `test/e2e/blind.e2e.test.ts` sends all of them with every request and fails if any shows up in a log line, a response, a database row or the raw database files.
- Rate limits key on the balance where the key is known, and on one shared budget otherwise. Opening a new balance takes proof of work instead of a per-address limit.
- A request leaves no row of its own once it settles. Billing keeps daily aggregates per model and supplier (`usage_daily`: counts, tokens, charged amount, any shortfall of a late charge, price and supplier cost). A NUT-24 request has an in-flight row until it settles, so a crash can still return the payment as change; a balance request has none (its reservation is deleted at settlement), and charges write no ledger row.
- The admin API and CLI show aggregates only. A balance is a random key's hash and its amount, tied to nothing else: once funded, it is no longer linked to the invite that opened it.

What this does not hide: the host and its network still see client addresses, and so does a reverse proxy that logs them. Sending through an Oblivious HTTP relay run by someone else, or Tor, hides them ([docs/OHTTP.md](docs/OHTTP.md)). Funding records (`fundings`) still keep the balance id, the invoice or address and the amounts, so the client can poll them and recovery can finish them. See [docs/DESIGN.md](docs/DESIGN.md).

## Tests

```sh
pnpm typecheck            # also typechecks client/ and the relay against Web APIs only
pnpm test                 # unit tests
pnpm builds:check         # checks builds.json
pnpm deploy:check         # checks tinfoil-config.yml and the two templates in deploy/ (--release checks tinfoil-config.yml for a release)
pnpm announce --help      # signs and publishes the operator announcement (docs/OPERATORS.md)
pnpm mint:up && pnpm test:e2e && pnpm mint:down    # end to end against real local Nutshell mints
pnpm test:live            # optional; needs TOKENFACTORY_API_KEY (read from .env if present)
```

CI (`.github/workflows/ci.yml`) runs all of these except the announcement and the live tests on every pull request and every push to `main`, read-only and without credentials.

Set `BELLOWS_TEST_LOGS=1` to see the gateway's logs while tests run.

`docker-compose.test.yml` runs three FakeWallet mints: `mint-a` (the gateway's own mint in tests), `mint-b` (an untrusted mint) and `mint-c` (a "foreign" mint with input fees, for other-mint funding). On-chain funding is tested against `test/e2e/onchain-mock.ts`, a NUT-30 proxy over `mint-a` that follows the request and response shapes of a Nutshell branch with NUT-30.

`test/unit/standalone.test.ts` checks that no page or static file is served, that the waitlist is gone, that every client route still exists and that NUT-18 requests carry the service name. `test/unit/config.test.ts` checks the `BELLOWS_*` names, that startup refuses to run while any old `FORGE_*` name is set, and the defaults. `test/unit/forge-db.test.ts` checks that startup refuses to create a new database next to an existing `forge.db`.

`test/unit/sealed-state.test.ts` checks the secrets file (mode 0600, content never echoed), that secrets set in the environment are refused by name, supplier and admin keys from the secrets source, the HKDF wallet seed against a test vector computed outside Node, a stored seed kept in use with a warning, a changed seed refused, sealed mode refusing a database off the named mounts (elsewhere, in memory, on a mount nested inside, through a symlink), and a startup line that names the mode and never a secret. `test/e2e/sealed-state.e2e.test.ts` tops up against a local mint, recovers the gateway's eCash from the mint with NUT-09 restore using only the wallet secret, and checks that neither the secret nor the seed appears in the database files or the logs. In the e2e suite each gateway reads its secrets from `secrets.json` next to its database, as a development install does.

`test/unit/attestation.test.ts` checks the RFC 9458 key configuration, the dev attester and its verifier (another binding, a changed payload, a bad signature and an untrusted key refused), the Tinfoil REPORT_DATA derivation against the vector published with Tinfoil's verifier, the Tinfoil binding checks and the attester against a stand-in socket, the identity document's refresh and failure handling, the `builds.json` checker, and `verifyBellows` refusing development attestations without opt-in, unapproved builds, false claims and statements changed in transit, and reading `storage` and the memory balance cap from the statement. `test/unit/storage.test.ts` checks `BELLOWS_STORAGE`: the sealed-mode mount check, the boot warning, and that memory storage refuses to start without invite-only or with on-chain funding, with its balance cap per unit. It also checks that `client/` imports no Node module. `test/e2e/identity.e2e.test.ts` verifies a running Bellows over HTTP with the dev attester and with the Tinfoil attester against a stand-in socket, and checks that the private key appears in neither the document nor the logs.

`test/unit/ohttp.test.ts` checks that `/ohttp-keys` serves the attested key, round trips in both OHTTP modes, a chunked answer arriving piece by piece, and the refusal of tampered, replayed (a topup among them), stale, undated, cut-short and misdirected requests, with the client retrying once on the gateway's clock, and that a refused request never takes a place in the replay cache, a flood at the admission bound never fills it, and a clock stepping back does not shut new requests out. It also checks that the app receives none of the outer request. `test/unit/relay.test.ts` checks the relay's allowlist, that it forwards only the body and its content type, passes on a busy gateway's `Retry-After`, its refusals, that it writes nothing, the Worker entry point, and the Node server with the gateway seeing the relay's address only. `test/e2e/ohttp.e2e.test.ts` runs client, relay and Bellows against the local mints: topup, chat, streamed chat, a NUT-24 payment and a refund through the relay, with the relay's bytes holding none of the content, the Bellows never receiving the client's address or headers, and a replayed topup crediting nothing.

`test/unit/deploy.test.ts` checks the deploy kit: that no container but `bellows` may request attestations, receive secrets or mount Bellows' volume, in `tinfoil-config.yml` and in both templates in `deploy/`, every other rule `pnpm deploy:check` enforces (each one with a config that breaks it), that a release refuses example values and placeholder digests, that the release workflow's own pin step leaves an operator's edited config, plain or onion, ready for a release, that a copy of the repository as an operator has it (their config, their builds in `builds.json`) passes the unit suite, that the onion template is the plain template plus the sidecar, that Bellows starts in sealed mode from the measured env with secrets from the platform, that the egress allowlist covers every mint, supplier, price source and Nostr relay the config uses, that the shim exposes every route, image pinning, reading a measured release into `builds.json`, the keyserver policy example, the Dockerfiles (pinned bases, numeric non-root users, no package manager) the release workflows (builds proposed by pull request), the CI workflow (read-only, no credentials, the same checks as a release) and, for every workflow, actions pinned by commit and no default permissions.

`test/unit/operators.test.ts` checks operator announcements (signing, every refusal, newest wins, Nostr relays against a stand-in), the publishing command (hidden prompt, the key never printed), startup refusing an announcement that does not match the configuration, and the operator pool against Bellows instances in the same process (verify, health, pick, remember, failover, routes). `test/e2e/operators.e2e.test.ts` runs three Bellows against the local mints, moves a balance from one to another (passing over one that takes another mint, solving proof of work at the next) and fails over when operators go down.

`test/e2e/forge-ai-fit.e2e.test.ts` runs the Forge AI clients' calls, copied without change in `test/e2e/forge-ai-client.ts`, against a Bellows set up as Forge AI runs it, once directly and once through Oblivious HTTP: models, funding methods, a topup and its replay, a pasted key, Lightning, other-mint funding with change, on-chain funding against the mock, streamed chat with reasoning, encrypted pass-through, plain and locked refunds, history, an empty balance, an unknown key, and the agent example paying per request with plain and locked change. Through OHTTP it checks that the Bellows received nothing but `POST /ohttp`. It also checks the CORS headers a web app on another origin needs, and that an app that predates proof of work cannot open a balance while everything on an existing key works.

The admin tests (`test/unit/admin.test.ts`, `test/e2e/admin.e2e.test.ts`) cover access control (404 when off, no page, 401 on a missing or wrong token, failed-login limit that never locks out the right token, Origin and JSON checks, no CORS), no per-balance, per-funding or per-request listing, invites and revoke, freeze (spending blocked, refunds allowed), revenue export (never above sweepable, locked export redeemable only with the key, history with token hash and no token, crash after the swap finished once by recovery) and overview numbers against the balances and the daily aggregates.

The e2e suite covers the 402 flow with change, sat pricing, topup, spend, refund, wrong mint, wrong unit, double spend, client disconnect mid-stream, upstream failure and retries, flat pricing, invites off by default and the optional invite gate, crash recovery (both NUT-19 replay and NUT-09 restore), a NUT-24 payment interrupted mid-receive and settled in the same process (a retry with the same token served once, or the whole payment back from the change URL), P2PK-locked change and refunds (locked to the key: a plain wallet and the gateway's own wallet cannot redeem them, the key holder can; invalid keys 400; crash after a locked swap recovered by replay, by NUT-09 restore of the stored blinded messages, and left owed when neither answers), funding by Lightning (quote, paid, minted, credited; restart mid-quote; crash after the mint with replay and with restore; concurrent polls credit once), by other-mint eCash (fees shown, credit exact, change returned, cross-unit, crash after the swap and after the melt, refund when the melt no longer fits, quote expiry frees the invite, deny list, plain-http mints refused) and on-chain against the mock (NUT-20 locked quotes, repeated deposits, crash after the mint), the memory-storage balance cap (`test/e2e/memory-cap.e2e.test.ts`: a topup, Lightning quote or other-mint quote past it refused with the token left unspent, two topups at once never passing it together, an open invoice or an unsettled topup holding its room, and the retry of an unsettled topup credited), EHBP pass-through against a fake enclave (usage from header and from HTTP trailer), and file text in messages never reaching the logs or the database.

## License

MIT. See [LICENSE](LICENSE).
