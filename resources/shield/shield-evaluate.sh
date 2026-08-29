#!/bin/sh
# shield-evaluate.sh — Shield Mode's standalone enforcement evaluator.
# repo-identity-guard-shield-artifact v2 (evaluator)
#
# This is the actual runtime artifact a future Git hook (pre-commit /
# pre-push) invokes. It has NO dependency on Node, VS Code, or any running
# extension host — only `git` itself plus the POSIX shell utilities that
# ship alongside `git` on every platform Git runs on (sh, awk, sed, grep,
# tr). See docs/SHIELD_MODE.md "Evaluator runtime decision" for why this
# is sufficient and why a Node/Python/jq/gh dependency would be wrong here.
#
# Usage:
#   shield-evaluate.sh commit
#   shield-evaluate.sh push <remote-name> <remote-url>   [ref lines on stdin, as a real pre-push hook receives — read but not yet used]
#
# Exit code is the entire contract: 0 = allow the Git action, non-zero =
# block it. A concise reason is always written to stderr, never stdout
# (stdout is reserved for a future machine-readable mode; nothing writes
# there today). This script never installs itself, never mutates Git
# config, and never touches anything outside read-only `git` plumbing
# commands, its own policy file, and -- as of Phase 5, and only under the
# narrow conditions `verify_github_account` documents -- the single
# ordinary SSH connection ("ssh -G", then "ssh -T") the push itself would
# use anyway, to ask GitHub who it authenticated. No key material is ever
# read, no SSH config is ever written, and no other network call is ever
# made.
#
# This script's semantics are intentionally mirrored 1:1 by the pure
# TypeScript reference implementation in src/shield/evaluator.ts — that
# module exists for exhaustive, fast unit testing of the *decision logic*;
# this script is what actually ships and runs at hook time. Both are
# exercised against the same real temporary repositories in
# src/test/shieldEvaluatorScript.test.ts to keep them from silently
# drifting apart.
#
# Known simplification (documented, not accidental): this script does
# lightweight field-presence/version checks on the policy file, not full
# JSON schema validation the way validateShieldPolicy() in
# src/shield/policy.ts does. A policy file this script itself never wrote
# (hand-edited, or corrupted in a way that still coincidentally contains
# plausible-looking lines) could in principle slip past. Full JSON parsing
# in portable POSIX shell is not a reasonable scope for a hook script;
# `policyVersion` and `expectedGitEmail` presence are checked explicitly
# because their absence is the one failure mode most likely from a
# genuinely broken/truncated write.

set -eu

ACTION="${1:-}"
if [ "$ACTION" != "commit" ] && [ "$ACTION" != "push" ]; then
  echo "Shield: usage: shield-evaluate.sh <commit|push> [remote-name remote-url]" >&2
  exit 2
fi

REASON_IDS=""
REASON_MESSAGES=""

add_reason() {
  # $1 = stable reason id, $2 = human-readable message
  REASON_IDS="$REASON_IDS $1"
  REASON_MESSAGES="$REASON_MESSAGES
Shield: [$1] $2"
}

fail_immediately() {
  # For failures that make any further evaluation meaningless
  # (policy-missing, policy-corrupt, inspection-failed): report and exit
  # without evaluating anything else, matching evaluateFromPolicyLoad's
  # short-circuit behavior in src/shield/evaluator.ts. Deliberately the same
  # "Shield: [id] message" shape add_reason's lines use below (not prefixed
  # "Shield: BLOCKED" the way the final summary line is) -- a caller (e.g.
  # a hook shim) that strips that one summary line by matching
  # "^Shield: BLOCKED" must never accidentally swallow this line too.
  echo "Shield: [$1] $2" >&2
  exit 1
}

lower() {
  # Trailing newline is deliberate: this is used both inside `$(...)`
  # (where it's stripped harmlessly) and piped line-by-line inside a
  # `while read` loop feeding `grep -qx` (where dropping it would merge
  # every line into one and silently break every array-membership check).
  printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]'
}

# ==================== locate + load policy ====================

GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || fail_immediately inspection-failed "could not resolve the repository's common git directory"

POLICY_FILE="$GIT_COMMON_DIR/repo-identity-guard/shield-policy.json"

if [ ! -f "$POLICY_FILE" ]; then
  fail_immediately policy-missing "Shield is enabled but no policy file was found at $POLICY_FILE"
fi

