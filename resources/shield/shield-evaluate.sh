#!/bin/sh
# shield-evaluate.sh — Shield Mode's standalone enforcement evaluator.
# repo-identity-guard-shield-artifact v5 (evaluator)
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
# Policy parsing (Phase 8): this script now performs a STRICT
# recursive-descent JSON parse of the policy file in POSIX awk, plus the
# same schema validation validateShieldPolicy() applies in TypeScript --
# see the long "policy parsing (strict)" comment below for what changed,
# for the two fail-OPEN holes the previous line-scanning parser had, and
# for the exact trust boundary that remains. Any malformed, truncated, or
# ambiguous policy is now `policy-corrupt`, which fails CLOSED.

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


# ==================== policy parsing (strict) ====================
#
# Phase 8 hardening. The previous parser was two small awk one-liners that
# scanned for `"key":` line-wise. Adversarial testing found two ways to
# make it FAIL OPEN -- i.e. exit 0 and allow the action -- neither of which
# required any cleverness:
#
#   1. A policy whose arrays are packed onto one line
#      (`"enabledActions": ["commit","push"]`) made `policy_array` return
#      NOTHING, so the `enabledActions` membership test failed and the
#      script exited 0. It "worked" only because serializeShieldPolicy
#      happens to emit one element per line; any other formatting of the
#      same valid JSON disabled enforcement silently.
#   2. A truncated policy (an interrupted write, a full disk) kept a valid
#      `policyVersion` and a non-empty `expectedGitEmail` prefix, hit the
#      same empty-`enabledActions` path, and again exited 0.
#
# Two further weaknesses were fail-closed but wrong: a one-line nested
# object made `policy_scalar host/owner/repo` return the entire object
# blob, and any non-`true` text in `strictPushSetup` (`"yes"`, `1`,
# `True`) silently downgraded the profile to non-strict, skipping every
# route and account check.
#
# So this is now a real, strict JSON parser: a recursive-descent parse in
# POSIX awk -- no jq, no Node, no Python, nothing beyond the awk that
# already ships everywhere `git` does. It parses the WHOLE document, and
# rejects (policy-corrupt, which fails closed) anything that is not
# exactly one well-formed JSON value: truncation, trailing garbage,
# unterminated strings or containers, bad escapes, raw control characters
# inside strings, invalid numbers, and DUPLICATE KEYS within one object
# (JSON permits those; Shield refuses to guess which of two
# `"owner"` fields was meant). Formatting is now irrelevant -- one line or
# a hundred, any indentation, any whitespace -- because nothing is
# line-oriented any more.
#
# ## Trust boundary, stated explicitly
#
# The parser is strict about STRUCTURE and about the schema checks below.
# The flattened form it emits is one `path<TAB>type<TAB>value` line per
# node, so a string value that contains a literal tab or newline could not
# be represented faithfully; JSON forbids raw control characters inside
# strings (this parser enforces that), and the only way to smuggle one in
# is an explicit `\n`/`\t`/`	` escape, which is normalized to a
# single space in the emitted value. No field Shield compares
# (`expectedGitEmail`, owner, repo, host, aliases, branch names, actions,
# logins) can legitimately contain a control character, so this affects
# only the human-readable `profileLabel` echoed in a block message. What
# remains outside the boundary is unchanged and unchangeable from here:
# anyone who can write this policy file can also write the hook that reads
# it, so the file is not a security boundary against a local attacker --
# it is protected against CORRUPTION and MALFORMEDNESS, and corruption now
# fails closed instead of silently disabling enforcement.
#
# The one-line invariant holds for `serializeShieldPolicy`'s own output
# too, so this is a strict superset of what the previous parser accepted,
# minus the shapes that were unsafe.

