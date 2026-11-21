# Operators

Anyone can run a Bellows. This document covers how an operator says where their Bellows is and what it takes, how a client chooses among many operators, and how a client moves its balance from one operator to another.

Balances do not move between operators by themselves. A balance key works only at the operator that issued it. To change operators, a client withdraws its balance as eCash and funds a new balance elsewhere ("Moving a balance" below).

## The operator announcement

An operator publishes one signed Nostr event per Bellows. It is addressable (NIP-01): for one operator key and one address, the newest event replaces the older ones.

| Field | Value |
| - | - |
| `kind` | `38390`. Chosen from the unused part of the addressable range; it is not registered in the NIPs list |
| `content` | An optional plain-text description, at most 1000 characters |
| `["d", address]` | The Bellows' origin, for example `https://bellows.example`. The replaceable key |
| `["u", address]` | The same origin |
| `["ohttp-relay", url]` | Zero or more. Each is the full URL a client posts encapsulated requests to ([OHTTP.md](OHTTP.md)) |
| `["onion", url]` | Optional. The Bellows' v3 onion address, for example `http://<56 characters>.onion` |
| `["version", version]` | The Bellows release it runs |
| `["measurement", type, register, ...]` | Optional. The build measurement, as `builds.json` lists it |
| `["unit", unit]` | One or more. The units balances are kept in: `usd`, `sat` |
| `["mint", url]` | One or more. The mints whose eCash it takes (`BELLOWS_TRUSTED_MINTS`), with no trailing slash |
| `["alt", "Bellows operator announcement"]` | NIP-31 text for clients that do not know the kind |

Addresses are `https`. Plain `http` is accepted only on a loopback address, for local runs and tests. Tags a client does not know are ignored, so later versions can add fields.

### Where the announcement lives

The same signed event is published in two places:

1. **On Nostr relays**, where clients find operators.
2. **Inside the Bellows' attested identity.** Set `BELLOWS_OPERATOR_ANNOUNCEMENT_FILE` to the file holding the event, or `BELLOWS_OPERATOR_ANNOUNCEMENT` to the event itself as JSON. Bellows serves it in the `operator` field of the statement at `/.well-known/bellows` ([ATTESTATION.md](ATTESTATION.md)), so the hardware attestation covers it. A sealed deployment uses the variable: the operator cannot write a file on the encrypted volume, and the measured config cannot hold an announcement that names the build it is measured into, so the keyserver releases it with the secrets ([OPERATE.md](OPERATE.md)).

When a version of Bellows is listed in `builds.json` for several operator deployments, `pnpm announce` needs `--deployment owner/repo@tag` to pick the measurement of yours.

At startup Bellows checks the announcement and refuses to start unless it is a correctly signed announcement that matches its configuration: the relays equal `BELLOWS_RELAYS` in the same order, the version is this release, the measurement (when the announcement names one) is the one this Bellows claims, every unit is in `BELLOWS_UNITS` and every mint is in `BELLOWS_TRUSTED_MINTS`. An announcement that does not match what the Bellows does would only make clients refuse it later.

### Publishing

```sh
pnpm announce --url https://bellows.example --unit sat --unit usd \
  --mint https://mint.example \
  --relay https://relay.example/relay/bellows.example \
  --onion http://<56 characters>.onion \
  --description "Example operator" \
  --out announcement.json \
  --nostr wss://nostr-relay-one.example --nostr wss://nostr-relay-two.example
```

- The command asks for the operator's Nostr secret key (an `nsec1...` string or 64 hex characters) at a prompt that does not show what is typed. When stdin is not a terminal it reads the first line, so the key can come from a password manager: `password-tool show nostr | pnpm announce ...`. The key is never taken from the command line or the environment, and is never printed or written.
- The fields are checked before the key is asked for.
- `--version` defaults to this release. Unless `--measurement` gives one, the measurement is read from `builds.json` (`--builds` names another file) for that version, and left out when the version is not listed.
- `--out` writes the signed event for `BELLOWS_OPERATOR_ANNOUNCEMENT_FILE`. `--nostr` publishes it and reports each relay's answer. `--dry-run` signs and writes but publishes nothing.
- Exit status: 0 when everything worked, 1 when a Nostr relay refused the event or did not answer, 2 for a usage error or a bad key.

Publish again after every upgrade, relay change or mint change, and restart the Bellows with the new file. Clients take the attested copy as current.

## Choosing an operator (client library)

