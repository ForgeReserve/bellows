# Build on Bellows

Bellows is an OpenAI-compatible AI gateway that you pay per request with Cashu eCash. This guide shows how an app, an agent or a script uses a running Bellows: pick one, check which build it runs, list its models, pay, send chat requests, stream answers, go through Oblivious HTTP, handle errors and take your money back. The last part points operators at the pages for running their own.

Every path, header and field here is described in full in [API reference](api.md). The examples were run against a local Bellows with local test mints; [How these examples were checked](#how-these-examples-were-checked) lists what ran and what did not.

## Pick an engine

A Bellows is an origin that serves the API. Two choices:

- **The reference instance** at `https://bellows.island-bitcoin.containers.tinfoil.dev`, which runs release 0.1.2 on Tinfoil Containers. It takes real eCash.
- **A local engine** on your machine, with test mints that pay their own invoices. Use it while you build.

Start a local engine from a checkout of this repository. You need Node 22.18 or later, pnpm and Docker.

```sh
pnpm install --frozen-lockfile
pnpm mint:up        # three local Nutshell test mints (FakeWallet, usd and sat)
BELLOWS_TRUSTED_MINTS=http://127.0.0.1:3338 BELLOWS_MODELS_FILE=config/models.dev.json \
  BELLOWS_DB_PATH=data/dev.db pnpm start      # listens on http://localhost:8787
```

`config/models.dev.json` adds mock models (`mock-echo`, `mock-slow` and others) that answer without any supplier key. In another terminal, make test eCash worth 100 cents:

```sh
pnpm test-token 100 usd     # prints cashuB...
```

`pnpm test-token` talks only to a local test mint. Never point it at a real mint.

Check that the engine answers:

```sh
B=http://localhost:8787     # or https://bellows.island-bitcoin.containers.tinfoil.dev
curl -s $B/healthz
# {"ok":true,"rate":{"btc_usd":65008.12,"age_s":5},"invite_only":false}
```

## Check which build it runs

Before you send a prompt or a token, check that the engine runs an approved build. A Bellows serves its identity at `GET /.well-known/bellows`: a statement (version, claimed build, the HPKE key clients encrypt to, its relays, the operator's announcement) and an attestation that binds that statement. [Attested identity](../verify/attestation.md) describes each part.

Look at it by hand:

```sh
curl -s $B/.well-known/bellows | jq '.attestation | {format, warning}'
curl -s $B/.well-known/bellows | jq -r .statement | base64 -d | jq '{version, measurement, relays, operator}'
```

On a local engine the attestation format is `urn:bellows:attestation:dev:v1` with the warning `DEVELOPMENT STAND-IN. NOT HARDWARE ATTESTATION. PROVES NOTHING.` On Tinfoil it is `https://tinfoil.sh/predicate/attestation/v3`.

`GET /ohttp-keys` serves the same key for standard OHTTP tools. It should equal the attested one:

```sh
curl -s $B/ohttp-keys | tail -c +3 | base64                                    # drop the 2-byte length
curl -s $B/.well-known/bellows | jq -r .statement | base64 -d | jq -r .hpke.key_config
```

Reading the document proves nothing by itself. The check that counts is `verifyBellows` in the client library: it verifies the attestation, finds the measured build in `builds.json`, and returns the attested key, or throws. If it throws, send nothing.

```ts
import { tinfoilVerifier, verifyBellows } from './client/index.ts';
import buildsJson from './builds.json' with { type: 'json' };

const bellows = await verifyBellows('https://bellows.island-bitcoin.containers.tinfoil.dev', {
  approvedBuilds: buildsJson,
  verifier: tinfoilVerifier({ authenticate }),
});
// bellows.keyConfig is the attested key, bellows.relays its relays, bellows.build the approved build.
```

`authenticate` is yours to supply. It must check the SEV-SNP report or TDX quote (vendor certificate chain, collateral, provenance) and return the measurement it proves and the REPORT_DATA read from the quote. No implementation ships in this repository; [The client library](../verify/attestation.md#the-client-library) says what it must do, and [Not verified locally](../verify/attestation.md#not-verified-locally) lists what has not been run on real sealed hardware.

Against a local engine, accept the development stand-in explicitly. It proves nothing, so use it only for development:

```ts
import { devVerifier, verifyBellows } from './client/index.ts';

const BELLOWS = 'http://localhost:8787';
// A local engine is not in builds.json. List the build it claims, for development only.
const doc = await (await fetch(`${BELLOWS}/.well-known/bellows`)).json();
const claimed = JSON.parse(atob(doc.statement));
const devBuilds = {
  format: 'bellows-builds/v1',
  builds: [{ version: claimed.version, image: `ghcr.io/example/bellows@sha256:${'0'.repeat(64)}`, measurement: claimed.measurement, released: '2026-11-16' }],
};
const bellows = await verifyBellows(BELLOWS, { approvedBuilds: devBuilds, verifier: devVerifier(), allowDevelopment: true });
```

Without `allowDevelopment` the same call throws `BellowsVerifyError` with code `development_refused`.

`verifyBellows` reads `/.well-known/bellows` straight from the engine, so the operator sees your address on that one request. To keep it hidden, pass a `fetch` in its options that sends through Tor.

## List models

```sh
curl -s $B/v1/models | jq '{units, mints, invite_only, models: [.data[] | {id, tier, encrypted_passthrough, usd_per_mtok: .pricing.usd_per_mtok, verified: .pricing.verified}]}'
```

What to read from the answer:

- `data[].id` is the model name to send. `tier` is `enclave` for a model that runs in its supplier's sealed hardware, `standard` otherwise.
- `pricing.usd_per_mtok` is the price per million input and output tokens, markup included. `sat_per_mtok` is the same at the current BTC/USD rate. A price with `verified: false` is an estimate.
- `mints` lists the mints whose eCash this engine takes. `units` lists `usd` (cents) and `sat`.
- `invite_only: true` means opening a balance or paying per request needs an invite code from the operator.

## Pay for requests

There are two ways to pay. Both use eCash from one of the `mints` in `/v1/models`.

| Way | Send | Good for |
| - | - | - |
| Prepaid balance | `Authorization: Bearer sk-forge-...` | Apps and chats that make many requests |
| Per request (NUT-24) | `X-Cashu: cashuB...` | Agents and scripts that want no account and no key |

A balance key links every request made with it to the others. A per-request payment is not linked to other requests by the engine. [Privacy](../how-it-works/privacy.md) has the details.

### Open a balance

Send a token to `POST /v1/wallet/topup`. Opening a new balance needs a small proof of work: the first answer is `428 pow_required` with a challenge. Find a nonce so that SHA-256 of `<challenge>:<nonce>` starts with `bits` zero bits, then send the same request again with `X-Bellows-Pow: <challenge>:<nonce>`. `GET /v1/pow` hands out a challenge ahead of time. A challenge is good for 5 minutes and one request.

With curl and a small Python solver:

```sh
pow_solve() {
  python3 -c 'import hashlib, itertools, sys
c, bits = sys.argv[1], int(sys.argv[2])
for i in itertools.count():
    n = format(i, "x")
    h = int.from_bytes(hashlib.sha256(f"{c}:{n}".encode()).digest(), "big")
    if h >> (256 - bits) == 0:
        print(f"{c}:{n}")
        break' "$1" "$2"
}

TOKEN=cashuB...     # eCash from one of the engine's mints
POW=$(curl -s $B/v1/pow)
SOLUTION=$(pow_solve "$(jq -r .challenge <<<"$POW")" "$(jq -r .bits <<<"$POW")")
TOPUP=$(curl -s $B/v1/wallet/topup -H 'content-type: application/json' \
  -H "X-Bellows-Pow: $SOLUTION" -d "{\"token\": \"$TOKEN\"}")
KEY=$(jq -r .key <<<"$TOPUP")
echo "$TOPUP" | jq '{unit, credited, balance_msub}'
```

The answer holds `key` once. Keep it: it is the balance. To make sure a lost answer never loses the key, choose the key yourself and send it as the bearer key on the topup: `sk-forge-` followed by 24 to 64 characters from `A-Z a-z 0-9 _ -`, for example `"sk-forge-$(openssl rand -hex 16)"`. The answer then has `key: null`, and the balance is under your key. Sending the same token again is safe: the answer has `replay: true` and `credited: 0`.

In JavaScript, with `solvePow` from the client library:

```ts
import { solvePow } from './client/index.ts';

async function topup(base: string, token: string) {
  const send = (headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ token }),
    });
  let res = await send();
  if (res.status === 428) {
    const { pow } = await res.json();
    res = await send({ 'X-Bellows-Pow': await solvePow(pow.challenge, pow.bits) });
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${body.error.code}: ${body.error.message}`);
  return body; // { key, account_id, unit, credited, balance_msub, ... }
}

const { key } = await topup('http://localhost:8787', 'cashuB...');
```

In Python, with `requests`:

```python
import hashlib, itertools
import requests

BELLOWS = "http://localhost:8787"

def solve_pow(challenge, bits):
    for i in itertools.count():
        nonce = format(i, "x")
        digest = hashlib.sha256(f"{challenge}:{nonce}".encode()).digest()
        if int.from_bytes(digest, "big") >> (256 - bits) == 0:
            return f"{challenge}:{nonce}"

def topup(token, key=None):
    headers = {"authorization": f"Bearer {key}"} if key else {}
    res = requests.post(f"{BELLOWS}/v1/wallet/topup", json={"token": token}, headers=headers)
    if res.status_code == 428:
        pow_ = res.json()["pow"]
        headers["X-Bellows-Pow"] = solve_pow(pow_["challenge"], pow_["bits"])
        res = requests.post(f"{BELLOWS}/v1/wallet/topup", json={"token": token}, headers=headers)
    body = res.json()
    if not res.ok:
        raise RuntimeError(f"{res.status_code} {body['error']['code']}: {body['error']['message']}")
    return body

key = topup("cashuB...")["key"]
```

A balance has one unit, set by its first topup. A token in another unit gets `400 wrong_unit`.

### Fund a balance with Lightning

A user who holds no eCash from the engine's mints can pay a Lightning invoice instead. The engine mints eCash at its funding mint and credits the exact amount.

```sh
curl -s $B/v1/wallet/fund/methods | jq '{lightning, onchain: .onchain.enabled}'

KEY="sk-forge-$(openssl rand -hex 16)"
POW=$(curl -s $B/v1/pow)
SOLUTION=$(pow_solve "$(jq -r .challenge <<<"$POW")" "$(jq -r .bits <<<"$POW")")
FUNDING=$(curl -s $B/v1/wallet/fund/lightning -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" -H "X-Bellows-Pow: $SOLUTION" -d '{"amount": 500, "unit": "sat"}')
jq '{id, state, request}' <<<"$FUNDING"      # request is the bolt11 invoice to pay
ID=$(jq -r .id <<<"$FUNDING")

curl -s $B/v1/wallet/fund/$ID -H "authorization: Bearer $KEY" | jq '{state, credited}'
```

Poll the funding until `state` is `done` (or `expired`). Polling also moves it forward. Other funding methods (a bitcoin deposit, eCash from another mint) are in [API reference](api.md#funding-a-balance).

### Pay per request (NUT-24)

Send a chat request with no credentials. The answer is `402` with a NUT-18 payment request in `X-Cashu` and the amount in the body:

```sh
curl -s -i $B/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model": "mock-echo", "messages": [{"role": "user", "content": "Hello"}]}'
# HTTP/1.1 402 Payment Required
# x-cashu: creqA...
# {"error":{...,"code":"payment_required"},"payment_request":"creqA...","amount":7,"unit":"usd","mints":["http://127.0.0.1:3338"]}
```

Pay `amount` in `unit` at one of `mints`: send the same request again with `X-Cashu: cashuB...`. The amount is the request's maximum cost. The engine charges what the request used and returns the rest as eCash change: in the `X-Cashu-Change` header, in the final `event: forge` of a stream, and at `GET /v1/change/{request_id}` (the `X-Forge-Change-Url` header). Add `X-Cashu-Pubkey: 02...` to lock the change to your wallet key, so that only the holder of the private key can redeem it.

`examples/agent-pays.ts` does all of this with cashu-ts. Against a local engine it can mint its own test eCash:

```sh
BELLOWS_URL=http://localhost:8787 DEMO_FAKE_MINT=1 pnpm demo:agent "What is eCash?"
# 402 Payment Required: 7 cents (usd) from one of http://127.0.0.1:3338
# Answer: ...
# Charged: 1 cents
# Change returned: 6 cents; ...
```

Set `CASHU_PUBKEY=generate` to lock the change to a fresh key for the run. Against a real engine, set `CASHU_TOKEN=cashuB...` to spend real eCash.

## Send a chat request

`POST /v1/chat/completions` takes OpenAI chat completions. `tools`, `tool_choice` and other fields pass through. `n` must be 1. `max_tokens` is capped at the model's `max_output_tokens`.

```sh
curl -s -D - $B/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model": "mock-echo", "messages": [{"role": "user", "content": "Hello"}]}'
```

The answer is an OpenAI chat completion. Its headers say what it cost:

| Header | Value |
| - | - |
| `X-Forge-Request-Id` | `req_...`, this request's id |
| `X-Forge-Unit` | The unit charged |
| `X-Forge-Charged-Msub` | The amount charged, in thousandths of the unit (milli-cents for `usd`) |
| `X-Forge-Balance-Msub` | The balance afterwards |
| `X-Forge-Privacy` | `standard`, `enclave-plaintext` or `enclave-encrypted` |

In JavaScript:

```ts
const res = await fetch(`${BELLOWS}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'Hello' }] }),
});
const answer = await res.json();
console.log(answer.choices[0].message.content, res.headers.get('x-forge-charged-msub'));
```

Any OpenAI client works with the balance key as its API key and `<engine>/v1` as its base URL. With the OpenAI Python SDK:

```python
from openai import OpenAI

client = OpenAI(base_url=f"{BELLOWS}/v1", api_key=key)   # key is the sk-forge-... balance key
print([m.id for m in client.models.list()])
reply = client.chat.completions.create(model="mock-echo", messages=[{"role": "user", "content": "Hello"}])
print(reply.choices[0].message.content)
```

## Stream an answer

Send `"stream": true`. The answer is `text/event-stream`: the model's chunks, then `data: [DONE]`, then one Bellows event that settles the request.

```sh
curl -sN $B/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model": "mock-echo", "stream": true, "messages": [{"role": "user", "content": "Hello"}]}'
# data: {"id":"chatcmpl-mock-2",...,"choices":[{"index":0,"delta":{"content":"Hello"},...}]}
# ...
# data: [DONE]
#
# event: forge
# data: {"request_id":"req_...","unit":"usd","charged_msub":162,"balance_msub":99676}
```

The `forge` event carries `charged_msub` and, for a balance, `balance_msub`. For a per-request payment it carries `change`, `change_units` and `change_url`. If the model fails mid-stream, a `data: {"error": {...}}` line comes first and the event has `"partial": true`; the part that was delivered is charged. A client that parses every event should read or skip `event: forge`.

In JavaScript, a small reader that works on a plain `fetch` answer and on a `bellowsFetch` answer alike:

```ts
async function streamChat(response: Response, onText: (text: string) => void) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let event = '';
  let settled: unknown = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (event === 'forge') settled = JSON.parse(data);
        else if (data !== '[DONE]') {
          const chunk = JSON.parse(data);
          if (chunk.error) throw new Error(chunk.error.message);
          onText(chunk.choices?.[0]?.delta?.content ?? '');
        }
      } else if (line === '') event = '';
    }
  }
  return settled; // { request_id, unit, charged_msub, balance_msub }
}

const res = await fetch(`${BELLOWS}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'mock-echo', stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
});
const settled = await streamChat(res, (text) => process.stdout.write(text));
```

In Python:

```python
import json

with requests.post(f"{BELLOWS}/v1/chat/completions", headers={"authorization": f"Bearer {key}"}, stream=True,
                   json={"model": "mock-echo", "stream": True, "messages": [{"role": "user", "content": "Hello"}]}) as res:
    event = ""
    for line in res.iter_lines(decode_unicode=True):
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()
            if event == "forge":
                print("\nsettled:", json.loads(data))
            elif data != "[DONE]":
                print(json.loads(data)["choices"][0]["delta"].get("content", ""), end="", flush=True)
        elif line == "":
            event = ""
```

The OpenAI Python SDK streams too, with `stream=True` on `client.chat.completions.create`.

## Send through Oblivious HTTP

Oblivious HTTP (RFC 9458) wraps each API call for the attested key and sends it through a relay. The relay sees your address and ciphertext. The engine sees the request and the relay's address. Who is asking is hidden from the operator when you use a relay run by someone else, or Tor. A relay and a Bellows run by the same party hide nothing from that party. [Oblivious HTTP](../how-it-works/ohttp.md) has the details.

`bellowsFetch(operator, path, init)` takes the same path and `init` as `fetch` and returns the engine's answer as an ordinary `Response`, streamed answers included:

```ts
import { bellowsFetch } from './client/index.ts';

// bellows comes from verifyBellows (above). Use its first relay, or send straight to the engine.
const operator = { ...bellows, relay: bellows.relays[0] ?? null };

const wallet = await bellowsFetch(operator, '/v1/wallet', { headers: { authorization: `Bearer ${key}` } });
console.log(await wallet.json());

const res = await bellowsFetch(operator, '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'mock-echo', stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
});
const settled = await streamChat(res, (text) => process.stdout.write(text));
```

- A topup, a NUT-24 payment and a refund work through `bellowsFetch` the same way as a direct call. A `402`, `428` or `429` from the engine comes back as an answer.
- `bellowsFetch` throws `BellowsFetchError` only when the request cannot be sent or the answer cannot be opened. Its `code` is one of `bad_path`, `bad_request`, `bad_key_config`, `network`, `relay_error`, `gateway_refused` or `bad_response`. On a busy `503`, `retryAfter` holds the seconds to wait.
- Answers stream by default (chunked OHTTP). Pass `{ chunked: false }` as the fourth argument for relays that take only plain RFC 9458 messages.
- The key is new on every restart of the engine. After a refusal, verify again and use the new key.

To try a relay locally, run the one in `relay/` in front of your local engine and list it on the engine:

```sh
BELLOWS_RELAY_TARGETS=http://127.0.0.1:8787/ohttp pnpm relay      # listens on 127.0.0.1:8788
# and start the engine with:
BELLOWS_RELAYS=http://127.0.0.1:8788/relay/127.0.0.1:8787
```

The relay forwards only the body and its content type and keeps no logs. [relay/README.md](../../relay/README.md) shows how to run it as a Node server or a Cloudflare Worker.

## Handle errors

Every error is OpenAI-shaped: `{"error": {"message", "type", "code"}}`. Match on `code`.

```sh
curl -s $B/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model": "no-such-model", "messages": [{"role": "user", "content": "Hello"}]}'
# {"error":{"message":"unknown model no-such-model; see GET /v1/models","type":"model_not_found","code":"model_not_found"}}
```

The ones an app meets most:

| Status and code | What to do |
| - | - |
| `402 payment_required` | Pay: send the request again with `X-Cashu` for the amount in the body, or with a balance key |
| `402 insufficient_balance` | Top up the balance, or ask for fewer `max_tokens` |
| `401 invalid_key` | The engine does not know this key. A key works only at the engine that issued it |
| `404 model_not_found` | Pick a model from `GET /v1/models` |
| `400 untrusted_mint`, `wrong_unit`, `insufficient_amount`, `invalid_token` | The token was refused before any eCash moved. It is still yours to spend |
| `400 token_spent` | The mint reports the token as already spent |
| `403 invite_required` | The engine is invite only. Ask its operator for a code |
| `428 pow_required` | Solve the proof of work and send the request again |
| `429 rate_limited` | Wait `Retry-After` seconds |
| `502 upstream_error` | The model failed. Nothing was charged and a per-request payment comes back whole as change |
| `503 mint_unavailable` | Send the request again with the same token, or fetch its change at `GET /v1/change/{request_id}` |
| `503 topup_pending` | Send the topup again with the returned key and the same token |

`GET /v1/change/{request_id}` answers `409 not_settled` with `Retry-After` while the request still runs. The full list of codes is in [API reference](api.md#error-codes).

## Read the balance and take it back

```sh
curl -s $B/v1/wallet -H "authorization: Bearer $KEY"
# {"account_id":"acct_...","unit":"usd","balance_msub":99676,"available_msub":99676,"balance":99.676,"refundable":99}