POLICY_DUMP=$(awk '
function err(msg) { printf("!ERROR\t%s\n", msg); failed = 1; exit 1 }
function emit(path, type, value) {
  gsub(/[\t\n\r]/, " ", value)
  printf("%s\t%s\t%s\n", path, type, value)
}
function skipws() {
  while (pos <= len) {
    c = substr(doc, pos, 1)
    if (c == " " || c == "\t" || c == "\n" || c == "\r") { pos++ } else { return }
  }
}
function expect_literal(lit,   n) {
  n = length(lit)
  if (substr(doc, pos, n) != lit) { err("invalid token at offset " pos) }
  pos += n
}
# Returns the unescaped contents of a JSON string starting at pos.
function parse_string(   out, ch, esc, hex, code, i) {
  if (substr(doc, pos, 1) != "\"") { err("expected a string at offset " pos) }
  pos++
  out = ""
  while (1) {
    if (pos > len) { err("unterminated string (policy file is truncated?)") }
    ch = substr(doc, pos, 1)
    if (ch == "\"") { pos++; return out }
    if (ch == "\\") {
      pos++
      if (pos > len) { err("unterminated escape sequence") }
      esc = substr(doc, pos, 1)
      pos++
      if (esc == "\"") { out = out "\"" }
      else if (esc == "\\") { out = out "\\" }
      else if (esc == "/") { out = out "/" }
      else if (esc == "b") { out = out " " }
      else if (esc == "f") { out = out " " }
      else if (esc == "n") { out = out " " }
      else if (esc == "r") { out = out " " }
      else if (esc == "t") { out = out " " }
      else if (esc == "u") {
        hex = substr(doc, pos, 4)
        if (length(hex) != 4 || hex !~ /^[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]$/) { err("invalid \\u escape at offset " pos) }
        pos += 4
        code = 0
        for (i = 1; i <= 4; i++) { code = code * 16 + index("0123456789abcdef", tolower(substr(hex, i, 1))) - 1 }
        # Only plain printable ASCII is materialized. Anything else -- a
        # control character, or any non-ASCII code point (which POSIX awk
        # cannot encode as UTF-8 portably) -- becomes "?" so the value can
        # never smuggle a control character into the flattened dump, and
        # never silently differs between awk implementations.
        if (code >= 32 && code < 127) { out = out sprintf("%c", code) } else { out = out "?" }
      }
      else { err("invalid escape sequence \"\\" esc "\"") }
      continue
    }
    # JSON forbids raw control characters inside strings.
    if (ch == "\n" || ch == "\r" || ch == "\t") { err("raw control character inside a string") }
    out = out ch
    pos++
  }
}
function parse_number(path,   start, s) {
  start = pos
  if (substr(doc, pos, 1) == "-") { pos++ }
  while (pos <= len && substr(doc, pos, 1) ~ /[0-9]/) { pos++ }
  if (pos <= len && substr(doc, pos, 1) == ".") { pos++; while (pos <= len && substr(doc, pos, 1) ~ /[0-9]/) { pos++ } }
  if (pos <= len && (substr(doc, pos, 1) == "e" || substr(doc, pos, 1) == "E")) {
    pos++
    if (pos <= len && (substr(doc, pos, 1) == "+" || substr(doc, pos, 1) == "-")) { pos++ }
    while (pos <= len && substr(doc, pos, 1) ~ /[0-9]/) { pos++ }
  }
  s = substr(doc, start, pos - start)
  if (s !~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/) { err("invalid number \"" s "\"") }
  emit(path, "number", s)
}
function parse_object(path,   key, childpath, first) {
  emit(path, "object", "")
  pos++
  first = 1
  while (1) {
    skipws()
    if (pos > len) { err("unterminated object (policy file is truncated?)") }
    if (substr(doc, pos, 1) == "}") { pos++; return }
    if (!first) {
      if (substr(doc, pos, 1) != ",") { err("expected \",\" or \"}\" at offset " pos) }
      pos++
      skipws()
    }
    first = 0
    key = parse_string()
    childpath = path "." key
    # Duplicate keys are legal JSON and a genuine ambiguity -- refuse
    # rather than let "first wins" or "last wins" decide an enforcement
    # value (e.g. two "owner" fields in approvedPushDestination).
    if (childpath in seen) { err("duplicate key \"" key "\" in the same object") }
    seen[childpath] = 1
    skipws()
    if (substr(doc, pos, 1) != ":") { err("expected \":\" after key \"" key "\"") }
    pos++
    parse_value(childpath)
  }
}
function parse_array(path,   i) {
  emit(path, "array", "")
  pos++
  i = 0
  while (1) {
    skipws()
    if (pos > len) { err("unterminated array (policy file is truncated?)") }
    if (substr(doc, pos, 1) == "]") { pos++; return }
    if (i > 0) {
      if (substr(doc, pos, 1) != ",") { err("expected \",\" or \"]\" at offset " pos) }
      pos++
      skipws()
    }
    parse_value(path "[" i "]")
    i++
  }
}
function parse_value(path,   c) {
  skipws()
  if (pos > len) { err("unexpected end of policy (truncated?)") }
  c = substr(doc, pos, 1)
  if (c == "{") { parse_object(path); return }
  if (c == "[") { parse_array(path); return }
  if (c == "\"") { emit(path, "string", parse_string()); return }
  if (c == "t") { expect_literal("true"); emit(path, "bool", "true"); return }
  if (c == "f") { expect_literal("false"); emit(path, "bool", "false"); return }
  if (c == "n") { expect_literal("null"); emit(path, "null", ""); return }
  parse_number(path)
}
{ doc = doc $0 "\n" }
END {
  if (failed) { exit 1 }
  len = length(doc)
  pos = 1
  parse_value("")
  skipws()
  if (pos <= len) { err("unexpected trailing content after the policy object") }
}
' "$POLICY_FILE" 2>/dev/null) || true

# The parser emits nodes as it goes and appends a "!ERROR<TAB>reason" line
# when it gives up, so a failure is detected by that line's presence
# rather than by awk's exit status -- which keeps the SPECIFIC reason
# ("unterminated string", "duplicate key \"owner\"", ...) instead of
# collapsing every malformation into one generic message. An entirely
# empty dump (awk itself missing/killed) is also a failure: a policy that
# parsed successfully always emits at least its root node.
POLICY_PARSE_ERROR=$(printf '%s\n' "$POLICY_DUMP" | awk -F'\t' '$1 == "!ERROR" { print $2; exit }')
if [ -n "$POLICY_PARSE_ERROR" ]; then
  fail_immediately policy-corrupt "Shield's policy file at $POLICY_FILE is not valid JSON and cannot be trusted ($POLICY_PARSE_ERROR). Run \"Repo Identity Guard: Repair Shield\"."
fi
if [ -z "$POLICY_DUMP" ]; then
  fail_immediately policy-corrupt "Shield's policy file at $POLICY_FILE could not be read or parsed at all. Run \"Repo Identity Guard: Repair Shield\"."
fi

# ---- accessors over the flattened dump ----
#
# Every one of these is a lookup by EXACT path, so a key nested inside
# some other object (or a "key"-looking substring inside a string value)
# can never be mistaken for a top-level field -- the class of confusion
# the old substring-scanning parser was open to.

policy_type() {
  printf '%s\n' "$POLICY_DUMP" | awk -F'\t' -v k="$1" '$1 == k { print $2; found = 1; exit } END { if (!found) print "absent" }'
}

policy_scalar() {
  printf '%s\n' "$POLICY_DUMP" | awk -F'\t' -v k="$1" '$1 == k && ($2 == "string" || $2 == "number" || $2 == "bool") { print $3; exit }'
}

# Every element of an array field, one per line, in document order.
policy_array() {
  printf '%s\n' "$POLICY_DUMP" | awk -F'\t' -v p="$1[" '$2 == "string" && index($1, p) == 1 && substr($1, length(p) + 1) ~ /^[0-9]+\]$/ { print $3 }'
}

# Count of array elements of ANY type -- compared against the count of
# string elements to reject `["a", 3]`-style arrays, matching
# isStringArray() in src/shield/policy.ts.
policy_array_count() {
  printf '%s\n' "$POLICY_DUMP" | awk -F'\t' -v p="$1[" -v want="$2" '
    index($1, p) == 1 && substr($1, length(p) + 1) ~ /^[0-9]+\]$/ && (want == "" || $2 == want) { n++ }
    END { print n + 0 }'
}

