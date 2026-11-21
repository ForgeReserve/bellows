# Using a Bellows

These pages are for developers who call a Bellows from an app, an agent or a script: how to check it, pay it, send requests and take your money back.

| Page | What it holds |
| - | - |
| [Build on Bellows guide](guide.md) | Start here. Pick an engine, check its build, list models, pay, chat, stream, go through Oblivious HTTP, handle errors and withdraw, with examples in curl, JavaScript and Python |
| [API reference](api.md) | Every path, header, field and error code of the client API, the operator API and the discovery format |
| [Operators](operators.md) | Operator announcements on Nostr, choosing among many operators with the client library, and moving a balance from one operator to another |

## How you pay

- **Per request (NUT-24).** Call the API with no credentials. You get `HTTP 402` with an `X-Cashu` header holding a NUT-18 payment request, which names the amount, the unit and the accepted mints. Send the request again with `X-Cashu: cashuB...`. The gateway runs the request, charges the actual cost, and returns the unused value as eCash change. No account, no key.
- **Prepaid balance.** Send an eCash token to `POST /v1/wallet/topup` and get an `sk-forge-...` key. Use it as a normal bearer key. Withdraw the remainder as eCash at any time.

A balance can also be funded without holding eCash from an accepted mint first: pay a Lightning invoice, send bitcoin on-chain (NUT-30, off by default), or hand over eCash from another Cashu mint, which the gateway melts to pay a Lightning invoice at its funding mint. In each case the gateway mints eCash for itself and credits the exact amount minted. [Funding a balance](api.md#funding-a-balance) has the details.

## The client library

`client/` is TypeScript that runs in browsers and in Node. It checks a Bellows' attested build (`verifyBellows`), sends calls through Oblivious HTTP (`bellowsFetch`), solves the proof of work for a new balance (`solvePow`), and picks among operators (`OperatorPool`, `moveBalance`). [Use the client library](guide.md#use-the-client-library) lists its exports.
