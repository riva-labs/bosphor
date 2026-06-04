---
title: Troubleshooting
---

# Troubleshooting

Common issues and their solutions when working with Bosphor.

## Setup issues

### `nvm: command not found`

Install nvm first: see [nvm install instructions](https://github.com/nvm-sh/nvm#installing-and-updating). After installation, restart your terminal or run `source ~/.bashrc`.

### `forge: command not found`

Foundry is not installed or not in PATH. Run `foundryup` and restart your terminal. If you have not installed Foundry, run:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### `sui: command not found`

The Sui CLI is not installed. Follow the [Sui install guide](https://docs.sui.io/guides/developer/getting-started/sui-install).

## Deployment issues

### Deployment fails with "insufficient funds"

Your wallet does not have enough testnet tokens. Request more from:

- **Sepolia ETH**: [Alchemy Sepolia Faucet](https://www.alchemy.com/faucets/ethereum-sepolia) or [Google Cloud Sepolia Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
- **Sui testnet SUI**: Run `sui client faucet` or use the [Sui Testnet Faucet](https://faucet.testnet.sui.io/)

### Sui deploy fails with "Published.toml already exists"

Remove the existing `Published.toml` before redeploying:

```bash
rm sui/lz-receiver/Published.toml
```

This file is generated during deployment and must be removed for a fresh deploy.

### Sui deploy fails with gas budget errors

Increase the gas budget in the deploy script, or ensure your Sui wallet has enough SUI. The default budget is usually sufficient, but complex deployments may need more.

### EVM `setPeer` fails

Verify you are using the Sui **package ID** (not the OApp object ID) as the peer address. This is a common mistake. The package ID is the value printed during `npm run deploy:sui`.

## Relayer issues

### Relayer cannot connect to Sui RPC

Check that `SUI_RPC_URL` is set correctly. The default is `https://fullnode.testnet.sui.io:443`. If using a custom RPC, verify the URL is accessible.

### Relayer shows "fee quote failed, using default"

The LZ fee quote requires all `SUI_LZ_*` environment variables to be set. Copy the values from `relayer/.env.example`. When the quote fails, the relayer falls back to 0.5 SUI (500,000,000 MIST).

### Relayer wallet runs out of SUI

The relayer pays LZ fees and Sui gas from its own wallet. Monitor the balance and top up using `sui client faucet` on testnet. Each proof send costs approximately 0.05-0.5 SUI depending on gas prices and LZ fees.

### Relayer processes the same intent twice

This is expected behavior after TTL expiration. Processed intents are pruned from memory after `INTENT_TTL_MS` (default: 1 hour). On-chain guards prevent actual double-execution, so the retry is harmless. Increase `INTENT_TTL_MS` if you see excessive retries.

### Relayer health endpoint returns "degraded"

The `/health` endpoint returns `"degraded"` when one or both chain connections fail. Check:

1. `EVM_RPC_URL` is responding (try `curl <your-rpc-url>`)
2. `SUI_RPC_URL` is responding
3. Network connectivity from the relayer host

## Cross-chain debugging

### How to check LayerZero message status

After submitting an intent on EVM, use the transaction hash to check delivery status:

1. Go to [LayerZero Testnet Scan](https://testnet.layerzeroscan.com)
2. Search for the EVM transaction hash
3. The message should show status `DELIVERED` once DVN verification is complete

Delivery typically takes 1-5 minutes on testnet.

### E2E test times out waiting for LZ delivery

LayerZero testnet delivery can take 1 to 5 minutes. If the test times out, check [LayerZero Testnet Scan](https://testnet.layerzeroscan.com) for the transaction status. The message may still be in flight.

### Intent submitted but no `IntentReceived` event on Sui

1. Check LZ Scan for the message status. If it shows `INFLIGHT`, wait for delivery.
2. If it shows `FAILED`, the LZ executor could not build the PTB. Verify the OApp is registered correctly with `register_oapp`.
3. Verify peers are set correctly on both chains: EVM `setPeer` uses the Sui package ID, and Sui `set_peer` uses the EVM adapter address.

### `IntentReceived` emitted but no proof returned to EVM

The relayer may not be running, or it may have missed the event. Check:

1. Relayer logs for errors
2. Relayer health endpoint (`GET /health`)
3. Sui wallet balance (relayer needs SUI for gas and LZ fees)
4. That all `SUI_LZ_*` environment variables are set

### Sui transaction fails with "object version conflict"

This happens when two Sui transactions reference the same object in quick succession. The deploy scripts include `waitForTransaction` calls to prevent this. If you run manual transactions too quickly, wait a few seconds and retry.

## Build issues

### `npm run docs:build` fails with broken links

If you see "Docusaurus found broken links", check that all internal links use paths relative to `routeBasePath: '/'`. For example, link to `/architecture` instead of `/docs/architecture`.

### Forge tests fail with missing submodules

Run `git submodule update --init --recursive` to fetch all dependencies. The EVM contracts depend on LayerZero and OpenZeppelin via git submodules.

## Related

- [Quickstart](quickstart.md) for initial setup
- [Deployment](deployment.md) for deployment steps
- [Relayer](relayer.md) for relayer configuration
- [Known Limitations](known-limitations.md) for protocol constraints