require_string_array() {
  # $1 = path. Must exist, be an array, and contain only strings --
  # exactly what validateShieldPolicy() requires in TypeScript.
  if [ "$(policy_type "$1")" != "array" ]; then
    fail_immediately policy-corrupt "policy field ${1#.} must be an array of strings"
  fi
  if [ "$(policy_array_count "$1" "")" != "$(policy_array_count "$1" "string")" ]; then
    fail_immediately policy-corrupt "policy field ${1#.} must contain only strings"
  fi
}

require_optional_string() {
  case "$(policy_type "$1")" in
    absent|string) ;;
    *) fail_immediately policy-corrupt "policy field ${1#.} must be a string when present" ;;
  esac
}

# ---- schema validation, 1:1 with validateShieldPolicy() ----
#
# Previously only `policyVersion` and `expectedGitEmail` were checked, and
# a policy that failed anything else simply behaved unpredictably. Every
# check below fails CLOSED (policy-corrupt, exit 1), so a malformed policy
# blocks the action and says why, instead of quietly enforcing a subset.

if [ "$(policy_type "")" != "object" ]; then
  fail_immediately policy-corrupt "Shield's policy file must contain a JSON object"
fi

if [ "$(policy_type .policyVersion)" != "number" ] || [ "$(policy_scalar .policyVersion)" != "1" ]; then
  fail_immediately policy-corrupt "unexpected or missing policyVersion (got: '$(policy_scalar .policyVersion)')"