# Prints the value of a top-level (or uniquely-named nested) scalar JSON
# field from the policy file, or an empty string if absent. Never fails —
# see the module header for why (this must be safe to call under `set -e`
# for fields that are legitimately optional).
policy_scalar() {
  awk -v key="\"$1\":" '
    index($0, key) {
      line = $0
      sub(/^[^:]*:[[:space:]]*/, "", line)
      sub(/,[[:space:]]*$/, "", line)
      gsub(/^"|"$/, "", line)
      print line
      found = 1
      exit
    }
    END { if (!found) print "" }
  ' "$POLICY_FILE"
}

# Prints one element per line of an array-of-strings JSON field, or
# nothing if the field is absent or an empty array (`"key": []` on one
# line). Relies on the policy file always being machine-generated by
# serializeShieldPolicy (JSON.stringify(..., null, 2)) — one element per
# line, never packed onto one line except when empty.
policy_array() {
  awk -v key="\"$1\":" '
    index($0, key) {
      if (index($0, "[]") > 0) { next }
      infield = 1
      next
    }
    infield && /\]/ { infield = 0; next }
    infield {
      v = $0
      gsub(/^[[:space:]]*"/, "", v)
      gsub(/",?[[:space:]]*$/, "", v)
      if (v != "") print v
    }
  ' "$POLICY_FILE"
}

POLICY_VERSION=$(policy_scalar policyVersion)
if [ "$POLICY_VERSION" != "1" ]; then
  fail_immediately policy-corrupt "unexpected or missing policyVersion (got: '$POLICY_VERSION')"
fi

EXPECTED_EMAIL=$(policy_scalar expectedGitEmail)
if [ -z "$EXPECTED_EMAIL" ]; then
  fail_immediately policy-corrupt "policy is missing required field expectedGitEmail"
fi
EXPECTED_NAME=$(policy_scalar expectedGitName)
PROFILE_LABEL=$(policy_scalar profileLabel)
STRICT_PUSH=$(policy_scalar strictPushSetup)

if ! policy_array enabledActions | grep -qx "$ACTION"; then
  # This policy does not govern this action at all — never block it.
  exit 0
fi

# ==================== commit ====================

evaluate_commit() {
  # ---- identity: re-read fresh, right now — never a cached scan ----
  AUTHOR_IDENT=$(git var GIT_AUTHOR_IDENT 2>/dev/null) \
    || fail_immediately inspection-failed "git var GIT_AUTHOR_IDENT failed"
  COMMITTER_IDENT=$(git var GIT_COMMITTER_IDENT 2>/dev/null) \
    || fail_immediately inspection-failed "git var GIT_COMMITTER_IDENT failed"

  ident_name() { printf '%s' "$1" | sed -E 's/^(.*) <[^>]*> [0-9]+ [+-][0-9]+[[:space:]]*$/\1/'; }
  ident_email() { printf '%s' "$1" | sed -E 's/^.*<([^>]*)>.*$/\1/'; }

  AUTHOR_NAME=$(ident_name "$AUTHOR_IDENT")
  AUTHOR_EMAIL=$(ident_email "$AUTHOR_IDENT")
  COMMITTER_NAME=$(ident_name "$COMMITTER_IDENT")
  COMMITTER_EMAIL=$(ident_email "$COMMITTER_IDENT")

  # worktree ?? local ?? global — same precedence RepoFacts collection
  # uses (see gitService.ts); read fresh here, not passed in.
  CONFIGURED_NAME=$(git config --worktree user.name 2>/dev/null || git config --local user.name 2>/dev/null || git config --global user.name 2>/dev/null || true)
  CONFIGURED_EMAIL=$(git config --worktree user.email 2>/dev/null || git config --local user.email 2>/dev/null || git config --global user.email 2>/dev/null || true)

  name_matches() {
    [ -z "$EXPECTED_NAME" ] && return 0
    [ "$(lower "$1")" = "$(lower "$EXPECTED_NAME")" ]
  }
  email_matches() {
    [ "$(lower "$1")" = "$(lower "$EXPECTED_EMAIL")" ]
  }

  AUTHOR_OK=1
  name_matches "$AUTHOR_NAME" && email_matches "$AUTHOR_EMAIL" || AUTHOR_OK=0
  COMMITTER_OK=1
  name_matches "$COMMITTER_NAME" && email_matches "$COMMITTER_EMAIL" || COMMITTER_OK=0

  if [ "$AUTHOR_OK" = 0 ] || [ "$COMMITTER_OK" = 0 ]; then
    # Which identity (author, committer, or both) actually mismatched —
    # reported so "Found:" never has to guess.
    WHO=""
    [ "$AUTHOR_OK" = 0 ] && WHO="author ${AUTHOR_NAME:-(unknown)} <${AUTHOR_EMAIL:-(unknown)}>"
    if [ "$COMMITTER_OK" = 0 ]; then
      if [ -n "$WHO" ]; then
        WHO="$WHO; committer ${COMMITTER_NAME:-(unknown)} <${COMMITTER_EMAIL:-(unknown)}>"
      else
        WHO="committer ${COMMITTER_NAME:-(unknown)} <${COMMITTER_EMAIL:-(unknown)}>"
      fi
    fi
    EXPECTED_DISPLAY="${EXPECTED_NAME:+$EXPECTED_NAME }<$EXPECTED_EMAIL>"

    if name_matches "$CONFIGURED_NAME" && email_matches "$CONFIGURED_EMAIL"; then
      add_reason commit-identity-override "Profile: $PROFILE_LABEL
Expected: $EXPECTED_DISPLAY
Found: $WHO
(Git config for this repo already matches $PROFILE_LABEL — the effective identity above is overridden by the environment or an explicit command-line option.)"
    else
      add_reason commit-identity-mismatch "Profile: $PROFILE_LABEL
Expected: $EXPECTED_DISPLAY
Found: $WHO"
    fi
  fi

  # ---- branch / detached HEAD ----
  BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null || true)
  if [ -z "$BRANCH" ]; then
    add_reason detached-head "HEAD is detached. Commits made here aren't tracked by any branch and are easy to lose."
  else
    LOWER_BRANCH=$(lower "$BRANCH")
    if policy_array protectedBranches | while IFS= read -r b; do lower "$b"; done | grep -qx "$LOWER_BRANCH"; then
      add_reason protected-branch "\"$BRANCH\" is locally protected. Committing directly on it is not allowed by this policy."
    fi
    # Branch-pattern mismatch (expectedBranchPatterns) is intentionally NOT
    # checked here: it's a non-blocking warning in the main safety engine
    # (branchPolicyPatternMismatchResult), and Shield must not silently
    # upgrade that into a hard block.
  fi

  # ---- repo operation state (current worktree's own git-dir, not the
  # shared common dir — merge/rebase state is per-worktree) ----
  WT_GIT_DIR=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) \
    || fail_immediately inspection-failed "could not resolve this worktree's git directory"

  if [ -f "$WT_GIT_DIR/MERGE_HEAD" ]; then
    add_reason repo-operation-in-progress "A merge is already in progress. Committing now could interfere with it."
  elif [ -d "$WT_GIT_DIR/rebase-merge" ] || [ -d "$WT_GIT_DIR/rebase-apply" ]; then
    add_reason repo-operation-in-progress "A rebase is already in progress. Committing now could interfere with it."
  elif [ -f "$WT_GIT_DIR/CHERRY_PICK_HEAD" ]; then
    add_reason repo-operation-in-progress "A cherry-pick is already in progress. Committing now could interfere with it."
  elif [ -f "$WT_GIT_DIR/REVERT_HEAD" ]; then
    add_reason repo-operation-in-progress "A revert is already in progress. Committing now could interfere with it."
  fi

  # Unresolved conflicts, independent of the above (a rebase can have
  # conflicts and both facts matter).
  if git status --porcelain=v2 2>/dev/null | grep -q '^u '; then
    add_reason merge-conflicts "There are unresolved merge conflicts in the working tree."
  fi
  # Ordinary uncommitted changes alone (no conflicts, no in-progress
  # operation) are deliberately never checked here — must never block.
}

