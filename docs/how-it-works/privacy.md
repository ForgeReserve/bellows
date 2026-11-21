# Privacy

What the gateway can see depends on the tier and on whether the client encrypts.

## Never stored or logged, any tier

- Prompt and completion content. Logs hold only request id, model, supplier, token counts (the cached input count among them), how usage was measured, cost, status and latency. The database keeps daily aggregates per model and supplier (`usage_daily`), never a row per settled request.
- Client network addresses, user agents, referrers and forwarded-for values. Bellows never reads them, so they reach no log, database row or error. Rate limits key on the balance key or on one shared budget, and opening a new balance takes proof of work instead of a per-address limit.
- Balance keys (only a SHA-256 is stored) and invite codes (same).
- P2PK lock keys (`X-Cashu-Pubkey`, `pubkey`) are not logged. They are public keys, stored with the in-flight request, payout or funding they lock (`requests.lock_pubkey` until the request settles, `outgoing.lock_pubkey`, `fundings.f_lock_pubkey`) so a payout made after a crash is still locked, and returned to the payer as `locked_to`.

Streams are read in memory as they pass, to count tokens when the supplier does not report usage. Only counters are kept.

## Blind by default

Bellows stores, logs and shows nothing that identifies a client:

- `test/unit/blind.test.ts` fails if the source reads a client's network address, user agent, referrer or forwarded-for value. `test/e2e/blind.e2e.test.ts` sends all of them with every request and fails if any shows up in a log line, a response, a database row or the raw database files.
- A request leaves no row of its own once it settles. Billing keeps daily aggregates per model and supplier in `usage_daily`: counts, tokens (with the sum of cached input tokens), the amount charged, any shortfall of a late charge, the price and the supplier's cost. A NUT-24 request has an in-flight row until it settles, so that a crash can still return the payment as change. A balance request has none (its reservation is deleted at settlement), and charges write no ledger row.
- The admin API and the admin CLI show aggregates only. A balance is the hash of a random key and its amount, tied to nothing else.

What this leaves visible: the host and its network still see client addresses, and so does a reverse proxy that logs them. Sending through an Oblivious HTTP relay run by someone else, or Tor, hides them ([Oblivious HTTP](ohttp.md)). Funding records (`fundings`) keep the balance id, the invoice or address and the amounts, so that the client can poll them and recovery can finish them. The [design](design.md) says what each step hides.

## Per tier

| | Standard (for example Token Factory) | Enclave, plaintext | Enclave, encrypted (EHBP) |
| - | - | - | - |
| `X-Forge-Privacy` header | `standard` | `enclave-plaintext` | `enclave-encrypted` |
| Gateway sees prompt and reply | Yes, in memory while relaying | Yes, in memory while relaying | No: bodies are HPKE ciphertext end to end |
| Supplier sees prompt and reply | Yes | Only inside an attested enclave | Only inside an attested enclave |
| Gateway sees | Model, sizes, usage, timing | Same | Model name, body size, max output tokens, frame count, timing, usage numbers reported by Tinfoil |
| How usage is measured | Upstream `usage` | Upstream `usage` | `X-Tinfoil-Usage-Metrics` response header (non-streaming) or HTTP trailer (streaming); else flat schedule |

