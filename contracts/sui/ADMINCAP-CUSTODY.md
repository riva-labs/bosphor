# AdminCap Custody Runbook

Decision record and operating procedure for the Sui OApp AdminCap (issue #342).

## Decision: no recovery code, hardened custody instead

Evaluated options: a second minted cap held offline, a timelocked on-chain
recovery function, and custody-only. The owner's call (2026-08-31): **any
recovery mechanism is itself the biggest attack surface**. A second cap is a
second thing to steal; a timelock recovery function is a standing on-chain
backdoor that an attacker who compromises the recovery address can exercise.
The cap stays singular and we do not lose it.

This is also structurally forced: the AdminCap is defined by the LayerZero
`oapp` package (`public struct AdminCap has key, store`), not by Bosphor code,
so minting logic could not be added to it without wrapping it in another
object, which only moves the problem.

## Inventory

| What | Where | Holder |
|------|-------|--------|
| OApp AdminCap (lz-receiver) | LZ `oapp` package type, one instance per deploy | Deployer address (`SUI_DEPLOYER_KEY` in the host env of the matching deployment) |

The cap authorizes: `set_relayer`, send/receive library configuration, and
package upgrade flows. Losing it freezes the OApp permanently; leaking the key
that holds it hands over the OApp.

## Custody policy

- **Testnet**: the cap stays on the hot deployer address. Development velocity
  (frequent set_relayer, library config during LZ infra changes) outweighs the
  custody benefit; testnet loss is recoverable by redeploying.
- **Mainnet**: on deploy day, the cap is transferred in the same session to a
  dedicated offline address (hardware wallet or air-gapped key). The hot
  deployer key never retains a mainnet cap overnight. Admin operations are
  performed by signing from the offline address; day-to-day operations
  (relayer runtime) never need the cap.

## Transfer procedure

The cap has `key, store`, so custody transfer is one transaction:

```bash
sui client transfer --object-id <ADMIN_CAP_ID> --to <OFFLINE_ADDRESS> --gas-budget 10000000
```

Verify afterwards that the object shows the new owner:

```bash
sui client object <ADMIN_CAP_ID>
```

Record every transfer in the drill log below.

## Compromise response

If the key holding the cap is suspected leaked: immediately transfer the cap
to a fresh, clean address (the transfer itself is the mitigation, it wins any
race as long as it lands first), then rotate every other credential that
lived alongside the leaked key.

## Drill log

A custody drill is a round-trip transfer to a second controlled address and
back, proving the procedure and the recorded object ids are correct. Run one
per milestone and after any tooling change.

| Date | Network | From -> To -> Back | Digests | Operator |
|------|---------|--------------------|---------|----------|
| pending | testnet | deployer -> secondary -> deployer | pending | pending |
