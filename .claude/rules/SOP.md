# Standard Operating Procedures

> Which commands to use, in which order, for each type of development work.
> These are the approved workflows. Do not skip steps or reorder them.

## Task Tracking

**All task tracking happens on GitHub Issues. No exceptions.**

- NEVER use Linear, Jira, or any other external tracker. GitHub Issues is the single source of truth.
- Every feature, bug, and refactor MUST have a GitHub issue before work begins.
- PRDs created by `/to-prd` MUST be published as GitHub issues.
- Slices created by `/to-issues` MUST be GitHub issues linked to the parent.
- PRs MUST reference issues with `Closes #N` in the body.
- When resuming work across sessions, read the GitHub issue for context.
- After a PR is merged, Claude MUST close all related GitHub issues (parent and child slices) with a comment referencing the PR number. Then delete any remaining remote branches. This is not optional, it is part of the ship workflow.

---

## Adding a New Feature

**Phase 1 -- Alignment (stay in planning mode; keep an eye on the scope)**

1. `/grill-with-docs` -- Clarify all details about the feature before writing anything. If no docs are relevant, use `/grill-me`. Exit when every open question is answered and the scope is unambiguous.

2. `/to-prd` -- Turn the grilled understanding into a PRD and open a parent GitHub issue.

3. `/to-issues` -- Slice the parent issue into small, independently-mergeable child issues. Note the first issue number, you will need to track it across `/clear` cycles.

**Phase 2 -- Execution**

4. Create a feature branch, `git checkout -b feature/<short-description>`, before writing a single line of code. Then run `/clear` to clear context. This is the hard boundary between planning and building. Everything from here is code on the branch, never on `main`.

5. `/tdd` -- Implement each slice with TDD. One issue at a time. After every `/clear` cycle, re-specify the current issue number explicitly so the AI picks up from the right place.

6. `/review` -- Run a pre-landing review on the diff before every commit. Catch contract safety issues, cross-chain message integrity violations, and structural problems.

7. `/qa` -- After all issues for the feature are closed, run one full QA cycle. For Bosphor this means: `forge test`, `sui move test`, and `npm run test:e2e`.

**Phase 3 -- Ship**

8. `/autoplan` -- Run the full review pipeline on the final state.

9. `/document-generate` -- Update or generate documentation for anything changed.

10. `/ship` -- Commit, open a PR with `gh pr create`, and push. Include `Closes #N` in the body and a test plan.

---

## Fixing a Bug

> The Iron Law: no fix without a confirmed root cause.

**Phase 1 -- Investigation**

1. `/investigate` -- Always start here. Four phases: investigate, analyze, hypothesize, implement. Do not touch code until root cause is confirmed. `/investigate` is non-negotiable for bugs, do not skip it and go straight to editing.

**Phase 2 -- Fix**

2. Create a branch, `git checkout -b fix/<short-description>`, before writing the fix. For a genuine hotfix (single file, urgent production issue), pushing directly to `main` is acceptable. For anything else, use a branch.

3. `/clear` -- Clear context after investigation, before writing the fix. Keeps the fix focused and prevents stale investigation context from contaminating the solution.

4. Implement the fix. Scope it strictly to the confirmed root cause. No opportunistic cleanup.

5. `/review` -- Pre-landing check on the diff. Verify the fix addresses root cause and does not introduce regressions.

**Phase 3 -- Verify**

6. Run the full test gate: `forge test`, `sui move test`, and `npm run test:e2e`. All must pass.

7. `/ship` -- Commit, open a PR with `gh pr create`, and push. Reference the issue (`Closes #N`) and include a test plan.

---

## Refactoring

> Refactoring changes structure without changing behavior. If behavior changes, it is a feature or a bug fix, not a refactor.

**Phase 1 -- Scope**

1. `/grill-me` -- Clarify the refactor's exact scope and success criteria. What is moving, what is not, what must stay identical.

2. `/plan-eng-review` -- Architecture review before touching code. Catch data-flow issues, circular dependencies, and migration sequencing problems early.

**Phase 2 -- Execute**

3. `/clear` -- Clear context before writing code.

4. Implement. After each meaningful chunk of changes, run `/simplify` to catch over-engineering or missed reuse opportunities before accumulating more changes.

5. `/review` -- Pre-landing check. Confirm no behavioral changes crept in.

**Phase 3 -- Verify**

6. Run the full test gate: `forge test`, `sui move test`, and `npm run test:e2e`. All must pass.

7. `/ship` -- Commit, open a PR with `gh pr create`, and push. Reference the issue and include a test plan.

---

## Shipping / Deploying

> Use this when a feature or fix is complete and ready to go out.

1. `/review` -- Final diff check before merging.

2. Run the full test gate: `forge test`, `sui move test`, and `npm run test:e2e`.

3. `/ship` -- Commit, open a PR with `gh pr create`, and push. Link the issue in the body (`Closes #N`). The PR description must include: what changed, why, and how to test. This is not optional, it is the context agents and reviewers rely on.

---

## Designing Something New (Architecture / Protocol / Contract)

> Use this before any code is written for a new protocol feature, a new contract, or a new system.

1. `/office-hours` -- Brainstorm and stress-test the idea. Answer: is it worth building, who is it for, what is the narrowest wedge.