fi

if [ "$(policy_type .generatedAt)" != "number" ]; then
  fail_immediately policy-corrupt "policy is missing a numeric generatedAt"
fi

for required_field in .matchedProfileId .profileLabel .expectedGitEmail; do
  if [ "$(policy_type "$required_field")" != "string" ] || [ -z "$(policy_scalar "$required_field")" ]; then
    fail_immediately policy-corrupt "policy is missing required non-empty string field ${required_field#.}"
  fi
done

require_optional_string .expectedGitName
require_optional_string .approvedRepositoryKey
require_optional_string .expectedGitHubLogin

case "$(policy_type .approvedPushDestination)" in
  absent|object) ;;
  *) fail_immediately policy-corrupt "policy field approvedPushDestination must be an object when present" ;;
esac
require_optional_string .approvedPushDestination.host
require_optional_string .approvedPushDestination.owner
require_optional_string .approvedPushDestination.repo

# A non-boolean strictPushSetup used to read as "not strict", silently
# turning OFF every route and account check. It is now corruption.
if [ "$(policy_type .strictPushSetup)" != "bool" ]; then
  fail_immediately policy-corrupt "policy field strictPushSetup must be a boolean (true or false)"
fi

require_string_array .trustedSshHostAliases
require_string_array .protectedBranches
require_string_array .expectedBranchPatterns
require_string_array .enabledActions

# Secret-shaped-field guard -- mirrors validateShieldPolicy()'s own list.
# A policy carrying any of these was built from the wrong source object and
# must never be honoured, let alone left sitting on disk unremarked.
for forbidden_field in token accessToken password privateKey sshKey credentials secret; do
  if [ "$(policy_type ".$forbidden_field")" != "absent" ]; then
    fail_immediately policy-corrupt "policy must not contain a \"$forbidden_field\" field -- Shield policy is non-secret by design"
  fi
done

EXPECTED_EMAIL=$(policy_scalar .expectedGitEmail)
EXPECTED_NAME=$(policy_scalar .expectedGitName)
PROFILE_LABEL=$(policy_scalar .profileLabel)
STRICT_PUSH=$(policy_scalar .strictPushSetup)

