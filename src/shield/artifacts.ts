/**
 * Ownership/version marking for the files the identity lock's enforcement
 * engine (historically "Shield") writes onto disk (the pre-commit,
 * pre-merge-commit and pre-push hook shims -- the first two built from the
 * same builder, see HOOK_SPECS in manager.ts -- and its copy of the
 * standalone evaluator). All are plain shell scripts, so "ownership" is a comment line
 * embedded in the
 * file itself — checked before ShieldManager will overwrite or delete
 * anything at a path it doesn't fully control, and read back by
 * `inspect()`/`repair()` to tell "this is Shield's own artifact, possibly
 * outdated" apart from "something else lives here now."
 *
 * Deliberately no separate manifest of artifact CONTENT: the
 * marker-plus-version comment embedded in each artifact *is* the durable
 * record of what a file is, so a partially-completed install can never be
 * mistaken for a complete one —
 * `inspect()` always re-derives state from what is actually on disk right
 * now, never from a cached "I installed this" flag that could drift from
 * reality (a foreign tool overwriting the hook, a user hand-editing it, a
 * crash mid-write). See ShieldManager's module comment for how this feeds
 * the off/active/degraded/broken lifecycle.
 *
 * This is NOT the same thing as "Shield keeps no records at all", which an
 * earlier version of this comment implied. A marker embedded in a file can
 * only ever be found by looking at a path you already know to look at, and
 * `core.hooksPath` can move after an install — so Shield ALSO keeps a
 * durable list of the hooks directories it has installed into
 * (`src/shield/installRecord.ts`). That record never decides what an
 * artifact IS (this marker does, re-read from disk every time); it only
 * says where else to go and look.
 */

export const SHIELD_ARTIFACT_MARKER = "repo-identity-guard-shield-artifact";

/**
 * Bumped whenever the *installed* hook shim or evaluator copy's contents
 * change in a way worth re-installing for (not the same axis as
 * `SHIELD_POLICY_VERSION`, which versions the policy schema). `inspect()`
 * flags an on-disk artifact whose embedded version is older than this as
 * "repair available," without treating it as broken or non-owned.
 *
 * v6: identity-lock product model — the evaluator enforces only commit
 * identity and push account identity, every block message starts with the
 * machine-readable `REPO_IDENTITY_GUARD_BLOCK` prelude, and the pre-push
 * shim no longer echoes the raw remote URL (which can embed credentials).
 *
 * v7: push is always governed (policy v4). An identity with no GitHub
 * login blocks every push (`push-identity-not-configured`) instead of
 * leaving push unchecked; v3 policies are refused until upgraded. Every v6
 * installation is upgraded in place by `IdentityLockService` (assignment
 * kept), because a v6 evaluator would keep letting such pushes through.
 */
export const SHIELD_ARTIFACT_VERSION = 7;

