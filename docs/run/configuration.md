# Configuration reference

Every setting a Bellows reads, where its secrets come from, how it picks which other mints to accept, and the model catalog. Settings are environment variables, checked with zod at startup (`src/config.ts`). Secrets are never environment variables: they come from one secrets source ([Secrets and sealed state](#secrets-and-sealed-state)).

`.env.example` lists the common settings with comments. Copy it to `.env` when you run Bellows in Docker ([Running a Bellows on your own server](self-hosted.md)). In a sealed deployment, every setting is a literal in the measured `tinfoil-config.yml` ([sealed deployment guide](sealed-deployment.md)).

## Environment variables

| Variable | Default | Meaning |
| - | - | - |
| `BELLOWS_TRUSTED_MINTS` | required | Comma-separated mints whose eCash is accepted. Tokens from other mints get HTTP 400. There is no built-in mint |
| `BELLOWS_MINT_ALIASES` | none | Other addresses of the same mint, as comma-separated `alias=main` pairs. Tokens under an alias are accepted and stored under the main address, so the wallet keeps one counter per keyset |
| `BELLOWS_UNITS` | `usd,sat` | Accepted units |
| `BELLOWS_DEFAULT_UNIT` | `sat` | Unit of a call that names none: a 402 quote without `X-Forge-Unit`, and a Lightning or other-mint funding without `unit`. It must be one of `BELLOWS_UNITS`, so an engine without `sat` sets it to `usd` |
| `BELLOWS_INVITE_ONLY` | `false` | Optional gate: require an invite code to open a balance or pay per request |
| `BELLOWS_SERVICE_NAME` | `Bellows` | Name in NUT-18 payment requests (`<name>: <model>`) |
| `BELLOWS_MARKUP` | `1.25` | Multiplier on supplier cost, at least 1. `1` charges the supplier's cost with no margin, as the reference instance does ([Prices](#prices)) |
| `BELLOWS_SERVE_UNVERIFIED_PRICES` | `false` | Serve models whose catalog price has `price_verified: false`. Off, they are neither listed nor routable, whatever supplier keys are present. On, startup logs them at error level. See [Model catalog](#model-catalog) |
| `BELLOWS_MODELS_FILE` | `config/models.json` | Supplier and model catalog |
| `PORT` | `8787` | Port the API listens on |
| `HOST` | `0.0.0.0` | Address the API listens on |
| `BELLOWS_DB_PATH` | `data/bellows.db` | SQLite ledger and wallet state. In sealed mode it must be on a mount in `BELLOWS_SEALED_MOUNTS` |
| `BELLOWS_MODE` | `development` | `development` or `sealed`. See [Secrets and sealed state](#secrets-and-sealed-state) |
| `BELLOWS_SECRETS` | `file` in development, `platform` in sealed mode | Where secrets come from |
| `BELLOWS_SECRETS_FILE` | `secrets.json` next to the database | The secrets file, for the `file` source |
| `BELLOWS_SEALED_MOUNTS` | none | Comma-separated mount points of the encrypted volume. Required in sealed mode |
| `BELLOWS_RATE_SOURCES` | `coinbase,kraken,bitstamp` | BTC/USD sources (also `coingecko`); add one by implementing `RateSource` in `src/rates.ts` |
| `BELLOWS_RATE_MIN_SOURCES` | `2` | Sources that must answer for a rate to be used |
| `BELLOWS_RATE_TTL_SECONDS` / `BELLOWS_RATE_MAX_STALE_SECONDS` | `60` / `900` | Cache time; after max staleness sat pricing returns 503 instead of guessing |
| `BELLOWS_SAT_PRICE_BUFFER` | `1.02` | Headroom on sat 402 amounts so a rate move between quote and payment does not reject the token |
| `BELLOWS_BYTES_PER_TOKEN` | `2` | Conservative bytes per input token used to size the reservation |
| `BELLOWS_RATE_LIMIT_RPM` | `60` | Requests per minute per balance key |
| `BELLOWS_ANON_RATE_LIMIT_RPM` | `600` | Requests per minute shared by every request without a known balance key (NUT-24 payments and 402 asks) |
| `BELLOWS_POW_BITS` | `16` | Proof of work a request needs to open a new balance, in leading zero bits of SHA-256 (16 is about 65,000 hashes). `0` turns it off; those requests then share the anonymous budget |
| `BELLOWS_MAX_BODY_BYTES` | `1000000` | Request size limit |
| `BELLOWS_MAX_TOKEN_BYTES` | `64000` | Largest eCash token accepted, in bytes ([Accepting a token](../how-it-works/payments.md#accepting-a-token)) |
| `BELLOWS_UPSTREAM_TIMEOUT_MS` / `BELLOWS_UPSTREAM_RETRIES` | `180000` / `2` | Time to upstream response headers (a timeout is final); retries on connection errors, 408, 429 and 5xx |
| `BELLOWS_STALE_RESERVATION_SECONDS` | `900` | Age after which the periodic sweep releases, without charge, a reservation that no running request holds ([Reservations](../how-it-works/payments.md#reservations)) |
| `BELLOWS_FUND_MINT` | first trusted mint | Mint used for Lightning, on-chain and other-mint funding |
| `BELLOWS_LIGHTNING_ENABLED` | `true` | Lightning funding (NUT-04 bolt11 quotes) |
| `BELLOWS_FUND_MAX_SAT` / `BELLOWS_FUND_MAX_USD` | `1000000` / `50000` | Largest Lightning funding, in sat / cents (the mint's own limit also applies) |
| `BELLOWS_MINT_QUOTE_CHECKS_PER_MIN` | `12` | Mint quote checks per minute, shared by all fundings, because the gateway's one address shares the mint's rate limit ([Checking quotes](../how-it-works/payments.md#checking-quotes-without-tripping-the-mints-rate-limit)) |
| `BELLOWS_ONCHAIN_ENABLED` | `false` | On-chain funding (NUT-30). Leave off until tested against your funding mint |
| `BELLOWS_ONCHAIN_CONFIRMATIONS` | `3` | Confirmations shown to users; the mint decides when a deposit is paid |
| `BELLOWS_ONCHAIN_WATCH_DAYS` | `30` | How long an on-chain address is watched for deposits |
| `BELLOWS_ESPLORA_URL` | unset | Optional Esplora API used to show unconfirmed deposits. Unset: the gateway asks only the mint |
| `BELLOWS_FOREIGN_ENABLED` | `true` | Accept eCash from other mints (melted into a Lightning quote at the funding mint) |
| `BELLOWS_FOREIGN_POLICY` | `discovered` | Which other mints are accepted. `discovered`: the operator list (`BELLOWS_FOREIGN_ALLOW` and mints added through the admin API) plus mints found through NIP-87 reviews ([below](#other-mints-nip-87-discovery)). `allowlist`: the operator list only. `any`: every https mint, limited to `BELLOWS_FOREIGN_ALLOW` when that is set. `BELLOWS_FOREIGN_DENY` always wins |
| `BELLOWS_FOREIGN_ALLOW` / `BELLOWS_FOREIGN_DENY` | empty | Operator list of accepted mints (the admin API can add more), and mints never accepted |
| `BELLOWS_FOREIGN_UNLISTED` | `true` | Under `discovered` and `allowlist`, let a customer fund from a mint that is not accepted after a warning (`mint_unlisted`, then `accept_unlisted: true`), with the lower cap below. `false`: such mints get `mint_not_allowed` |
| `BELLOWS_FOREIGN_UNLISTED_MAX_SAT` / `BELLOWS_FOREIGN_UNLISTED_MAX_USD` | `5000` / `500` | Largest token from an unlisted mint, in sat / cents. The other-mint cap still applies when lower |
| `BELLOWS_FOREIGN_MIN_REVIEWERS` | `2` | Distinct verified NIP-87 reviewers a discovered mint needs |
| `BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT` | `false` | Also require the mint's own verified kind 38172 announcement (few mints publish one today) |
| `BELLOWS_FOREIGN_DISCOVERY_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` | Nostr relays read for mint announcements (kind 38172) and reviews (kind 38000). Empty: no discovery |
| `BELLOWS_FOREIGN_DISCOVERY_TTL_MINUTES` | `60` | How long a discovered list is served before a background refresh (a failed refresh retries after a minute) |
| `BELLOWS_FOREIGN_MAX_DISCOVERED` | `25` | Most discovered mints accepted at once, best reviewed first |
| `BELLOWS_FOREIGN_MAX_SAT` / `BELLOWS_FOREIGN_MAX_USD` | `100000` / `5000` | Largest token from another mint, in sat / cents |
| `BELLOWS_FOREIGN_ALLOW_INSECURE` | `false` | For tests only: accept other mints over plain http and on private addresses |
| `BELLOWS_FUND_MAX_PENDING` | `5` | Unfinished fundings per balance |
| `BELLOWS_ADMIN_ORIGIN` | request `Host` | Origin admin changes must come from |
| `BELLOWS_ADMIN_RATE_LIMIT_RPM` | `120` | Admin API requests per minute with the right token (failed logins have their own budget of 10 a minute) |
| `BELLOWS_TINFOIL_ADMIN_URL` | `https://api.tinfoil.sh` | The Tinfoil API that `TINFOIL_ADMIN_KEY` is used with, for the credit figures in `GET /admin/api/overview` |
| `BELLOWS_TINFOIL_OPENING_CREDIT_USD` | `5` | The credit Tinfoil granted at sign-up, which its transaction history does not list. The overview adds it when it works out the credit left |
| `BELLOWS_TINFOIL_LOW_USD` | `1` | Tinfoil credit left, in USD, below which the overview marks it as low |
| `BELLOWS_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `BELLOWS_LOG_SILENT` | unset | `1` writes no log lines |
| `BELLOWS_ATTESTER` | `dev` in development, `tinfoil` in sealed mode | Who attests `/.well-known/bellows`. `dev` is a stand-in clients refuse unless they opt into development mode; sealed mode refuses it. See [Attested identity](../verify/attestation.md) |
| `BELLOWS_TINFOIL_ATTESTATION_SOCKET` | `/tinfoil/attestation.sock` | The Tinfoil attestation socket (`attestation: true` on the container in `tinfoil-config.yml`) |
| `BELLOWS_ATTEST_REFRESH_MINUTES` | `360` | Make the attestation again after this long |
| `BELLOWS_DEV_MEASUREMENT` | fixed default | `dev` attester only: the development measurement's one register (64 lowercase hex) |
| `BELLOWS_BUILD_MEASUREMENT` | unset | Hardware attesters: the measurement this build claims, as JSON `{"type": ..., "registers": [...]}` from `builds.json` |
| `BELLOWS_RELAYS` | none | Comma-separated Oblivious HTTP relay URLs published in `/.well-known/bellows`: each the full URL a client posts to, for example `https://relay.example/relay/bellows.example` |
| `BELLOWS_OHTTP_MAX_SKEW_SECONDS` | `300` | How far an encapsulated request's date may be from this clock; also how long its key is remembered to refuse replays |
| `BELLOWS_OHTTP_REPLAY_CACHE_MAX` | `200000` | Most encapsulated keys remembered at once; past this `/ohttp` answers 503 |
| `BELLOWS_OHTTP_ADMIT_PER_SECOND` | the most the replay cache holds (about 332) | New encapsulated requests admitted per second, for all clients together; past this `/ohttp` answers 503 with `Retry-After`. Unset, the replay cache cannot fill; a value that could fill it is refused at startup ([Admission](../how-it-works/ohttp.md#admission)) |
| `BELLOWS_OHTTP_MAX_MESSAGE_BYTES` | `8388608` | Largest Binary HTTP request, and largest plain (not chunked) answer, in one OHTTP exchange. Chunked answers stream and are bounded at 1 GiB. A client in plain mode must accept at least this much ([Size limits](../how-it-works/ohttp.md#size-limits)) |
| `BELLOWS_OPERATOR_ANNOUNCEMENT_FILE` | unset | The signed operator announcement (`pnpm announce --out`), published in `/.well-known/bellows`. Startup refuses one that is unsigned or does not match the relays, version, measurement, units and mints configured here ([Operators](../use/operators.md)) |
| `BELLOWS_OPERATOR_ANNOUNCEMENT` | unset | The same announcement as JSON text, instead of the file. A sealed deployment gets it from the keyserver with the secrets, because the operator cannot write to the encrypted volume ([sealed deployment guide](sealed-deployment.md)). Set this or the file, not both |

## Secrets and sealed state

Every secret comes from one secrets source. None is read from an environment variable, and startup refuses to run while one is set there.

| Secret | Meaning |
| - | - |
| `BELLOWS_WALLET_SECRET` | At least 32 random bytes as hex (`openssl rand -hex 32`). The wallet seed for deterministic eCash outputs (NUT-13) is derived from it with HKDF-SHA256 and never stored, so a restored volume and a fresh one agree on the seed |
| `BELLOWS_ADMIN_TOKEN` or `BELLOWS_ADMIN_TOKEN_HASH` | The admin token (a random string of at least 16 characters, no spaces), or its SHA-256 in hex. Bellows cannot check the strength of a token it only has the hash of, so generate the token with `openssl rand -hex 32`. Neither, or an empty value: `/admin` answers 404. See [Admin API](admin.md#admin-api) |
| Supplier keys, such as `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY` | The names come from `apiKeySecret` in the model catalog. A supplier whose key is missing is left out with its models |
| `TINFOIL_ADMIN_KEY` | Optional Tinfoil admin key, for the credit figures in `GET /admin/api/overview` |
| `BELLOWS_WALLET_SEED` | Only for a database that ran with the old `BELLOWS_WALLET_SEED` variable: that 64-byte hex seed, used as is. Set it or `BELLOWS_WALLET_SECRET`, not both |

Sources (`BELLOWS_SECRETS`):

- `file` (the default in development): a JSON object of name to value, at `BELLOWS_SECRETS_FILE` or `secrets.json` next to the database. `secrets.example.json` shows the shape. Bellows refuses a file other users can read. In development, a new database with no secrets file gets one with a fresh wallet secret; an existing database never does.
- `platform` (the default in sealed mode): the secrets the hosting platform releases to the sealed machine after it has proved which build runs. They reach the process as environment variables set by the platform, not by the deploy config.

Modes (`BELLOWS_MODE`):

- `development` (default): the database and the secrets file can be anywhere. Startup says that nothing is sealed.
- `sealed`: startup refuses to run unless the database, and the secrets file when there is one, resolve (after symlinks) to a mount named in `BELLOWS_SEALED_MOUNTS`, the encrypted volume. The mount table is read from `/proc/self/mountinfo`, so sealed mode runs on Linux. A file system mounted inside the named volume does not count.

The wallet seed in use, in order: `BELLOWS_WALLET_SEED` from the secrets source; a seed an earlier version stored in the database (it stays in use, and startup logs `wallet_seed_stored`); the seed derived from `BELLOWS_WALLET_SECRET`. The database keeps a check value for the seed (an HMAC under it, which reveals nothing about it), and a later start with a different seed is refused: outputs written under one seed cannot be restored under another.

The `startup` log line names the mode, the secrets source and where it reads from, the database path and mount, which seed is in use and whether the admin API is on. It never prints a secret.

## Other mints (NIP-87 discovery)

Under `BELLOWS_FOREIGN_POLICY=discovered` the gateway accepts eCash from the mints the operator lists plus the mints Cashu wallets recommend, found the way wallet.cashu.me finds them: kind 38172 mint announcements and kind 38000 reviews (`#k=38172`) from `BELLOWS_FOREIGN_DISCOVERY_RELAYS`. Event ids and BIP-340 signatures are checked, reviews older than 24 months are ignored, and a reviewer counts once per mint. A mint is accepted when it has at least `BELLOWS_FOREIGN_MIN_REVIEWERS` distinct reviewers (plus a verified mainnet announcement when `BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT=true`) and passes a probe: `GET /v1/info` and `GET /v1/keysets` answer, an active keyset exists in a unit this gateway uses, and NUT-05 bolt11 melt is enabled in that unit (the gateway melts the eCash there). The list is kept in the database, served at once after a restart, and refreshed in the background; a request never waits on a relay. The URL safety check still runs on every accepted mint, and again whenever the gateway loads that mint's wallet; no Cashu request follows a redirect.

The operator can add mints through the admin API (`POST /admin/api/mints/allowed`). An added mint goes through the URL safety check and the same probe, keeps the name from its `/v1/info`, is stored in the `operator_mints` table and is accepted like `BELLOWS_FOREIGN_ALLOW` under every policy (under `any` it never limits the policy). The gateway's own mints and denied mints cannot be added. Both kinds are listed with `source: "operator"`.

A customer can still use a mint that is not on the list (`BELLOWS_FOREIGN_UNLISTED=true`, policy `discovered` or `allowlist`). The first quote answers 409 `mint_unlisted` with `{unlisted: {mint, max: {sat, usd}}}`; a client shows the warning and, if the user agrees, resends the quote with `accept_unlisted: true`. The mint must then pass the live probe (results are cached for 10 minutes, a failure for 1 minute), the token is capped at `BELLOWS_FOREIGN_UNLISTED_MAX_SAT` / `_USD`, and the funding is marked unlisted (`fundings.f_unlisted`, `foreign.unlisted` in the funding view, and counted as `health.fundings_unlisted` in `GET /admin/api/overview`). Denied mints are always refused.

## Model catalog

`config/models.json` lists suppliers and models. Each model has a public `id`, its `supplier`, the `upstream` model name, the supplier's cost in USD per million input and output tokens, `max_output_tokens`, and `uncensored` (clients may hide those behind an explicit opt-in). `price_verified: true` says the cost was checked against the supplier's rate card; it defaults to `false`.

A model whose price is not verified is not served: it is left out of `GET /v1/models` and a request for it gets `404 model_not_found`, even when its supplier's key is in the secrets source. A placeholder price would otherwise overcharge customers or leave you paying the difference. Startup logs `unverified_prices_withheld` with the models it left out, and refuses to start if no verified model is left. To serve them anyway, set `BELLOWS_SERVE_UNVERIFIED_PRICES=true`: startup then logs `unverified_prices_served` at error level, and `/v1/models` shows those models with `pricing.verified: false`. The admin settings (`GET /admin/api/settings`) show them as `unverified_prices`.

Tinfoil prices were read from `https://inference.tinfoil.sh/v1/models` on 2026-11-09. Token Factory prices in the shipped catalog are placeholders marked `price_verified: false`, so those models are not served until you set them from your rate card: on 2026-11-13 Token Factory published no prices that could be checked (its gateway's public model list is empty, and its `/v1/model/info` returned no cost fields on 2026-11-09).

A supplier sets `pricing: "metered"` (charge on reported usage) or `pricing: "flat"` (charge a schedule by request body size plus declared max output). A metered supplier may also carry a `flat` schedule, used only when no usage signal arrives.

`config/models.dev.json` is the catalog for local development. It adds an in-process mock supplier (`mock-echo`, `mock-slow` and others), so everything works without upstream keys. To use the real suppliers in development, add `TOKENFACTORY_API_KEY` and `TINFOIL_API_KEY` to the secrets file (`data/secrets.json` in the [quick start](../../README.md#quick-start)). Token Factory models in the dev catalog are marked `price_verified: false`, so they are served only with `BELLOWS_SERVE_UNVERIFIED_PRICES=true`.

## Prices

A model's price is its supplier's cost in the catalog times `BELLOWS_MARKUP`. The markup defaults to 1.25 for anyone running their own Bellows and cannot be set below 1. Prices are kept in USD; a price in sats is converted at the median BTC/USD rate of the price sources. Each charge is rounded up to the next thousandth of the unit, and a per-request (NUT-24) payment to the next whole unit, because its change is whole eCash units.

The reference instance at `https://bellows.island-bitcoin.containers.tinfoil.dev` sets `BELLOWS_MARKUP` to `1` in its measured [`tinfoil-config.yml`](../../tinfoil-config.yml): it charges the suppliers' cost with no margin, and its operator pays its hosting. Its default unit is `sat`, and it also takes `usd`.

To check what an instance charges, compare two things:

- `GET /v1/models` gives each model's price per million input and output tokens, markup included: `pricing.usd_per_mtok`, and `pricing.sat_per_mtok` at the rate in use. It is public.
- The supplier's cost is `input_usd_per_mtok` and `output_usd_per_mtok` in `config/models.json`, and the markup is `BELLOWS_MARKUP` in `tinfoil-config.yml`, both at the release tag the instance runs. For a sealed instance both are part of the measured build: the catalog is in the image, whose digest the measured config pins.

At markup 1, `pricing.usd_per_mtok` equals the catalog's cost. The operator API also lists cost next to price (`GET /admin/api/settings`), but only for the operator.

## Suppliers

| Supplier | Tier | How |
| - | - | - |
| Token Factory | standard | OpenAI-compatible LiteLLM proxy at `https://gateway.trytokenfactory.dev/v1` |
| Tinfoil | enclave | Plaintext OpenAI-compatible calls, or EHBP encrypted pass-through (see [Privacy](../how-it-works/privacy.md#encrypted-pass-through-tinfoil-ehbp)) |
| mock | standard | In-process, deterministic, for tests and local demos |

Add a supplier by implementing `Supplier` in `src/suppliers/types.ts` (one `chat()` method for OpenAI-compatible upstreams) and registering its `type` in `src/suppliers/index.ts`.
