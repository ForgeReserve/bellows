# Running a Bellows on your own server

This page runs a Bellows with Docker on a server you control. Run this way, a Bellows is not sealed: its operator can read plaintext requests in memory and can read its database. Encrypted requests to enclave models stay unreadable to the gateway in either case ([Privacy](../how-it-works/privacy.md)). To run one its operator cannot read, follow the [sealed deployment guide](sealed-deployment.md) instead.

## Run it with Docker

The `Dockerfile` builds an image that runs the TypeScript sources directly on Node (no build step), as a non-root user, with the database at `/data/bellows.db` on a volume:

```sh
docker build -t bellows .
docker run -d --name bellows -p 127.0.0.1:8787:8787 -v bellows-data:/data --env-file .env bellows
```

Copy `.env.example` to `.env` first and set at least `BELLOWS_TRUSTED_MINTS`. The [configuration reference](configuration.md) lists every setting. `.env` holds settings only, never a secret: the wallet secret, the admin token and the supplier keys go in `/data/secrets.json` on the volume (copy `secrets.example.json`, `chmod 600`, owned by the container user). [Secrets and sealed state](configuration.md#secrets-and-sealed-state) explains the secrets file.

Put a reverse proxy with TLS in front. Bellows never reads a client address, so the proxy needs no forwarded-for setup, and it should keep no access log of its own ([Blind by default](../how-it-works/privacy.md#blind-by-default)). Keep `/admin` off the public internet ([Admin API](admin.md#admin-api)).

## Back up the database and the wallet secret

The SQLite file is the gateway's ledger and holds the state of its eCash wallet. The wallet secret is what the wallet's keys come from. Back up both. Keep a copy of the wallet secret offline: with it, the gateway's eCash can be recovered from the mint even without the database. [Payments](../how-it-works/payments.md#known-limits) explains what the database and the secret each protect.

## Moving from Forge AI

A Forge AI deployment can switch to Bellows with the same database. [Migrating from Forge AI](migrate-from-forge-ai.md) lists every change.
