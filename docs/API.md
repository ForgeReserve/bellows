# Bellows API

This is the reference for building on a Bellows without reading its code. It has three parts:

- **The client API**: what an app or an agent calls to pay for and use AI models.
- **The operator API**: what the operator of a Bellows calls to run it.
- **The discovery format**: how a client finds a Bellows, checks which build it runs, and reaches it.

The Forge AI web app and its agent example use the client API exactly as written here. `test/e2e/forge-ai-fit.e2e.test.ts` runs their calls, unchanged, against a Bellows directly and through Oblivious HTTP, on local test mints.

## Conventions

**Base URL.** Every path below is relative to the Bellows' origin, for example `https://bellows.example`. The client API lives under `/v1/`.

**JSON.** Request and response bodies are JSON unless a section says otherwise. Send `Content-Type: application/json` with a body.

**Units and amounts.** A Bellows keeps balances and takes payment in `usd` (cents) and `sat` (satoshis), as configured. Amounts named `amount`, `credited`, `credit` or `refundable` are whole units. Fields ending in `_msub` are thousandths of a unit: milli-cents for `usd`, millisatoshis for `sat`. A balance has one unit, set when it is opened.

**Names kept from Forge AI.** Bellows started as the engine inside Forge AI. To keep existing clients working, the client API keeps the `X-Forge-` header prefix, the `event: forge` stream event and the `sk-forge-` prefix of balance keys.

**Errors.** Every error is OpenAI-shaped: `{"error": {"message", "type", "code"}}`, sometimes with extra members named in the endpoint's section. `type` and `code` carry the same value. Match on `code`, not on `message`. The full list is under [Error codes](#error-codes).

**Paying.** A request is paid one of two ways:

- **From a balance.** Send `Authorization: Bearer sk-forge-...`. A balance is opened by a topup or a funding and returns its key once.
- **Per request (NUT-24).** Send the eCash in `X-Cashu: cashuB...`. No account and no key. Unused value comes back as eCash change.

