<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/bellows-mark-dark.svg">
    <img src="docs/brand/bellows-mark-light.svg" alt="Bellows logo: a gold ring and a green ring around a closed lock" width="140">
  </picture>
</p>

# Bellows

Bellows is an open-source AI gateway that you pay with Cashu eCash. It speaks the OpenAI API: point any OpenAI client at it, pay with eCash, and it forwards your request to an AI model from a supplier its operator chooses. eCash is digital cash that a Cashu mint issues as tokens, which a wallet holds and can hand to anyone, like banknotes.

Bellows started as the engine inside Forge AI, which remains an example deployment, and is extracted here so anyone can run one. It is licensed MIT.

## Who it is for

- **App, agent and script developers** who want to pay for AI requests with eCash, per request or from a prepaid balance.
- **Operators** who want to run a gateway for others, on their own server or sealed on Tinfoil Containers.
- **Contributors** who want to help build it. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## What works today

- **Two ways to pay.** Pay each request with an eCash token in a header and get the unused value back as change (NUT-24, the Cashu standard for paying an HTTP request). Or top up a prepaid balance and use its `sk-forge-...` key like a normal API key, and withdraw what is left as eCash at any time.
- **Other ways to fund a balance.** A balance can also be funded by paying a Lightning invoice, by sending bitcoin on-chain (off by default), or with eCash from another Cashu mint.
- **Sealed deployments.** Bellows aims to be operator-blind: the person who runs one learns nothing worth taking from it. With the deploy kit on Tinfoil Containers, it runs in sealed hardware, a confidential virtual machine that keeps its memory from the host. Before sending anything, a client checks a hardware attestation: a signed statement from the processor about which build is running. Releases 0.1.0, 0.1.1 and 0.1.2 were built and measured this way and are listed in [`builds.json`](builds.json), and the reference instance at `https://bellows.island-bitcoin.containers.tinfoil.dev` runs 0.1.2.
- **Hiding who is asking.** With Oblivious HTTP (OHTTP), a client encrypts each call and sends it through a relay. The relay sees the client's address but not the request; Bellows sees the request and the relay's address. Who is asking is hidden from the operator when someone else runs the relay, or when the client uses Tor.
- **Many operators.** Each operator publishes a signed announcement, and the client library picks one, fails over to the next and can move a balance between them.

Current limits:

- The operator-blind work is in progress. The [design](docs/how-it-works/design.md) says what each step hides and what stays visible, and the [threat model](docs/how-it-works/threat-model.md) says what each party can see.
- Not every part of a sealed deployment has been checked on sealed hardware yet. [Not verified on sealed hardware](docs/run/sealed-deployment.md#not-verified-on-sealed-hardware) lists what is still open.
- Run anywhere else, on your own server or in Docker, a Bellows is not sealed: its operator can read plaintext requests in memory and can read its database. Requests encrypted end to end to a model that runs in its supplier's sealed hardware (an enclave model) stay unreadable to the gateway in either case.
- Fedimint eCash is not accepted yet ([why](docs/how-it-works/payments.md#not-yet-fedimint)).
- Bellows serves the API only. It has no web page: client apps such as a chat app, an agent or a script run elsewhere and call the API.

## Quick start

This runs a Bellows on your machine with local test mints (Nutshell with its FakeWallet backend), whose Lightning invoices count as paid without any real payment. You need Node 22.18 or later (24 recommended), pnpm, Docker and `jq`.

```sh
pnpm install --frozen-lockfile
pnpm mint:up                                  # three local Nutshell test mints (usd and sat)
export BELLOWS_TRUSTED_MINTS=http://127.0.0.1:3338 BELLOWS_MODELS_FILE=config/models.dev.json BELLOWS_DB_PATH=data/dev.db
pnpm start &                                  # http://localhost:8787
TOKEN=$(pnpm -s test-token 50 usd)            # test eCash worth 50 cents
```

Opening a new balance takes a small proof of work. This solves one with the client library and tops up a new balance with the token:

```sh
SOLUTION=$(node --input-type=module -e "
  import { solvePow } from './client/pow.ts';
  const { challenge, bits } = await (await fetch('http://localhost:8787/v1/pow')).json();
  console.log(await solvePow(challenge, bits));")
KEY=$(curl -s localhost:8787/v1/wallet/topup -H 'content-type: application/json' \
  -H "X-Bellows-Pow: $SOLUTION" -d "{\"token\": \"$TOKEN\"}" | jq -r .key)
```

`KEY` now holds a new `sk-forge-...` balance key. Use it as a bearer key:

```sh
curl -s localhost:8787/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"model": "mock-echo", "messages": [{"role": "user", "content": "Hello"}]}'
```

The agent demo pays for a request end to end with a token in a header (NUT-24):

```sh
BELLOWS_URL=http://localhost:8787 DEMO_FAKE_MINT=1 pnpm demo:agent "What is eCash?"
```

On first start Bellows creates `data/secrets.json` next to the new database, holding a fresh wallet secret. `config/models.dev.json` adds mock models (`mock-echo`, `mock-slow`), so everything works without supplier keys; [Model catalog](docs/run/configuration.md#model-catalog) says how to add the real suppliers. The [Build on Bellows guide](docs/use/guide.md) goes through the same steps with curl, JavaScript and Python.

## Documentation

Pick what you want to do. The [docs home](docs/README.md) lists every page.

| I want to | Start here |
| - | - |
| Use a Bellows from my app, agent or script | [Build on Bellows guide](docs/use/guide.md), then the [API reference](docs/use/api.md) |
| Choose among operators, or move a balance | [Operators](docs/use/operators.md) |
| Run a Bellows on my own server | [Running a Bellows on your own server](docs/run/self-hosted.md) and the [configuration reference](docs/run/configuration.md) |
| Run a sealed Bellows its operator cannot read | [Sealed deployment guide](docs/run/sealed-deployment.md) |
| Manage a running Bellows | [Admin API and admin CLI](docs/run/admin.md) |
| Move from a Forge AI deployment | [Migrating from Forge AI](docs/run/migrate-from-forge-ai.md) |
| Check which build a Bellows runs | [Building and verifying](docs/verify/README.md) and [Attested identity](docs/verify/attestation.md) |
| Understand how it works and what it hides | [How it works](docs/how-it-works/README.md): design, payments, Oblivious HTTP, privacy and the threat model |
| Contribute code or docs | [CONTRIBUTING.md](CONTRIBUTING.md) and [Contributing docs](docs/contributing/README.md) |

## License

MIT. See [LICENSE](LICENSE).
