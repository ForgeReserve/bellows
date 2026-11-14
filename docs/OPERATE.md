# Operating a Bellows

This page runs a Bellows on Tinfoil Containers, step by step, so that its operator cannot read the requests, the answers, the balances or the keys. What each party can still see is in [THREAT-MODEL.md](THREAT-MODEL.md).

**NOT VERIFIED** marks every step that needs real sealed hardware. Those steps follow Tinfoil's public documentation and the deploy kit in this repository, and have not yet been run on Tinfoil. Everything else here has been run locally. "Not verified on sealed hardware" at the end lists the open points.

## The deploy kit

| File | What it is |
| - | - |
| `tinfoil-config.yml` | Your deployment, the file Tinfoil measures: the Bellows container, its encrypted volume, its egress allowlist, the secrets it asks your keyserver for, and the paths it serves. It starts as a copy of `deploy/tinfoil-config.example.yml` |
| `deploy/tinfoil-config.example.yml` | The template for `tinfoil-config.yml`. Leave it as it is; the tests check the templates |
| `deploy/tinfoil-config.onion.example.yml` | The template with a Tor onion service as a sidecar ([Onion service](#onion-service)) |
| `Dockerfile` | The Bellows image: base pinned by digest, non-root, read-only root file system, no package manager |
| `deploy/tor/` | The Tor sidecar image |
| `deploy/keyserver/policy.example.yaml`, `store.example.json` | Example policy and file store for your keyserver |
| `.github/workflows/tinfoil-release.yml`, `tinfoil-release-publish.yml` | The release: build and push the images, pin their digests, tag, measure, and propose the build for `builds.json` |
| `pnpm deploy:check [--release]` | Checks a config against the rules below |
| `pnpm deploy:pin`, `pnpm builds:add` | The release workflow's steps, for running by hand |

The rules `pnpm deploy:check` enforces, and why:

- **Only the `bellows` container has `attestation: true`.** Any container that can reach the attestation socket can obtain a quote over any nonce, and so could attest a statement with its own key ([ATTESTATION.md](ATTESTATION.md)). A Tor sidecar or any other container runs without it.
- **Secrets come from your keyserver, and only Bellows gets them.** `keyserver-url` is required. Secrets are never `env` values and never Tinfoil-managed secrets, which Tinfoil's infrastructure can read. No container other than `bellows` lists `secrets`.
- **The database is on the encrypted volume.** Bellows runs sealed (`BELLOWS_MODE=sealed`), the database path is under a mount listed in `BELLOWS_SEALED_MOUNTS`, that mount is a persistent volume, and every volume has a `key-secret` so it unlocks at boot with a key only your keyserver releases. A volume belongs to one container: no other container mounts Bellows' volume.
- **Every setting is measured.** Every `env` entry is a literal in the measured file. A bare name, whose value would come from an unmeasured instance variable, is refused.
- **Nobody gets in.** No `cvm_admin`, no `ports`, no `cvm-network`, no capabilities, no root user, and `read_only: true` on every container, so no writable root file system.
- **Bellows reaches only what it needs.** Its egress network is an allowlist: your mints, the suppliers in `config/models.json`, the price sources and the Nostr relays for mint discovery. The test suite checks that the allowlist covers every host the config uses.
- **Requests reach Bellows only**, on the paths it serves.
- **For a release**, `--release` also refuses example values and an image digest that is still a placeholder.

## What you need

- A Tinfoil organization with Containers enabled, an organization admin key and the Tinfoil CLI (`tinfoil login`).
- A GitHub account for a **public** deploy repository. Tinfoil measures the config in a public repository so that anyone can check it.
- A server for your keyserver with a domain and a certificate from a public certificate authority (Let's Encrypt works; self-signed is refused). It must be reachable from the enclave at every boot.
- The mints you accept, and API keys for the suppliers you use.
- Your suppliers' rate cards. Bellows serves a model only when its price in `config/models.json` is marked `price_verified: true`, so check each price you sell and mark it; a model left unverified is not listed or routable. `BELLOWS_SERVE_UNVERIFIED_PRICES=true` serves them anyway and logs that at error level at every start; it sits in the measured config, so anyone reading your deploy repository sees it.
- A machine you keep offline, for making and backing up the keys.

## 1. Make your deploy repository

Copy this repository to a new public repository (a fork works). It is your deployment: the code, the measured config and its release workflows.

Edit `tinfoil-config.yml`, not the templates in `deploy/`. The test suite, which the release runs, checks the templates against their example values and checks your `tinfoil-config.yml` against the rules above.

- `keyserver-url`: your keyserver.
- `BELLOWS_TRUSTED_MINTS` (and `BELLOWS_FUND_MINT` if you set it): your mints. Add each mint's host to the `egress` allowlist.
- Any other setting in [README.md](../README.md#configuration). Add it as a quoted literal.
- If you change `config/models.json`, list each supplier's API key under `secrets` and its host in the allowlist.

Then check it:

```sh
pnpm install --frozen-lockfile
pnpm deploy:check
```

In the repository settings, allow GitHub Actions to create pull requests (Settings, Actions, General). The release workflow proposes each build as a pull request.

## 2. Make the keys, offline

On the offline machine:

```sh
openssl rand -base64 32     # BELLOWS_DATA_VOLUME_KEY: unlocks the encrypted volume
openssl rand -hex 32        # BELLOWS_WALLET_SECRET: the wallet seed is derived from it
openssl rand -hex 32        # your admin token; keep it in your password manager
printf %s '<admin token>' | sha256sum     # BELLOWS_ADMIN_TOKEN_HASH
```

Generate the admin token with `openssl rand -hex 32` and nothing else. The shim in `tinfoil-config.yml` serves `/admin/api` at your public origin, because TLS ends inside the sealed machine and no proxy of yours can stand in front of it. The token is the admin API's only protection, with a budget of 10 failed logins a minute. Bellows receives only its hash, so it cannot refuse a short or guessable token. If you do not need the admin API, remove `/admin/api` and `/admin/api/*` from the shim's `paths` before the release, and leave `BELLOWS_ADMIN_TOKEN_HASH` empty.

### Back up the volume key and the wallet secret

These two values are the only way back to the money:

- **The volume key** opens the encrypted volume, which holds the ledger: every customer balance and the state of the gateway's eCash wallet. If it is lost, the volume cannot be opened by you, by Tinfoil or by anyone. It never changes: a new key cannot open the existing volume, and Tinfoil's secret rotation does not re-encrypt it.
- **The wallet secret** derives the wallet's keys. With it, the gateway's eCash can be recovered from the mint (NUT-09 restore, [PAYMENTS.md](PAYMENTS.md)) even without the volume. Customer balances cannot: they live only in the ledger on the volume.

Keep both offline before anything is written to the volume:

1. Write each value on paper, twice, or save it encrypted with a passphrase on two USB drives (for example `age -p -o volume-key.age`). Keep the copies in two places.
2. Check each copy by reading it back on the offline machine and comparing it with the original (`sha256sum`).
3. Never put either value in Tinfoil's secret store, in a repository, in email or in chat.

With the onion service, back up `BELLOWS_ONION_VOLUME_KEY` the same way. Losing it loses the onion address.

## 3. Run your keyserver

Run Tinfoil's reference keyserver ([github.com/tinfoilsh/keyserver](https://github.com/tinfoilsh/keyserver)) on your server, with its TLS certificate. Pin its image to a release; this kit was written against release `v0.0.5` (its image tag has no `v`: `ghcr.io/tinfoilsh/keyserver:0.0.5`).

- Copy `deploy/keyserver/policy.example.yaml` and fill it in. You add the approval for your first release in step 5.
- Choose a backend: HashiCorp Vault, AWS Secrets Manager or a local file. For the file backend, copy `deploy/keyserver/store.example.json`, fill it in on the offline machine, move it to the server and `chmod 600` it.
- The keyserver must serve `/challenge` and `/fetch` directly at `keyserver-url`, without redirects.

The keyserver releases a secret only to an enclave whose fresh attestation proves it runs your repository at an approved tag and holds a certificate for your instance's domain. You run it, so you decide which release gets your secrets. That is also the known weak point: see [THREAT-MODEL.md](THREAT-MODEL.md#the-operator-approves-releases).

NOT VERIFIED: the keyserver's release to a Bellows enclave, and every secret arriving as an environment variable.

## 4. Release

Set `version` in `package.json`, commit, and run the **Tinfoil Release** workflow (Actions tab, or `tinfoil repo build run <owner>/<repo> --version v1.0.0`) with `v` and that version. It:

1. type-checks and tests the code, including the end-to-end suite against local mints;
2. builds and pushes the Bellows and Tor images to GitHub's container registry, with timestamps from the release commit;
3. pins their digests into `tinfoil-config.yml`, the file Tinfoil measures: the `bellows` image, and the `tor` image when your config has the onion service (`pnpm deploy:pin tinfoil-config.yml bellows=<image> tor=<image>`). It then runs `pnpm deploy:check --release`, which refuses any container left with a placeholder digest;
4. commits the pinned config, tags that commit and pushes the tag;
5. starts **Tinfoil Release - Publish**, which measures the tagged config with Tinfoil's measure action. That action signs the measurement into the Sigstore transparency log and publishes a GitHub release with `tinfoil-deployment.json`;
6. adds the build to `builds.json` (`pnpm builds:add`) and opens a pull request.

Review that pull request. The entry names the version, the image digest, the measurement (`https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1`: the SEV-SNP launch measurement, then TDX RTMR1 and RTMR2) and the deployment (`<owner>/<repo>@v1.0.0`). Check the measurement against `tinfoil-deployment.json` in the GitHub release and its Sigstore entry, read `tinfoil-config.yml` at the tag, and merge.

Clients accept the build only once it is in the `builds.json` they trust. A Tinfoil measurement covers the whole measured config, and each operator's config differs (its keyserver, its mints), so each operator deployment is its own entry. To be listed in the public Bellows `builds.json`, open a pull request there with the same entry.

### If a step fails

- **Tinfoil Release failed before it pushed the tag.** Nothing was published. Fix the cause and run it again with the same version.
- **The tag exists, and Tinfoil Release - Publish never started or failed before the GitHub release `v<version>` exists.** Tinfoil Release refuses an existing tag, so start Publish on the tag yourself:

  ```sh
  gh workflow run tinfoil-release-publish.yml --ref v<version>
  ```

- **The GitHub release `v<version>` exists, and there is no builds pull request.** The measure action refuses to publish a release twice, so do not run Publish again. Make the pull request by hand from the published measurement:

  ```sh
  git switch -c builds/v<version> origin/<default branch>
  gh release download v<version> --pattern tinfoil-deployment.json --dir /tmp/bellows-release
  pnpm builds:add --deployment-file /tmp/bellows-release/tinfoil-deployment.json \
    --version <version> --deployment <owner>/<repo>@v<version>
  pnpm builds:check
  git commit -am "builds: approve v<version>" && git push origin builds/v<version>
  gh pr create --title "builds: approve v<version>" --fill
  ```

  Review it as above before merging.

NOT VERIFIED: the workflows have not run on GitHub; Tinfoil's measure action has not measured this config; the image build has not been checked for reproducibility.

## 5. Approve the release in your keyserver

Add a workload entry to your policy for the new tag, with your repository, the tag and your instance's domain, and restart the keyserver. Approve only a release whose build is in the public `builds.json`. Keep the entry of the previous release while it may still need to boot (a rollback).

Sign your operator announcement now that the measurement is known, and put it in the keyserver store as `BELLOWS_OPERATOR_ANNOUNCEMENT`:

```sh
pnpm announce --url https://<your domain> --unit usd --unit sat --mint https://<your mint> \
  --deployment <owner>/<repo>@v1.0.0 --out announcement.json --nostr wss://<nostr relay>
```

It must match the measured config (units, mints, relays, version), or Bellows refuses to start. It is public; it travels through the keyserver only because the measured config cannot name the measurement it is measured into.

## 6. Create the volume and the instance

```sh
tinfoil container hosts
tinfoil volume create bellows-data --size 16GB --host <host>
tinfoil container create bellows --repo <owner>/<repo> --tag v1.0.0 --volume bellows-data:data
```

Leave debug mode off. A debug instance ignores the keyserver and takes Tinfoil-managed secrets instead; never point one at a real volume or real keys. Do not create any of the values from step 2 in Tinfoil's secret store, and do not pass `--secret`.

On boot, the enclave fetches the declared secrets from your keyserver, unlocks the volume at `/data`, and starts Bellows. Bellows starts only in sealed mode with its database on that mount, and logs a `startup` line naming the mode, the mount and the attester, never a secret.

NOT VERIFIED: volume creation, first-boot initialization of a blank volume through `key-secret`, the volume's mount point appearing in `/proc/self/mountinfo`, and the shim's handling of streamed answers.

## 7. Check it

```sh
curl https://<your domain>/healthz
curl https://<your domain>/.well-known/bellows
```

- `/.well-known/bellows` must return an attestation, not `503 not_attested`. Verify it the way a client does, with `verifyBellows` from `client/` and your `builds.json` ([ATTESTATION.md](ATTESTATION.md)). It must find your build.
- The instance logs show `startup` with `"mode":"sealed"` and `"sealed_mount":"/data"`, then `attested` with `"attester":"tinfoil"`.
- `GET /v1/models` lists the models you mean to sell. A warning `unverified_prices_withheld` names models left out because their price is not verified; an error `unverified_prices_served` means `BELLOWS_SERVE_UNVERIFIED_PRICES` is on.
- The admin API answers with your admin token at `https://<your domain>/admin/api/overview`, and 401 without it. It is on the public origin ([README.md](../README.md#admin-api)).

NOT VERIFIED: a real Tinfoil attestation of a Bellows, and its verification with an app's `authenticate`.

## Onion service

`deploy/tinfoil-config.onion.example.yml` adds a Tor onion service. Clients that reach Bellows through Tor hide their address from the operator. To use it:

1. Copy it over `tinfoil-config.yml` (Tinfoil reads only that path) and make the same edits as in step 1. Leave the template itself as it is. The release pins both the `bellows` and the `tor` image in `tinfoil-config.yml`.
2. Make and back up `BELLOWS_ONION_VOLUME_KEY` (step 2), and add it to your keyserver store and policy.
3. Create a second volume and attach it to the `onion` mount: `--volume bellows-data:data --volume bellows-onion:onion`.
4. After the first boot, the tor container logs `bellows-onion: onion address <address>.onion`. Add it to your announcement (`--onion http://<address>.onion`), update the keyserver store, and redeploy.

The tor container runs as an unprivileged user on a read-only root file system. It has open egress, because it must reach Tor relays, and it has no secrets, no attestation access and no access to Bellows' volume; `pnpm deploy:check` refuses a config that gives it any of these. Its keys, and so the onion address, live on their own encrypted volume. It forwards port 80 of the onion address to `bellows:8787` over a network with no egress.

Checked locally: the image builds, and `--verify-config` accepts the configuration the entrypoint writes, in a read-only container with no capabilities. NOT VERIFIED: Tor reaching its relays from Tinfoil's open egress, the onion service answering, and the onion keys persisting across boots. The entrypoint resolves `bellows` once at start; if the Bellows container's address changes, restart the tor container.

## Oblivious HTTP under load

Anyone can send `POST /ohttp`, and an encapsulated request names no account, so the gateway bounds new encapsulated requests for all clients together ([OHTTP.md](OHTTP.md#admission)):

- Only a request that will run takes a place in the replay cache. One refused for its method, path or date never does, so requests that run nothing cannot fill it.
- `BELLOWS_OHTTP_ADMIT_PER_SECOND` new requests a second are admitted, with a burst of one second's worth. Past that, `/ohttp` answers `503` with `Retry-After` and logs `ohttp_refused` with reason `busy`.
- Left unset, the bound is `BELLOWS_OHTTP_REPLAY_CACHE_MAX / (2 * BELLOWS_OHTTP_MAX_SKEW_SECONDS + 2)`: about 332 a second with the defaults (200,000 keys, 300 s skew). At that rate the replay cache cannot fill, so `replay_cache_full` should not appear in the logs. If it does, the gateway's clock has jumped.
- To admit more, raise `BELLOWS_OHTTP_REPLAY_CACHE_MAX` (the default 200,000 keys take a few tens of megabytes) or lower `BELLOWS_OHTTP_MAX_SKEW_SECONDS`. Setting `BELLOWS_OHTTP_ADMIT_PER_SECOND` above what the cache holds is refused at startup, with the most it can be.
- Lower it on a small instance. Every admitted request runs in the app, where payment, rate limits and proof of work apply to it as to a direct request.

Many `busy` lines mean someone is sending more than the bound. They crowd out other OHTTP clients while they keep sending, but nothing stays shut once they stop. Direct requests to `/v1` are not counted.

## Updating

A new version is a new release (step 4), a new `builds.json` entry, a new keyserver approval (step 5) and then:

```sh
tinfoil container update bellows --tag v1.0.1
```

An instance with a persistent volume is replaced, not run side by side: it is unreachable until the new version is running. The volume and its key stay the same. Do not replace the volume key.

## Backups and recovery

The operator cannot read the volume, so there is no database export from a sealed deployment. What protects the money:

- the offline copies of the volume key and the wallet secret (step 2);
- the volume itself, which survives Stop, Deploy, updates and deleting the instance, until you delete the volume;
- the mint, from which the wallet secret restores the gateway's eCash.

If the volume is lost, the eCash in the gateway's wallet can be restored with the wallet secret, and the balances customers held are lost. Clients that keep their balances small, and move them with `moveBalance` ([OPERATORS.md](OPERATORS.md)), lose little.

The volume has no rollback protection: whoever controls the disk can put back an older copy, and the enclave does not notice. See [THREAT-MODEL.md](THREAT-MODEL.md).

## Rehearse locally

The image runs the way Tinfoil runs it, with a read-only root file system, no capabilities and no new privileges:

```sh
docker build -t bellows .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:size=64m -v bellows-data:/data -p 127.0.0.1:8787:8787 \
  -e BELLOWS_TRUSTED_MINTS=http://host.docker.internal:3338 -e BELLOWS_FOREIGN_DISCOVERY_RELAYS= \
  -e BELLOWS_UNITS=usd -e BELLOWS_DEFAULT_UNIT=usd -e BELLOWS_MODELS_FILE=config/models.dev.json bellows
```

With `-e BELLOWS_MODE=sealed -e BELLOWS_SECRETS=platform -e BELLOWS_SEALED_MOUNTS=/data -e BELLOWS_ATTESTER=tinfoil` and a test wallet secret in `BELLOWS_WALLET_SECRET`, the same command starts in sealed mode on Docker's Linux mount table: `/healthz` answers and `/.well-known/bellows` answers `503 not_attested`, because there is no attestation socket outside an enclave. Never use real keys for this.

## Not verified on sealed hardware

- The keyserver releasing secrets to a Bellows enclave, as environment variables, and refusing a debug enclave.
- Volume creation and unlock at boot through `key-secret`, first-boot initialization of a blank disk, the mount's owner (`1000:1000`), and the mount appearing in `/proc/self/mountinfo` so that sealed mode accepts it.
- The attestation socket in a Bellows container and the document it returns ([ATTESTATION.md](ATTESTATION.md#not-verified-locally)).
- The release workflows on GitHub, Tinfoil's measure action on this config, the measurement form in `builds.json` matching what an app's `authenticate` returns, and reproducible image builds.
- Tinfoil's dashboard and CLI accepting these workflows in place of the template's, and the `version` input they send.
- The egress allowlist in practice: hostnames re-resolved by the platform, Nostr relays over WebSocket, and enclave hosts a client names beyond the ones listed (they are blocked unless you add them).
- Streamed answers and the admin API through the shim.
- The Tor sidecar on Tinfoil (see [Onion service](#onion-service)).
- Price, self-serve access and where inbound TLS ends, as [DESIGN.md](DESIGN.md#platform) notes.
