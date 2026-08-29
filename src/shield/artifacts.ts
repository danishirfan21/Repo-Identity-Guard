/**
 * Ownership/version marking for the files Shield writes onto disk (the
 * pre-commit and pre-push hook shims, and its copy of the standalone
 * evaluator). All are plain shell scripts, so "ownership" is a comment line
 * embedded in the
 * file itself — checked before ShieldManager will overwrite or delete
 * anything at a path it doesn't fully control, and read back by
 * `inspect()`/`repair()` to tell "this is Shield's own artifact, possibly
 * outdated" apart from "something else lives here now."
 *
 * Deliberately no separate manifest/lockfile: the marker-plus-version
 * comment embedded in each artifact *is* the durable record, so a
 * partially-completed install can never be mistaken for a complete one —
 * `inspect()` always re-derives state from what is actually on disk right
 * now, never from a cached "I installed this" flag that could drift from
 * reality (a foreign tool overwriting the hook, a user hand-editing it, a
 * crash mid-write). See ShieldManager's module comment for how this feeds
 * the off/active/degraded/broken lifecycle.
 */

export const SHIELD_ARTIFACT_MARKER = "repo-identity-guard-shield-artifact";

/**
 * Bumped whenever the *installed* hook shim or evaluator copy's contents
 * change in a way worth re-installing for (not the same axis as
 * `SHIELD_POLICY_VERSION`, which versions the policy schema). `inspect()`
 * flags an on-disk artifact whose embedded version is older than this as
 * "repair available," without treating it as broken or non-owned.
 */
export const SHIELD_ARTIFACT_VERSION = 1;

function markerPattern(): RegExp {
  return new RegExp(`${SHIELD_ARTIFACT_MARKER}\\s+v(\\d+)`);
}

/** True when `content` carries Shield's ownership marker anywhere in it — i.e. this file is Shield's own, safe to overwrite/delete. Absence means "foreign": never touch it. */
export function isShieldOwnedArtifact(content: string): boolean {
  return content.includes(SHIELD_ARTIFACT_MARKER);
}

/** The artifact version embedded in an owned file's marker comment, or undefined if the marker (or a version number after it) isn't present. */
export function extractShieldArtifactVersion(content: string): number | undefined {
  const match = content.match(markerPattern());
  if (!match) return undefined;
  const version = Number(match[1]);
  return Number.isFinite(version) ? version : undefined;
}

/**
 * The pre-commit hook Shield installs. Contains no enforcement logic of
 * its own — it only locates and runs the evaluator copy Shield placed
 * alongside the repo's policy (both under the shared git-common-dir, so
 * this resolves correctly from any worktree), which is what makes
 * enforcement work with VS Code completely closed. Fails open (exit 0)
 * if that evaluator copy is missing, rather than blocking every commit
 * because of a half-removed install.
 */
export function buildPreCommitHookScript(): string {
  return `#!/bin/sh
# Repo Identity Guard Shield pre-commit hook (owned by Repo Identity Guard)
# ${SHIELD_ARTIFACT_MARKER} v${SHIELD_ARTIFACT_VERSION} (pre-commit)
#
# Managed by Repo Identity Guard's Shield Mode. Do not hand-edit this file
# -- "Repo Identity Guard: Repair Shield" regenerates it, and "Repo
# Identity Guard: Disable Shield" removes it (only because that command
# recognizes this exact marker comment; a hand-edited copy that keeps the
# marker would still be recognized as Shield's own and be replaced/removed
# by those commands -- if you need to customize hook behavior, chain your
# own separate hook instead of editing this one).
set -eu

GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
EVAL_SCRIPT="$GIT_COMMON_DIR/repo-identity-guard/shield-evaluate.sh"

# No evaluator copy present -- nothing to enforce. Fail open: a half
# installed/removed Shield must never be the reason an ordinary commit is
# blocked.
[ -f "$EVAL_SCRIPT" ] || exit 0

set +e
REASON=$(sh "$EVAL_SCRIPT" commit 2>&1 >/dev/null)
CODE=$?
set -e

if [ "$CODE" -eq 0 ]; then
  exit 0
fi

{
  echo ""
  echo "Repo Identity Guard Shield"
  echo ""
  echo "COMMIT BLOCKED"
  echo ""
  printf '%s\\n' "$REASON" | grep -v '^Shield: BLOCKED'
  echo ""
  echo "Fix the repository identity or disable Shield for this repository."
} >&2

exit "$CODE"
`;
}

/**
 * The pre-push hook Shield installs. Like the pre-commit hook, it contains
 * no enforcement logic of its own -- it forwards Git's own pre-push
 * arguments (`$1` = remote name, `$2` = remote location/URL) and its own
 * stdin (the `<local-ref> <local-sha1> <remote-ref> <remote-sha1>` lines
 * Git feeds a real pre-push hook) straight through to the evaluator copy
 * Shield placed alongside the repo's policy -- these are the actual
 * action-time values for THIS push, never a value predicted earlier by an
 * extension scan. Fails open (exit 0) if the evaluator copy is missing,
 * for the same reason the pre-commit hook does.
 */
export function buildPrePushHookScript(): string {
  return `#!/bin/sh
# Repo Identity Guard Shield pre-push hook (owned by Repo Identity Guard)
# ${SHIELD_ARTIFACT_MARKER} v${SHIELD_ARTIFACT_VERSION} (pre-push)
#
# Managed by Repo Identity Guard's Shield Mode. Do not hand-edit this file
# -- "Repo Identity Guard: Repair Shield" regenerates it, and "Repo
# Identity Guard: Disable Shield" removes it (only because that command
# recognizes this exact marker comment; a hand-edited copy that keeps the
# marker would still be recognized as Shield's own and be replaced/removed
# by those commands -- if you need to customize hook behavior, chain your
# own separate hook instead of editing this one).
set -eu

REMOTE_NAME="\${1:-}"
REMOTE_LOCATION="\${2:-}"

GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
EVAL_SCRIPT="$GIT_COMMON_DIR/repo-identity-guard/shield-evaluate.sh"

# No evaluator copy present -- nothing to enforce. Fail open: a half
# installed/removed Shield must never be the reason an ordinary push is
# blocked.
[ -f "$EVAL_SCRIPT" ] || exit 0

# Stdin here is Git's own <local-ref> <local-sha1> <remote-ref>
# <remote-sha1> lines for this push -- not redirected, so the evaluator
# invocation below inherits it exactly as Git provided it.
set +e
REASON=$(sh "$EVAL_SCRIPT" push "$REMOTE_NAME" "$REMOTE_LOCATION" 2>&1 >/dev/null)
CODE=$?
set -e

if [ "$CODE" -eq 0 ]; then
  exit 0
fi

{
  echo ""
  echo "Repo Identity Guard Shield"
  echo ""
  echo "PUSH BLOCKED"
  echo ""
  echo "Remote: $REMOTE_NAME"
  echo "Destination: $REMOTE_LOCATION"
  echo ""
  printf '%s\\n' "$REASON" | grep -v '^Shield: BLOCKED'
  echo ""
  echo "Fix the push destination/route or disable Shield for this repository."
} >&2

exit "$CODE"
`;
}