The client library in [`client/`](../client/) runs in browsers and in Node 22+.

```ts
import { loadOperatorAnnouncements, OperatorPool, storageMemory, tinfoilVerifier } from './client/index.ts';

const { announcements } = await loadOperatorAnnouncements(['wss://nostr-relay.example'], { authors: trustedOperatorKeys });
const pool = new OperatorPool({
  operators: announcements,
  approvedBuilds: buildsJson,
  verifier: tinfoilVerifier({ authenticate }),
  memory: storageMemory(localStorage),
  unit: 'sat',
});
const { response, operator } = await pool.fetch('/v1/models');
```

`loadOperatorAnnouncements` reads kind 38390 events from Nostr relays, checks each event's id and signature, and keeps the newest per key and address. `authors` limits it to keys the app trusts. An app can also ship a list of signed events and skip the relays.

Before an operator is used, the pool:

1. Verifies the Bellows with `verifyBellows`: a hardware attestation of a build on the approved list ([ATTESTATION.md](ATTESTATION.md)).
2. Checks that the attested statement carries a signed announcement by the **same operator key for the same address**. A listed event that points at someone else's Bellows is refused (`announcement_mismatch`). From here on the pool uses the attested copy.
3. Checks requirements: the unit and mint the app asks for (`not_accepted` otherwise).
4. Checks health: `GET /healthz` through Oblivious HTTP, on the same path real requests take.

Then it picks. The order is the remembered operator first, then the list order. An operator that failed in the last minute (`retryAfterMs`) goes to the back. `memory` is any `{get, set}`; `storageMemory(localStorage)` keeps it across page loads and ignores storage that throws. Every call that gets an answer below 500 makes its operator the remembered one.

### Routes

| `route` | Requests go |
| - | - |
| `relay-or-direct` (default) | Through the first relay the Bellows lists in its attested statement, straight to it when it lists none |
| `relay` | Only through a relay. A Bellows that lists none is passed over |
| `direct` | Straight to the Bellows. Its host sees the client's address |
| `onion` | To the onion address in the announcement, with a `fetch` that reaches Tor. The attested announcement must name the same onion address |

Who is asking is hidden from the operator only when you use a relay run by someone else, or Tor. A relay and a Bellows run by the same party hide nothing from that party.

### Failover

`pool.fetch(path, init, options)` fails over to the next operator when one cannot be verified, fails its health check, cannot be reached, or answers 502, 503 or 504. Failing verification or health is always safe to skip: nothing of the request was sent.

Once a request may have reached a Bellows, sending it to another one could run it twice, and a paid request would be paid twice. So by default only `GET` and `HEAD` fail over at that point. Set `failover: true` only for a request that is safe to send twice.

A call that carries a balance key names its operator (`{ operator: id }`) and never fails over: the key means nothing elsewhere, and an operator that did not issue it could use it at the one that did. The pool enforces this: a call with an `authorization` header and no `operator` is refused (`not_accepted`) before anything is sent. A pinned call skips the pool's `unit` and `mint`, since it reaches a balance that operator already holds. A failed operator is verified again before its next use, which also picks up a Bellows that restarted with a new key. When every operator fails, the error (`no_operator`) lists each one and why.

## Moving a balance

```ts
import { moveBalance } from './client/index.ts';

const moved = await moveBalance(pool, {
  from: oldOperatorId,
  key: oldBalanceKey,
  onToken: async (w) => saveUntilDone(w.token),
});
// moved.to is the new operator, moved.key the new balance key there.
```

1. **Withdraw.** `GET /v1/wallet` at the old operator, then `POST /v1/wallet/refund` for every whole unit. Withdrawals are whole units, so a remainder below one cent or one sat stays behind. The answer names the token's `mint`.
2. **Hand over.** `onToken` gets the token as soon as the old operator issues it, before anything else can fail. Keep it until the move returns: until then it is the balance.
3. **Fund.** The new key is chosen on the client before funding. The token goes to `POST /v1/wallet/topup` at `to`, or, when `to` is not given, at each other operator in pool order. An operator whose attested announcement does not take the token's unit and mint is passed over before anything is sent, so it never sees the token or a key. Proof of work for a new balance is solved on the client. An operator that refuses the mint or unit anyway, or that needs an invite, is passed over and the next one is asked. An operator that answers 429 (limiting requests) did not run the funding: the move waits out its `Retry-After` up to `rateLimitRetries` times (default 2) when the wait is at most `maxRetryAfterSeconds` (default 10), and otherwise asks the next operator, or stops with `fund_retry` when `to` is given. A 429 after the same operator answered that the funding is pending stops with `fund_unknown`, because the funding may still complete there. Without `newKey`, each operator asked gets a key of its own, so one that refuses never learns the key of the balance that is funded in the end.

