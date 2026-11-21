# How Bellows works

These pages explain how Bellows works inside, what it hides from its operator and what it does not. Read them to judge whether Bellows fits your use, or before you change the code.

| Page | What it holds |
| - | - |
| [Design](design.md) | Start here. What "operator-blind" means, the three things to hide and the mechanism for each, the platform, the architecture, and the build plan the code follows |
| [Payments](payments.md) | How Bellows takes, holds and returns eCash: units, the payment flows, metering, funding, the gateway's wallet, crash safety and known limits |
| [Oblivious HTTP](ohttp.md) | The OHTTP gateway: what an encapsulated request may do, replays, admission, refusals, streaming, size limits, the client and the relay |
| [Privacy](privacy.md) | What the gateway can see per model tier, what it never stores or logs, and encrypted pass-through to enclave models |
| [Threat model](threat-model.md) | What each party can see and do in a sealed deployment, what the design assumes, and where it is weak |

## Oblivious HTTP in short

Oblivious HTTP (RFC 9458) lets a client hide who is asking. Bellows is an Oblivious HTTP gateway for its own client API. A client encrypts each call to the attested HPKE key with `bellowsFetch` from [`client/`](../../client/) and sends it to `POST /ohttp`, through a relay when it has one. The relay sees the client's address and ciphertext; Bellows sees the request and the relay's address. Who is asking is hidden from the operator when you use a relay run by someone else, or Tor. Chunked OHTTP streams chat answers as they are written. Each request carries its date and is refused if replayed. [`relay/`](../../relay/README.md) is a small relay that runs as a Node server or a Cloudflare Worker, forwards only the opaque body and keeps no logs.

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
