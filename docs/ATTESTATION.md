# Attested identity

A client checks which build a Bellows runs before it sends anything. This page describes what a Bellows serves for that check, how the check works, and which parts have not been exercised on real sealed hardware.

## What a Bellows serves

At boot Bellows makes an HPKE key pair (DHKEM(X25519, HKDF-SHA256)) in memory. The private key never leaves memory and is new on every boot. Bellows then writes a statement and asks its attester for a hardware attestation that binds the statement's hash. `GET /.well-known/bellows` returns:

```json
{
  "format": "bellows-identity/v1",
  "statement": "<base64 of the statement JSON bytes>",
  "attestation": { "format": "<attestation format URI>", "...": "..." }
}
```

The statement, after base64 decoding:

```json
{
  "version": "0.1.0",
  "measurement": { "type": "<format URI>", "registers": ["<lowercase hex>"] },
  "hpke": { "key_config": "<base64, RFC 9458 key configuration>" },
  "relays": ["https://relay.example/relay/bellows.example"],
  "operator": null,
  "storage": "volume"
}
```

- `version` is the Bellows release.
- `measurement` is the build the server claims to be, or `null`. A client never trusts this claim. It trusts only the measurement the attestation proves, and it refuses a claim that differs.
- `hpke.key_config` is one key configuration in the encoding of RFC 9458, section 3.1: key id, KEM `0x0020`, the 32-byte public key, and the cipher suites (HKDF-SHA256 with AES-128-GCM).
- `relays` lists the Oblivious HTTP relays for this Bellows (`BELLOWS_RELAYS`), each the full URL a client posts encapsulated requests to ([OHTTP.md](OHTTP.md)).
- `operator` is the operator's signed announcement (a Nostr event, [OPERATORS.md](OPERATORS.md)) from `BELLOWS_OPERATOR_ANNOUNCEMENT_FILE`, or `null`. Startup checks that it is signed and matches the configuration. Because the attestation covers it, a client can check that the Bellows it verified belongs to the operator who announced it.
- `storage` is `BELLOWS_STORAGE`: `volume`, or `memory` for a deployment without a volume, where every restart loses every balance ([OPERATE.md](OPERATE.md#running-without-a-volume)). The measured config sets it, `pnpm deploy:check` refuses a config where it does not match the mounts, and a sealed Bellows refuses to start saying `volume` with its database on a `tmpfs`. A statement without it means `volume`.
- `balance_max` is present with `memory` only: the most one balance may hold, per unit, in whole units (`BELLOWS_MEMORY_MAX_BALANCE_USD` in cents and `BELLOWS_MEMORY_MAX_BALANCE_SAT`), so a client can warn people before they fund past it. Being in the statement, it cannot be raised in transit.

The attestation binds

```
binding = SHA-256( "bellows-identity/v1" || 0x00 || statement bytes )
```

The statement travels as base64, so client and server hash the same bytes and nothing is re-serialized. Anyone between the client and the sealed machine who changes the key, a relay or the announcement breaks the binding.

The document is made at boot and again every `BELLOWS_ATTEST_REFRESH_MINUTES` (default 360), because platform collateral ages. While a refresh fails, the last good document is served. Until the first attestation succeeds, the endpoint answers `503 not_attested` with `Retry-After`.

## Attesters

`BELLOWS_ATTESTER` picks one. The default is `dev` in development mode and `tinfoil` in sealed mode. Sealed mode refuses `dev`.

### dev

A signed stand-in for development and tests. It is marked with the format `urn:bellows:attestation:dev:v1` and a warning that it proves nothing. It signs a payload (`report_data`, `measurement`, `issued_at`) with an ECDSA P-256 key made in memory. Its measurement has the type `urn:bellows:measurement:dev:v1` and one register, `BELLOWS_DEV_MEASUREMENT` or a fixed default. Anyone can make one, so clients refuse it unless they opt into development mode.

### tinfoil

For Tinfoil Containers. Set `attestation: true` on the Bellows container in `tinfoil-config.yml`; the enclave then gives the container the socket `/tinfoil/attestation.sock` (`BELLOWS_TINFOIL_ATTESTATION_SOCKET`). Bellows asks it for

```
GET /.well-known/tinfoil-attestation?nonce=<binding as 64 hex characters>
```

and serves the V3 document it returns (format `https://tinfoil.sh/predicate/attestation/v3`) as the attestation. In that document the CPU quote's REPORT_DATA is

```
SHA-256( "https://tinfoil.sh/report-data/v1" || nonce || SHA-256(crypto_material) || SHA-256(device_evidence) ) || 32 zero bytes
```

so the hardware binds the Bellows statement through the nonce. Before serving a document, Bellows makes the same binding checks a client makes. On Tinfoil, leave `BELLOWS_BUILD_MEASUREMENT` unset: the measurement covers `tinfoil-config.yml` itself, so the config cannot carry it, and the statement's claim is `null`. Clients rely on the measurement the attestation proves, never on the claim.

Only the Bellows container may have `attestation: true` in `tinfoil-config.yml`. Any container that can reach the attestation socket can obtain a quote over any nonce, and so could attest a statement with its own key. Tinfoil's runtime policy says the same: fetching a quote does not identify the requesting container. A Tor sidecar or any other container in the enclave runs without attestation access. `pnpm deploy:check` refuses a config that breaks this rule, and `test/unit/deploy.test.ts` checks it on `tinfoil-config.yml` and on both templates in `deploy/` ([OPERATE.md](OPERATE.md)). Only the Bellows container may receive secrets or mount its volume.

## Approved builds

`builds.json` at the repository root lists each approved release:

```json
{
  "format": "bellows-builds/v1",
  "builds": [
    {
      "version": "1.0.0",
      "image": "ghcr.io/example/bellows@sha256:<64 hex>",
      "measurement": { "type": "<format URI>", "registers": ["<lowercase hex>"] },
      "released": "2026-12-01",
      "deployment": "example/bellows-deploy@v1.0.0"
    }
  ]
}
```

`notes` and `deployment` are optional. A Tinfoil measurement covers the whole measured `tinfoil-config.yml`, and each operator's config differs (its keyserver, its mints), so one release can have one approved build per operator deployment. `deployment` names the measured config as `owner/repo@tag`, the same repository and tag the operator's keyserver policy pins. The checker refuses unknown members, an image not pinned by digest, malformed registers, a version listed twice for the same deployment, a malformed deployment and one measurement under two builds. Run it with `pnpm builds:check [path]`. The list is empty until the first release is built and measured on the platform.

A Tinfoil build's measurement has the type `https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1` (`TINFOIL_RELEASE_MEASUREMENT_TYPE` in `client/`) and three registers: the SEV-SNP launch measurement, then TDX RTMR1 and RTMR2, as Tinfoil's measure action publishes them in `tinfoil-deployment.json`. The release workflow writes the entry (`pnpm builds:add`) and proposes it in a pull request ([OPERATE.md](OPERATE.md#4-release)). An app's `authenticate` should return the measurement of the release it authenticated in this form.

## The client library

`client/` is TypeScript that runs in browsers and in Node. It uses Web APIs only (fetch, WebCrypto, TextEncoder) and typechecks without Node types (`client/tsconfig.json`).

```ts
import { tinfoilVerifier, verifyBellows } from './client/index.ts';

const bellows = await verifyBellows('https://bellows.example', {
  approvedBuilds: buildsJson,
  verifier: tinfoilVerifier({ authenticate }),
});
// bellows.keyConfig is the attested HPKE key. If verifyBellows throws, send nothing.
```

`verifyBellows` fetches `/.well-known/bellows` and then:

1. refuses a development stand-in unless `allowDevelopment` is set;
2. picks the verifier for the attestation format and has it check that the attestation is authentic and binds the statement;
3. finds the proved measurement in the approved builds;
4. refuses a statement whose claimed measurement or version differs from the approved build;
5. returns the key configuration, the build, the relays, the operator announcement, the storage and the balance cap (`balanceMax`, or `null`).

Every refusal is a `BellowsVerifyError` with a stable `code`.

Hardware verification is supplied by the app. `tinfoilVerifier` checks the document's format, that its nonce is the binding, both endorsed section hashes, and REPORT_DATA. It then calls the app's `authenticate`, which must check the SEV-SNP report or TDX quote (vendor certificate chain, collateral, provenance) and return the measurement it proves together with the REPORT_DATA read from the authenticated quote. `tinfoilVerifier` refuses the document unless that REPORT_DATA equals the recomputed value. The `challenge.report_data` field in the JSON is not authenticated, so the comparison uses the quote's own field. `devVerifier` checks the stand-in's signature and binding, and can pin its signing keys with `trustedKeys`.

## Not verified locally

These parts follow the platform's public documentation and have not been run on real sealed hardware:

- The Tinfoil attestation socket, its request and its responses. Tinfoil marks fresh attestation from containers as beta. Tests use a stand-in socket and a stand-in quote.
- The V3 document shape beyond the fields described above. The binding checks follow Tinfoil's documentation and the document parser in its open-source Go verifier; the REPORT_DATA derivation is checked against a test vector published with that verifier.
- Hardware quote verification and the measurement it yields. The client leaves this to the app's `authenticate`; no implementation ships here.
- The form of a Tinfoil measurement in `builds.json` (above) matching what an app's `authenticate` returns for a real enclave, and the release workflow that computes it, which has not run on GitHub.
- How long Tinfoil's collateral stays valid, and so the right refresh interval.
- Tinfoil's measured `attested-keys`: a key declared in `tinfoil-config.yml`, made once per enclave boot, and endorsed in every quote as a `crypto_material` entry with the format `https://tinfoil.sh/key/spki/v1`. This is the platform's own key binding. Bellows binds its HPKE key through the nonce today. Moving the HPKE key into an attested key is a possible later hardening.