**Invites.** When the operator sets `BELLOWS_INVITE_ONLY=true` (`invite_only` in [`GET /v1/models`](#get-v1models)), opening a new balance needs an invite code (`invite` in the body) and a per-request payment needs one in `X-Forge-Invite`. An invite opens one balance. Requests on an existing balance need no invite.

**Proof of work.** A request that opens a new balance carries a small proof of work instead of being limited per client address, which a Bellows never reads. See [Proof of work](#proof-of-work). An operator can turn it off with `BELLOWS_POW_BITS=0`.

**Rate limits.** A `POST` on a known balance key counts against that balance's budget (`BELLOWS_RATE_LIMIT_RPM`, default 60 a minute). Any other `POST` counts against one budget shared by everyone (`BELLOWS_ANON_RATE_LIMIT_RPM`, default 600 a minute), except a request that opens a balance with a valid proof of work. Past a budget the answer is `429 rate_limited` with `Retry-After` in seconds. `GET` requests are not limited.

**Body size.** A request body over `BELLOWS_MAX_BODY_BYTES` (default 1,000,000) gets `413 request_too_large`.

**Browsers.** `/v1/*`, `/.well-known/*`, `/attestation`, `/ohttp` and `/ohttp-keys` answer any origin (`Access-Control-Allow-Origin: *`), so a web app on another origin can call a Bellows directly. Allowed request headers: `Accept`, `Authorization`, `Content-Type`, `X-Cashu`, `X-Cashu-Pubkey`, `X-Forge-Invite`, `X-Forge-Unit`, `X-Bellows-Pow`, `Ehbp-Encapsulated-Key`, `X-Tinfoil-Enclave-Url`, `X-Tinfoil-Model`, `X-Tinfoil-Max-Output-Tokens`, `X-Tinfoil-Completion-Count`. Exposed response headers: `X-Cashu`, `X-Cashu-Change`, `X-Forge-Request-Id`, `X-Forge-Unit`, `X-Forge-Charged-Msub`, `X-Forge-Balance-Msub`, `X-Forge-Change-Url`, `X-Forge-Privacy`, `Ehbp-Response-Nonce`, `Retry-After`, `X-Bellows-Pow-Challenge`. The operator API sends no CORS headers.

## Reaching a Bellows

A client can reach a Bellows three ways. The paths, headers and bodies of the client API are the same in each.

| Route | What the operator's network sees |
| - | - |
| Straight over HTTPS | The client's address, timing and traffic volume |
| Oblivious HTTP through a relay run by someone else ([below](#oblivious-http)) | For the client API calls, the relay's address. The relay sees the client's address and ciphertext only. Discovery (`/.well-known/bellows`) does not go through the relay; send it through Tor to keep it hidden |
| Tor, to the onion address in the operator's announcement | A Tor circuit |

Who is asking is hidden from the operator only when you use a relay run by someone else, or Tor. A relay and a Bellows run by the same party hide nothing from that party.

### Oblivious HTTP

A Bellows is an Oblivious HTTP gateway ([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458.html)) for its own client API. The client library does the work:

```ts
import { bellowsFetch, tinfoilVerifier, verifyBellows } from './client/index.ts';

const bellows = await verifyBellows('https://bellows.example', { approvedBuilds: buildsJson, verifier: tinfoilVerifier({ authenticate }) });
const operator = { ...bellows, relay: bellows.relays[0] ?? null };
const res = await bellowsFetch(operator, '/v1/wallet', { headers: { authorization: `Bearer ${key}` } });
```

`verifyBellows` reads `/.well-known/bellows` directly from the Bellows, so the operator sees the client's address on that one request. To keep it hidden, pass a `fetch` in the `verifyBellows` options that sends through Tor.

`bellowsFetch(operator, path, init)` takes the same path and `init` a plain `fetch` would, and returns the Bellows' answer as an ordinary `Response`. An app that already calls `fetch(path, init)` switches by calling `bellowsFetch(operator, path, init)` instead; nothing else in the call changes. A non-2xx answer from the Bellows (402, 429 and the rest) is returned like any other answer. `bellowsFetch` throws `BellowsFetchError` only when the request cannot be sent or the answer cannot be opened, with `code` one of `bad_path`, `bad_request`, `bad_key_config`, `network`, `relay_error` (the relay refused, and set `Bellows-Relay-Error`), `gateway_refused` (the Bellows refused the encapsulated request) or `bad_response`.

On the wire:

| Route | What it does |
| - | - |
| `GET /ohttp-keys` | The key configuration as `application/ohttp-keys`. It is the key `/.well-known/bellows` attests. Take the key from the attested statement, not from here |
| `POST /ohttp` | Takes `message/ohttp-req` or `message/ohttp-chunked-req` ([chunked OHTTP, draft 08](https://datatracker.ietf.org/doc/html/draft-ietf-ohai-chunked-ohttp-08)) and answers `message/ohttp-res` or `message/ohttp-chunked-res`. Chunked answers stream |

- An encapsulated request may name any path under `/v1/`, and `/healthz`, `/.well-known/bellows`, `/.well-known/hpke-keys` and `/attestation`, with `GET` or `POST`. Anything else gets an encapsulated `404 not_found`; another method gets `405 method_not_allowed`.
- It runs through the same app as a direct request: priced, paid, rate limited and gated the same way. It keeps its own headers. Nothing from the outer request reaches the app.
- It must carry the time it was made, in `Bellows-Date` or `Date` (`400 date_required` otherwise). A date more than 300 seconds from the gateway's clock gets `400 stale_request` with the gateway's time in `Bellows-Date`, and does not run. The client library retries once on that clock.
- A replay of an encapsulated request is refused before it runs (plain `400`). A replayed topup credits nothing.
- A request the gateway cannot open gets a status and no body: `415` (not an OHTTP type), `400` (cannot be opened, tampered, or a replay), `413` (too large), `500` (the answer could not be sealed; the request ran), `503` (the replay cache is full).

A relay forwards to an allowlisted Bellows at `POST /relay/<host of the Bellows>`. Its full URL is what a statement's `relays` and an announcement's `ohttp-relay` tags list. [OHTTP.md](OHTTP.md) has the details, the size limits and what a streamed answer reveals.

## Client API

### `GET /v1/models`

The models this Bellows sells, in the OpenAI list shape, with prices and payment details.

```json
{
  "object": "list",
  "data": [
    {
      "id": "example-model",
      "object": "model",
      "created": 0,
      "owned_by": "example-supplier",
      "name": "Example Model",
      "tier": "standard",
      "privacy": "standard",
      "encrypted_passthrough": false,
      "uncensored": false,
      "capabilities": { "vision": false, "reasoning": true, "reasoning_efforts": ["low", "high"] },
      "speed": null,
      "context_length": 128000,
      "max_output_tokens": 4096,
      "pricing": {
        "mode": "metered",
        "usd_per_mtok": { "input": 0.5, "output": 1.5 },
        "sat_per_mtok": { "input": 500, "output": 1500 },
        "verified": true
      }
    }
  ],
  "units": ["usd", "sat"],
  "mints": ["https://mint.example"],
  "invite_only": false,
  "btc_usd": 100000
}
```

- `tier` (and its copy `privacy`) is `enclave` for a model that runs in its supplier's sealed hardware, `standard` otherwise.
- `encrypted_passthrough` is true when the model takes EHBP-encrypted bodies ([Encrypted chat](#encrypted-chat-ehbp)). Such a model also lists `upstream_model`, the name to send in `X-Tinfoil-Model`.
- `pricing.usd_per_mtok` is the price per million input and output tokens in US dollars, markup included. `sat_per_mtok` is the same at the current BTC/USD rate, or `null` when sats are not offered or no rate is known. `mode` is `metered` (charged by tokens) or `flat` (charged by a fixed schedule of request sizes).
- `mints` lists the mints whose eCash this Bellows takes for topups and per-request payment. `btc_usd` is the rate in use, or `null`.

### `POST /v1/chat/completions`

OpenAI chat completions, streamed or not. `tools`, `tool_choice` and other fields pass through untouched. `n` must be 1. `max_tokens` (or `max_completion_tokens`) is capped per model at `max_output_tokens`; without one, the cap applies.

**Payment.** Before the request runs, the Bellows reserves its maximum cost: the request's size as input tokens plus the full output allowance, at the model's price. It then charges the actual cost when the answer is done.

| Send | Result |
| - | - |
| `Authorization: Bearer sk-forge-...` | Paid from the balance. `402 insufficient_balance` if the balance cannot cover the maximum cost; `403 account_frozen` if the operator froze it |
| `X-Cashu: cashuB...` | Paid per request (NUT-24). The token must cover the maximum cost. Add `X-Forge-Invite` when invite only. `X-Cashu-Pubkey` locks the change to your key ([Locking](#locking-payouts-to-your-key)) |
| Neither | `402 payment_required` with a NUT-18 payment request (below). `X-Forge-Unit: sat` asks for a quote in sats |

The `402` answer:

```
HTTP/1.1 402 Payment Required
X-Cashu: creqA...

{"error": {"message": "pay 20 usd in eCash: retry with X-Cashu: cashuB... Unused value is returned as change.", "type": "payment_required", "code": "payment_required"},
 "payment_request": "creqA...", "amount": 20, "unit": "usd", "mints": ["https://mint.example"]}
```

Pay `amount` in `unit` at one of `mints` and send the same request again with `X-Cashu`. A sat quote carries a small buffer for rate movement; the unused part comes back as change.

**Answer headers.**

| Header | Value |
| - | - |
| `X-Forge-Request-Id` | `req_...`, this request's id |
| `X-Forge-Privacy` | `standard`, `enclave-plaintext` or `enclave-encrypted` |
| `X-Forge-Unit` | The unit charged |
| `X-Forge-Charged-Msub` | The amount charged (not on streamed answers; see below) |
| `X-Forge-Balance-Msub` | The balance afterwards, for balance payments |
| `X-Cashu-Change` | The change as an eCash token, for NUT-24 payments |
| `X-Forge-Change-Url` | `/v1/change/{request_id}`, where the change can be fetched again |

**Streaming.** With `"stream": true` the answer is `text/event-stream`. The upstream's chunks pass through, then `data: [DONE]`, then one Bellows event that settles the request:

```
event: forge
data: {"request_id":"req_...","unit":"usd","charged_msub":1300,"balance_msub":98700}
```

Its members: `request_id`, `unit`, `charged_msub`, and `balance_msub` (balance payments) or `change`, `change_units` and `change_url` (NUT-24). If the upstream fails mid-stream, a `data: {"error": {...}}` line comes first and the event carries `"partial": true`; the part that was delivered is charged. A stream answer includes a usage chunk only if the request asked for it with `stream_options.include_usage`. The OpenAI JavaScript SDK ignores events after `[DONE]`. Other clients that parse every event should skip `event: forge` or read it.

**Upstream failures** charge nothing and return all NUT-24 change. The answer is `502` (or the upstream's own 4xx) with code `upstream_error`.

#### Encrypted chat (EHBP)

For a model with `encrypted_passthrough`, a client can encrypt the body to the model's own enclave with Tinfoil's EHBP. The Bellows forwards the ciphertext and cannot read the request or the answer. Send:

| Header | Value |
| - | - |
| `Ehbp-Encapsulated-Key` | From the EHBP encryption |
| `X-Tinfoil-Model` | The model's `upstream_model` (or its `id`) |
| `X-Tinfoil-Max-Output-Tokens` | Optional; capped as `max_tokens` is |
| `X-Tinfoil-Completion-Count` | Optional; must be `1` |
| `X-Tinfoil-Enclave-Url` | Optional; an enclave URL on the operator's allowlist |

Pay as for any request. The answer body is ciphertext with `Ehbp-Response-Nonce`. The charge comes from the usage the enclave reports. A non-streamed answer carries the charge headers; a streamed one is settled when it ends, so read the balance afterwards with `GET /v1/wallet` (or fetch NUT-24 change from `X-Forge-Change-Url`). A model whose supplier requires encryption answers a plaintext request with `400 encryption_required`.

To encrypt, a browser client loads the enclave's key and attestation through the Bellows' origin: `GET /.well-known/hpke-keys` and `GET /attestation` pass the enclave's own documents through. Tinfoil's SDK does this with its `baseURL` set to `<origin>/v1/`.

### `GET /v1/change/{request_id}`

The change of a NUT-24 request, for a client that lost the answer. The request id is the capability: it was returned only to the payer. No other credentials.

- `200 {"request_id", "data": [{id, amount, unit, mint, status, token, locked_to}], "token"}`. `token` is the first token.
- `409 not_settled` with `Retry-After` while the request still runs.
- `404 not_found` when there is no change for that id.

### Balance

| Endpoint | Send | Answer |
| - | - | - |
| `POST /v1/wallet/topup` | `{"token": "cashuB...", "invite"?: "..."}`. Optional bearer key: tops up that balance, or opens a new one under a key you chose (`sk-forge-` and 24 to 64 characters from `A-Z a-z 0-9 _ -`) | `{key?, account_id, unit, credited, replay, balance_msub, balance}` |
| `GET /v1/wallet` | Bearer key | `{account_id, unit, balance_msub, available_msub, balance, refundable}` |
| `POST /v1/wallet/refund` | Bearer key; optional `{"amount": N, "pubkey"?: "02..."}`, `amount` in whole units, default all | `{id, token, amount, unit, mint, status, locked_to, balance_msub, refunds}` |
| `GET /v1/wallet/refunds` | Bearer key | `{data: [{id, amount, unit, mint, status, token, locked_to}]}`: every withdrawal of this balance, for re-delivery |

- **Topup.** The token must be from one of the `mints` in `/v1/models`. Its unit sets the balance's unit; a token in another unit gets `400 wrong_unit`. `key` is returned only when the Bellows generated it, once: keep it. Sending the same token again is safe: the answer has `replay: true` and `credited: 0`. If the mint cannot be reached mid-swap, the answer is `503 topup_pending` with the `key` (when generated) and `account_id`: retry with that key and the same token.
- **Balance.** `available_msub` is the balance minus what running requests have reserved. `refundable` is the whole units that can be withdrawn now.
- **Refund.** Answers `200` with the token, or `202` with `status: "owed"` and `token: null` when the mint did not answer; the refund is saved and `GET /v1/wallet/refunds` (or the next refund call) delivers it. A remainder below one unit stays on the balance. `refunds` lists every withdrawal, as `GET /v1/wallet/refunds` does. Errors: `400 invalid_amount` (outside `1..refundable`), `503 wallet_insufficient`.
- **Unknown key.** A key the Bellows does not know gets `401 invalid_key` on `GET /v1/wallet`, refunds, funding status and chat. On a topup or a funding, a well-formed key it does not know opens a new balance under that key.

### Funding a balance

A balance can be funded without eCash from an accepted mint: by a Lightning invoice, a bitcoin deposit (off by default), or eCash from another Cashu mint. Each method opens a balance on first use (with an invite when invite only, and proof of work) and returns `key` once when the Bellows generated it. Send a bearer key to fund an existing balance, or to open a new one under a key you chose. A funding in another unit than the balance's gets `400 wrong_unit`.

| Endpoint | Send | Answer |
| - | - | - |
| `GET /v1/wallet/fund/methods` | | What is offered (below) |
| `POST /v1/wallet/fund/lightning` | `{"amount", "unit", "invite"?}` | A funding; `request` is a bolt11 invoice |
| `POST /v1/wallet/fund/onchain` | `{"invite"?}` | A funding in `sat`; `request` is a bitcoin address |
| `GET /v1/wallet/fund/mints` | | Other mints accepted for funding (below) |
| `POST /v1/wallet/fund/foreign/quote` | `{"token", "unit", "invite"?, "pubkey"?, "accept_unlisted"?}` | A funding in state `quoted` with the exact credit. Nothing is spent yet |
| `POST /v1/wallet/fund/foreign/confirm` | Bearer key; `{"id", "token", "pubkey"?}` | The funding, moving |
| `GET /v1/wallet/fund/{id}` | Bearer key | The funding. Polling it also moves it forward |
| `GET /v1/wallet/fund` | Bearer key | `{data: [funding]}`, this balance's recent fundings |

`GET /v1/wallet/fund/methods`:

```json
{
  "ecash": { "mints": ["https://mint.example"], "units": ["usd", "sat"] },
  "lightning": { "enabled": true, "units": ["sat", "usd"], "min": { "sat": 1, "usd": 1 }, "max": { "sat": 1000000, "usd": 100000 } },
  "onchain": { "enabled": false, "unit": "sat", "min_amount": 0, "confirmations": 3 },
  "foreign": {
    "enabled": true,
    "max": { "sat": 100000, "usd": 10000 },
    "policy": "discovered",
    "mints": ["https://other-mint.example"],
    "mints_url": "/v1/wallet/fund/mints",
    "unlisted": { "enabled": true, "max": { "sat": 10000, "usd": 1000 } }
  },
  "invite_only": false
}
```

`GET /v1/wallet/fund/mints`: `{enabled, policy, mints: [{url, name?, reviewers?, source}], updated_at}`, where `source` is `discovered` (from Cashu mint reviews on Nostr, NIP-87) or `operator`. Denied mints are never listed.

**The funding object.**

```
{id, method: "lightning" | "onchain" | "foreign", state, unit, amount, request, expires_at, credited, balance_msub, account_id, mint,
 onchain?: {confirmations_required, paid_sat, seen_sat, confirmed_sat, confirmations, watch_until},
 foreign?: {mint, unlisted, unit, token_amount, credit, fee_max, change_token, refund_token, locked_to, payout_pending},
 error?, created_at, key?}
```

- `credited` is the exact amount, in whole units of `unit`, added to the balance so far. `amount` is what was asked for (Lightning) or the quoted credit (other mint).
- `state` is one of `quoted`, `receiving`, `melting`, `pending`, `minting`, `done`, `expired`, `failed`, `refunded`. The last four are final.
- **Lightning:** `pending` (invoice unpaid) to `minting` to `done`, or `expired`. `expires_at` is the invoice's expiry in milliseconds.
- **On-chain:** `pending` while the address is watched. Every deposit the mint counts as paid is minted and credited, and `credited` grows. The funding ends `done` when the watch window (`onchain.watch_until`) closes. `expires_at` is `null`.
- **Other mint:** the quote prices the token: `foreign.credit` is what the balance gets, `foreign.fee_max` the most the token's mint can keep. Confirm with the same token within `expires_at`. The Bellows receives the token at its mint, melts it to pay an invoice at its funding mint, then mints and credits `credit`. Unused fee reserve comes back as `foreign.change_token`, eCash from the token's mint. If the payment cannot go through, the token's value comes back as `foreign.refund_token` and the state is `refunded`. With `pubkey` (at quote or confirm) both are locked to it, and `payout_pending` is true until the locking swap is done; keep polling.
- Other-mint errors: a token from one of this Bellows' own mints gets `400 use_topup` (send it to `/v1/wallet/topup`); a denied mint or one the policy refuses gets `400 mint_not_allowed`; a mint not on the accepted list gets `409 mint_unlisted` with `{unlisted: {mint, max}}` until the quote is sent again with `accept_unlisted: true`, under the lower cap in `max`. A confirm with another token than the quoted one gets `400 token_mismatch`; a confirm after `expires_at`, `409 quote_expired`.

### Locking payouts to your key

Every token a Bellows hands back (NUT-24 change, refunds, other-mint change and refunds) is ordinary eCash by default, so until you redeem it the Bellows could spend it too. Give a public key and the token is locked to it (NUT-11 P2PK, plain lock): only the wallet holding the private key can redeem it.

- Where: `X-Cashu-Pubkey` on a chat request, `pubkey` in a refund body, `pubkey` at an other-mint quote or confirm.
- Forms: a compressed secp256k1 key in hex (`02...` or `03...`, 66 characters), an `npub1...`, or a 64-hex x-only key. The last two become `"02" + x`. Anything else is `400 invalid_pubkey` before any eCash moves.
- `locked_to` in the answer names the key. A token locked to a key you do not hold is lost.

### Proof of work

A request that opens a new balance (a topup or a funding sent without a known balance key) needs a proof of work when `BELLOWS_POW_BITS` is above 0 (default 16).

1. Send the request. Without a solution the answer is `428 pow_required` with `{"pow": {"challenge", "bits", "expires_at", "header"}}` and the challenge in `X-Bellows-Pow-Challenge`. `GET /v1/pow` hands out a challenge ahead of time: `{challenge, bits, expires_at, header, paths}`, where `paths` lists the paths that need one.
2. Find a nonce of 1 to 32 characters from `A-Z a-z 0-9 _ -` such that SHA-256 of `<challenge>:<nonce>` starts with `bits` zero bits. `solvePow(challenge, bits)` in the client library does this.
3. Send the same request again with `X-Bellows-Pow: <challenge>:<nonce>`. A challenge is good for 5 minutes and for one request.

### Other client paths

| Path | Answer |
| - | - |
| `GET /healthz` | `{ok, rate: {btc_usd, age_s} \| null, invite_only}` |
| `GET /.well-known/bellows` | The attested identity ([below](#well-knownbellows)) |
| `GET /.well-known/hpke-keys` | The model enclave's HPKE key configuration, passed through. `404` without an enclave supplier |
| `GET /attestation` | The model enclave's attestation bundle, passed through. `404` without one |

### Error codes

| Status | Codes |
| - | - |
| 400 | `invalid_request`, `invalid_amount`, `invalid_token`, `invalid_pubkey`, `untrusted_mint`, `wrong_unit`, `insufficient_amount`, `token_spent`, `encryption_required`, `method_unavailable`, `use_topup`, `mint_not_allowed`, `mint_check_failed`, `amount_too_large`, `token_mismatch`, `foreign_mint_error`, `issue_failed` |
| 401 | `invalid_key` |
| 402 | `payment_required`, `insufficient_balance` |
| 403 | `invite_required`, `invite_used`, `invite_invalid`, `account_frozen` |
| 404 | `model_not_found`, `not_found` |
| 409 | `not_settled`, `quote_expired`, `mint_unlisted`, `in_flight`, `token_in_flight` |
| 413 | `request_too_large` |
| 428 | `pow_required` |
| 429 | `rate_limited`, `too_many_pending` |
| 502 | `upstream_error` |
| 503 | `mint_unavailable` (retry with the same token), `topup_pending`, `rate_unavailable` (no BTC/USD rate; pay in `usd` or retry), `wallet_insufficient`, `wallet_inconsistent` (retry), `payout_unknown` (a locked payout the mint has not confirmed; it stays owed and is never paid twice) |
| 500 | `internal_error` |

## Operator API

`/admin/api/*` is for the operator. It is off, and every `/admin` path answers `404`, until the secrets source holds `BELLOWS_ADMIN_TOKEN` (a random token without spaces) or `BELLOWS_ADMIN_TOKEN_HASH` (its SHA-256 in hex). It is not reachable through Oblivious HTTP. Keep `/admin` on a private network or behind a proxy with its own authentication.

- **Authentication.** `X-Bellows-Admin-Token: <token>` or `Authorization: Bearer <token>`. A missing or wrong token gets `401 unauthorized`. Failed logins share one budget of 10 a minute (`429 rate_limited` past it), apart from the operator's own budget.
- **Changes.** Every request other than `GET` needs a same-origin `Origin` header, or the one in `BELLOWS_ADMIN_ORIGIN` (`403 bad_origin` otherwise), and `Content-Type: application/json` (`415 json_required` otherwise). Bodies are at most 64 KiB.
- **Answers** are JSON with `Cache-Control: no-store`. Errors are `{"error": {"code", "message"}}`.
- **Aggregates only.** No endpoint lists balances, fundings or requests, or ties a balance to an invite, an address or a time.

| Endpoint | Send | Answer |
| - | - | - |
| `GET /admin/api/session` | | `{ok: true}`: checks the token |
| `GET /admin/api/overview` | | `{at, markup, rate, units, holdings, windows, health, ...}`. `units` has per unit: revenue collected and exported, wallet holdings, owed payouts, customer balances, what can be swept, and counts of balances and frozen balances. `windows` (`today`, `d7`, `d30`) has requests, tokens, charged and supplier cost by model, tier and supplier, from daily aggregates. `health` has suppliers, mints, open fundings by state and method, quote-check budget and unfinished exports |
| `POST /admin/api/export/preview` | `{unit, amount?, mint?, pubkey?}` | `{unit, mint, amount, max, sweepable, locked_to}`: what an export would sweep |
| `POST /admin/api/export` | The preview's fields plus `confirm_amount`, `confirm_mint`, `confirm_pubkey` copied from the preview | `200 {id, status: "done", unit, mint, amount, locked_to, token}`, or `202` with `status: "owed"` and `token: null` when the mint did not answer. `409 confirm_mismatch` if the confirmation differs |
| `GET /admin/api/exports` | | `{data: [...]}`: export history (amount, lock, a hash of the token; never the token) |
| `POST /admin/api/exports/{id}/finish` | `{}` | Finishes an interrupted export and returns its token. `409 already_delivered` once delivered |
| `GET /admin/api/invites` | | `{data: [{id, label, status, nut24_uses, created_at, redeemed_at}]}` |
| `POST /admin/api/invites` | `{count?: 1..100, label?}` | `{data: [{id, code}]}`. Codes are shown once |
| `POST /admin/api/invites/{id}/revoke` | `{}` | `{ok, id, status: "revoked"}` |
| `POST /admin/api/accounts/{id}/freeze` | `{frozen: true \| false}` | `{id, frozen}`. For a balance whose id its owner gave you. A frozen balance cannot spend; refunds still work |
| `POST /admin/api/fundings/{id}/recheck` | `{}` | `{data: funding, quote_checks}`. Re-checks one unfinished funding; `409 not_open` for a finished one, `429 quote_budget` when the mint's quote-check budget is used up |
| `GET /admin/api/costs?days=30` | | Supplier cost and margin per model over whole UTC days (1 to 365) |
| `GET /admin/api/mints/discovery` | | Other-mint policy, accepted mints, the operator's own list and discovery status |
| `POST /admin/api/mints/discovery/refresh` | `{}` | Refreshes discovery now; at most once a minute |
| `POST /admin/api/mints/allowed` | `{url, note?, force?}` | `{mint, probe, forced, added, view}`. Adds a mint to the operator's list after a live check; `force` adds one that failed it (`400 mint_check_failed` otherwise). One of the Bellows' own mints gets `409 own_mint`, a denied one `409 mint_denied` |
| `DELETE /admin/api/mints/allowed?url=...`, `POST /admin/api/mints/allowed/remove` `{url}` | | Removes a mint added through the API |
| `GET /admin/api/settings` | | The configuration in force: units, mints, caps, enabled methods, other-mint policy, models and prices, and where state and secrets live (a source kind and a mount, never a secret) |

Every admin change is logged as `admin_action` with counts and amounts only. `pnpm admin` runs the same operations against the database from the host ([README](../README.md#admin-cli)).

## Discovery format

A client needs three things before it sends anything: where the Bellows is, which build it runs, and the key to encrypt to. They come from four documents.

### `/.well-known/bellows`

```json
{
  "format": "bellows-identity/v1",
  "statement": "<base64 of the statement's JSON bytes>",
  "attestation": { "format": "<attestation format URI>", "...": "..." }
}
```

The statement, decoded:

```json
{
  "version": "0.1.0",
  "measurement": { "type": "<format URI>", "registers": ["<lowercase hex>"] },
  "hpke": { "key_config": "<base64 RFC 9458 key configuration>" },
  "relays": ["https://relay.example/relay/bellows.example"],
  "operator": null
}
```

- `version` is the Bellows release. `measurement` is the build the server claims, or `null`; a client trusts only the measurement the attestation proves.
- `hpke.key_config` is the RFC 9458 key configuration (section 3.1): key id, KEM `0x0020` (X25519), the 32-byte public key, and HKDF-SHA256 with AES-128-GCM. The key is made at boot, lives only in memory and is new on every restart.
- `relays` are the Oblivious HTTP relay URLs for this Bellows, in the operator's order.
- `operator` is the operator's signed announcement ([below](#operator-announcement)) or `null`.
- The attestation binds `SHA-256("bellows-identity/v1" || 0x00 || statement bytes)`. The statement travels as base64 so both sides hash the same bytes. Anyone in front of the sealed machine who changes the key, a relay or the announcement breaks the binding.
- Attestation `format` is `https://tinfoil.sh/predicate/attestation/v3` on Tinfoil, or `urn:bellows:attestation:dev:v1` for the development stand-in, which proves nothing and which clients refuse unless they opt in.
- Until the first attestation succeeds, the answer is `503 not_attested` with `Retry-After`.

`verifyBellows(url, {approvedBuilds, verifier})` in the client library fetches this document, checks the attestation with the app's verifier, and finds the proved measurement in `builds.json`. It returns the attested key configuration (`keyConfig`), the approved build, the proved measurement, the relays and the operator announcement, or throws `BellowsVerifyError` with a stable `code`. If it throws, send nothing. [ATTESTATION.md](ATTESTATION.md) has each check. It reads the document directly from the Bellows, so the operator sees the client's address on that request. To keep it hidden, pass a `fetch` in the options that sends through Tor (`verifyBellows(url, {approvedBuilds, verifier, fetch})`).

### `builds.json`

The approved builds, published in the Bellows repository:

```json
{
  "format": "bellows-builds/v1",
  "builds": [
    {
      "version": "1.0.0",
      "image": "ghcr.io/example/bellows@sha256:<64 hex>",
      "measurement": { "type": "https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1", "registers": ["<hex>", "<hex>", "<hex>"] },
      "released": "2026-12-01",
      "deployment": "example/bellows-deploy@v1.0.0",
      "notes": "optional"
    }
  ]
}
```

A client accepts a Bellows only when the measurement its attestation proves is listed here. `deployment` names the operator's measured deploy config as `owner/repo@tag`, since each operator's config is measured too. `pnpm builds:check` validates the file.

### Operator announcement

An operator says where their Bellows is with one signed, addressable Nostr event (NIP-01), published on Nostr relays and served inside the attested statement:

| Field | Value |
| - | - |
| `kind` | `38390` (not registered in the NIPs list) |
| `content` | Optional description, at most 1000 characters |
| `["d", origin]`, `["u", origin]` | The Bellows' origin, for example `https://bellows.example` |
| `["ohttp-relay", url]` | Zero or more relay URLs |
| `["onion", url]` | Optional v3 onion address |
| `["version", version]` | The release it runs |
| `["measurement", type, register, ...]` | Optional build measurement, as in `builds.json` |
| `["unit", unit]` | One or more of `usd`, `sat` |
| `["mint", url]` | One or more accepted mints |
| `["alt", "Bellows operator announcement"]` | NIP-31 text |

`loadOperatorAnnouncements(relays, {authors})` reads them and checks each signature. `OperatorPool` verifies each Bellows, checks that its attested statement carries an announcement by the same operator key for the same origin, health-checks it, picks one and fails over. `moveBalance` withdraws a balance from one operator as eCash and funds a new one at another. A balance key works only at the operator that issued it. [OPERATORS.md](OPERATORS.md) has the details.

### Key and relay endpoints

- `GET /ohttp-keys` serves the same key as `application/ohttp-keys`, for standard OHTTP tooling. Check it against the attested key.
- A relay URL has the form `https://<relay host>/relay/<Bellows host>`. A Bellows relay forwards the body and its content type only, and nothing that identifies the client.

## Moving an existing client to a Bellows

A client written for Forge AI works against a Bellows with these changes, and no change to its calls:

- **Base URL.** A Bellows does not serve a web app. A web app served from its own origin points its calls at the Bellows' origin (`fetch(base + path, init)`). Cross-origin calls work; see [Browsers](#conventions).
- **Proof of work.** Opening a new balance needs a proof of work unless the operator sets `BELLOWS_POW_BITS=0`. A client that predates it gets `428 pow_required` when it opens a balance, and everything else works. Solve it as in [Proof of work](#proof-of-work).
- **Oblivious HTTP, optional.** Verify the Bellows with `verifyBellows` and send each call with `bellowsFetch(operator, path, init)` in place of `fetch(path, init)`. Paths, headers, bodies and answers stay the same, streaming included.
- **Encrypted chat.** Point the EHBP client's base URL at `<Bellows origin>/v1/`. Sending EHBP through Oblivious HTTP needs an EHBP client that takes a custom `fetch`.
