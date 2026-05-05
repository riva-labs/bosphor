# Contributing to Bosphor

## Development Setup

### Prerequisites

- Node.js 22 (pinned via `.nvmrc`)
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- [Sui CLI](https://docs.sui.io/build/install)

### Local Environment

```bash
git clone https://github.com/AliErcanOzgokce/bosphor
cd bosphor
nvm use
npm install
cp .env.example .env
```

### Running Tests

```bash
# Solidity (Foundry)
cd contracts && forge test -vvv

# Sui Move
cd sui/lz-receiver && sui move test

# Relayer
cd relayer && npm test
```

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

## Pull Request Process

1. Fork the repository and create a feature branch from `main`.
2. Ensure all tests pass locally before opening a PR.
3. Update documentation if your changes affect the public API.
4. Fill out the PR template completely.
5. Request review from a maintainer.

## Code Style

- **Solidity**: Follow the [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html). Use NatSpec for all public functions.
- **Move**: Follow [Sui Move conventions](https://docs.sui.io/references/contribute/code-conventions). Use `///` doc comments.
- **TypeScript**: Strict mode, no `any` types where avoidable, no `console.log` in library code (use structured logger).

## Questions

Open a [GitHub Discussion](https://github.com/AliErcanOzgokce/bosphor/discussions) for questions about usage or architecture.
