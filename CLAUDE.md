# Bosphor — Project Context

Cross-chain storage intent router: EVM → LayerZero v2 → Sui/Walrus → proof back to EVM.

## Status: Milestone 1 COMPLETE

## Deployed Contracts (Testnet — v5)
- EVM BosphorAdapter (Sepolia): 0xbC7EF2F021F517d871282C2bb512C741ad2958c3
- Sui Package: 0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656
- Sui OApp Object: 0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0
- LZ Endpoint (Sepolia): 0x6EDCE65403992e310A62460808c4b910D972f10f (EID 40161)
- Sui Testnet EID: 40378

## Key Fix (v5)
ptb_builder::lz_receive_info was returning raw MoveCall bytes.
LZ executor expects OAppInfoV1 format: [version][BCS(address, vec<u8>, vec<u8>, vec<u8>)].
Fix: wrapped with oapp_info_v1::create().encode().

## Architecture
EVM submitIntent → LZ → Sui lz_receive → IntentReceived event
→ Relayer → Walrus upload → execute_store → EVM confirmExecution

## npm Scripts
- npm run deploy:sui      — Sui deploy + register_oapp + set_peer
- npm run deploy:evm      — EVM deploy + setPeer
- npm run wire            — peer update only
- npm run test:e2e        — E2E test with LZ polling
- npm run new-deployment  — full: deploy-sui + deploy-evm + wire + e2e

## Key Technical Notes

### LayerZero v2
- OApp = OAppSender + OAppReceiver + OAppCore(Ownable)
- LZ-v2 uses OpenZeppelin v4.9.6 (NOT v5 — OAppCore msg.sender-based Ownable)
- Sui testnet EID: 40378
- LZ TestHelper too complex → minimal EndpointV2Mock used instead
- Sui LZ packages: OApp `0x04c440985f5deab2fb7f821b3288d93225a3e637cf22dda476809836f0533751`, EndpointV2 `0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a`
- EVM setPeer for Sui: Must use PACKAGE ID (not OApp Object ID)
- OAppInfoV1 format: lz_receive_info MUST be wrapped in OAppInfoV1::encode()
- sui client publish: Needs positional arg, Published.toml must be removed for fresh deploy
- waitForTransaction: Required between consecutive Sui TX's to avoid object version conflicts

### Sui Package Upgrade
- CallCap stored in LzReceiverConfig (not directly accessible via PTB)
- register_oapp entry function wraps endpoint_v2::register_oapp with internal CallCap access
- Upgrade via sui client upgrade --upgrade-capability <cap_id>

### Runtime
- Node 22 required (.nvmrc pinned) — tsx + @mysten/sui incompatible with Node 24
- Relayer: ethers v6 + @mysten/sui v1 + tsx

### Conventions
- Conventional commits: type(scope): description
- No Co-authored-by or AI references in commits
- English communication preferred

---

# Naming

- The product name is **Bosphor** (PascalCase). Never write "BOSPHOR" or "bosphor" in UI copy, docs, comments, prompts, or any generated text. Only lowercase `bosphor` is acceptable in file paths, CLI commands, and package names where convention requires it.

# Branch Strategy

Claude must enforce this rule continuously, without being asked.

**Rule:** Any work that introduces a new feature, touches 3+ files, spans multiple tasks, or takes more than one commit MUST go on a dedicated branch. Never push this kind of work directly to main.

**Exceptions:** Hotfixes and urgent single-file fixes (typos, one-line config changes, documentation updates) may go directly on main.

**How Claude enforces this:**
- When starting a feature or multi-task implementation, create the branch before writing any code: `git checkout -b <type>/<short-description>`
- Branch prefix follows `.claude/rules/git-standards.md`: `feature/`, `fix/`, `refactor/`, `chore/`
- Run `/clear` after creating the branch to start clean in the new context
- Finish all work with `/ship`, which opens a PR via `gh pr create`. Never merge by pushing directly.
- If work is already started on main and should have been on a branch, stop and say so before continuing

**Branch naming:** `<type>/<short-description>` (e.g. `feature/batch-intents`, `fix/relayer-reconnect`, `refactor/extract-lz-config`)

# Task tracking

- NEVER create, update, or interact with Linear issues. We do NOT use Linear for task tracking. All issues and task tracking happen on GitHub Issues exclusively.

# Commit message rules

- NEVER add `Co-Authored-By` trailers to commit messages.
- Follow the Conventional Commits format defined in `.claude/rules/git-standards.md`.
- NEVER commit changes immediately after making them. Always wait for explicit instruction from the user to commit.

# Writing rules

- NEVER use em dashes (---, &mdash;, or the character). Not in UI copy, comments, docs, prompts, or any generated text. Use a period or comma instead.
- ALWAYS write the product name as "Bosphor" (PascalCase). This applies everywhere: UI copy, comments, docs, prompts, and any generated text.

# Build verification

Before committing or shipping, Claude MUST run the full build and test gate:

```bash
# From the project root:
(cd contracts && forge build && forge test -vvv)
(cd sui/lz-receiver && sui move test --build-env testnet)
(cd relayer && npm run build)
npm run test:e2e
```

All steps must pass. A passing build alone is not sufficient. If any step fails, fix the issue before proceeding. This applies to `/review`, `/ship`, and any commit workflow.

# Docs rule

After every development task, check whether `docs/` or `website/docs/` has a page that covers the changed or added feature. If it does, update it. If the feature is new and user-facing (contract interface, relayer behavior, deployment flow, protocol change), create the relevant page. Write in plain language for developers integrating with Bosphor. Do not write docs for internal implementation details.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming: invoke /office-hours
- Strategy/scope: invoke /plan-ceo-review
- Architecture: invoke /plan-eng-review
- Full review pipeline: invoke /autoplan
- Bugs/errors: invoke /investigate
- Code review/diff check: invoke /review
- Ship/deploy/PR: invoke /ship or /land-and-deploy
- Save progress: invoke /context-save
- Resume context: invoke /context-restore
