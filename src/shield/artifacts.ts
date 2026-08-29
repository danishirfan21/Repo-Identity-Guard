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
export const SHIELD_ARTIFACT_VERSION = 5;

/**
 * The sidecar file name suffix a hook's exact original foreign bytes are
 * preserved under when Shield is installed with `chainForeignHooks`
 * (Phase 6) — e.g. `pre-commit.repo-identity-guard-original` next to
 * `pre-commit` itself, in the same hooks directory. Both hook shims below
 * look for this exact sibling at runtime (via `dirname "$0"`, so it works
 * regardless of the hooks directory's actual path) and, if Shield's own
 * check passes, hand off to it with the same argv and stdin — see
 * "Hook coexistence (Phase 6)" in docs/SHIELD_MODE.md. `ShieldManager` is
 * what actually creates/restores this sidecar (moving the foreign hook
 * aside on enable, moving it back on disable); this constant is shared so
 * the path the shell script looks for and the path the manager writes are
 * never allowed to drift apart.
 */
export const SHIELD_CHAIN_ORIGINAL_SUFFIX = ".repo-identity-guard-original";

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
 * Shared shell fragment: resolve the evaluator copy Shield installed, and
 * FAIL CLOSED with a clearly-framed "Shield internal error / broken
 * installation" message if anything about that resolution doesn't hold.
 *
 * ## Why this fails closed (v5 hardening)
 *
 * Up to v4 both shims exited 0 ("fail open") when `git rev-parse
 * --git-common-dir` failed or the evaluator copy was missing. That was
 * wrong, and empirically exploitable: with Shield reported ACTIVE, simply
 * deleting `<gitCommonDir>/repo-identity-guard/shield-evaluate.sh` left
 * the hook in place and every mismatched-identity commit sailed straight
 * through, silently. "Hook installed but evaluator missing" is not a
 * policy verdict and not a disabled Shield — it is a broken installation,
 * and the only safe reading of a broken enforcement mechanism is to stop
 * the operation and say so.
 *
 * The complementary half of this guarantee lives in `ShieldManager`:
 * `disable()` removes/disarms every hook it can prove it owns — at the
 * hooks directory currently in effect AND at every hooks directory
 * recorded in Shield's durable installation record (see
 * `src/shield/installRecord.ts`) — strictly BEFORE it deletes the
 * evaluator/policy. So a *completed* disable never leaves a hook behind
 * to fail closed against a deliberately-removed evaluator. The remaining
 * window (a disable interrupted between those two steps) fails closed
 * with an actionable message rather than silently un-enforcing, and is
 * resolved by re-running Disable Shield or Repair Shield.
 *
 * `$1` is the label used in the message ("COMMIT"/"PUSH").
 */
function evaluatorResolutionFragment(actionLabel: string): string {
  return `GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || GIT_COMMON_DIR=""
if [ -z "$GIT_COMMON_DIR" ]; then
  {
    echo ""
    echo "Repo Identity Guard Shield"
    echo ""
    echo "${actionLabel} BLOCKED (Shield internal error: broken installation)"
    echo ""
    echo "This Shield hook is installed, but the repository's git-common-dir could not be resolved (\\"git rev-parse --path-format=absolute --git-common-dir\\" failed). Shield cannot find its policy or evaluator, so it cannot make a decision -- failing closed."
    echo ""
    echo "Note: \\"--path-format\\" requires Git 2.31 or newer, which is Shield's minimum supported Git version."
    echo ""
    echo "Next step: run \\"Repo Identity Guard: Repair Shield\\", or \\"Repo Identity Guard: Disable Shield\\" to remove Shield from this repository."
  } >&2
  exit 1
fi

EVAL_SCRIPT="$GIT_COMMON_DIR/repo-identity-guard/shield-evaluate.sh"

# FAIL CLOSED, never open: a hook that is installed but whose evaluator is
# missing/unreadable is a BROKEN Shield installation, not a disabled one.
if [ ! -f "$EVAL_SCRIPT" ] || [ ! -r "$EVAL_SCRIPT" ]; then
  {
    echo ""
    echo "Repo Identity Guard Shield"
    echo ""
    echo "${actionLabel} BLOCKED (Shield internal error: broken installation)"
    echo ""
    echo "This Shield hook is installed, but Shield's evaluator is missing or unreadable at:"
    echo "  $EVAL_SCRIPT"
    echo ""
    echo "Shield cannot decide whether this ${actionLabel === "COMMIT" ? "commit" : "push"} is safe, so it is failing closed rather than letting it through unchecked."
    echo ""
    echo "Next step: run \\"Repo Identity Guard: Repair Shield\\" to reinstall it, or \\"Repo Identity Guard: Disable Shield\\" to remove Shield from this repository (which also removes this hook)."
  } >&2
  exit 1
fi
`;
}

