/**
 * Deterministic release tooling shared library. Replaces release-please.
 *
 * The model is intentionally boring and side-effect-free until asked:
 *   - Each component has a version file (package.json for node, VERSION for plain).
 *   - The bump level for a component is derived from the conventional-commit
 *     messages on the current branch relative to main, attributed by scope and by
 *     changed file paths.
 *   - Versions are pre-1.0: feat -> minor, fix/perf -> patch, breaking -> minor.
 *   - Tags are `<tagPrefix><version>` and are created after merge from the version
 *     files, so there is no release PR and nothing to deadlock.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function gitOk(args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface Component {
  name: string;
  dir: string;
  type: "plain" | "node";
  versionFile: string;
  changelog: string;
  tagPrefix: string;
  scopes: string[];
}

export function loadConfig(): Component[] {
  const raw = readFileSync(resolve(repoRoot, "release.config.json"), "utf8");
  return (JSON.parse(raw).components as Component[]);
}

// --- semver (pre-1.0 aware) ---

export type Bump = "none" | "patch" | "minor" | "major";
const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };
export const maxBump = (a: Bump, b: Bump): Bump => (RANK[a] >= RANK[b] ? a : b);

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(s: string): SemVer {
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`invalid semver: "${s}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export const formatSemver = (v: SemVer): string => `${v.major}.${v.minor}.${v.patch}`;

export function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Applies a bump. While pre-1.0 (major === 0) a breaking change bumps minor, not major. */
export function applyBump(v: SemVer, bump: Bump): SemVer {
  let effective = bump;
  if (v.major === 0 && bump === "major") effective = "minor";
  switch (effective) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
    default:
      return v;
  }
}

// --- conventional commits ---

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:/;

function bumpForType(type: string | undefined, breaking: boolean): Bump {
  if (breaking) return "major";
  if (type === "feat") return "minor";
  if (type === "fix" || type === "perf") return "patch";
  return "none";
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

/** Resolves the merge-base of HEAD and the first existing of the given refs. */
export function mergeBase(candidates = ["origin/main", "main"]): string {
  for (const ref of candidates) {
    if (gitOk(["rev-parse", "--verify", ref])) {
      return git(["merge-base", ref, "HEAD"]);
    }
  }
  throw new Error(`none of the base refs exist: ${candidates.join(", ")}`);
}

export function commitsInRange(base: string, head = "HEAD"): Commit[] {
  const REC = "\x1e";
  const FLD = "\x1f";
  const out = git(["log", `${base}..${head}`, `--format=%H${FLD}%s${FLD}%b${REC}`]);
  return out
    .split(REC)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body = ""] = r.split(FLD);
      return { sha: sha!.trim(), subject: subject ?? "", body };
    });
}

function pathsForCommit(sha: string): string[] {
  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

export interface ComponentAnalysis {
  bump: Bump;
  commits: Commit[];
}

/**
 * Analyses base..HEAD and attributes each releasable commit to components by
 * scope and by changed file paths, returning the aggregate bump and the list of
 * contributing commits per component (for a focused changelog).
 */
export function analyze(components: Component[], base: string): Map<string, ComponentAnalysis> {
  const result = new Map<string, ComponentAnalysis>(
    components.map((c) => [c.name, { bump: "none", commits: [] }]),
  );

  for (const commit of commitsInRange(base)) {
    const header = commit.subject.match(HEADER_RE);
    if (!header) continue;
    const type = header.groups?.type;
    const scope = header.groups?.scope?.trim();
    const breaking =
      Boolean(header.groups?.bang) || /^BREAKING[ -]CHANGE:/m.test(commit.body);

    const bump = bumpForType(type, breaking);
    if (bump === "none") continue;

    const hits = new Set<string>();
    const paths = pathsForCommit(commit.sha);
    for (const c of components) {
      if (scope && c.scopes.includes(scope)) hits.add(c.name);
      if (paths.some((p) => p === c.dir || p.startsWith(c.dir + "/"))) hits.add(c.name);
    }

    for (const name of hits) {
      const entry = result.get(name)!;
      entry.bump = maxBump(entry.bump, bump);
      entry.commits.push(commit);
    }
  }

  return result;
}

// --- version file access ---

function extractVersion(component: Component, content: string): SemVer {
  if (component.type === "node") return parseSemver(JSON.parse(content).version);
  return parseSemver(content);
}

/** Version of a component in the working tree, or null if the component is absent. */
export function readCurrentVersion(component: Component): SemVer | null {
  const path = resolve(repoRoot, component.versionFile);
  if (!existsSync(path)) return null;
  return extractVersion(component, readFileSync(path, "utf8"));
}

/** Version of a component at a git ref, or null if it did not exist there. */
export function readVersionAtRef(ref: string, component: Component): SemVer | null {
  try {
    return extractVersion(component, git(["show", `${ref}:${component.versionFile}`]));
  } catch {
    return null;
  }
}

export function writeVersion(component: Component, version: SemVer): void {
  const path = resolve(repoRoot, component.versionFile);
  const v = formatSemver(version);
  if (component.type === "node") {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.version = v;
    writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  } else {
    writeFileSync(path, v + "\n");
  }
}

const CHANGELOG_SECTIONS: Array<{ title: string; test: (t: string, breaking: boolean) => boolean }> = [
  { title: "Breaking Changes", test: (_t, breaking) => breaking },
  { title: "Features", test: (t, breaking) => t === "feat" && !breaking },
  { title: "Bug Fixes", test: (t, breaking) => (t === "fix" || t === "perf") && !breaking },
];

/** Prepends a release section to a component's changelog, creating it if missing. */
export function prependChangelog(
  component: Component,
  version: SemVer,
  commits: Commit[],
  date: string,
): void {
  const path = resolve(repoRoot, component.changelog);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "# Changelog\n";

  const parsed = commits
    .map((c) => {
      const h = c.subject.match(HEADER_RE);
      return h
        ? {
            type: h.groups!.type!,
            breaking: Boolean(h.groups?.bang) || /^BREAKING[ -]CHANGE:/m.test(c.body),
            subject: c.subject,
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  let section = `## ${formatSemver(version)} (${date})\n`;
  for (const { title, test } of CHANGELOG_SECTIONS) {
    const items = parsed.filter((p) => test(p.type, p.breaking));
    if (items.length === 0) continue;
    section += `\n### ${title}\n\n`;
    for (const it of items) section += `- ${it.subject}\n`;
  }
  section += "\n";

  // Insert after the top-level "# Changelog" heading.
  const lines = existing.split("\n");
  const headingIdx = lines.findIndex((l) => l.startsWith("# "));
  const insertAt = headingIdx >= 0 ? headingIdx + 1 : 0;
  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n").replace(/^\n+/, "");
  writeFileSync(path, `${before}\n\n${section}${after}`.replace(/\n{3,}/g, "\n\n"));
}

export function tagFor(component: Component, version: SemVer): string {
  return `${component.tagPrefix}${formatSemver(version)}`;
}

export function tagExists(tag: string): boolean {
  return gitOk(["rev-parse", "--verify", `refs/tags/${tag}`]);
}
