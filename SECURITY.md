# Security Policy

Bosphor is a cross-chain storage intent router. The on-chain adapters, the Sui
receiver, the relayer, and `@bosphor/sdk` all sit on the path between a user's
funds and their data, so we take security reports seriously.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

Report it privately through GitHub's ["Report a vulnerability"](https://github.com/riva-labs/bosphor/security/advisories/new)
advisory flow, or email the maintainers at security@bosphor.xyz. Include:

- a description of the issue and its impact,
- the affected component (contracts-evm, sui, relayer, sdk, solana),
- steps to reproduce or a proof of concept,
- any suggested remediation.

We aim to acknowledge a report within 3 business days and to keep you updated as
we investigate. Please give us a reasonable window to release a fix before any
public disclosure.

## Supported versions

Bosphor is pre-1.0 and under active development on testnet/devnet. Security fixes
land on `main` and in the latest published component versions. There is no
long-term support branch yet; graduation to 1.0.0 is tracked per component in the
project README.

## Scope

In scope: the EVM adapter, the Sui receiver and executor, the relayer, the Solana
adapter, and `@bosphor/sdk`. Out of scope: third-party infrastructure we depend on
(LayerZero, Walrus, Sui, the underlying chains) - report those to their respective
maintainers.
