/**
 * version-bump: determine and apply per-component version bumps from the
 * conventional commits on this branch, BEFORE a PR is opened. Replaces the
 * release-please release PR.
 *
 * Usage:
 *   tsx scripts/release/version-bump.ts            # apply bumps + changelog to the working tree
 *   tsx scripts/release/version-bump.ts --check    # verify bumps are present (CI gate), no writes
 *   tsx scripts/release/version-bump.ts --base <ref>   # override base ref (default origin/main, then main)
 *
 * A component is bumped at most once per branch: the target is computed from the
 * component's version on the base branch plus the required bump, so re-running is
 * idempotent and never double-bumps.
 */
import {
  loadConfig,
  mergeBase,
  analyze,
  readVersionAtRef,
  readCurrentVersion,
  applyBump,
  compareSemver,
  formatSemver,
  writeVersion,
  prependChangelog,
  type Bump,
  type Commit,
  type Component,
  type SemVer,
} from "./lib.ts";

const args = process.argv.slice(2);
const check = args.includes("--check");
const baseIdx = args.indexOf("--base");
const baseOverride = baseIdx >= 0 ? args[baseIdx + 1] : undefined;

const today = new Date().toISOString().slice(0, 10);
const base = mergeBase(baseOverride ? [baseOverride] : undefined);
const components = loadConfig();
const analysis = analyze(components, base);

interface Plan {
  component: Component;
  bump: Bump;
  commits: Commit[];
  from: SemVer;
  to: SemVer;
  current: SemVer;
  satisfied: boolean;
}

const plans: Plan[] = [];
for (const component of components) {
  const { bump, commits } = analysis.get(component.name)!;
  if (bump === "none") continue;

  const current = readCurrentVersion(component);
  if (!current) continue; // component not present on this branch

  const baseVersion = readVersionAtRef(base, component) ?? current;
  const target = applyBump(baseVersion, bump);
  plans.push({
    component,
    bump,
    commits,
    from: baseVersion,
    to: target,
    current,
    satisfied: compareSemver(current, target) >= 0,
  });
}

if (plans.length === 0) {
  console.log("No releasable changes. No version bump needed.");
  process.exit(0);
}

if (check) {
  for (const p of plans) {
    console.log(
      `[${p.satisfied ? "ok" : "MISSING"}] ${p.component.name}: needs ${p.bump} -> ` +
        `${formatSemver(p.to)} (current ${formatSemver(p.current)})`,
    );
  }
  const missing = plans.filter((p) => !p.satisfied);
  if (missing.length > 0) {
    console.error(
      `\nVersion bump required for: ${missing.map((p) => p.component.name).join(", ")}.\n` +
        "Run `npm run version:bump` and commit the result before merging.",
    );
    process.exit(1);
  }
  console.log("\nAll component versions are correctly bumped.");
  process.exit(0);
}

for (const p of plans) {
  if (p.satisfied) {
    console.log(`${p.component.name}: already at ${formatSemver(p.current)}, skipping`);
    continue;
  }
  writeVersion(p.component, p.to);
  prependChangelog(p.component, p.to, p.commits, today);
  console.log(`${p.component.name}: ${formatSemver(p.from)} -> ${formatSemver(p.to)} (${p.bump})`);
}

console.log("\nDone. Review the changes, then commit them into your branch.");
