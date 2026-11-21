# Contributing to Bellows

Thank you for helping with Bellows. This guide gets you from a fresh clone to a pull request: how to set up, run the engine, run each kind of test, find your way around the code, and what a good pull request looks like here.

If you are new to the project, read the [README](README.md) first, and the [design](docs/how-it-works/design.md) when you want to know why things are the way they are.

## Set up

You need:

- Node 22.18 or later. CI uses Node 24, which is also the version recommended for running Bellows. Node runs the TypeScript sources directly, so there is no build step.
- pnpm. The version is pinned in `package.json` (`packageManager`); `corepack enable` installs it, as CI does.
- Docker, for the local test mints, the end-to-end tests and the image.
- `jq`, if you follow the curl examples in the docs.

Then install the dependencies from the lockfile:

```sh
corepack enable
pnpm install --frozen-lockfile
```

`pnpm-workspace.yaml` sets `minimumReleaseAge` to 4320 minutes: pnpm does not install a package version until it has been published for three days.

## Run the engine locally

Start the local test mints, then Bellows with the development catalog, whose mock models answer without any supplier key:

```sh
pnpm mint:up
export BELLOWS_TRUSTED_MINTS=http://127.0.0.1:3338 BELLOWS_MODELS_FILE=config/models.dev.json BELLOWS_DB_PATH=data/dev.db
pnpm dev          # http://localhost:8787, restarts when a source file changes (pnpm start runs it once)
```

From there, the [quick start](README.md#quick-start) opens a balance and sends a chat request, and `pnpm test-token 50 usd` prints test eCash from the local mint. `pnpm demo:agent` runs the agent example (`examples/agent-pays.ts`), which pays per request. `pnpm mint:down` stops the mints. `data/`, `.env` and `secrets.json` are in `.gitignore`, so a local database and its secrets stay out of commits.

## Run the tests

| Command | What it does | Needs |
| - | - | - |
| `pnpm typecheck` | Type-checks the engine, and `client/` and the relay against Web APIs only | Nothing else |
| `pnpm test` | The unit tests in `test/unit/`, including the site check | Nothing else |
| `pnpm builds:check` | Checks `builds.json` | Nothing else |
| `pnpm deploy:check` | Checks `tinfoil-config.yml` and the two templates in `deploy/` against the deploy kit's rules (`--release` checks `tinfoil-config.yml` for a release) | Nothing else |
| `pnpm site:check` | Fails when the generated site in `site/` is out of date (`pnpm site:build` regenerates it) | Nothing else |
| `pnpm mint:up && pnpm test:e2e && pnpm mint:down` | The end-to-end tests in `test/e2e/`, against three local Nutshell mints | Docker |
| `pnpm test:live` | An optional smoke test against Token Factory | `TOKENFACTORY_API_KEY`, read from `.env` if present |

Set `BELLOWS_TEST_LOGS=1` to see the gateway's logs while tests run. The test mints listen on `127.0.0.1` ports 3338, 3339 and 3340.

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`, read-only and without credentials. One job runs `pnpm typecheck`, `pnpm test`, `pnpm builds:check` and `pnpm deploy:check`; another starts the mints and runs `pnpm test:e2e`. The live test is not run in CI. [What the tests check](docs/contributing/tests.md) says what each test file covers.

## Where things live

| Path | What it holds |
| - | - |
| `src/` | The gateway. `index.ts` starts it, `app.ts` holds the HTTP routes, `config.ts` reads the settings and the model catalog. Payments live in `ledger.ts`, `funding.ts`, `pricing.ts` and `cashu/`; suppliers in `suppliers/`; attesters in `attest/`; Oblivious HTTP in `ohttp.ts`; the admin API and CLI in `admin-api.ts` and `admin.ts` |
| `client/` | The client library, for browsers and Node: verifying a Bellows, Oblivious HTTP, proof of work, the operator pool and moving a balance. It uses Web APIs only |
| `relay/` | The Oblivious HTTP relay, as a Node server and a Cloudflare Worker ([relay/README.md](relay/README.md)) |
| `test/` | `unit/` (no Docker), `e2e/` (against local mints), `live/` (optional, against a real supplier) |
| `scripts/` | Repository tools: `test-token`, `announce`, the builds and deploy checks, image pinning, `try-it` (a small end-to-end check of a running Bellows) and the site generator. `site-pages/` holds the hand-written site pages |
| `config/` | The model catalogs: `models.json`, the default, and `models.dev.json` with mock models for local development |
| `deploy/` | The sealed deploy kit's templates: Tinfoil configs, the Tor sidecar and a keyserver policy example |
| `docs/` | The documentation, in folders by reader goal ([docs home](docs/README.md)) |
| `site/` | The static site, generated from `docs/` and `scripts/site-pages/` ([site/README.md](site/README.md)) |
| `examples/` | `agent-pays.ts`, an agent that pays per request |
| Root files | `Dockerfile` (the image), `tinfoil-config.yml` (the reference instance's measured deployment), `builds.json` (the approved builds), `docker-compose.test.yml` (the test mints), `.env.example` and `secrets.example.json` |

## Propose a change

Open a pull request against `main`. If you are not sure a change is wanted, or it is a large one, you can open an [issue](https://github.com/ForgeReserve/bellows/issues) first and describe it.

A good pull request here:

- **Does one thing**, with a title that names the area and the change, as the history does: `fix(ohttp): ...`, `docs(payments): ...`, `site: ...`.
- **Comes with tests.** A change in behaviour ships with tests, as every slice of the [build plan](docs/how-it-works/design.md#build-plan) did. A removed feature takes its tests with it rather than skipping them.
- **Passes the checks CI runs.** Run them locally first, including the end-to-end suite when you touch payments, funding, recovery or anything a request passes through.
- **Updates the docs in the same pull request.** When behaviour, a setting or a default changes, update the page that describes it, and its limits or "not verified" list if they change. Then run `pnpm site:build`. [Contributing docs](docs/contributing/README.md#editing-the-docs) explains how docs become site pages.
- **Keeps clients unidentifiable.** Nothing that identifies a client goes into a log, the database or an error: no network address, user agent, referrer, forwarded-for value or balance id, and never prompt or completion content (`src/log.ts`). The blind tests check this.
- **Holds no secrets.** Never commit a key, a token or a `.env` file. Secrets live in the secrets source, never in environment variables ([Secrets and sealed state](docs/run/configuration.md#secrets-and-sealed-state)).

Some files carry extra weight:

- `tinfoil-config.yml` is the reference instance's measured deployment. A change to it changes the measurement, so it takes effect only with the next release.
- `builds.json` lists the builds clients trust. Entries come from the release workflow, which proposes each one in its own pull request ([4. Release](docs/run/sealed-deployment.md#4-release)).
- Workflows in `.github/workflows/` pin every action by commit and grant no default permissions. `test/unit/deploy.test.ts` checks both.
- A step that needs real sealed hardware and has not been run there is marked NOT VERIFIED in the docs until it has.

## Questions

Ask in [GitHub issues](https://github.com/ForgeReserve/bellows/issues). Leave keys, tokens and secrets out of anything you post.

## License

Bellows is MIT licensed. See [LICENSE](LICENSE).