2. `/plan-ceo-review` -- Strategy and scope review. Confirm the idea fits product direction before going deep.

3. `/plan-eng-review` -- Lock in the technical plan before writing code. For smart contracts, this is where security considerations, gas optimization, and cross-chain message format decisions are finalized.

4. `/to-prd` -- Convert the reviewed plan into a PRD and a GitHub issue.

Then follow the **Adding a New Feature** SOP from step 3.

---

## Context Management

> Use these to stay in the smart zone. Context degrades as the window fills up.

- `/context-save` -- Save progress before the context window gets too full. Do this at natural breakpoints (end of a phase, before a `/clear`, before a long `/tdd` session).

- `/context-restore` -- Resume from a saved context at the start of a new session. Always run this before continuing work from a prior conversation.

- `/clear` -- Hard reset. Use at phase boundaries (end of planning, end of investigation). After `/clear`, re-specify the current task explicitly.

**Rule of thumb:** If a conversation has gone through 2+ `/clear` cycles and you are still in the same feature, run `/context-save` before the next cycle so nothing is lost.

---

## Code Review (Incoming PR or Diff)

1. `/review` -- For your own diffs before committing.

2. `/ultrareview` -- For thorough multi-agent review of a branch or GitHub PR (`/ultrareview <PR#>`). Use when the change is high-risk, cross-cutting, or needs an independent second opinion.

---

## PR & Issue Workflow

> Feature and refactor work goes on a dedicated branch and merges to `main` via PR. Direct pushes to `main` are reserved for hotfixes only.

### Branch strategy (Claude enforces this)

- **New feature, multi-task work, or anything touching 3+ files**: create a branch first: `git checkout -b <type>/<short-description>`. Never start this kind of work on `main`.
- **Hotfix or urgent single-file fix**: may go directly on `main`. If in doubt, use a branch.
- **Branch prefix:** `feature/`, `fix/`, `refactor/`, `chore/` -- matches the commit type.
- **Claude must create the branch before writing any code** when the work qualifies as a feature or multi-task change. If work has already started on `main` and should have been on a branch, Claude must stop and flag it.

### Why this matters for agents

Issues and PRs are the primary context source when an agent resumes work across `/clear` cycles or across sessions. A well-written issue means an agent can pick up a task cold and implement it correctly. A well-written PR description means reviewers and agents can audit the change without spelunking through the diff.

### Issues

- Every feature slice from `/to-issues` maps to one GitHub issue.
- Issue body must include: **what** needs to be built, **why** it matters, **acceptance criteria**, and links to the parent issue and any dependent issues.
- Issues are the spec. If the issue is vague, the implementation will be too. Use `/grill-me` or `/grill-with-docs` before writing the issue if scope is unclear.
- Label issues: `feature`, `bug`, `refactor`, `chore`, `docs`.

### Pull Requests

- Open PRs from the feature branch. Never push feature or multi-task work directly to `main`.
- PR title follows Conventional Commits format (same as commit messages).
- PR body must include:
  - **What changed**: 2-4 bullet points describing the diff.
  - **Why**: the motivation; reference the issue with `Closes #N`.
  - **How to test**: step-by-step instructions an agent or reviewer can follow.
- Open the PR as a draft while work is in progress; mark ready for review only when `/review` and tests have passed.
- Use `/ship` to commit and open the PR in one step. Use `gh pr edit` if you need to update an existing PR description.

### Branch naming

Follow the pattern in `git-standards.md`: `<type>/<short-description>` (e.g. `feature/batch-intents`, `fix/relayer-reconnect`, `refactor/extract-lz-config`).

---

## Build & Test Gate

Before committing or shipping, Claude MUST run the full build and test suite and verify everything passes. A passing build alone is not sufficient; all tests must also pass.

**Required checks (all mandatory):**

```bash
# From the project root:

# 1. Solidity build + tests
(cd contracts/evm && forge build && forge test -vvv)

# 2. Move tests
(cd sui/lz-receiver && sui move test --build-env testnet)

# 3. Relayer build
(cd relayer && npm run build)

# 4. End-to-end cross-chain test
npm run test:e2e
```

If any step fails, fix the issue before proceeding. This applies to `/review`, `/ship`, and any commit workflow.

---

## Quick Reference

| Situation                                   | First command                          |
| ------------------------------------------- | -------------------------------------- |
| New idea, not sure if worth building        | `/office-hours`                        |
| Feature is scoped, ready to clarify details | `/grill-with-docs` or `/grill-me`      |
| PRD is written, need to split into issues   | `/to-issues`                           |
| Ready to write code (feature)               | Create branch, `/clear`, then `/tdd`  |
| Bug reported                                | `/investigate`                         |
| About to commit                             | `/review`                              |
| Feature is done, need full test pass        | Run build & test gate                  |
| Ready to commit and open a PR               | `/ship`                                |
| Hotfix, urgent single-file fix              | Commit and push directly to `main`     |
| Context window is getting heavy             | `/context-save` then `/clear`          |
| Resuming from a prior session               | `/context-restore`                     |
| Architecture decision before building       | `/plan-eng-review`                     |
| Full automated review of a plan             | `/autoplan`                            |
