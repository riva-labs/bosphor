# Git Standards

## Commit Messages

This project uses **Conventional Commits**.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type       | When                                                          |
| ---------- | ------------------------------------------------------------- |
| `feat`     | New feature or user-facing functionality                      |
| `fix`      | Bug fix                                                       |
| `docs`     | Documentation only                                            |
| `chore`    | Tooling, config, dependencies, CI, no production code change  |
| `refactor` | Code restructuring without behavior change                    |
| `style`    | Formatting, whitespace, no logic change                       |
| `test`     | Adding or fixing tests                                        |
| `perf`     | Performance improvement                                       |
| `ci`       | CI/CD pipeline changes                                        |

### Scopes

Use the area of the codebase affected:

- `contracts`, `sui`, `relayer`, `scripts`, `docs`, `website`, `ci`, `config`
- For cross-cutting changes: omit scope

### Rules

- MUST use lowercase for type and scope.
- MUST use imperative mood in description: "add feature" not "added feature" or "adds feature".
- MUST keep the first line under 72 characters.
- MUST NOT end the description with a period.
- SHOULD include a body for non-trivial changes explaining **why**.
- MUST reference issue numbers in the footer when applicable: `Closes #42`.

### Examples

```
feat(contracts): add batch intent submission to BosphorAdapter
fix(relayer): handle object version conflict on consecutive Sui txs
refactor(scripts): extract deployment helpers to shared module
chore: update dependencies to latest patch versions
docs(sui): add Move doc comments for lz_receive module
ci: add forge and relayer build workflows
```

---

## Branch Strategy

### Branch Naming

```
<type>/<short-description>
```

- `feature/batch-intents`
- `fix/relayer-reconnect`
- `chore/update-deps`
- `refactor/extract-lz-config`

### Rules

- Any work that introduces a new feature, touches 3+ files, spans multiple tasks, or takes more than one commit MUST go on a dedicated branch.
- Hotfixes and urgent single-file fixes may go directly on `main`.
- If a branch is used, keep it short-lived and delete it after merge.
- MUST NOT force-push to shared branches.

---

## Pull Requests

- PR title MUST follow the same Conventional Commit format as the merge commit.
- PR description MUST include: what changed, why, and how to test.
- MUST NOT merge with failing CI checks.
- SHOULD squash-merge to keep `main` history clean.
- MUST NOT force-push to shared branches.

---

## What Not To Commit

- `.env` files (use `.env.example` for structure)
- `node_modules/`
- Private keys, mnemonics, or wallet secrets
- OS files (`.DS_Store`)
- Editor-specific files (`.vscode/settings.json` with personal config)
- Large binary files, use Git LFS if necessary
- Temporary debug code (`console.log`, `debugger`)
- Compiled artifacts (`out/`, `cache/`, `build/`) unless explicitly required