/**
 * Shared shell fragment: hand off to a chained original foreign hook, if
 * one is present at `$ORIGINAL_HOOK`.
 *
 * v5 hardening: the sidecar is only ever executed when it is actually an
 * executable regular file. Up to v4 the shim `exec`'d anything that
 * existed, which produced a mysterious `exec: ...: Permission denied`
 * (empirically reproduced) whenever a *non-executable* foreign hook had
 * been chained — a failure with no explanation and no obvious owner.
 * `ShieldManager` now refuses to chain anything but an executable regular
 * file in the first place, so this branch should be unreachable in
 * practice; it exists so that a sidecar that becomes unexecutable
 * afterwards still produces a precise, attributable message instead of a
 * raw shell error. Missing sidecar = nothing was ever chained = exit 0.
 *
 * `$1` is the label used in the message ("COMMIT"/"PUSH"); `$2` is the
 * shell snippet that actually runs the original hook.
 */
function chainedHandoffFragment(actionLabel: string, runOriginal: string): string {
  return `if [ -e "$ORIGINAL_HOOK" ] || [ -L "$ORIGINAL_HOOK" ]; then
  if [ ! -f "$ORIGINAL_HOOK" ] || [ ! -x "$ORIGINAL_HOOK" ]; then
    {
      echo ""
      echo "Repo Identity Guard Shield"
      echo ""
      echo "${actionLabel} BLOCKED (Shield internal error: broken hook chain)"
      echo ""
      echo "Shield's own check passed, but the chained original hook it was supposed to hand off to is not an executable regular file:"
      echo "  $ORIGINAL_HOOK"
      echo ""
      echo "Shield will not guess whether that hook was meant to run, so it is failing closed instead of silently skipping it."
      echo ""
      echo "Next step: restore that file's executable permission, or run \\"Repo Identity Guard: Disable Shield\\" (which restores the original hook to its own path) and re-enable Shield afterwards."
    } >&2
    exit 1
  fi
${runOriginal}
fi

exit 0
`;
}

