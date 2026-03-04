# Bosphor POC

Cross-chain intent execution: EVM intent → Sui/Walrus blob storage → proof back to EVM.

## Architecture

```
User (EVM) → BosphorAdapter.sol → IntentSubmitted event
                                        ↓
                                  Relayer (index.ts)
                                        ↓
                              walrus_executor.move → Walrus blob store
                                        ↓
                                  StorageExecuted event
                                        ↓
                              Relayer confirms on EVM
                                        ↓
                              IntentExecuted event + proof
```

## Structure

```
contracts/     Solidity — BosphorAdapter (Foundry)
sui/           Move — walrus_executor module
relayer/       TypeScript — event listener & executor
```

## Setup

### 1. Contracts (EVM)

```bash
cd contracts
forge install
forge build
forge script --broadcast ...  # deploy BosphorAdapter
```

### 2. Sui Module

```bash
cd sui
sui move build
sui client publish --gas-budget 100000000
```

### 3. Relayer

```bash
cd relayer
cp ../.env.example .env  # fill in values
npm install
npm start
```

## Flow

1. User calls `submitIntent(targetChainId, payload, deadline)` on EVM
2. Relayer picks up `IntentSubmitted` event
3. Relayer calls `execute_store` on Sui — stores blob via Walrus
4. Relayer calls `confirmExecution(intentId, proof)` on EVM with Sui tx digest as proof
5. Done — both chains have records of the execution