if ! policy_array .enabledActions | grep -qx "$ACTION"; then
  # This policy does not govern this action at all -- never block it.
  # Reaching here now means enabledActions was verified to be a
  # well-formed array of strings that genuinely does not list this action,
  # NOT that the array failed to parse.
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
    if policy_array .protectedBranches | while IFS= read -r b; do lower "$b"; done | grep -qx "$LOWER_BRANCH"; then
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
  URL_PORT="${4:-}"

  # ---- effective route resolution (Phase 8) ----
  #
  # An SSH alias is just a label in the user's own ~/.ssh/config. Nothing
  # stops `Host github-work` from carrying `HostName something-else`, and
  # nothing stops whatever answers there from replying with a
  # GitHub-shaped greeting ("Hi octocat! You've successfully
  # authenticated..."). Before Phase 8 that combination -- trusted alias
  # name + IdentitiesOnly + GitHub-shaped greeting -- was sufficient to
  # report the GitHub account VERIFIED, without Shield ever establishing
  # that the route goes to GitHub at all.
  #
  # So the effective route is resolved first, with `ssh -G` (purely local:
  # it reads the effective client configuration and makes no network
  # connection, reads no key material, and writes nothing), and the probe
  # below is then required to travel that same route:
  #
  #   * the same alias, so every Host/Match block applies identically;
  #   * the same port -- if the remote URL carried an explicit port, git
  #     would pass it, so `-p` is passed to BOTH `ssh -G` and `ssh -T`,
  #     making the resolved configuration and the probe agree;
  #   * the same login user, taken from the URL when it names one.
  #
  # If the effective HostName is not a GitHub SSH endpoint, no answer from
  # it can establish a github.com account, and verification fails closed.
  PORT_ARGS_SET=0
  if [ -n "$URL_PORT" ]; then PORT_ARGS_SET=1; fi

  if [ "$PORT_ARGS_SET" = 1 ]; then
    CONFIG_OUTPUT=$(ssh -G -p "$URL_PORT" "${SSH_USER_LOCAL}@${ALIAS}" 2>/dev/null) || CONFIG_OUTPUT=""
  else
    CONFIG_OUTPUT=$(ssh -G "${SSH_USER_LOCAL}@${ALIAS}" 2>/dev/null) || CONFIG_OUTPUT=""
  fi
  LOWER_CONFIG=$(printf '%s\n' "$CONFIG_OUTPUT" | tr '[:upper:]' '[:lower:]')

  ssh_config_value() {
    printf '%s\n' "$LOWER_CONFIG" | awk -v k="$1" '$1 == k { $1 = ""; sub(/^[[:space:]]+/, ""); print; exit }'
  }

  EFFECTIVE_HOSTNAME=$(ssh_config_value hostname)
  EFFECTIVE_PORT=$(ssh_config_value port)
  [ -z "$EFFECTIVE_PORT" ] && EFFECTIVE_PORT=22
  EFFECTIVE_USER=$(ssh_config_value user)

  if [ -z "$EFFECTIVE_HOSTNAME" ]; then
    add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: Shield could not resolve this SSH route's effective destination (\"ssh -G\" reported no hostname), so it cannot confirm that its verification probe takes the same route the push itself would."
    return
  fi

  # Must actually be GitHub. Mirrors isGitHubSshEndpoint() in
  # src/shield/githubSshVerification.ts exactly -- github.com,
  # ssh.github.com (GitHub's documented port-443 endpoint), or any
  # *.github.com. A GitHub Enterprise Server host is deliberately NOT
  # accepted: expectedGitHubLogin names a github.com username, and
  # comparing it against a different namespace would be a guess.
  case "$EFFECTIVE_HOSTNAME" in
    github.com|ssh.github.com|*.github.com) ;;
    *)
      add_reason push-account-unverified "Profile: $PROFILE_LABEL
