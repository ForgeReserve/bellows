# Migrating from Forge AI

Bellows is the engine that used to run inside Forge AI, extracted so anyone can run one. A Forge AI deployment can switch to Bellows with the same database. This page lists everything an operator has to change.

## What stays the same

- **The client API.** Every path, request body and response body is the same. The header names keep their `X-Forge-` prefix (`X-Forge-Request-Id`, `X-Forge-Unit`, `X-Forge-Charged-Msub`, `X-Forge-Balance-Msub`, `X-Forge-Change-Url`, `X-Forge-Privacy`, `X-Forge-Invite`), streams still end with `event: forge`, and balance keys still start with `sk-forge-`. One addition: a request that opens a new balance needs proof of work (`428 pow_required`, see the README). A Forge AI app that predates it opens new balances only against a Bellows with `BELLOWS_POW_BITS=0`; everything else works unchanged. `test/e2e/forge-ai-fit.e2e.test.ts` runs the Forge AI web app's calls and its agent example, unchanged, against a Bellows directly and through Oblivious HTTP. [API.md](API.md) lists what changes for an existing client.
- **The database.** Balances, the wallet, fundings, invites and exports carry over. Point `BELLOWS_DB_PATH` at the existing file. On first start Bellows folds the per-request rows into daily aggregates (`usage_daily`) and deletes them, drops the balance id and per-request columns from `requests`, deletes settled reservations and per-request ledger charges, and unlinks funded balances from their invites. Balances do not change. This cannot be undone, so back up the file first.
- **Supplier key names.** `TINFOIL_API_KEY`, `TINFOIL_ADMIN_KEY`, `TOKENFACTORY_API_KEY` and any other supplier key keep their names. They move out of the environment into the secrets source (see [Secrets](#secrets)).
- **The wallet.** A database that stored its wallet seed keeps using it, and startup logs `wallet_seed_stored` to say so. A deployment that set `FORGE_WALLET_SEED` puts that value in the secrets source as `BELLOWS_WALLET_SEED`.
- **Error codes.** Every `code` is the same. Some message texts changed: they say "the funding mint" and "this gateway" where they named Forge.

## Environment variables

Every `FORGE_*` variable is now `BELLOWS_*`. The old names are not read at all: there are no aliases. Startup refuses to run while any `FORGE_*` variable is set, and the error names every one it found. Rename every one.

| Forge AI | Bellows |
| - | - |
| `FORGE_DB_PATH` | `BELLOWS_DB_PATH` |
| `FORGE_MODELS_FILE` | `BELLOWS_MODELS_FILE` |
| `FORGE_TRUSTED_MINTS` | `BELLOWS_TRUSTED_MINTS` |
| `FORGE_MINT_ALIASES` | `BELLOWS_MINT_ALIASES` |
| `FORGE_UNITS` | `BELLOWS_UNITS` |
| `FORGE_DEFAULT_UNIT` | `BELLOWS_DEFAULT_UNIT` |
| `FORGE_INVITE_ONLY` | `BELLOWS_INVITE_ONLY` |
| `FORGE_MARKUP` | `BELLOWS_MARKUP` |
| `FORGE_BYTES_PER_TOKEN` | `BELLOWS_BYTES_PER_TOKEN` |
| `FORGE_RATE_SOURCES` | `BELLOWS_RATE_SOURCES` |
| `FORGE_RATE_MIN_SOURCES` | `BELLOWS_RATE_MIN_SOURCES` |
| `FORGE_RATE_TTL_SECONDS` | `BELLOWS_RATE_TTL_SECONDS` |
| `FORGE_RATE_MAX_STALE_SECONDS` | `BELLOWS_RATE_MAX_STALE_SECONDS` |
| `FORGE_SAT_PRICE_BUFFER` | `BELLOWS_SAT_PRICE_BUFFER` |
| `FORGE_RATE_LIMIT_RPM` | `BELLOWS_RATE_LIMIT_RPM` |
| `FORGE_MAX_BODY_BYTES` | `BELLOWS_MAX_BODY_BYTES` |
| `FORGE_MAX_TOKEN_BYTES` | `BELLOWS_MAX_TOKEN_BYTES` |
| `FORGE_WALLET_SEED` | `BELLOWS_WALLET_SEED`, in the secrets source (not the environment) |
| `FORGE_UPSTREAM_TIMEOUT_MS` | `BELLOWS_UPSTREAM_TIMEOUT_MS` |
| `FORGE_UPSTREAM_RETRIES` | `BELLOWS_UPSTREAM_RETRIES` |
| `FORGE_STALE_RESERVATION_SECONDS` | `BELLOWS_STALE_RESERVATION_SECONDS` |
| `FORGE_FUND_MINT` | `BELLOWS_FUND_MINT` |
| `FORGE_LIGHTNING_ENABLED` | `BELLOWS_LIGHTNING_ENABLED` |
| `FORGE_MINT_QUOTE_CHECKS_PER_MIN` | `BELLOWS_MINT_QUOTE_CHECKS_PER_MIN` |
| `FORGE_TINFOIL_ADMIN_URL` | `BELLOWS_TINFOIL_ADMIN_URL` |
| `FORGE_TINFOIL_OPENING_CREDIT_USD` | `BELLOWS_TINFOIL_OPENING_CREDIT_USD` |
| `FORGE_TINFOIL_LOW_USD` | `BELLOWS_TINFOIL_LOW_USD` |
| `FORGE_FUND_MAX_SAT` | `BELLOWS_FUND_MAX_SAT` |
| `FORGE_FUND_MAX_USD` | `BELLOWS_FUND_MAX_USD` |
| `FORGE_ONCHAIN_ENABLED` | `BELLOWS_ONCHAIN_ENABLED` |
| `FORGE_ONCHAIN_CONFIRMATIONS` | `BELLOWS_ONCHAIN_CONFIRMATIONS` |
| `FORGE_ONCHAIN_WATCH_DAYS` | `BELLOWS_ONCHAIN_WATCH_DAYS` |
| `FORGE_ESPLORA_URL` | `BELLOWS_ESPLORA_URL` |
| `FORGE_FOREIGN_ENABLED` | `BELLOWS_FOREIGN_ENABLED` |
| `FORGE_FOREIGN_ALLOW` | `BELLOWS_FOREIGN_ALLOW` |
| `FORGE_FOREIGN_DENY` | `BELLOWS_FOREIGN_DENY` |
| `FORGE_FOREIGN_MAX_SAT` | `BELLOWS_FOREIGN_MAX_SAT` |
| `FORGE_FOREIGN_MAX_USD` | `BELLOWS_FOREIGN_MAX_USD` |
| `FORGE_FOREIGN_ALLOW_INSECURE` | `BELLOWS_FOREIGN_ALLOW_INSECURE` |
| `FORGE_FOREIGN_POLICY` | `BELLOWS_FOREIGN_POLICY` |
| `FORGE_FOREIGN_UNLISTED` | `BELLOWS_FOREIGN_UNLISTED` |
| `FORGE_FOREIGN_UNLISTED_MAX_SAT` | `BELLOWS_FOREIGN_UNLISTED_MAX_SAT` |
| `FORGE_FOREIGN_UNLISTED_MAX_USD` | `BELLOWS_FOREIGN_UNLISTED_MAX_USD` |
| `FORGE_FOREIGN_MIN_REVIEWERS` | `BELLOWS_FOREIGN_MIN_REVIEWERS` |
| `FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT` | `BELLOWS_FOREIGN_REQUIRE_ANNOUNCEMENT` |
| `FORGE_FOREIGN_DISCOVERY_RELAYS` | `BELLOWS_FOREIGN_DISCOVERY_RELAYS` |
| `FORGE_FOREIGN_DISCOVERY_TTL_MINUTES` | `BELLOWS_FOREIGN_DISCOVERY_TTL_MINUTES` |
| `FORGE_FOREIGN_MAX_DISCOVERED` | `BELLOWS_FOREIGN_MAX_DISCOVERED` |
| `FORGE_FUND_MAX_PENDING` | `BELLOWS_FUND_MAX_PENDING` |
| `FORGE_LOG_LEVEL` | `BELLOWS_LOG_LEVEL` |
| `FORGE_ADMIN_TOKEN_HASH` | `BELLOWS_ADMIN_TOKEN_HASH`, in the secrets source (not the environment) |
| `FORGE_ADMIN_ORIGIN` | `BELLOWS_ADMIN_ORIGIN` |
| `FORGE_ADMIN_RATE_LIMIT_RPM` | `BELLOWS_ADMIN_RATE_LIMIT_RPM` |
| `FORGE_LOG_SILENT` | `BELLOWS_LOG_SILENT` |

Removed, with no replacement in the engine:

| Forge AI | Why |
| - | - |
| `FORGE_ADMIN_BASIC_AUTH_USER`, `FORGE_ADMIN_BASIC_AUTH_HASH` | Read only by the Forge AI reverse proxy configuration, never by the engine |
| `FORGE_TRUST_PROXY` | Bellows never reads a client address, so there is no forwarded-for header to trust. Rate limits key on the balance key, or on one shared budget |

New:

| Variable | Default | Meaning |
| - | - | - |
| `BELLOWS_SERVICE_NAME` | `Bellows` | Name in NUT-18 payment requests (`<name>: <model>`). Set `BELLOWS_SERVICE_NAME="Forge AI"` to keep the old text |
| `BELLOWS_ANON_RATE_LIMIT_RPM` | `600` | Requests per minute shared by every request without a known balance key |
| `BELLOWS_POW_BITS` | `16` | Proof of work to open a new balance; `0` turns it off |
| `BELLOWS_MODE` | `development` | `sealed` refuses a database that is not on the encrypted volume |
| `BELLOWS_SECRETS`, `BELLOWS_SECRETS_FILE` | `file`, `secrets.json` next to the database | Where secrets come from |
| `BELLOWS_SEALED_MOUNTS` | none | Mount points of the encrypted volume, for sealed mode |

## Secrets

Bellows reads no secret from the environment, and startup refuses to run while one is set there (the error names the variable, never its value). Move each into the secrets source: in development and on a plain host, a JSON file of name to value with mode 0600, by default `secrets.json` next to the database (`/data/secrets.json` in the image). The README section "Secrets and sealed state" has the details.

| In the environment before | In the secrets source now |
| - | - |
| `FORGE_WALLET_SEED` | `BELLOWS_WALLET_SEED` (only if you set it; a seed stored in the database needs nothing) |
| `FORGE_ADMIN_TOKEN_HASH` | `BELLOWS_ADMIN_TOKEN_HASH` (or the token itself as `BELLOWS_ADMIN_TOKEN`) |
| `TINFOIL_API_KEY`, `TOKENFACTORY_API_KEY`, other supplier keys | the same names |
| `TINFOIL_ADMIN_KEY` | the same name |

The model catalog field `apiKeyEnv` is now `apiKeySecret`, with the same value. A catalog that still says `apiKeyEnv` is refused at startup.

Do not add `BELLOWS_WALLET_SECRET` to a Forge AI database that has a stored seed or ran with `FORGE_WALLET_SEED`: the existing seed stays in use, and Bellows refuses a different seed for a database written under another one. A database that ran with `FORGE_WALLET_SEED` and holds wallet state refuses to start until that seed is in the secrets source as `BELLOWS_WALLET_SEED`.

## Defaults that changed

| Variable | Forge AI default | Bellows default | What to do |
| - | - | - | - |
| `BELLOWS_TRUSTED_MINTS` | the Forge mint | none: required | Set it to the mint URLs you set before. Startup fails without it |
| `BELLOWS_MINT_ALIASES` | the Forge mint's second address | none | Set the `alias=main` pairs you need. A Forge deployment had one built in, so set it explicitly |
| `BELLOWS_INVITE_ONLY` | `true` | `false` | Set `BELLOWS_INVITE_ONLY=true` to keep requiring invites |
| `BELLOWS_DB_PATH` | `data/forge.db` (`/data/forge.db` in the image) | `data/bellows.db` (`/data/bellows.db` in the image) | Set it to the existing file, or rename the file and its `-wal` and `-shm` companions while the gateway is stopped. Startup refuses to create a new database in a directory that already holds `forge.db` |

## Removed features

- **The web app.** Bellows serves no page, no static files and no `/sw.js`. Serve a client app from somewhere else; it talks to the same API.
- **The admin page.** `/admin/` and everything under `/admin` outside `/admin/api` answer 404. The admin API and the admin CLI (`pnpm admin`) stay.
- **The beta waitlist.** `POST /v1/beta/signup`, `/beta`, the admin endpoints `/admin/api/waitlist*` and the CLI commands `beta:list` and `beta:invited` are gone. New databases have no `beta_signups` table. An existing database keeps its table, untouched and unread. It holds contact details, so export what you still need and then drop it:

  ```sh
  sqlite3 data/bellows.db 'DROP TABLE IF EXISTS beta_signups;'
  ```

## Admin API

The admin token header is now `X-Bellows-Admin-Token`. `X-Forge-Admin-Token` is not read. `Authorization: Bearer <token>` works as before.

The admin API answers with aggregates only. `GET /admin/api/accounts`, `GET /admin/api/fundings` and `GET /admin/api/requests` are gone (404); the overview carries the totals and counts instead. `GET /admin/api/invites` no longer says which balance redeemed an invite. Freezing a balance by id and re-checking a funding by id still work. The CLI command `balances:list` is now `balances:show` and prints totals per unit.

## Steps

1. Stop the Forge AI gateway and back up the database file with its `-wal` and `-shm` files.
2. Rename every `FORGE_*` variable in your environment to `BELLOWS_*` using the table above. Drop the two basic-auth variables.
3. Move the secrets out of the environment into the secrets file (see [Secrets](#secrets)), `chmod 600` it, and rename `apiKeyEnv` to `apiKeySecret` in your model catalog.
4. Set `BELLOWS_TRUSTED_MINTS`, `BELLOWS_MINT_ALIASES`, `BELLOWS_INVITE_ONLY` and `BELLOWS_DB_PATH` explicitly to the values you ran with.
5. Optionally set `BELLOWS_SERVICE_NAME`.
6. Change scripts that call the admin API to send `X-Bellows-Admin-Token`, and drop any that read the removed listings.
7. Start Bellows and check the `startup` log line (mode, secrets source, `wallet_seed`), then `GET /healthz` and `GET /v1/models`. `invite_only` in both answers shows the invite setting in force.
8. Drop the `beta_signups` table once you no longer need it.