# ==================== push: GitHub SSH account verification (Phase 5) ====================
#
# Goes beyond "this route is a trusted alias" (route trust, Phase 0-4) to
# "this route currently authenticates to the specific GitHub login this
# profile expects" -- but ONLY when the policy actually asked for it
# (expectedGitHubLogin set) and the route already resolved to a trusted
# SSH alias with no overrides; an untrusted/unverified/overridden route
# already has its own blocking reason above, and this function is never
# reached for those. Only for SSH. Never reads private key contents,
# copies keys, edits SSH config, touches ssh-agent, or stores a
# password/passphrase. The only network activity here is the ordinary SSH
# connection this push would use anyway.
verify_github_account() {
  ALIAS="$1"
  SSH_USER_LOCAL="$2"
  EXPECTED="$3"

  # A route can only be strongly bound to one account if ssh-agent can't
  # silently substitute a different key -- IdentitiesOnly must be in
  # effect for this alias. Local config inspection only, no network call.
  CONFIG_OUTPUT=$(ssh -G "$ALIAS" 2>/dev/null) || CONFIG_OUTPUT=""
  if ! printf '%s\n' "$CONFIG_OUTPUT" | tr '[:upper:]' '[:lower:]' | grep -qx 'identitiesonly yes'; then
    add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: This SSH route's effective configuration does not set \"IdentitiesOnly yes\", so ssh-agent could offer a different, unrelated key than the one this route is meant to use -- the route cannot be strongly bound to an expected account without it."
    return
  fi

  # GitHub's SSH endpoint replies to a noninteractive self-test even
  # though it commonly exits 1 on FULLY SUCCESSFUL authentication (it has
  # no shell to hand back) -- so the exit code below is deliberately never
  # consulted, only the response text is. StrictHostKeyChecking=yes means
  # an unknown/changed host key fails the connection rather than silently
  # (or interactively) trusting it -- Shield must never auto-accept a host
  # key on the user's behalf.
  TIMEOUT="${REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT:-5}"
  set +e
  AUTH_OUTPUT=$(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout="$TIMEOUT" "${SSH_USER_LOCAL}@${ALIAS}" 2>&1)
  set -e

  case "$AUTH_OUTPUT" in
    *"successfully authenticated"*)
      AUTH_ID=$(printf '%s' "$AUTH_OUTPUT" | sed -nE 's/.*Hi ([^!]+)!.*successfully authenticated.*/\1/p' | head -n1)
      case "$AUTH_ID" in
        "")
          add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: SSH's response while verifying the account could not be parsed."
          ;;
        */*)
          # GitHub names deploy-key/App-installation identities as
          # "owner/repo", never a personal username -- never comparable to
          # expectedGitHubLogin, so always unverifiable, never guessed at.
          add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: This route authenticated using a deploy-key-style identity (\"$AUTH_ID\") rather than a personal GitHub account, so it cannot be confirmed against the expected account."
          ;;
        *)
          if [ "$(lower "$AUTH_ID")" != "$(lower "$EXPECTED")" ]; then
            add_reason push-account-mismatch "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Authenticated GitHub account: $AUTH_ID
Reason: The configured SSH route is authenticating as the wrong GitHub account."
          fi
          ;;
      esac
      ;;
    *"Permission denied"*)
      add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: SSH authentication to GitHub was refused (permission denied), so the account could not be confirmed."
      ;;
    *"Host key verification failed"*|*"know the"*"key fingerprint"*|*"host key is known"*)
      add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: This SSH host's key is not already trusted in known_hosts, so Shield refused to connect automatically. Verify the host key fingerprint yourself (e.g. run \"ssh -T ${SSH_USER_LOCAL}@${ALIAS}\" once interactively) and accept it before relying on strict account verification."
      ;;
    *"timed out"*)
      add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: The SSH connection timed out while verifying the account."
      ;;
    *)
      add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: SSH's response while verifying the account could not be parsed."
      ;;
  esac
}

# ==================== push ====================

evaluate_push() {
  REMOTE_NAME="${1:-}"
  REMOTE_URL="${2:-}"
  # Drain stdin (the real pre-push hook's <local-ref> <local-sha>
  # <remote-ref> <remote-sha> lines) without acting on it yet — accepted
  # now so the interface matches the real hook contract from day one; see
  # PushEvalFacts.refLines in src/shield/evaluator.ts.
  cat >/dev/null 2>&1 || true

  if [ -z "$REMOTE_URL" ]; then
    fail_immediately inspection-failed "no remote URL was provided to evaluate (expected: shield-evaluate.sh push <remote-name> <remote-url>)"
  fi

  # ---- parse the ACTUAL action-time remote URL (never a value predicted
  # earlier by an extension scan) — mirrors parseRemoteUrl() in
  # src/services/gitService.ts ----
  PROTOCOL=unknown
  HOST=""
  REPO_PATH=""
  case "$REMOTE_URL" in
    https://*|http://*)
      PROTOCOL=https
      rest=$(printf '%s' "$REMOTE_URL" | sed -E 's#^https?://##')
      HOST=$(printf '%s' "$rest" | sed -E 's#^([^/@]*@)?([^/:]+).*#\2#')
      REPO_PATH=$(printf '%s' "$rest" | sed -E 's#^[^/]*/##')
      ;;
    ssh://*)
      PROTOCOL=ssh
      rest=$(printf '%s' "$REMOTE_URL" | sed -E 's#^ssh://##')
      HOST=$(printf '%s' "$rest" | sed -E 's#^([^/@]*@)?([^/:]+).*#\2#')
      REPO_PATH=$(printf '%s' "$rest" | sed -E 's#^[^/]*/##')
      ;;
    *://*)
      # Any other <scheme>://... (git://, ftp://, file://, ...) -- mirrors
      # parseRemoteUrl()'s generic URL branch: protocol is "unknown" (only
      # https/ssh get their own label), but host/path are still extracted
      # the same way, EXCEPT an authority-less form (file:///path, where
      # what follows the scheme starts with "/") has no host at all --
      # matching `new URL(...).hostname` being "" for that shape.
      PROTOCOL=unknown
      rest=$(printf '%s' "$REMOTE_URL" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##')
      case "$rest" in
        /*)
          HOST=""
          REPO_PATH="$rest"
          ;;
        *)
          HOST=$(printf '%s' "$rest" | sed -E 's#^([^/@]*@)?([^/:]+).*#\2#')
          REPO_PATH=$(printf '%s' "$rest" | sed -E 's#^[^/]*/##')
          ;;
      esac
      ;;
    *:*)
      # scp-like: [user@]host:path (also covers a bare SSH host alias)
      PROTOCOL=ssh
      HOST=$(printf '%s' "$REMOTE_URL" | sed -E 's/^([^@]*@)?([^:]+):.*/\2/')
      REPO_PATH=$(printf '%s' "$REMOTE_URL" | sed -E 's/^[^:]*://')
      ;;
  esac
  REPO_PATH=$(printf '%s' "$REPO_PATH" | sed -E 's#^/+##; s#/+$##')
  PARSED_REPO=$(printf '%s' "$REPO_PATH" | awk -F/ '{print $NF}' | sed -E 's/\.git$//')
  PARSED_OWNER=$(printf '%s' "$REPO_PATH" | awk -F/ '{ if (NF>=2) print $(NF-1) }')

  # SSH connection user, e.g. "git" in "git@github-work:owner/repo.git" --
  # defaults to "git" (GitHub's own convention) when the URL/alias doesn't
  # specify one, since an SSH alias commonly sets `User git` itself.
  SSH_USER=$(printf '%s' "$REMOTE_URL" | sed -nE 's#^(ssh://)?([^@/:]+)@.*#\2#p')
  [ -z "$SSH_USER" ] && SSH_USER=git

  # ---- destination: OWNER-based, never host-based (see evaluator.ts's
  # destinationReasons for why a host comparison would falsely flag every
  # trusted-SSH-alias push as a mismatch). Fails CLOSED: if Shield never
  # recorded an approved destination for this repo (no remote resolvable
  # the last time it was enabled/repaired), that is treated as a mismatch,
  # not silently allowed — this also covers a direct `git push <url>` to
  # an ad hoc destination Shield never had visibility into. ----
  APPROVED_HOST=$(policy_scalar host)
  APPROVED_OWNER=$(policy_scalar owner)
  APPROVED_REPO=$(policy_scalar repo)
  EXPECTED_DESTINATION_DISPLAY="${APPROVED_HOST:-(unknown host)}:${APPROVED_OWNER:-?}${APPROVED_REPO:+/$APPROVED_REPO}"

  if [ -z "$APPROVED_OWNER" ]; then
    add_reason push-destination-mismatch "Profile: $PROFILE_LABEL
