# Bellows design

Status: design and build plan, written 2026-11-12. The slices in "Build plan" are built in order on one branch.

Bellows is an open-source AI gateway that takes Cashu eCash per request and forwards the request to AI models. It started as the engine inside Forge AI and is extracted here so anyone can run one. Its goal is to be **operator-blind**: the person who runs a Bellows learns nothing worth taking from it.

## What "operator-blind" means here

Three separate things have to be hidden, by three separate mechanisms. The design is honest about each.

| What | Hidden from the operator by | Status in this design |
|---|---|---|
| The words (requests and answers) | Bellows runs inside sealed hardware (a confidential VM). Clients encrypt to a key that exists only inside it, and check a hardware proof of which build is running before sending | Built here; real hardware run needs a hosting account |
| Money and state (balances, the wallet seed, supplier keys) | The database lives on an encrypted volume and secrets are released only to an approved build, after it proves what it is | Built here; depends on the same hosting |
| Who is asking (network address, timing) | A relay run by someone else (Oblivious HTTP, RFC 9458) or Tor. The relay sees an address and no content; Bellows sees content and no address | Built here; needs a second party to run the relay |

**What stays visible, stated plainly.** Without a relay or Tor, the operator's host and its network see client addresses, timing and traffic volume. The operator can always stop the service or destroy its data. Trust remains in the hardware vendor, in the hosting platform, and in whoever controls the list of approved builds. A relay and a Bellows run by the same party hide nothing from that party.

**Wording rule for all docs and any app text:** say "the operator cannot read" only for things in the first two rows. Say "hidden from the operator when you use a relay or Tor" for the third.

## Platform

First target: **Tinfoil Containers** (Intel TDX or AMD SEV-SNP). Reasons: Bellows already speaks Tinfoil's attestation and encrypted-body format for the models; a deployment is a Docker image plus a `tinfoil-config.yml` in a public repo; the measured config goes to a public transparency log; and it offers attestation-gated secrets and an encrypted persistent volume.

Not yet confirmed and to be checked on the real platform: whether inbound TLS ends inside the sealed machine, whether access is self-serve, and price. The design does not depend on the TLS answer, because clients encrypt at the application layer to an attested key.

Second target, kept possible by the `Attester` interface: Phala Cloud / dstack (Intel TDX), which is self-serve.

Everything platform-specific sits behind small interfaces with a development implementation, so the whole system runs and is tested on a laptop. Anything that could only be exercised on real sealed hardware is listed under "Not verified locally" at the end of the build.

## Architecture

```
client ──(OHTTP, encrypted to the enclave key)──> relay ──> Bellows (sealed) ──> AI models
   │                                              (someone else)      │
   └── checks the hardware proof and the approved-builds list         ├── encrypted volume: SQLite (balances, proofs)
                                                                       └── secrets released by a keyserver to approved builds only
```

- **Enclave identity.** At boot Bellows creates an HPKE key pair in memory. It asks the platform for a hardware attestation that binds the hash of the public key, and serves both at `/.well-known/bellows`. The private key never leaves memory and is new on every boot.
- **Client check.** Before sending anything, a client fetches `/.well-known/bellows`, verifies the attestation, and checks that the measured build is on the approved-builds list. A failed check means nothing is sent.
- **Requests.** Clients wrap each API call as Oblivious HTTP to the enclave key. Sent through a relay, the relay learns the address and Bellows learns the content. Sent directly, the content is still unreadable to anything in front of the sealed machine.
- **Models.** Private models keep their existing end-to-end encryption to the model's own enclave. Bellows passes those bodies through unread, as it does today.
- **State.** One SQLite file on the encrypted volume. The wallet seed is derived from a secret the keyserver releases, so a restored volume and a fresh one agree on the seed.
- **Operator view.** Aggregates only: totals, counts and health. No per-customer rows, no addresses, no request contents, in the API, the logs or the database.
- **Many operators.** Each operator publishes a signed announcement (address, relays, onion address, build). Clients keep a list and move to the next when one fails. Balances do not move between operators; a client withdraws its balance as eCash and funds the next one.

## Approved builds and upgrades

`builds.json` in this repo lists each approved release: version, image digest and measurement. The keyserver policy releases secrets only to a listed build, and clients accept only a listed build. An operator who edits their own keyserver policy to approve a malicious build can extract state; clients detect that build because it is not on the public list. This is the known weak point of version 1 and is written in `docs/THREAT-MODEL.md`. A later version moves approval to a key that the day-to-day operator does not hold.

The encrypted volume has no rollback detection on the first target platform. Version 1 documents this; it does not solve it.

## Build plan

One branch, slices in order. Every slice ships with tests. Local test mints are the ones in `docker-compose.test.yml`.

### S1. Stand alone

Make this repo a self-contained engine named Bellows.