/**
 * The pre-commit hook Shield installs (also installed as
 * `pre-merge-commit` — see `HOOK_SPECS` in `manager.ts`). Contains no
 * enforcement logic of its own — it only locates and runs the evaluator
 * copy Shield placed alongside the repo's policy (both under the shared
 * git-common-dir, so this resolves correctly from any worktree), which is
 * what makes enforcement work with VS Code completely closed.
 *
 * **Fails CLOSED** (v5) if the git-common-dir can't be resolved or that
 * evaluator copy is missing/unreadable — see
 * `evaluatorResolutionFragment` for the full reasoning and for why this
 * cannot leave a user permanently blocked after a completed Disable
 * Shield.
 *
 * Also, unconditionally, checks for a chained original hook (Phase 6 —
 * see `SHIELD_CHAIN_ORIGINAL_SUFFIX`) and hands off to it, with the same
 * argv, once Shield's own check has passed. This lookup costs nothing
 * when no original was ever chained (the sidecar file simply doesn't
 * exist), so this is the one script installed in both the "nothing else
 * was here" and "a foreign hook was moved aside" cases — never two
 * different script variants to keep in sync.
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

${evaluatorResolutionFragment("COMMIT")}
ORIGINAL_HOOK="$0${SHIELD_CHAIN_ORIGINAL_SUFFIX}"

set +e
REASON=$(sh "$EVAL_SCRIPT" commit 2>&1 >/dev/null)
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  # A structured policy reason always contains at least one "Shield: [id]"
  # line (add_reason/fail_immediately's own format). Its ABSENCE means the
  # evaluator crashed or exited before reaching a decision (e.g. an
  # unbound variable under \`set -eu\`, a missing \`git\` on PATH, a corrupted
  # copy of the script itself) -- that is a Shield bug, not a policy
  # verdict, and must never be presented to the user as one. Both branches
  # still fail closed (the commit is blocked either way); only the
  # framing differs, so "why was I blocked" is never answered wrong.
  case "$REASON" in
    *'Shield: ['*)
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
      ;;
    *)
      {
        echo ""
        echo "Repo Identity Guard Shield"
        echo ""
        echo "COMMIT BLOCKED (Shield internal error)"
        echo ""
        echo "Shield's evaluator failed unexpectedly instead of reaching a policy decision. Failing closed: the commit is blocked, but this is most likely a Shield bug or a corrupted Shield installation, not a problem with your commit."
        echo ""
        echo "Raw evaluator output:"
        printf '%s\\n' "$REASON"
        echo ""
        echo "Next step: re-run \\"sh $EVAL_SCRIPT commit\\" directly to see the full error, then repair or disable Shield for this repository. If this persists, please report it."
      } >&2
      ;;
  esac
  exit "$CODE"
fi

# Shield allows this commit -- hand off to a pre-existing hook that was
# moved aside when Shield was enabled/repaired with chaining (see
# ShieldManager's chainForeignHooks option), if any. Its exit code becomes
# this hook's exit code: a chained tool's own failure (e.g. a linter) is
# never silently swallowed. No original hook here means nothing to chain
# -- exit 0.
${chainedHandoffFragment("COMMIT", `  exec "$ORIGINAL_HOOK" "$@"`)}`;
}

/**
 * The pre-push hook Shield installs. Like the pre-commit hook, it contains
 * no enforcement logic of its own -- it forwards Git's own pre-push
 * arguments (`$1` = remote name, `$2` = remote location/URL) and its own
 * stdin (the `<local-ref> <local-sha1> <remote-ref> <remote-sha1>` lines
 * Git feeds a real pre-push hook) straight through to the evaluator copy
 * Shield placed alongside the repo's policy -- these are the actual
 * action-time values for THIS push, never a value predicted earlier by an
 * extension scan. **Fails CLOSED** (v5) if the evaluator copy is missing
 * or unreadable, for the same reason the pre-commit hook does.
 *
 * Also checks for a chained original hook (Phase 6 — see
 * `SHIELD_CHAIN_ORIGINAL_SUFFIX`), same as the pre-commit hook. Pre-push
 * is the one hook Git feeds meaningful stdin, and that stdin can only be
 * read once -- so unlike pre-commit's plain `exec`, this script captures
 * stdin to a temp file up front and feeds that same captured content to
 * BOTH the evaluator and (if Shield allows the push) the chained original
 * hook, each as its own independent read.
 *
 * v5 hardening: if `mktemp` cannot create that private file, the script
 * fails closed as a Shield internal error. It used to fall back to a
 * *predictable* `${"$"}{TMPDIR:-/tmp}/repo-identity-guard-prepush-stdin.$$`
 * path and then truncate it (`: >`), which is a classic symlink/pre-
 * creation target in a shared temp directory: another local user who
 * pre-creates that path (the PID is guessable, and the file is truncated
 * and written unconditionally) gets Shield to clobber a file of their
 * choosing, and can read the pushed ref lines. A push is never worth
 * creating that hazard for, and "no secure temp file" is a broken
 * environment, not a policy verdict.
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

${evaluatorResolutionFragment("PUSH")}
ORIGINAL_HOOK="$(dirname "$0")/pre-push${SHIELD_CHAIN_ORIGINAL_SUFFIX}"

# Git's <local-ref> <local-sha1> <remote-ref> <remote-sha1> lines arrive on
# stdin exactly once. A chained original hook may need the very same
# lines the evaluator reads, so they're captured to a private temp file up
# front and handed to each consumer as its own independent read -- never
# split, never guessed at, never left for only one of the two to see.
#
# No predictable fallback path: if mktemp cannot create a private file,
# this fails closed as a Shield internal error rather than creating (and
# truncating!) a guessable path in a world-writable directory.
STDIN_CAPTURE=$(mktemp "\${TMPDIR:-/tmp}/repo-identity-guard-prepush-stdin.XXXXXX" 2>/dev/null) || STDIN_CAPTURE=""
if [ -z "$STDIN_CAPTURE" ] || [ ! -f "$STDIN_CAPTURE" ]; then
  {
    echo ""
    echo "Repo Identity Guard Shield"
    echo ""
    echo "PUSH BLOCKED (Shield internal error)"
    echo ""
    echo "Shield could not create a private temporary file (via mktemp) to hold this push's ref lines, so it cannot evaluate the push. Failing closed."
    echo ""
    echo "Shield deliberately does NOT fall back to a predictable temporary file name here -- doing so would let any other local user pre-create or symlink that path."
    echo ""
    echo "Next step: check that \\"\${TMPDIR:-/tmp}\\" exists, is writable, and has free space/inodes, then retry."
  } >&2
  exit 1
fi
chmod 600 "$STDIN_CAPTURE" 2>/dev/null || true
trap 'rm -f "$STDIN_CAPTURE"' EXIT
cat > "$STDIN_CAPTURE"

set +e
REASON=$(sh "$EVAL_SCRIPT" push "$REMOTE_NAME" "$REMOTE_LOCATION" < "$STDIN_CAPTURE" 2>&1 >/dev/null)
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  # See the pre-commit hook's identical comment: a structured policy
  # reason always contains a "Shield: [id]" line; its absence means the
  # evaluator itself crashed, which is a Shield bug, not a policy verdict
  # -- both still fail closed (block the push), only the framing differs.
  case "$REASON" in
    *'Shield: ['*)
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
      ;;
    *)
      {
        echo ""
        echo "Repo Identity Guard Shield"
        echo ""
        echo "PUSH BLOCKED (Shield internal error)"
        echo ""
        echo "Remote: $REMOTE_NAME"
        echo "Destination: $REMOTE_LOCATION"
        echo ""
        echo "Shield's evaluator failed unexpectedly instead of reaching a policy decision. Failing closed: the push is blocked, but this is most likely a Shield bug or a corrupted Shield installation, not a problem with your push."
        echo ""
        echo "Raw evaluator output:"
        printf '%s\\n' "$REASON"
        echo ""
        echo "Next step: re-run \\"sh $EVAL_SCRIPT push $REMOTE_NAME $REMOTE_LOCATION\\" directly to see the full error, then repair or disable Shield for this repository. If this persists, please report it."
      } >&2
      ;;
  esac
  exit "$CODE"
fi

# Shield allows this push -- hand off to a pre-existing hook that was
# moved aside when Shield was enabled/repaired with chaining, if any,
# feeding it the exact same stdin Git gave this hook. Its exit code
# becomes this hook's exit code -- a chained tool's own failure (e.g. a
# force-push guard) is never silently swallowed. Not \`exec\`: the trap
# above must still fire to clean up the captured stdin file.
${chainedHandoffFragment("PUSH", `  "$ORIGINAL_HOOK" "$@" < "$STDIN_CAPTURE"\n  exit $?`)}`;
}