Expected GitHub account: $EXPECTED
Reason: This SSH route's effective destination is ${EFFECTIVE_HOSTNAME}:${EFFECTIVE_PORT}, which is not a GitHub SSH endpoint, so nothing it reports can confirm a GitHub account. (Shield resolves the alias with \"ssh -G\" rather than trusting its name.)"
      return
      ;;
  esac

  # A route can only be strongly bound to one account if ssh-agent can't
  # silently substitute a different key -- IdentitiesOnly must be in
  # effect for this alias. Local config inspection only, no network call.
  if [ "$(ssh_config_value identitiesonly)" != "yes" ]; then
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
  #
  # The alias (not the resolved HostName) is what is connected to, so the
  # probe reproduces the push's route exactly rather than an approximation
  # of it; `-p` is passed only when the URL itself carried a port, for the
  # same reason.
  TIMEOUT="${REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT:-5}"
  set +e
  if [ "$PORT_ARGS_SET" = 1 ]; then
    AUTH_OUTPUT=$(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout="$TIMEOUT" -p "$URL_PORT" "${SSH_USER_LOCAL}@${ALIAS}" 2>&1)
  else
    AUTH_OUTPUT=$(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout="$TIMEOUT" "${SSH_USER_LOCAL}@${ALIAS}" 2>&1)
  fi
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

  # Explicit port, e.g. `ssh://git@github-work:2222/owner/repo.git`. Only
  # the `ssh://` URL form can carry one -- in the scp-like `host:path`
  # shape everything after the colon is the PATH, never a port (that is
  # Git's own rule, and mirroring it is what keeps this parse consistent
  # with where the push actually goes). Captured so the account
  # verification probe can travel the same host:port route the push would
  # (Phase 8); an unparseable/absent port simply means "whatever this
  # alias's effective config says", which is also what git would use.
  URL_PORT=""
  case "$REMOTE_URL" in
    ssh://*)
      URL_PORT=$(printf '%s' "$REMOTE_URL" | sed -nE 's#^ssh://([^/@]*@)?[^/:]+:([0-9]+)(/.*)?$#\2#p')
      ;;
  esac

  # ---- destination: OWNER-based, never host-based (see evaluator.ts's
  # destinationReasons for why a host comparison would falsely flag every
  # trusted-SSH-alias push as a mismatch). Fails CLOSED: if Shield never
  # recorded an approved destination for this repo (no remote resolvable
  # the last time it was enabled/repaired), that is treated as a mismatch,
  # not silently allowed — this also covers a direct `git push <url>` to
  # an ad hoc destination Shield never had visibility into. ----
  APPROVED_HOST=$(policy_scalar .approvedPushDestination.host)
  APPROVED_OWNER=$(policy_scalar .approvedPushDestination.owner)
  APPROVED_REPO=$(policy_scalar .approvedPushDestination.repo)
  EXPECTED_DESTINATION_DISPLAY="${APPROVED_HOST:-(unknown host)}:${APPROVED_OWNER:-?}${APPROVED_REPO:+/$APPROVED_REPO}"

  if [ -z "$APPROVED_OWNER" ]; then
    add_reason push-destination-mismatch "Profile: $PROFILE_LABEL
Shield has no approved push destination on file for this repository (none was resolved the last time Shield was enabled or repaired).
Reason: Refresh Shield after confirming the intended remote before pushing."
  # MISSING EVIDENCE IS NOT A MATCH (Phase 8, kept 1:1 with
  # destinationReasons() in src/shield/evaluator.ts). The `[ -n
  # "$PARSED_REPO" ]` guard used to sit on the repo comparison, so a push
  # URL that yielded an owner but NO repository name satisfied a policy
  # that names a specific repository -- it matched purely because the
  # owner happened to parse. An unparseable owner was likewise compared as
  # the empty string. Both now require the push URL to actually produce
  # the evidence the policy asks for.
  elif [ -z "$PARSED_OWNER" ] \
    || [ "$(lower "$PARSED_OWNER")" != "$(lower "$APPROVED_OWNER")" ] \
    || { [ -n "$APPROVED_REPO" ] && { [ -z "$PARSED_REPO" ] || [ "$(lower "$PARSED_REPO")" != "$(lower "$APPROVED_REPO")" ]; }; }; then
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
    if policy_array .trustedSshHostAliases | while IFS= read -r a; do lower "$a"; done | grep -qx "$LOWER_HOST"; then
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
  EXPECTED_GH_LOGIN=$(policy_scalar .expectedGitHubLogin)
  if [ "$STRICT_PUSH" = "true" ] && [ "$ROUTE_UNVERIFIED" = 0 ] && [ -n "$EXPECTED_GH_LOGIN" ]; then
    verify_github_account "$HOST" "$SSH_USER" "$EXPECTED_GH_LOGIN" "$URL_PORT"
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
