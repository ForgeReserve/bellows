# Bellows relay

The first hop of Oblivious HTTP to a Bellows. A client sends an encrypted request to the relay; the relay forwards the opaque bytes to one Bellows on its allowlist and passes the encrypted answer back.

- It forwards the body and its content type, and nothing else: no address, cookies, user agent, forwarded-for or any other header from the client.
- It returns the status, an OHTTP content type and the body, and nothing else from the Bellows.
- It writes no logs and keeps nothing.
- It cannot read requests or answers. They are encrypted to a key held inside the Bellows.

A relay is worth running only for a Bellows someone else operates. A relay and a Bellows run by the same party hide nothing from that party.

## Routes

| Route | What it does |
|---|---|
| `POST /relay/<host>` | Forwards to the allowlisted gateway URL whose host is `<host>` |
| `GET /healthz` | `200 ok` |

Errors the relay makes itself carry a `Bellows-Relay-Error` header with a short code: `not_found`, `unknown_target`, `method_not_allowed`, `unsupported_media_type`, `too_large`, `empty`, `gateway_unreachable`, `gateway_redirected`. A refusal from the gateway is passed on as its status, without that header. A busy gateway's `503` keeps its `Retry-After` when that is a whole number of seconds; no other gateway header comes back.

A client uses the full relay URL for a Bellows, for example `https://relay.example/relay/bellows.example`. The Bellows operator lists it in `BELLOWS_RELAYS`, so it appears in the attested `/.well-known/bellows`.

## Run it with Node

```sh
BELLOWS_RELAY_TARGETS=https://bellows.example/ohttp pnpm relay
```

| Variable | Default | Meaning |
|---|---|---|
| `BELLOWS_RELAY_TARGETS` | required | Comma-separated gateway URLs (https, or http on a loopback address) |
| `BELLOWS_RELAY_PORT` | `8788` | Port: a whole number from 1 to 65535 |
| `BELLOWS_RELAY_HOST` | `127.0.0.1` | Address to listen on. Put a TLS terminator in front, and configure it to keep no access logs |
| `BELLOWS_RELAY_MAX_BODY_BYTES` | `2097152` | Largest encapsulated request accepted: a whole number of bytes, at least 1024 |

A port or size that is not a whole number in range (for example `2MB`) stops the relay at startup with a message, on Node and as a Worker.

The server prints one line at startup (port and number of gateways) and nothing about any request.

## Run it as a Cloudflare Worker

`worker.ts` is the same relay as a Worker. Set the gateway list in `wrangler.toml` (`BELLOWS_RELAY_TARGETS`), then deploy with `npx wrangler deploy --config relay/wrangler.toml`. The example keeps Workers observability off. Cloudflare still sees client addresses at its edge; whoever runs the relay must trust their host with that, as with any relay.

Not verified locally: the Worker has been tested only in Node through its `fetch` export, not on Cloudflare.

## Code

`relay.ts` holds the relay and uses Web APIs only (it typechecks without Node types: `relay/tsconfig.json`). `server.ts` (Node) and `worker.ts` (Workers) are thin entry points. Tests: `test/unit/relay.test.ts` and `test/e2e/ohttp.e2e.test.ts`.
