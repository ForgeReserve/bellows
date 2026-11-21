# Security

## Reporting a problem

Please report a security problem by email to security@forge-reserve.com. Keep the details out of public issues and pull requests until a fix is released.

A useful report says which version or commit you looked at, what you did, what happened, and what you expected. A proof of concept helps. If the problem concerns a running Bellows, say which one.

We will confirm that we received your report, tell you what we found, and credit you in the release notes if you would like that.

## What is in scope

- The engine in this repository: the API, payments, balances, the admin API and the client library.
- The sealed deployment kit and the release process that measures a build.
- The public reference instance.

The [threat model](docs/how-it-works/threat-model.md) says what each party can see by design, and [Not verified on sealed hardware](docs/run/sealed-deployment.md#not-verified-on-sealed-hardware) lists what is still open. A report that shows one of those claims to be wrong is especially welcome.

## Supported versions

Fixes go into the latest release. [`builds.json`](builds.json) lists the releases a client accepts.
