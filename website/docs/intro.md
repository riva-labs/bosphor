---
slug: /
sidebar_position: 1
title: Introduction
---

# Bosphor

Cross-chain storage intent routing for Walrus.

Bosphor lets any EVM chain submit storage intents that are executed on
Walrus (Sui) via LayerZero v2, with verifiable proof returned to the
origin chain.

## What it does

1. EVM contract receives a storage intent with arbitrary payload
2. LayerZero routes the message to Sui
3. Relayer uploads the payload to Walrus as a deletable blob
4. Execution proof returns to the EVM origin chain

## Current status

Deployed on Sepolia + Sui Testnet with verified E2E flow.
