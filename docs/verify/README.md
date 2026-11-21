# Building and verifying

These pages are about checking what a Bellows runs: how a release is built and measured, how a client checks the build before it sends anything, and which parts have not yet been verified.

| Page | What it holds |
| - | - |
| [Attested identity](attestation.md) | What a Bellows serves at `/.well-known/bellows`, the attesters, the approved builds in `builds.json`, how the client library checks them, and what has not been run on real sealed hardware |

## How a client checks a Bellows

At boot Bellows makes an HPKE key pair in memory and serves `GET /.well-known/bellows`: its version, the build measurement it claims, the key configuration, its relays and the operator announcement, with a hardware attestation that binds all of them. A measurement is the set of hash values, called registers, that identifies a build. Clients check that attestation, and that the attested build is listed in [`builds.json`](../../builds.json), before sending anything. The client library in [`client/`](../../client/) does this check (`verifyBellows`) in browsers and in Node. In development the attestation is a signed stand-in that clients refuse unless they opt into development mode.

## How a release is built and measured

The release workflows build and push the images, pin their digests into `tinfoil-config.yml`, tag the release, measure it with Tinfoil's measure action, and propose the build for `builds.json` in a pull request that a person reviews. [4. Release](../run/sealed-deployment.md#4-release) in the sealed deployment guide goes through it, including how to finish a release whose workflow failed. `pnpm builds:check` checks `builds.json`.

## What has not been verified yet

Each area keeps its own list, next to the text it qualifies:

- [Not verified on sealed hardware](../run/sealed-deployment.md#not-verified-on-sealed-hardware): the steps of a sealed deployment that have not been checked on Tinfoil one by one.
- [Attestation: not verified locally](attestation.md#not-verified-locally): the attestation socket, the document shape, hardware quote verification and the measurement form.
- [Oblivious HTTP: not verified locally](../how-it-works/ohttp.md#not-verified-locally): the relay as a Cloudflare Worker, third-party relays and clients, and the admission bound under real load.
- [Encrypted pass-through](../how-it-works/privacy.md#encrypted-pass-through-tinfoil-ehbp): what has been checked against a fake enclave, and the round trip against a real Tinfoil enclave that has not been run.
- [On-chain funding](../how-it-works/payments.md#on-chain-nut-30): tested against a mock of the mint, which is why it is off by default.
- [How the guide's examples were checked](../use/guide.md#how-these-examples-were-checked): which examples ran, and which did not.