curl -s $B/v1/wallet/refund -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' \
  | jq '{amount, unit, mint, status, token}'
```

- `balance_msub` is the balance in thousandths of the unit. `available_msub` subtracts what running requests have reserved. `refundable` is the whole units you can withdraw now.
- `POST /v1/wallet/refund` withdraws every whole unit as an eCash token, or `{"amount": N}` units. A remainder below one unit stays on the balance. Add `"pubkey": "02..."` to lock the token to your wallet key.
- If the mint does not answer, the refund answers `202` with `status: "owed"`. `GET /v1/wallet/refunds` delivers every withdrawal again, so a lost token can be fetched later.

Keep balances small. A balance lives in the engine's ledger, and moving it to another engine means withdrawing it as eCash and funding a new balance there.

## Use the client library

`client/` is TypeScript that runs in browsers and in Node. It uses Web APIs only (fetch, WebCrypto, streams). It is not published as a package: copy the directory into your app, or import it from a checkout as the examples above do (`./client/index.ts`). Its dependencies are `hpke`, `ohttp-ts`, `@noble/hashes` and `@noble/curves`; take the versions from this repository's `package.json`. Node 22.18 and later run the `.ts` files directly; a browser app builds them with its own bundler.

| Export | What it does |
| - | - |
| `verifyBellows(url, {approvedBuilds, verifier})` | Checks the attested identity against `builds.json` and returns the key, relays and build, or throws `BellowsVerifyError` |
| `tinfoilVerifier({authenticate})`, `devVerifier()` | Attestation verifiers for Tinfoil and for the development stand-in |
| `bellowsFetch(operator, path, init, options)` | One API call through Oblivious HTTP |
| `solvePow(challenge, bits)` | The proof of work for opening a balance |
| `loadOperatorAnnouncements`, `OperatorPool` | Find operators on Nostr, verify them, pick one and fail over |
| `moveBalance(pool, {from, key})` | Withdraw a balance from one operator and fund a new one at another |

[Operators](operators.md) shows the operator pool and moving a balance.

## Run your own engine

- To try it on your machine, follow [Pick an engine](#pick-an-engine). The [configuration reference](../run/configuration.md) lists every setting.
- To run one with Docker behind your own TLS proxy, see [Running a Bellows on your own server](../run/self-hosted.md). In that setup the operator can read requests in memory and can read the database.
- To run one its operator cannot read, deploy it on Tinfoil Containers with the deploy kit: the [sealed deployment guide](../run/sealed-deployment.md) goes step by step, and marks every step that has not yet been run on sealed hardware. The [threat model](../how-it-works/threat-model.md) says what each party can still see.

## How these examples were checked

Run on 2026-11-16 against a local engine at release 0.1.2 (`config/models.dev.json`, development attester), one local Nutshell 0.22.1 test mint and the relay in `relay/`, on other ports than the defaults shown here:

- the curl commands for health, the identity document, the key comparison, models, proof of work and topup, Lightning funding with a chosen key, chat, streaming, the `402` answer, errors, balance and refund;
- the JavaScript examples (`verifyBellows` with `devVerifier`, its `development_refused` refusal, topup with `solvePow`, chat, the stream reader, and `bellowsFetch` through the relay for the balance, a streamed chat, an unpaid `402` and a refund) on Node 24;
- the Python examples with `requests` on Python 3.9, and the OpenAI Python SDK 2.48.0 for models, chat, streaming and a `404`;
- `pnpm demo:agent`, with plain and with locked change.

Not run here: `verifyBellows` with `tinfoilVerifier` (it needs an `authenticate` you supply) and any paid request to the reference instance.
