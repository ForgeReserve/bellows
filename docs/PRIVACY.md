# Privacy

What the gateway can see depends on the tier and on whether the client encrypts.

## Never stored or logged, any tier

- Prompt and completion content. Logs hold only request id, model, supplier, token counts, how usage was measured, cost, status and latency. The database keeps daily aggregates per model and supplier (`usage_daily`), never a row per settled request.
- Client network addresses, user agents, referrers and forwarded-for values. Bellows never reads them, so they reach no log, database row or error. Rate limits key on the balance key or on one shared budget, and opening a new balance takes proof of work instead of a per-address limit.
- Balance keys (only a SHA-256 is stored) and invite codes (same).
- P2PK lock keys (`X-Cashu-Pubkey`, `pubkey`) are not logged. They are public keys, stored with the in-flight request, payout or funding they lock (`requests.lock_pubkey` until the request settles, `outgoing.lock_pubkey`, `fundings.f_lock_pubkey`) so a payout made after a crash is still locked, and returned to the payer as `locked_to`.

Streams are read in memory as they pass, to count tokens when the supplier does not report usage. Only counters are kept.

## Per tier

| | Standard (for example Token Factory) | Enclave, plaintext | Enclave, encrypted (EHBP) |
| - | - | - | - |
| `X-Forge-Privacy` header | `standard` | `enclave-plaintext` | `enclave-encrypted` |
| Gateway sees prompt and reply | Yes, in memory while relaying | Yes, in memory while relaying | No: bodies are HPKE ciphertext end to end |
| Supplier sees prompt and reply | Yes | Only inside an attested enclave | Only inside an attested enclave |
| Gateway sees | Model, sizes, usage, timing | Same | Model name, body size, max output tokens, frame count, timing, usage numbers reported by Tinfoil |
| How usage is measured | Upstream `usage` | Upstream `usage` | `X-Tinfoil-Usage-Metrics` response header (non-streaming) or HTTP trailer (streaming); else flat schedule |

Payment links: with a balance key, every request on that key is linkable to the others. A P2PK lock key is a stable identifier: reusing one key links the payouts locked to it, at the gateway and at the mint, which sees the key in the locked proofs when they are redeemed. Use a fresh key per payout (cashu.me warns when a key was used before) if that matters. With NUT-24, requests are not linked by the gateway, but the mint knows its own swaps. Bellows reads no client address, but the host it runs on, its network and anything in front of it, such as a reverse proxy, still see client addresses. Client addresses are hidden from the operator when you use an Oblivious HTTP relay run by someone else, or Tor ([OHTTP.md](OHTTP.md)). A VPN moves the address to the VPN provider.

The operator API and CLI show totals and counts only: no listing of balances, fundings or requests. Once a balance has been funded it is no longer linked to the invite that opened it.

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
