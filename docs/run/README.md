# Running a Bellows

These pages are for operators: the people who run a Bellows for others.

There are two ways to run one:

- **On your own server**, with Docker behind your own TLS proxy. This is the simple way, and it is not sealed: you, the operator, can read plaintext requests in memory and can read the database. Start with [Running a Bellows on your own server](self-hosted.md).
- **Sealed, on Tinfoil Containers**, with the deploy kit in this repository: `tinfoil-config.yml` (the measured deployment, with an encrypted volume and secrets from your own keyserver), the hardened `Dockerfile`, an optional Tor onion sidecar (`deploy/`), a keyserver policy example, and the release workflows that build, pin, measure and propose each build for `builds.json`. `pnpm deploy:check` checks a config against the kit's rules, among them that only the Bellows container may request attestations. Start with the [sealed deployment guide](sealed-deployment.md), which marks every step that has not yet been run on sealed hardware.

| Page | What it holds |
| - | - |
| [Running a Bellows on your own server](self-hosted.md) | The Docker image, the secrets file, the reverse proxy and backups |
| [Sealed deployment guide](sealed-deployment.md) | The deploy kit and its rules, keys, the keyserver, releases, the instance, the onion service, updates, backups, and what is not verified on sealed hardware |
| [Configuration reference](configuration.md) | Every environment variable, secrets and sealed mode, other-mint discovery, the model catalog and the suppliers |
| [Admin API and admin CLI](admin.md) | Turning the admin API on, where it is reachable, the admin CLI and the logs |
| [Migrating from Forge AI](migrate-from-forge-ai.md) | Everything a Forge AI deployment changes to run as a Bellows |

Two other pages matter to operators: [Publishing](../use/operators.md#publishing) your operator announcement, and the [threat model](../how-it-works/threat-model.md), which says what each party can see in a sealed deployment.