Shield has no approved push destination on file for this repository (none was resolved the last time Shield was enabled or repaired).
Reason: Refresh Shield after confirming the intended remote before pushing."
  elif [ "$(lower "$PARSED_OWNER")" != "$(lower "$APPROVED_OWNER")" ] || { [ -n "$APPROVED_REPO" ] && [ -n "$PARSED_REPO" ] && [ "$(lower "$PARSED_REPO")" != "$(lower "$APPROVED_REPO")" ]; }; then
    add_reason push-destination-mismatch "Profile: $PROFILE_LABEL
Expected approved destination: $EXPECTED_DESTINATION_DISPLAY
Reason: Push destination changed since Shield approval (this push would go to ${PARSED_OWNER:-an unknown owner}${PARSED_REPO:+/$PARSED_REPO})."
  fi

  # ---- route trust ----
  IS_GENERIC=0
  case "$(lower "$HOST")" in
    github.com|gitlab.com|bitbucket.org) IS_GENERIC=1 ;;
  esac

  # An SSH command override can redirect the connection regardless of what
  # the URL's host claims -- check this BEFORE trusting any alias, since a
  # "trusted" alias proves nothing once the program that actually speaks
  # SSH for this push might not be the one ~/.ssh/config implies. None of
  # these inspect key material, touch SSH config, or make a network call --
  # they only check whether an override is present.
  SSH_OVERRIDES=""
  [ -n "${GIT_SSH:-}" ] && SSH_OVERRIDES="GIT_SSH"
  [ -n "${GIT_SSH_COMMAND:-}" ] && SSH_OVERRIDES="${SSH_OVERRIDES:+$SSH_OVERRIDES, }GIT_SSH_COMMAND"
  CORE_SSH_COMMAND=$(git config --get core.sshCommand 2>/dev/null || true)
  [ -n "$CORE_SSH_COMMAND" ] && SSH_OVERRIDES="${SSH_OVERRIDES:+$SSH_OVERRIDES, }core.sshCommand"

  ROUTE_UNVERIFIED=1
  ROUTE_REASON_ID=push-route-unverified
  ROUTE_MESSAGE="This push's protocol could not be determined, so the account that would authenticate it cannot be verified locally."
  if [ "$PROTOCOL" = "ssh" ] && [ -n "$SSH_OVERRIDES" ]; then
    ROUTE_REASON_ID=push-route-override
    ROUTE_MESSAGE="An SSH command override ($SSH_OVERRIDES) was detected, so the route this push would actually use cannot be verified against the $PROFILE_LABEL profile's trusted SSH host aliases -- even though the URL's host (\"$HOST\") might otherwise be trusted."
  elif [ "$PROTOCOL" = "https" ]; then
    ROUTE_MESSAGE="This push is over HTTPS. The account that authenticates it cannot be verified locally."
  elif [ "$PROTOCOL" = "ssh" ] && [ "$IS_GENERIC" = 1 ]; then
    ROUTE_MESSAGE="This push uses the generic SSH host \"$HOST\", which authenticates with whichever key is used by default."
  elif [ "$PROTOCOL" = "ssh" ]; then
    LOWER_HOST=$(lower "$HOST")
    if policy_array trustedSshHostAliases | while IFS= read -r a; do lower "$a"; done | grep -qx "$LOWER_HOST"; then
      ROUTE_UNVERIFIED=0
    else
      ROUTE_MESSAGE="This push uses SSH host alias \"$HOST\", which is not listed as trusted by the $PROFILE_LABEL profile."
    fi
  fi

  # An unverified/untrusted/unverifiable route only blocks when the
  # profile is strict — a destination mismatch (added above,
  # unconditionally) always blocks regardless of strictness.
  if [ "$ROUTE_UNVERIFIED" = 1 ] && [ "$STRICT_PUSH" = "true" ]; then
    add_reason "$ROUTE_REASON_ID" "$ROUTE_MESSAGE"
  fi

  # ---- account verification (Phase 5) ----
  # Only ever attempted when: strict, the route above is otherwise already
  # trusted (ROUTE_UNVERIFIED=0 -- an untrusted/overridden route already
  # has its own blocking reason and this must never duplicate or override
  # that), and the profile actually asked for a specific account
  # (expectedGitHubLogin set). No expectedGitHubLogin means Shield makes
  # no claim about WHO authenticated -- route trust alone, same as
  # Phase 0-4.
  EXPECTED_GH_LOGIN=$(policy_scalar expectedGitHubLogin)
  if [ "$STRICT_PUSH" = "true" ] && [ "$ROUTE_UNVERIFIED" = 0 ] && [ -n "$EXPECTED_GH_LOGIN" ]; then
    verify_github_account "$HOST" "$SSH_USER" "$EXPECTED_GH_LOGIN"
  fi
}

# ==================== run + report ====================

if [ "$ACTION" = "commit" ]; then
  evaluate_commit
else
  evaluate_push "${2:-}" "${3:-}"
fi

if [ -n "$REASON_IDS" ]; then
  echo "Shield: BLOCKED ($ACTION) —$REASON_IDS" >&2
  printf '%s\n' "$REASON_MESSAGES" >&2
  exit 1
fi

exit 0