Payment links: with a balance key, every request on that key is linkable to the others. A P2PK lock key is a stable identifier: reusing one key links the payouts locked to it, at the gateway and at the mint, which sees the key in the locked proofs when they are redeemed. Use a fresh key per payout (cashu.me warns when a key was used before) if that matters. With NUT-24 the gateway stores nothing that ties one request to another, and the mint knows its own swaps. Token counts and timing in the `request` log line, and its cached input count above all, can still suggest that two requests belong together ([Prompt caching](#prompt-caching)). Bellows reads no client address, but the host it runs on, its network and anything in front of it, such as a reverse proxy, still see client addresses. Client addresses are hidden from the operator when you use an Oblivious HTTP relay run by someone else, or Tor ([Oblivious HTTP](ohttp.md)). A VPN moves the address to the VPN provider.

The operator API and CLI show totals and counts only: no listing of balances, fundings or requests. Once a balance has been funded it is no longer linked to the invite that opened it.

## Prompt caching

Tinfoil caches the start of a prompt in the GPU memory of the enclave that served it. Its docs (docs.tinfoil.sh/sdk/prompt-caching) say the cache is never written to disk, exported or shared between enclaves, that entries have no fixed lifetime and a prefix that is not reused is usually evicted within minutes, and that a later request reuses an entry only when the API identity, a `user_cache_secret`, the model and the start of the prompt all match. Bellows sends every request to a supplier with that supplier's one API key, so all of its requests to Tinfoil have the same API identity. Which requests share a cache then depends on the secret.

- **Plaintext requests.** Bellows passes the body on as it came (apart from the model name, the token limit and the request for usage it adds), so a `user_cache_secret` the client puts in it reaches Tinfoil. Bellows adds none. Plaintext requests without one share one cache: one person's request can make another person's request that opens with the same text faster and, on a model with a cached price, cheaper. The cached count in the answer, the charge and the speed can then tell the second person that someone sent that opening recently. Tinfoil's docs note that requests sharing an identity and a secret also share cache-hit timing.
- **Encrypted requests.** The body is ciphertext Bellows can neither read nor change, so whether it carries a `user_cache_secret` is up to the client that encrypted it. Tinfoil's docs say its SDK manages the secret by default. Bellows' client library (`client/`) does not build or encrypt request bodies and sets no secret.
- **What Bellows keeps.** The `request` log line carries each request's cached input count (`cached_input_tokens`, from the supplier's usage figures) with its request id, model and time, as it does the other token counts, and `usage_daily` keeps the day's sum per model. A count above 0 in a log line means the request opened with the same text as a recent request that shared its cache. For a plaintext request without a secret, that earlier request can be anyone's. For a request whose client keeps one secret per user or per session, it came from that same user or session. So whoever reads the logs can learn that a request continues a recent one from the same client, even when each was paid with its own NUT-24 token. Tinfoil does not say which earlier request it was.
- **Choosing.** Tinfoil's docs describe no way to turn caching off. A client that sends a fresh secret with every request never reuses the cache (and pays the full input price); one that keeps one secret per user keeps each cache to that user. Bellows sets neither.

## Funding

- Lightning and on-chain funding go through the funding mint (`BELLOWS_FUND_MINT`). The mint sees the quote, the invoice or address and when it is paid; the gateway's mint requests are not linked to the balance key on the mint's side. The gateway stores the quote id, invoice or address, and amounts with the balance id, never the key.
- On-chain status comes from the mint only, unless `BELLOWS_ESPLORA_URL` is set; then the gateway asks that Esplora server about the deposit address (point it at your own node to keep addresses private).
- eCash from another mint: the gateway contacts that mint from its own IP address to swap and melt the token. That mint learns the funding mint's invoice it paid. The change or refund token handed back is fresh eCash from that mint.

## Encrypted pass-through (Tinfoil EHBP)

Tinfoil's Encrypted HTTP Body Protocol encrypts request and response bodies with HPKE to a key held inside an attested enclave, and leaves headers readable. Bellows follows Tinfoil's proxy guide (docs.tinfoil.sh/guides/proxy-server):

- A request carrying `Ehbp-Encapsulated-Key` is treated as encrypted. The gateway never parses its body.
- It needs `X-Tinfoil-Model` to price and route. The enclave rejects a body whose model does not match that header.
- The gateway sets `X-Tinfoil-Max-Output-Tokens` (client value, capped per model) and `X-Tinfoil-Completion-Count: 1`; the enclave enforces both, so the worst-case price holds.
- It forwards the body byte for byte with `Content-Type`, `Accept` and `Ehbp-Encapsulated-Key`, replaces the client's credentials with the gateway's Tinfoil key, and adds `X-Tinfoil-Request-Usage-Metrics: true`.
- `X-Tinfoil-Enclave-Url` from the client is allowed only for `https` hosts under `tinfoil.sh` without credentials.
- The response is streamed back unchanged with `Ehbp-Response-Nonce`. Usage arrives as `X-Tinfoil-Usage-Metrics` (`prompt=..,completion=..`), as a header or as a trailer after a stream; the gateway settles on it.
- If the client disconnects, the gateway counts the EHBP frames it relayed (each length-prefixed frame is visible without decryption) as the output estimate.
- NUT-24 change cannot be put into an encrypted stream; it is at `GET /v1/change/{request_id}` (the `X-Forge-Change-Url` header).

Verified so far: the e2e suite runs these flows against a fake enclave (header and trailer usage, untouched bytes, allowlist). Before this engine was extracted from the Forge AI app, a browser client using Tinfoil's `tinfoil` SDK (1.4.0) verified the live Tinfoil attestation and sent an EHBP request through this encrypted path. A full round trip against a real Tinfoil enclave needs a `TINFOIL_API_KEY` and has not been run.

## Client apps

Bellows serves no web page. A client app (a chat app, an agent, a script) runs on the user's device and talks to the API. What it stores, and what it sends, is up to that app.

File attachments are the client's job too. An app reads a file on the device and sends its text inside the message, for example as a `<file name="report.pdf" pages="12">...</file>` block. To Bellows that is message content like any other: relayed in memory (or, encrypted, never readable), never logged or stored. `test/e2e/files-privacy.e2e.test.ts` checks the logs and the database for file text on both the plaintext and the encrypted path.