/** The artifact version that shipped with policy v3 — an identity lock to upgrade in place, never a legacy Shield installation to migrate or remove. */
export const PREVIOUS_LOCK_ARTIFACT_VERSION = 6;

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
 * Shell lines printing the machine-readable prelude every block message
 * starts with (see `resources/shield/shield-evaluate.sh`'s `block`). Used
 * for the hook-level failures the evaluator itself can never report —
 * a broken installation, a broken hook chain, an evaluator crash — so an
 * AI agent or script sees the same stable format no matter which layer
 * blocked. These hook-level `REASON_ID`s (`broken-installation`,
 * `broken-hook-chain`, `internal-error`) are not evaluator reasons and are
 * never produced by `shield-evaluate.sh`.
 */
function preludeLines(action: "commit" | "push", code: string, reasonId: string, indent = "    "): string {
  return [
    `echo 'REPO_IDENTITY_GUARD_BLOCK'`,
    `echo 'ACTION: ${action}'`,
    `echo 'REASON: ${code}'`,
    `echo 'REASON_ID: ${reasonId}'`,
  ]
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function repairOrUnlock(indent = "    "): string {
  return [
    `echo 'What to do: open this repository in VS Code and run "Repo Identity Guard: Repair Identity Lock",'`,
    `echo 'or "Repo Identity Guard: Unlock Current Repository" if it should not be locked (that also removes this hook).'`,
  ]
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * Shared shell fragment: resolve the evaluator copy the lock installed, and
 * FAIL CLOSED with a clearly-framed "broken installation" block if
 * anything about that resolution doesn't hold.
 *
 * ## Why this fails closed (v5 hardening, kept)
 *
 * Up to v4 the shims exited 0 ("fail open") when the evaluator copy was
 * missing, which was empirically exploitable: deleting the evaluator left
 * the hook in place and every mismatched-identity commit sailed through.
 * "Hook installed but evaluator missing" is a broken installation, and
 * the only safe reading of broken enforcement is to stop and say so.
 *
 * The complementary guarantee lives in `ShieldManager.disable()` (what
 * Unlock runs): it removes every hook it owns — at the current hooks
 * directory AND every directory in the durable installation record —
 * strictly BEFORE deleting the evaluator/policy, so a *completed* unlock
 * never leaves a hook behind to fail closed.
 */
function evaluatorResolutionFragment(action: "commit" | "push"): string {
  return `GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || GIT_COMMON_DIR=""
if [ -z "$GIT_COMMON_DIR" ]; then
  {
${preludeLines(action, "broken_installation", "broken-installation")}
    echo ''
    echo 'Repo Identity Guard blocked this ${action} (internal error: broken installation).'
    echo ''
    echo 'This repository has an identity-lock hook installed, but its common Git directory could not be resolved'
    echo '("git rev-parse --path-format=absolute --git-common-dir" failed -- Git 2.31 or newer is required), so the'
    echo 'lock policy cannot be found and the assigned identity cannot be checked. Failing closed.'
    echo ''
${repairOrUnlock()}
  } >&2
  exit 1
fi

EVAL_SCRIPT="$GIT_COMMON_DIR/repo-identity-guard/shield-evaluate.sh"

# FAIL CLOSED, never open: a hook that is installed but whose evaluator is
# missing/unreadable is a BROKEN lock installation, not an unlocked repo.
if [ ! -f "$EVAL_SCRIPT" ] || [ ! -r "$EVAL_SCRIPT" ]; then
  {
${preludeLines(action, "broken_installation", "broken-installation")}
    echo ''
    echo 'Repo Identity Guard blocked this ${action} (internal error: broken installation).'
    echo ''
    echo 'This repository has an identity-lock hook installed, but the lock evaluator is missing or unreadable at:'
    echo "  $EVAL_SCRIPT"
    echo 'The assigned identity cannot be checked, so this ${action} is blocked rather than let through unchecked.'
    echo ''
${repairOrUnlock()}
  } >&2
  exit 1
fi
`;
}

/**
 * Shared shell fragment: hand off to a chained original foreign hook, if
 * one is present at `$ORIGINAL_HOOK`. The sidecar is only ever executed
 * when it is actually an executable regular file (v5 hardening); a
 * missing sidecar means nothing was ever chained, so the hook exits 0.
 */
function chainedHandoffFragment(action: "commit" | "push", runOriginal: string): string {
  return `if [ -e "$ORIGINAL_HOOK" ] || [ -L "$ORIGINAL_HOOK" ]; then
  if [ ! -f "$ORIGINAL_HOOK" ] || [ ! -x "$ORIGINAL_HOOK" ]; then
    {
${preludeLines(action, "broken_hook_chain", "broken-hook-chain", "      ")}
      echo ''
      echo 'Repo Identity Guard blocked this ${action} (internal error: broken hook chain).'
      echo ''
      echo 'The identity check passed, but the pre-existing hook Repo Identity Guard chained is not an'
      echo 'executable regular file:'
      echo "  $ORIGINAL_HOOK"
      echo 'Repo Identity Guard will not guess whether that hook was meant to run, so it is failing closed.'
      echo ''
      echo 'What to do: restore that file'"'"'s executable permission, or run "Repo Identity Guard: Unlock Current Repository"'
      echo '(which restores the original hook to its own path) and assign the identity again afterwards.'
    } >&2
    exit 1
  fi
${runOriginal}
fi

exit 0
`;
}

/**
 * The pre-commit hook the identity lock installs (also installed as
 * `pre-merge-commit` — see `HOOK_SPECS` in `manager.ts`, since a real merge
 * commit runs that hook instead of pre-commit). Contains no enforcement
 * logic of its own — it only locates and runs the evaluator copy installed
 * alongside the lock policy (both under the shared git-common-dir, so this
 * resolves correctly from any worktree), which is what makes enforcement
 * work with VS Code completely closed.
 *
 * The evaluator's block message is passed through VERBATIM (it already
 * carries the machine-readable prelude). Output that does not start with
 * that prelude means the evaluator crashed instead of deciding — still
 * blocked, but framed as an internal error so "why was I blocked" is never
 * answered wrong. Once the identity check passes, a chained original hook
 * (see `SHIELD_CHAIN_ORIGINAL_SUFFIX`) is run with the same argv.
 */
export function buildPreCommitHookScript(): string {
  return `#!/bin/sh
# Repo Identity Guard identity-lock pre-commit hook (owned by Repo Identity Guard)
# ${SHIELD_ARTIFACT_MARKER} v${SHIELD_ARTIFACT_VERSION} (pre-commit)
#
# Managed by Repo Identity Guard. Do not hand-edit this file -- "Repo
# Identity Guard: Repair Identity Lock" regenerates it, and "Repo Identity
# Guard: Unlock Current Repository" removes it (restoring any hook that was
# chained behind it). If you need your own pre-commit logic, keep it in a
# separate hook and let Repo Identity Guard chain it.
set -eu

${evaluatorResolutionFragment("commit")}
ORIGINAL_HOOK="$0${SHIELD_CHAIN_ORIGINAL_SUFFIX}"

set +e
REASON=$(sh "$EVAL_SCRIPT" commit 2>&1 >/dev/null)
CODE=$?
set -e

if [ "$CODE" -ne 0 ]; then
  case "$REASON" in
    REPO_IDENTITY_GUARD_BLOCK*)
      printf '%s\\n' "$REASON" >&2
      ;;
    *)
      {
${preludeLines("commit", "internal_error", "internal-error", "        ")}
        echo ''
        echo 'Repo Identity Guard blocked this commit (internal error).'
        echo ''
        echo 'The identity-lock evaluator failed unexpectedly instead of reaching a decision. Failing closed: the'
        echo 'commit is blocked, but this is most likely a Repo Identity Guard bug or a damaged installation, not a'
        echo 'problem with your commit.'
        echo ''
        echo 'Raw evaluator output:'
        printf '%s\\n' "$REASON"
        echo ''
${repairOrUnlock("        ")}
      } >&2
      ;;
  esac
  exit "$CODE"
fi

# The identity check passed -- hand off to a pre-existing hook that was
# moved aside when the lock was installed, if any. Its exit code becomes
# this hook's exit code: a chained tool's own failure (e.g. a linter) is
# never silently swallowed.
${chainedHandoffFragment("commit", `  exec "$ORIGINAL_HOOK" "$@"`)}`;
}

/**
 * The pre-push hook the identity lock installs. Forwards Git's own
 * pre-push arguments (`$1` = remote name, `$2` = remote location) and its
 * stdin to the evaluator — the actual action-time values for THIS push.
 *
 * Pre-push stdin can only be read once, so it is captured to a private
 * `mktemp` file and handed to both the evaluator and (if allowed) a
 * chained original hook. There is deliberately no predictable fallback
 * path if `mktemp` fails (v5 hardening) — that fails closed.
 *
 * v6: the remote LOCATION is never echoed in any message — an HTTPS
 * remote URL can embed a username and token.
 */
export function buildPrePushHookScript(): string {
  return `#!/bin/sh
# Repo Identity Guard identity-lock pre-push hook (owned by Repo Identity Guard)
# ${SHIELD_ARTIFACT_MARKER} v${SHIELD_ARTIFACT_VERSION} (pre-push)
#
# Managed by Repo Identity Guard. Do not hand-edit this file -- "Repo
# Identity Guard: Repair Identity Lock" regenerates it, and "Repo Identity
# Guard: Unlock Current Repository" removes it (restoring any hook that was
# chained behind it). If you need your own pre-push logic, keep it in a
# separate hook and let Repo Identity Guard chain it.
set -eu

REMOTE_NAME="\${1:-}"
REMOTE_LOCATION="\${2:-}"

${evaluatorResolutionFragment("push")}
ORIGINAL_HOOK="$(dirname "$0")/pre-push${SHIELD_CHAIN_ORIGINAL_SUFFIX}"

# Git's <local-ref> <local-sha1> <remote-ref> <remote-sha1> lines arrive on
# stdin exactly once; a chained original hook may need the very same
# lines, so they're captured to a private temp file up front. No
# predictable fallback path: if mktemp fails, this fails closed rather
# than creating (and truncating!) a guessable path in a shared directory.
STDIN_CAPTURE=$(mktemp "\${TMPDIR:-/tmp}/repo-identity-guard-prepush-stdin.XXXXXX" 2>/dev/null) || STDIN_CAPTURE=""
if [ -z "$STDIN_CAPTURE" ] || [ ! -f "$STDIN_CAPTURE" ]; then
  {
${preludeLines("push", "internal_error", "internal-error")}
    echo ''
    echo 'Repo Identity Guard blocked this push (internal error).'
    echo ''
    echo 'Could not create a private temporary file (via mktemp) to hold this push'"'"'s ref lines, so the push cannot'
    echo 'be evaluated. Repo Identity Guard deliberately does not fall back to a predictable temporary file name.'
    echo ''
    echo "What to do: check that \\"\${TMPDIR:-/tmp}\\" exists, is writable, and has free space, then retry."
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
  case "$REASON" in
    REPO_IDENTITY_GUARD_BLOCK*)
      printf '%s\\n' "$REASON" >&2
      ;;
    *)
      {
${preludeLines("push", "internal_error", "internal-error", "        ")}
        echo "REMOTE: $REMOTE_NAME"
        echo ''
        echo 'Repo Identity Guard blocked this push (internal error).'
        echo ''
        echo 'The identity-lock evaluator failed unexpectedly instead of reaching a decision. Failing closed: the'
        echo 'push is blocked, but this is most likely a Repo Identity Guard bug or a damaged installation, not a'
        echo 'problem with your push.'
        echo ''
        echo 'Raw evaluator output:'
        printf '%s\\n' "$REASON"
        echo ''
${repairOrUnlock("        ")}
      } >&2
      ;;
  esac
  exit "$CODE"
fi

# The push identity check passed -- hand off to a pre-existing hook that
# was moved aside when the lock was installed, if any, feeding it the
# exact same stdin. Not \`exec\`: the trap above must still fire to clean
# up the captured stdin file.
${chainedHandoffFragment("push", `  "$ORIGINAL_HOOK" "$@" < "$STDIN_CAPTURE"\n  exit $?`)}`;
}