What can go wrong, and what is left in the error (`MoveBalanceError`):

| `code` | Meaning | What to do |
| - | - | - |
| `nothing_to_move` | The balance is below one unit | Nothing |
| `withdraw_pending` | The old operator owes the withdrawal but has not issued it | Fetch it later at `GET /v1/wallet/refunds` there (with its `mint`), then call again with `token` and a `newKey` |
| `withdraw_failed` | The old operator refused or could not be reached. Nothing was withdrawn, or it is listed at `GET /v1/wallet/refunds` | Try again |
| `withdrawn_unroutable` | The balance was withdrawn, but the old operator did not say which mint the token is from, so no destination can be checked against it. `token` and `key` are in the error, and `onToken` already has the token | Redeem the token in any Cashu wallet, or finish the move with `token` (its unit and mint) and `newKey: key` |
| `no_destination` | No operator took the token. `token` and `key` are in the error | Fund another operator with `token` and `newKey: key`, or redeem the token in any Cashu wallet |
| `fund_unknown` | The funding request may have reached `to` and its outcome is not known: `to` could not be reached, answered that the funding is pending, or answered with a server error (5xx). `token`, `to` and `key` are in the error | Call again with the same `to`, `newKey: key` and `token`. Never send the token elsewhere first: if it was received, it is spent |
| `fund_retry` | `to` is limiting requests (429) and did not run the funding, even after waiting as asked. The token is untouched. `token`, `to` and `key` are in the error | Call again later with the same `to`, `newKey: key` and `token`, or fund another operator |
| `fund_failed` | `to` refused the token for good with a 4xx answer other than 429, for example as already spent | Check the balance at `to` with `key`. The token is in the error |

Finishing a move takes `token` (`{ token, unit, mint }`) and the `key` from the error as `newKey`. A call with `token` and no `newKey` is refused (`not_accepted`): a fresh key would open an empty balance and the token would be refused as spent. Calling again with the same `to`, `newKey` and `token` is safe: the operator recognizes the token and the key and credits once (`credited: 0` when the first call was credited).

## What this does not do

- Balances never move between operators on their own, and operators do not talk to each other.
- An announcement says what an operator offers. It is not a promise of uptime, prices or honesty about anything the attestation does not cover.
- The pool trusts the approved-builds list and the verifier the app gives it. An app that lists an operator key trusts that operator to keep its announcement current.

## Tests

`test/unit/operators.test.ts` checks event signing and verification, the announcement's fields and every refusal (unsigned, wrong kind, repeated or missing tags, bad URLs, dated in the future), newest-wins selection, reading and publishing on Nostr relays against a stand-in relay, the client's proof of work against the Bellows' check, the publishing command (NIP-19 key vector, hidden prompt in a terminal and from a pipe, fields checked before the key is asked for, the key never printed, publishing and dry run), startup refusing an announcement that does not match the configuration, and the pool against Bellows instances in the same process: picking and remembering, an announcement pointing at someone else's Bellows, unapproved builds, the development stand-in, units and mints, failover for `GET` and none for `POST` once sent, pinned calls, a restart with a new key, a failed health check, the relay and onion routes, pinned calls skipping the pool's unit and mint, unpinned calls with a balance key refused, and the move: its refusals, a funding request or answer lost on the way (`fund_unknown`, then finished once with the same key), a pending funding retried, a server error after a pending funding (`fund_unknown`, not `fund_failed`), a withdrawal owed but not issued (`withdraw_pending`), a withdrawal answered without its mint (`withdrawn_unroutable`, with `onToken` called first), a destination answering 429 (`fund_retry` with `to`, a short `Retry-After` waited out, the next operator asked without `to`, a 429 after a pending answer `fund_unknown` with no other operator asked), an operator that takes another mint never contacted, and a refusing operator never seeing the funded key.

`test/e2e/operators.e2e.test.ts` runs three Bellows over HTTP against the local mints, one behind a relay. It funds a balance at one, spends part of it, moves the rest (the first candidate takes another mint and gets no request, the second asks for proof of work and takes it), checks the amounts at both ends and that finishing the move again credits nothing, loses the answer to a funding and finishes it with the same key once, and fails over when operators go down.
