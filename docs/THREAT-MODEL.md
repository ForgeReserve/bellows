# Threat model

Bellows aims to be operator-blind: the person who runs one learns nothing worth taking from it. This page says what each party can see and do in a sealed deployment ([OPERATE.md](OPERATE.md)), what the design assumes, and where it is weak. It follows the wording rule in [DESIGN.md](DESIGN.md): "the operator cannot read" is said only of the words and of money and state; who is asking is "hidden from the operator when you use a relay or Tor".

Parts of this depend on sealed hardware and on Tinfoil's platform behaving as documented. Those parts have not yet been run on real sealed hardware; [OPERATE.md](OPERATE.md#not-verified-on-sealed-hardware) lists them.

## Three things to hide, three mechanisms

| What | Hidden from the operator by |
| - | - |
| The words: requests and answers | Bellows runs in a confidential VM. Clients check a hardware attestation of the build, then encrypt to a key that exists only inside it (Oblivious HTTP, [OHTTP.md](OHTTP.md)) |
| Money and state: balances, the wallet seed, supplier keys, the admin token | The database is on an encrypted volume, and the keys are released by a keyserver only to an approved build, after it proves what it is |
| Who is asking: address and timing | A relay run by someone else, or Tor. The relay sees an address and no content; Bellows sees content and no address |

## What each party can see

| Party | Sees | Does not see |
| - | - | - |
| **Client** | Its own requests, answers and balance | Other clients |
| **Operator** (runs the deployment and the keyserver) | Aggregates from the admin API (revenue, totals owed, counts, supplier costs, health), the instance's logs, which hold no client data ([PRIVACY.md](PRIVACY.md)), traffic volume and timing at the host. Without a relay or Tor, client network addresses | The words, per-customer balances, the wallet seed, supplier keys. The operator cannot read these: they exist in plaintext only inside the sealed machine. Client addresses are hidden from the operator when clients use a relay or Tor |
| **Relay operator** | The client's network address, timing and the size of encrypted messages | The words, which are encrypted to Bellows' attested key |
| **Hosting platform** (Tinfoil) | What the operator's host sees: timing, volume, addresses without a relay, encrypted disk blocks and which blocks are read and written | The words and the state, provided the hardware and the attested runtime hold. Secrets come from the operator's keyserver, not from Tinfoil's secret store |
| **Hardware vendor** (AMD or Intel) | Nothing by default | |
| **AI supplier** | The prompts and answers of plaintext models, with Bellows as the caller. For private models, nothing: the body is encrypted end to end to the model's own enclave and Bellows passes it through unread ([PRIVACY.md](PRIVACY.md)) | Who the client is |
| **Mint** | The gateway's eCash operations, and the client's own when the client deals with the mint | Which client a gateway operation is for |
| **Nostr relays** | Published operator announcements, and the discovery queries Bellows makes for mint reviews | Clients |
| **Network observer** | Encrypted traffic between the parties above | The words |

## What the operator can do

- **Stop the service or destroy its data.** Deleting the volume loses the ledger. The wallet secret, kept offline, restores the gateway's eCash from the mint; customer balances held only in the ledger are lost. Clients keep balances small and move them between operators ([OPERATORS.md](OPERATORS.md)).
- **Change prices, mints or suppliers.** Only by releasing a new build, whose config is public and measured. A price not marked as checked against the supplier's rate card is not served unless the measured config sets `BELLOWS_SERVE_UNVERIFIED_PRICES=true`, which anyone can read there; such models show `pricing.verified: false` in `/v1/models`.
- **See timing and volume** at the host, and client addresses unless clients use a relay or Tor.
- **Run the relay too.** A relay and a Bellows run by the same party hide nothing from that party.

### The operator approves releases

The operator runs the keyserver and writes its policy. An operator who approves a malicious build of their own in that policy can make it receive the volume key and the wallet secret, and so read the state. Clients detect such a build: it is not in the public `builds.json`, so they refuse to send it anything. The state already on the volume is exposed all the same. This is the known weak point of version 1. A later version moves approval to a key the day-to-day operator does not hold.

### Rollback

The encrypted volume detects a changed block but not an old one. Whoever controls the disk can put back an earlier copy of the volume, and the enclave does not notice. A rolled-back ledger can owe customers what they have already spent, or forget payments. Version 1 documents this and does not solve it.

### Access patterns

The disk encryption hides contents, not which blocks are read and written, or when. A privileged observer of the host can learn something about activity from that.

## What the design assumes

- **The hardware** (AMD SEV-SNP or Intel TDX) keeps the VM's memory from the host and signs true measurements.
- **The platform's attested runtime** (Tinfoil's CVM image, measured and published) does what its documentation says: it runs only the measured containers, gives the attestation socket only to the container that asks for it in the config, takes secrets only from the configured keyserver, and refuses debug mode for private secrets.
- **The keyserver** releases secrets only after verifying a fresh attestation of an approved release served at the pinned domain.
- **The approved-builds list.** Whoever controls the public `builds.json` decides which builds clients trust. Each entry is a public, reviewed change.
- **The code.** The build that is measured is the code in its public repository at that tag. Clients rely on reviewers having read it.

## What the deploy kit enforces

`pnpm deploy:check` refuses a config that would break one of these assumptions from the inside: a second container with attestation access (it could attest a statement with its own key), a second container with secrets or with access to Bellows' volume (the tor sidecar has open egress), a container without a read-only root file system, admin access to the enclave, open ports, secrets in the measured file or in Tinfoil's secret store, a database off the encrypted volume, a volume without a keyserver-released key, unmeasured settings, or open egress for Bellows. See [OPERATE.md](OPERATE.md#the-deploy-kit).

## What it does not cover

- A client whose own device is compromised.
- Traffic analysis by a party that sees both sides of a relay or of Tor.
- Denial of service by the operator, the platform or the network.
- A flood of anonymous requests. Oblivious HTTP requests carry no identity, so they share one admission bound: a sender above it crowds out other OHTTP clients while it keeps sending, though it cannot fill the replay cache or shut new requests out after it stops ([OHTTP.md](OHTTP.md#admission)).
- The AI supplier's handling of plaintext models.