- Package name `bellows`; README written for an operator; no Forge branding in code or docs except as an example deployment.
- Environment variables renamed from `FORGE_*` to `BELLOWS_*`. No aliases. Add `docs/MIGRATE-FROM-FORGE-AI.md` with the full mapping.
- Remove serving of the web app, service worker and admin pages (the `public/` tree is not in this repo). Remove the beta waitlist. Keep invites as an optional gate, off by default.
- The HTTP API for clients is unchanged: same paths and bodies, so the existing Forge AI app works against a Bellows.
- All unit and e2e tests pass; tests for removed features are deleted with the features, not skipped.

### S2. Blind by default

Nothing that identifies a client is stored, logged or shown.

- No client address, user agent, referrer or forwarded-for value in logs, the database or errors. A test fails if any appears.
- Rate limits no longer key on the address. Key on the account token where there is one; otherwise use a global budget. Funding endpoints that today limit per address get a small proof-of-work challenge instead.
- Requests table: keep only what billing needs, as daily aggregates per model and supplier (count, tokens, price, cost). No per-request row tied to an account after settlement.
- Admin API returns aggregates only: revenue, total owed to customers, counts, supplier costs, health. Remove per-account listings, per-funding listings and per-request listings. Revenue export stays.
- Account balances stay, since a balance is what the token buys. The token is random and tied to nothing else.

### S3. Sealed state

- All secrets (supplier API keys, wallet secret, admin token) come from one secrets source behind an interface: a file path for local use, the platform's released secrets in production. No secret in environment literals in the deploy config.
- The wallet seed is derived from the released wallet secret with HKDF, not generated and stored in the database. A migration path covers an existing database that holds a stored seed: keep using the stored seed and say so at startup.
- Database path is configurable and expected on the encrypted volume; startup refuses to run in production mode if the path is not on a mount named in config.
- Startup prints which mode it is in (development or sealed) and never prints a secret.

### S4. Attested identity

- `Attester` interface: `attest(reportData) -> attestation document`. Implementations: `dev` (a signed stand-in, clearly marked, refused by clients unless they opt into development mode) and `tinfoil` (reads the platform's attestation; mark the platform call NOT VERIFIED if it cannot be exercised locally).
- HPKE key pair created at boot. `/.well-known/bellows` returns: version, build measurement, HPKE key config, attestation document binding the key hash, relay list, and the operator announcement.
- `builds.json` format and a checker.
- Client library `client/` (TypeScript, runs in browsers and Node, no Node-only APIs): `verifyBellows(url, {approvedBuilds, verifier})` returns the verified key config or throws. The hardware verification is pluggable so the Tinfoil verifier can be supplied by the app.

### S5. Oblivious HTTP

- Bellows is an OHTTP gateway (RFC 9458) for its own API: `POST /ohttp` takes an encapsulated request for any client API path and returns the encapsulated response. Key config at `/ohttp-keys`, and it is the attested HPKE key.
- Client library: `bellowsFetch(operator, path, init)` encapsulates, sends through a relay when one is configured or directly otherwise, and decapsulates.
- `relay/`: a small standalone relay that forwards opaque bodies to an allowlisted Bellows, strips every identifying header, keeps no logs, and runs as a Node server and as a Cloudflare Worker.
- Streaming: use chunked OHTTP if a maintained library supports it; otherwise answers through the relay are not streamed and the limitation is documented.
- Tests: a full round trip client → relay → Bellows against the local mints; the relay never holds plaintext; Bellows never receives the client address; a tampered or replayed request fails.
- Use a maintained OHTTP library. Verify it exists, check its license, and respect the repo's package release-age rule.

### S6. Operators

- Signed operator announcement as a replaceable Nostr event: address, relays, onion address, build measurement, units and mints accepted. A script publishes it with the key read from a hidden prompt.
- Client library: load a list of operators, verify each, health-check, pick one, fail over on error, and remember the last good one.
- "Move balance": withdraw the remaining balance as eCash from one operator and fund another. A test covers it with two local Bellows instances.

### S7. Deploy kit

- `tinfoil-config.yml`, a hardened Dockerfile (non-root, read-only filesystem), a release workflow that builds the image, pins its digest, measures it and updates `builds.json`.
- A test parses `tinfoil-config.yml` and fails if any container other than `bellows` has `attestation: true`. Any container that can reach the attestation socket can obtain a quote over any nonce, and so could attest a statement with its own key (docs/ATTESTATION.md).
- Keyserver policy example (file-based) and how to back up the volume secret offline.
- Optional Tor onion service as a sidecar, with its key on the encrypted volume.
- `docs/OPERATE.md` (run one, step by step) and `docs/THREAT-MODEL.md` (what each party can see, using the wording rule above).
- Mark every step that needs real sealed hardware as NOT VERIFIED until it has been run there.

### S8. Forge AI fit

- A test proves the unchanged Forge AI client calls (wallet, funding, chat, refunds, change) work against Bellows directly and through OHTTP.
- `docs/API.md`: the client API, the operator API and the discovery format, written so another app can use a Bellows without reading the code.
