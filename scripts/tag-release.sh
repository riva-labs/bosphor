#!/usr/bin/env bash
#
# Tag a release-please release PR by hand.
#
# We keep the public Releases page milestone-only, so release-please runs with
# `skip-github-release: true`. That also skips git-tag creation, so a merged
# release PR stays "autorelease: pending" and deadlocks the next run ("untagged,
# merged release PRs outstanding"). This script does the manual half in one shot:
#
#   1. Admin-merge the release PR (GITHUB_TOKEN-created PRs get no CI, and branch
#      protection would otherwise block the merge).
#   2. Create the `<component>-v<version>` tag for every component in the
#      manifest that is missing one, pointing at current main.
#   3. Flip the PR label pending -> tagged so release-please stops aborting.
#   4. Delete any stale release-please branch that would trip "Error adding to
#      tree" on the next run.
#
# It is idempotent: existing tags are left alone. Component versioning
# (package.json + CHANGELOG) is still handled automatically by release-please;
# this only creates the tags it no longer creates for us.
#
# Usage:
#   scripts/tag-release.sh              # find the open pending release PR
#   scripts/tag-release.sh 231          # target a specific PR number
#   scripts/tag-release.sh --dry-run    # show what it would do, change nothing

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=false
PR=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) PR="$arg" ;;
  esac
done

run() {
  if $DRY_RUN; then echo "  [dry-run] $*"; else "$@"; fi
}

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v gh >/dev/null || { echo "gh is required"; exit 1; }

# 1. Resolve the release PR (open, labelled autorelease: pending).
if [ -z "$PR" ]; then
  PR=$(gh pr list --state open --label "autorelease: pending" \
        --search "chore: release" --json number -q '.[0].number // empty')
fi

if [ -n "$PR" ]; then
  STATE=$(gh pr view "$PR" --json state -q .state)
  if [ "$STATE" = "OPEN" ]; then
    echo "Admin-merging release PR #$PR ..."
    run gh pr merge "$PR" --squash --admin --delete-branch
  else
    echo "Release PR #$PR is already $STATE."
  fi
else
  echo "No open release PR found; ensuring manifest tags exist anyway."
fi

# 2. Sync to latest main and create any missing component tags.
run git checkout main
$DRY_RUN || git pull --ff-only
$DRY_RUN || git fetch --tags --quiet
SHA=$(git rev-parse HEAD)

CREATED=()
while IFS=$'\t' read -r path version; do
  component=$(jq -r --arg p "$path" '.packages[$p].component' release-please-config.json)
  tag="${component}-v${version}"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
    echo "  $tag exists, skipping"
  else
    echo "  creating $tag at ${SHA:0:12}"
    run git tag -a "$tag" -m "$component $version" "$SHA"
    run git push origin "$tag"
    CREATED+=("$tag")
  fi
done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' .release-please-manifest.json)

# 3. Flip the label so release-please treats the merged PR as tagged.
if [ -n "$PR" ]; then
  echo "Marking PR #$PR as tagged ..."
  run gh pr edit "$PR" --remove-label "autorelease: pending" --add-label "autorelease: tagged"
fi

# 4. Drop any stale release branch (left behind, it causes "Error adding to tree").
if git ls-remote --heads origin release-please--branches--main | grep -q .; then
  echo "Deleting stale release-please--branches--main ..."
  run git push origin --delete release-please--branches--main
fi

echo "Done. New tags: ${CREATED[*]:-none}"
