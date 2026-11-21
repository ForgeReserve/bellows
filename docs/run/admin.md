# Admin API and admin CLI

The operator of a Bellows has two tools: the admin API, over HTTP, and the admin CLI, which works on the database directly. Both show aggregates only: totals, counts and health. Neither lists balances, fundings or requests.

## Admin API

`/admin/api/*` is the operator API. It is off (every `/admin` path answers 404) until the secrets source holds `BELLOWS_ADMIN_TOKEN`, a random token you generate, or `BELLOWS_ADMIN_TOKEN_HASH`, its SHA-256 in hex ([Secrets and sealed state](configuration.md#secrets-and-sealed-state)). `secrets.example.json` ships with the token empty, so the admin API stays off until you fill it in. Bellows refuses a token shorter than 16 characters or with spaces in it, so placeholder text cannot turn the API on. It cannot check a token it receives only as a hash, so always generate the token this way:

```sh
TOKEN=$(openssl rand -hex 32)
printf %s "$TOKEN" | shasum -a 256
```

Send the token as `X-Bellows-Admin-Token: <token>` (or `Authorization: Bearer <token>`). A missing or wrong token gets 401, and failed logins share one budget of 10 a minute, separate from the operator's own, so they cannot lock the operator out. Every request other than GET needs a same-origin `Origin` header (or `BELLOWS_ADMIN_ORIGIN`) and a JSON body. The admin API sends no CORS headers.

Where it is reachable depends on the deployment:

- **Self-hosted.** Keep `/admin` off the public internet: a private network, or a proxy with its own authentication in front of it.
- **Sealed (the Tinfoil deploy kit).** TLS ends inside the sealed machine, so no proxy of yours can sit in front of `/admin`. The kit's shim serves `/admin/api` at the same public origin as the client API, and the token is its only protection, together with the failed-login budget. Generate the token with `openssl rand -hex 32` and keep it in a password manager. If you do not need the admin API, remove `/admin/api` and `/admin/api/*` from the shim's `paths` in `tinfoil-config.yml`; every `/admin` path then stops at the shim, and you can add them back in a later release.

Every answer is an aggregate. There is no listing of balances, fundings or requests. What it offers:

- an overview: revenue, total customer balances and how many there are, wallet holdings, owed payouts, activity by model, tier and supplier (today, 7 and 30 days, from the daily aggregates), funding counts by method and state, and health;
- revenue export: sweep revenue as an eCash token, optionally locked to a key, after a preview whose amount, mint and key the export call confirms; the export history; and finishing an export that was interrupted;
- invites: list, create (codes are shown once) and revoke;
- freezing a balance whose id its owner gave you, and re-checking one funding by id;
- supplier cost and margin per model;
- other-mint discovery and the operator's own list of accepted mints;
- a read-only view of the configuration in force.

The [operator API reference](../use/api.md#operator-api) lists every endpoint with its request and answer. Every admin action is logged as `admin_action` with counts and amounts only. Tokens, invite codes and keys are never logged.

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

Without `--unit`, `revenue:export` and `prices:show` use `BELLOWS_DEFAULT_UNIT`.

`revenue:export` never exports eCash that backs customer balances or unpaid change. Exports are recorded in `revenue_exports` (amount, lock, token hash; never the token).

## Logs

Logs are JSON lines with request id, model, supplier, token counts, cost, status and latency. Prompt and completion content is never logged or stored. [Privacy](../how-it-works/privacy.md) says what is kept and what is not.
