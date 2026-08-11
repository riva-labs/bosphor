/**
 * tag: create and push `<component>-v<version>` tags from the version files on
 * the current commit. Runs in CI on push to main after a PR merges. Replaces
 * release-please tag creation and scripts/tag-release.sh.
 *
 * Deterministic and idempotent: it only creates tags that do not already exist,
 * so re-running is safe and there is no release PR to deadlock. The public
 * Releases page stays milestone-only, so this creates git tags only, not GitHub
 * Releases.
 *
 * Usage:
 *   tsx scripts/release/tag.ts             # create + push missing tags
 *   tsx scripts/release/tag.ts --dry-run   # print what would be tagged, change nothing
 */
import {
  loadConfig,
  readCurrentVersion,
  tagFor,
  tagExists,
  git,
  formatSemver,
} from "./lib.ts";

const dryRun = process.argv.includes("--dry-run");
const created: string[] = [];

for (const component of loadConfig()) {
  const version = readCurrentVersion(component);
  if (!version) continue; // component not present

  const tag = tagFor(component, version);
  if (tagExists(tag)) {
    console.log(`  ${tag} exists, skipping`);
    continue;
  }

  if (dryRun) {
    console.log(`  [dry-run] would create and push ${tag}`);
    created.push(tag);
    continue;
  }

  git(["tag", "-a", tag, "-m", `${component.name} ${formatSemver(version)}`]);
  git(["push", "origin", tag]);
  console.log(`  created ${tag}`);
  created.push(tag);
}

console.log(created.length ? `\nTagged: ${created.join(", ")}` : "\nNo new tags.");
