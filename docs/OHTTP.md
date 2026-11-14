# Oblivious HTTP

Bellows is an Oblivious HTTP gateway ([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458.html)) for its own client API. A client encrypts each API call to the attested HPKE key and sends it through a relay. The relay sees the client's address and ciphertext. Bellows sees the request and the relay's address. When a relay is run by someone other than the operator, who is asking is hidden from the operator, and what is asked is hidden from the relay.

Without a relay, a client can still send encapsulated requests straight to Bellows. The content is then unreadable to anything in front of the sealed machine (a load balancer, a TLS terminator, the host), but the operator's network sees the client's address.

A relay and a Bellows run by the same party hide nothing from that party.

## The gateway

| Route | What it does |
|---|---|
| `GET /ohttp-keys` | The key configuration as `application/ohttp-keys` (RFC 9458 section 3.2). It is the HPKE key that `/.well-known/bellows` attests. |
| `POST /ohttp` | Takes `message/ohttp-req` (RFC 9458) or `message/ohttp-chunked-req` ([chunked OHTTP, draft 08](https://datatracker.ietf.org/doc/html/draft-ietf-ohai-chunked-ohttp-08)) and answers with `message/ohttp-res` or `message/ohttp-chunked-res`. |

A client must take the key from the attested statement (`verifyBellows`), not from `/ohttp-keys`. Anyone in front of the sealed machine can change an unattested key. `/ohttp-keys` is there for standard OHTTP tooling, and a client that reads it should check that it matches the attested key.

The key suite is DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM. The key pair is made at boot, lives only in memory and is new on every restart. A client that gets a refusal after a restart verifies again and uses the new key.

### What an encapsulated request may do

The inner request runs through the same app as a direct request, so it is priced, paid, rate limited and gated by proof of work exactly the same way. It may name these paths, with `GET` or `POST`:

- every path under `/v1/`
- `/healthz`, `/.well-known/bellows`, `/.well-known/hpke-keys` and `/attestation`

Anything else (the operator API, `/ohttp` itself) gets an encapsulated `404` with code `not_found`. Another method gets `405`.

The inner request keeps its own headers (`Authorization`, `X-Cashu`, `Content-Type` and the rest). Hop headers (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding` and similar) are dropped. Nothing from the outer request reaches the app: not its headers, not its address.

### Replays

RFC 9458 leaves replay protection to the gateway (section 6.5). Bellows refuses a replayed request before it runs:

- Every encapsulated request carries the time it was made, in `Bellows-Date` (the client library sets it; browsers do not let a page set `Date`) or in `Date`. A request without one gets an encapsulated `400` with code `date_required`.
- A date more than `BELLOWS_OHTTP_MAX_SKEW_SECONDS` (default 300) from the gateway's clock gets an encapsulated `400` with code `stale_request` and the gateway's time in `Bellows-Date`. The request does not run, so a client can resend it dated by that clock. The client library does this once.
- The encapsulated key of each request (new for every request) is remembered until the request's date leaves the window. The same encapsulated key again is a replay: plain `400`, and the request does not run. This holds for a topup too: replaying a captured topup credits nothing.
- Only a request that will run is remembered. The date, the method and the path are checked first, and a request refused for any of them (`date_required`, `stale_request`, `405`, `404`) is answered without taking a place in the replay cache, so requests that run nothing cannot fill it. Replaying a request refused for its method, path or a missing date gets the same refusal and runs nothing. A request refused as stale because it is dated ahead of this clock is refused only until its date enters the window; after that it can run once.
- At most `BELLOWS_OHTTP_REPLAY_CACHE_MAX` keys are remembered (default 200,000, a few tens of megabytes). When that many are live, new requests get `503` until older ones expire. The admission bound below keeps that from happening. Memory is the only state: a restart forgets the keys, and a restart also makes a new HPKE key, so a request captured before a restart cannot be opened after it.

### Admission

Encapsulated requests carry no identity, so the gateway cannot limit one client apart from another. It bounds new requests for everyone together instead: at most `BELLOWS_OHTTP_ADMIT_PER_SECOND` a second, with a burst of one second's worth. Past it a request gets a plain `503` with `Retry-After` (whole seconds), takes no place in the replay cache, and can be sent again unchanged once the bound has room. The Bellows relay passes `Retry-After` on with a `503` and exposes it to browsers; a third-party relay may drop it, so a client should not count on seeing it. Only a request that would be remembered counts: refused, stale and replayed requests use none of it.

A key is kept for at most twice the skew plus one second (601 s by default). Left unset, the bound is the most the replay cache holds over that time (`BELLOWS_OHTTP_REPLAY_CACHE_MAX / (2 * BELLOWS_OHTTP_MAX_SKEW_SECONDS + 2)`, about 332 a second by default), so the cache cannot fill. A flood then competes with honest clients for each second's admissions, rather than shutting every new request out until old keys expire. A sender of more than the bound can still crowd others out while it keeps sending: the bound limits what a flood costs the gateway, not who gets through. A set value that could let the cache fill is refused at startup. Inside the app, each request still meets the same payment, rate limits and proof of work as a direct one. See [OPERATE.md](OPERATE.md#oblivious-http-under-load).

### Refusals

RFC 9458 asks the gateway to answer a request it cannot open with a plain error. Bellows answers with a status and no body:

| Status | Why |
|---|---|
| `415` | Not an OHTTP content type |
| `400` | Not decryptable, tampered, cut short, wrong key, malformed, or a replay |
| `413` | The request is over `BELLOWS_OHTTP_MAX_MESSAGE_BYTES` |
| `500` | The answer could not be sealed (a plain answer over `BELLOWS_OHTTP_MAX_MESSAGE_BYTES`). The request ran. The log line `ohttp_answer_failed` carries the reason only |
| `503` | Past the admission bound (`Retry-After` says when to send again), or the replay cache is full |

Each refusal writes one log line, `ohttp_refused`, with the reason only.

### Streaming

Chunked OHTTP streams answers. Bellows seals each piece of the answer as the app writes it (pieces that are ready together are sealed together, never more than 16 KiB in one chunk), so a streamed chat answer reaches the client as it is written. The final chunk is empty, and the padding of the Binary HTTP message goes at its end.

The crypto is [ohttp-ts](https://github.com/thibmeu/ohttp-ts) (MIT): HPKE, the request decryption and the per-chunk sealing with its nonces. Bellows writes the chunk framing itself (a length before each sealed chunk, 0 before the last), because the library's own answer stream seals 16 KiB at a time and holds each chunk until the next one exists. A short chat answer would then arrive only when it ended.

What a streamed answer shows to the relay and the network: the size and timing of each sealed chunk, which follow the tokens the model writes. A direct HTTPS stream shows the same to the network. The total length is padded (at least 1 KiB, then within about 12%). Plain RFC 9458 answers (`chunked: false` in the client) arrive whole, padded the same way.

Requests are not streamed: the client and the relay send each encapsulated request as one body, because browsers and mobile runtimes do not all stream request bodies.

### Size limits

| What | Limit |
|---|---|
| An encapsulated request, chunked or plain | `BELLOWS_OHTTP_MAX_MESSAGE_BYTES` of Binary HTTP. The gateway reads at most that plus framing room and answers `413` past it. Anyone can send one, so this is the gateway's memory bound |
| A plain RFC 9458 answer | `BELLOWS_OHTTP_MAX_MESSAGE_BYTES`. It is buffered whole on both sides. The client's plain-mode default is the same 8 MiB, so it opens every plain answer a gateway with the default sends |
| A chunked answer | 1 GiB, the chunked OHTTP default of ohttp-ts and of the client. The answer is Bellows' own, so the request limit does not apply to it, and a long stream is not cut short |

A plain answer the client cannot open has already run and been charged. Its request id and change URL are inside the answer. Keep the client's `maxMessageBytes` at least the gateway's `BELLOWS_OHTTP_MAX_MESSAGE_BYTES`.

## The client

```ts
import { bellowsFetch, verifyBellows } from './client/index.ts';

const bellows = await verifyBellows('https://bellows.example', { approvedBuilds, verifier });
const operator = { ...bellows, relay: 'https://relay.example/relay/bellows.example' };

const res = await bellowsFetch(operator, '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages, stream: true }),
});
// res is the Bellows' answer: status, headers and a body that streams.
```

`bellowsFetch(operator, path, init, options)`:

- `operator.origin` and `operator.keyConfig` come from `verifyBellows`. It reads `/.well-known/bellows` directly from the Bellows, not through the relay, so the operator sees the client's address on that request. To keep it hidden, pass a `fetch` in the `verifyBellows` options that sends through Tor. `operator.relay` is the relay URL that forwards to this Bellows. Without one the request goes straight to `<origin>/ohttp`.
- `options.relay` overrides `operator.relay`; `null` sends straight to the Bellows.
- `options.chunked` (default `true`) picks chunked OHTTP. `false` sends plain RFC 9458 messages, which some third-party relays require.
- `options.maxMessageBytes` is the largest Binary HTTP message the client sends or opens. The default is 8 MiB in plain mode (`DEFAULT_MAX_MESSAGE_BYTES`, the gateway's default) and 1 GiB in chunked mode (`DEFAULT_MAX_CHUNKED_ANSWER_BYTES`). In plain mode it must be at least the gateway's `BELLOWS_OHTTP_MAX_MESSAGE_BYTES`.
- It throws `BellowsFetchError` when the request cannot be sent or the answer cannot be opened. `code` is one of `bad_path`, `bad_request`, `bad_key_config`, `network`, `relay_error` (the relay refused, with its reason), `gateway_refused` (the gateway refused: see [Refusals](#refusals)) and `bad_response`. On a busy `503` that carried `Retry-After`, `retryAfter` holds its seconds. An answer from Bellows with an error status (`402`, `429` and so on) is returned like any other answer.

The client uses Web APIs only (fetch, WebCrypto, streams) and runs in browsers and in Node. Its only dependencies are `ohttp-ts` and `hpke`, which use no Node-only module either; a test checks both.

## The relay

`relay/` is a small standalone relay: [relay/README.md](../relay/README.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BELLOWS_RELAYS` | none | Relay URLs that forward to this Bellows (each the full URL a client posts to), published in `/.well-known/bellows` |
| `BELLOWS_OHTTP_MAX_SKEW_SECONDS` | `300` | How far a request's date may be from the gateway's clock |
| `BELLOWS_OHTTP_REPLAY_CACHE_MAX` | `200000` | Most encapsulated keys remembered at once |
| `BELLOWS_OHTTP_ADMIT_PER_SECOND` | the most the cache holds (about 332) | New encapsulated requests admitted per second, for all clients together. See [Admission](#admission) |
| `BELLOWS_OHTTP_MAX_MESSAGE_BYTES` | `8388608` | Largest Binary HTTP request, and largest plain (not chunked) answer, padding included. Chunked answers are bounded at 1 GiB. See [Size limits](#size-limits) |

## Tests

- `test/unit/ohttp.test.ts`: the key, round trips in both modes, streaming piece by piece, the size limits (a plain answer over 1 MiB, a long chunked answer past a small request limit, `413` on an oversized request, `500` on an answer that cannot be sealed), tampered, replayed, stale, undated and misdirected requests, the replay cache (which a request refused for its date, method or path never enters, so refused requests cannot fill it), the admission bound (a flood longer than a key lifetime never fills the cache at the default), and that the app receives none of the outer request.
- `test/unit/relay.test.ts`: the relay's allowlist, what it forwards and returns, its refusals, that it writes nothing, the Worker entry point, and the Node server with the gateway seeing the relay's address only.
- `test/e2e/ohttp.e2e.test.ts`: client, relay and Bellows against the local test mints. It funds a balance, chats plain and streamed, pays one request with eCash, and refunds, all through the relay. It checks that the relay's bytes hold none of the content, that the Bellows never receives the client's address or headers, and that a replayed topup and a tampered request are refused.

## Not verified locally

- The relay as a Cloudflare Worker has been run only in Node, through its `fetch` export, not on Cloudflare. In particular, which headers Cloudflare adds to a Worker's outgoing requests has not been checked. Bellows reads no client address or forwarding header in any case.
- Interoperability with third-party OHTTP relays and clients has been tested only against ohttp-ts itself, which its authors test against the RFC 9458 and chunked OHTTP draft vectors.
- The admission bound has been tested in process with a simulated clock, not under real load from many addresses. Decrypting a request costs the gateway CPU before any bound applies, and the bound does not cap that.
