# Contributing to Bosphor

## Development Setup

### Prerequisites

- Node.js 22 (pinned via `.nvmrc`)
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- [Sui CLI](https://docs.sui.io/build/install)

### Local Environment

```bash
git clone --recurse-submodules https://github.com/riva-labs/bosphor
cd bosphor
nvm use
npm install
cp .env.example .env
```

This is not an npm workspace yet: the root `npm install` only installs the root
tooling. Each package (`relayer/`, `sdk/`, `canary/`, `website/`, `sdk-docs/`)
has its own `package.json`. Run `npm run setup` to install all of them in one
command, or install just the ones you work on, e.g. `(cd relayer && npm install)`.

Optional: install the opt-in pre-push hook so the Release Guard check runs
locally before you push:

```bash
npm run hooks:install
```

### Running Tests

From the repo root, `npm test` runs the Solidity, Move, relayer, and SDK unit
tests. To run them individually:

```bash
# Solidity (Foundry)
cd contracts/evm && forge test -vvv

# Sui Move
cd contracts/sui/lz-receiver && sui move test --build-env testnet

# Relayer
cd relayer && npm test

# SDK (incl. cross-chain parity vectors)
cd sdk && npm test
```

The full cross-chain gate (`npm run test:e2e`) needs a running relayer and a
funded testnet wallet; it is a manual pre-merge step, not part of CI.

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): add new feature
fix(scope): fix a bug
docs(scope): update documentation
test(scope): add or update tests
chore(scope): maintenance tasks
refactor(scope): code refactoring
```

Scope examples: `contracts`, `sui`, `relayer`, `scripts`, `ci`, `docs`.

## Versioning (before you open a PR)

Components (`contracts-evm`, `sui`, `relayer`, `sdk`) are versioned independently
and deterministically. If your change touches a versioned component, bump it
before opening the PR:

```bash
npm run version:bump   # reads your branch commits, writes the version files + changelog
```

The Release Guard CI check fails the PR if a component changed without a matching
bump (`npm run version:check` runs the same check locally). Only `feat` and `fix`
commits trigger a bump; `chore`/`docs`/`refactor`/`test`/`ci` do not. Tags are
created automatically on merge, so there is no release PR.

## Pull Request Process

1. Create a feature branch from `main` (`<type>/<short-description>`). Direct
   pushes to `main` are reserved for hotfixes.
2. Ensure the test gate passes locally before opening a PR.
3. Run `npm run version:bump` if a versioned component changed, and commit it.
4. Update documentation if your changes affect the public API.
5. Fill out the PR template completely and reference the issue with `Closes #N`.
6. Request review from a maintainer. Squash-merge to keep `main` clean.

## Code Style

- **Solidity**: Follow the [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html). Use NatSpec for all public functions.
- **Move**: Follow [Sui Move conventions](https://docs.sui.io/references/contribute/code-conventions). Use `///` doc comments.
- **TypeScript**: Strict mode, no `any` types where avoidable, no `console.log` in library code (use structured logger).

## Questions

Open a [GitHub Discussion](https://github.com/riva-labs/bosphor/discussions) for questions about usage or architecture.
