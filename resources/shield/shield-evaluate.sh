#!/bin/sh
# shield-evaluate.sh — Repo Identity Guard's standalone identity-lock evaluator.
# repo-identity-guard-shield-artifact v7 (evaluator)
#
# This is the runtime artifact the identity lock's Git hooks (pre-commit,
# pre-merge-commit, pre-push) invoke. It has NO dependency on Node, VS
# Code, or any running extension host — only `git` itself plus the POSIX
# shell utilities that ship alongside `git` on every platform Git runs on
# (sh, awk, sed, grep, tr). That is what makes the lock work with VS Code
# closed: from any terminal, GUI, or AI agent that runs ordinary `git`.
#
# (The file keeps its historical "shield" name: the engine was previously
# a user-facing feature called Shield Mode. Renaming it would buy nothing
# and would orphan every installed copy's ownership marker.)
#
# Usage:
#   shield-evaluate.sh commit
#   shield-evaluate.sh push <remote-name> <remote-url>   [ref lines on stdin, as a real pre-push hook receives — drained, never needed]
#
# Exit code is the entire contract: 0 = allow the Git action, non-zero =
# block it. On a block, ONE message is written to stderr (never stdout),
# starting with a stable machine-readable prelude:
#
#   REPO_IDENTITY_GUARD_BLOCK
#   ACTION: commit | push
#   REASON: <short code, e.g. wrong_identity>
#   REASON_ID: <stable reason id, e.g. commit-identity-mismatch>
#   IDENTITY: <assigned identity label>      (when the policy could be read)
#   ...KEY: value lines specific to the reason...
#
# followed by a blank line and a human explanation: what was blocked, why,
# the expected vs. found identity/account, what to do next, and that
# bypassing the check (--no-verify) is not the intended fix. Nothing
# printed here is secret: no token, credential-helper output, key path or
# key material, and never a raw remote URL (which can embed credentials).
#
# What it evaluates — and nothing else:
#  - commit: the EFFECTIVE author and committer identity (`git var`, which
#    sees GIT_AUTHOR_*/GIT_COMMITTER_* env vars, `git -c user.*=...`, and
#    `--author`) must equal the assigned identity.
#  - push, ALWAYS (a lock governs commit and push unconditionally): the
#    assigned identity must declare an expected GitHub login (if it does
#    not, every push is blocked as push_identity_not_configured -- never
#    allowed unchecked), the push must travel a trusted SSH alias with no
#    transport override, and a live `ssh -G` + `ssh -T` probe over that
#    exact route must authenticate as the expected login. Anything
#    unprovable blocks.
# Branch names, merge/rebase state, and which repository a push goes to
# are deliberately never consulted.
#
# This script never installs itself, never mutates Git config, and never
# touches anything outside read-only `git` plumbing, its own policy file,
# and — only for push verification — the single ordinary SSH connection
# the push itself would use. No key material is ever read, no SSH config
# is ever written, and no other network call is ever made.
#
# Its decisions are mirrored 1:1 by the pure TypeScript reference in
# src/shield/evaluator.ts, and the two are cross-checked by the
# differential test suites so they cannot silently drift apart.
#
# Deliberate bypasses (`git commit --no-verify`, `git push --no-verify`,
# deleting the hooks by hand) are outside the threat model: this protects
# against accidental and ordinary misuse, not a local user intentionally
# defeating their own Git setup.

set -eu

ACTION="${1:-}"
if [ "$ACTION" != "commit" ] && [ "$ACTION" != "push" ]; then
  echo "Repo Identity Guard: usage: shield-evaluate.sh <commit|push> [remote-name remote-url]" >&2
  exit 2
fi

# Filled in once the policy has been read; empty before that.
IDENTITY_LABEL=""

# Collapses any CR/LF/TAB to a space so a value can never break the
# one-field-per-line prelude format.
one_line() {
  printf '%s' "$1" | tr '\r\n\t' '   '
}

# Short machine code for each stable reason id. Kept 1:1 with
# SHIELD_REASON_CATALOG in src/shield/reasonCatalog.ts (asserted by
# src/test/identityLockOutput.test.ts).
reason_code() {
  case "$1" in
    commit-identity-mismatch) echo wrong_identity ;;
    commit-identity-override) echo identity_override ;;
    push-identity-not-configured) echo push_identity_not_configured ;;
    push-route-unverified) echo push_route_unverified ;;
    push-route-override) echo push_route_override ;;
    push-account-mismatch) echo wrong_push_account ;;
    push-account-unverified) echo push_account_unverified ;;
    policy-missing) echo policy_missing ;;
    policy-corrupt) echo policy_corrupt ;;
    *) echo inspection_failed ;;
  esac
}

BYPASS_NOTE="Do not bypass this check (for example with --no-verify): it exists so this repository is never used with the wrong identity by accident. If this repository should no longer be locked, run \"Repo Identity Guard: Unlock Current Repository\" in VS Code instead."

# block <reason-id> <extra prelude lines, may be empty> <human message>
#
# Prints the single block message and exits non-zero. Every block — policy
# problems, inspection failures, identity mismatches — goes through here,
# so the prelude format is guaranteed identical for all of them.
block() {
  {
    echo "REPO_IDENTITY_GUARD_BLOCK"
    echo "ACTION: $ACTION"
    echo "REASON: $(reason_code "$1")"
    echo "REASON_ID: $1"
    if [ -n "$IDENTITY_LABEL" ]; then
      echo "IDENTITY: $(one_line "$IDENTITY_LABEL")"
    fi
    if [ -n "$2" ]; then
      printf '%s\n' "$2"
    fi
    echo ""
    echo "Repo Identity Guard blocked this $ACTION."
    echo ""
    printf '%s\n' "$3"
    echo ""
    echo "$BYPASS_NOTE"
  } >&2
  exit 1
}

# For failures that make any further evaluation meaningless
# (policy-missing, policy-corrupt, inspection-failed) — mirrors
# evaluateFromPolicyLoad's short-circuit in src/shield/evaluator.ts.
fail_immediately() {
  block "$1" "" "$2

What to do: open this repository in VS Code and run \"Repo Identity Guard: Repair Identity Lock\" (or \"Unlock Current Repository\" if it should not be locked)."
}

lower() {
  # Trailing newline is deliberate: this is used both inside `$(...)`
  # (where it's stripped harmlessly) and piped line-by-line inside a
  # `while read` loop feeding `grep -qx` (where dropping it would merge
  # every line into one and silently break every array-membership check).
  #
  # Leading/trailing whitespace is STRIPPED as well as case being folded
  # (Phase 9 / Part 7): this is the shell half of `normalize()` in
  # src/shield/evaluator.ts, which does `.trim().toLocaleLowerCase()`. Git
  # itself strips leading/trailing whitespace from an ident's name, so the
  # two spellings were never two different identities to begin with.
  printf '%s\n' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | tr '[:upper:]' '[:lower:]'
}

# ==================== locate + load policy ====================

GIT_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || fail_immediately inspection-failed "Could not resolve the repository's common git directory."

POLICY_FILE="$GIT_COMMON_DIR/repo-identity-guard/shield-policy.json"

if [ ! -f "$POLICY_FILE" ]; then
  fail_immediately policy-missing "The identity-lock hook is installed, but no lock policy was found at $POLICY_FILE, so the assigned identity cannot be checked. Failing closed."
fi


# ==================== policy parsing (strict) ====================
#
# Phase 8 hardening. The previous parser was two small awk one-liners that
# scanned for `"key":` line-wise. Adversarial testing found ways to make it
# FAIL OPEN -- i.e. exit 0 and allow the action -- (a policy whose arrays
# are packed onto one line, and a truncated policy), so this is a real,
# strict JSON parser: a recursive-descent parse in POSIX awk -- no jq, no
# Node, no Python, nothing beyond the awk that already ships everywhere
# `git` does. It parses the WHOLE document, and rejects (policy-corrupt,
# which fails closed) anything that is not exactly one well-formed JSON
# value: truncation, trailing garbage, unterminated strings or containers,
# bad escapes, raw control characters inside strings, invalid numbers, and
# DUPLICATE KEYS within one object (JSON permits those; the evaluator
# refuses to guess which of two `"expectedGitEmail"` fields was meant).
#
# ## Trust boundary, stated explicitly
#
# The flattened form the parser emits is one `path<TAB>type<TAB>value`
# line per node; an explicit `\n`/`\t` escape in a string is normalized to
# a single space. No field the evaluator compares (`expectedGitEmail`,
# `expectedGitName`, aliases, logins, actions) can legitimately contain a
# control character. Anyone who can write this policy file can also write
# the hook that reads it, so the file is not a security boundary against a
# local attacker -- it is protected against CORRUPTION and MALFORMEDNESS,
# and corruption fails closed instead of silently disabling enforcement.

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
    # JSON forbids EVERY raw control character (U+0000-U+001F) inside a
    # string, not just the three that are easy to type.
    #
    # Phase 9 / Part 8 finding, found by the adversarial parser fuzzer: this
    # check used to be `ch == "\n" || ch == "\r" || ch == "\t"`, so every
    # other C0 control character -- U+0001 and the rest, plus DEL -- was
    # accepted into a string value. That was a FAIL-OPEN disagreement with
    # the TypeScript validator (JSON.parse rejects them outright): a policy
    # file corrupted with a stray control byte was rejected by the extension
    # and honoured by the shipped evaluator, which then allowed the commit.
    # [[:cntrl:]] is the POSIX character class for exactly that set.
    if (ch ~ /[[:cntrl:]]/) { err("raw control character inside a string") }
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
    # value (e.g. two "expectedGitEmail" fields).
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
  fail_immediately policy-corrupt "The identity-lock policy at $POLICY_FILE is not valid JSON and cannot be trusted ($POLICY_PARSE_ERROR). Failing closed."
fi
if [ -z "$POLICY_DUMP" ]; then
  fail_immediately policy-corrupt "The identity-lock policy at $POLICY_FILE could not be read or parsed at all. Failing closed."
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
# Every check below fails CLOSED (policy-corrupt, exit 1), so a malformed
# policy blocks the action and says why, instead of quietly enforcing a
# subset.

if [ "$(policy_type "")" != "object" ]; then
  fail_immediately policy-corrupt "The identity-lock policy must contain a JSON object. Failing closed."
fi

# v4 is the identity-lock policy. v1/v2 were the retired "Shield Mode"
# policy (profile matching, branch protection, approved push
# destinations); v3 was the first identity-lock policy, whose
# enforcedActions list could take push out of an assigned repository's
# lock. None of them is enforced by this evaluator. Opening the repository
# in VS Code migrates a v1/v2 installation (into a lock when an explicit
# legacy binding is provable, otherwise by removing the legacy hooks) and
# upgrades a v3 lock in place, keeping its assignment.
POLICY_VERSION_VALUE=$(policy_scalar .policyVersion)
if [ "$(policy_type .policyVersion)" != "number" ] || [ "$POLICY_VERSION_VALUE" != "4" ]; then
  case "$POLICY_VERSION_VALUE" in
    1|2)
      fail_immediately policy-corrupt "This repository still has a legacy Repo Identity Guard \"Shield\" policy (version $POLICY_VERSION_VALUE), which this version no longer enforces. Failing closed until it is migrated."
      ;;
    3)
      fail_immediately policy-corrupt "This repository's identity lock was written by an earlier version of Repo Identity Guard (policy version 3), which this evaluator no longer enforces. Failing closed until it is upgraded (the assignment is kept)."
      ;;
    *)
      fail_immediately policy-corrupt "The identity-lock policy has an unexpected or missing policyVersion (got: '$POLICY_VERSION_VALUE'; expected 4). Failing closed."
      ;;
  esac
fi

for numeric_field in .generatedAt .assignedAt; do
  if [ "$(policy_type "$numeric_field")" != "number" ]; then
    fail_immediately policy-corrupt "The identity-lock policy is missing a numeric ${numeric_field#.}."
  fi
done

for required_field in .lockId .identityId .identityLabel .expectedGitEmail; do
  if [ "$(policy_type "$required_field")" != "string" ] || [ -z "$(policy_scalar "$required_field")" ]; then
    fail_immediately policy-corrupt "The identity-lock policy is missing required non-empty string field ${required_field#.}."
  fi
done

require_optional_string .expectedGitName
require_optional_string .expectedGitHubLogin

require_string_array .trustedSshHostAliases

# A v4 lock governs commit AND push unconditionally -- there is no
# per-action list that could take push out of an assigned repository's
# lock. A policy that carries one anyway (hand-edited, or a v3 field
# grafted onto a v4 file) is refused rather than ignored, mirroring
# validateShieldPolicy(), so nobody can believe that editing it disables
# push checks.
if [ "$(policy_type .enforcedActions)" != "absent" ]; then
  fail_immediately policy-corrupt "The identity-lock policy must not contain an enforcedActions field: commit and push are always both governed (policy version 4)."
fi

# Empty/absent = the push requirement is INCOMPLETE: every push is blocked
# (push-identity-not-configured), never allowed unchecked.
EXPECTED_GH_LOGIN=$(policy_scalar .expectedGitHubLogin)

# Secret-shaped-field guard -- mirrors validateShieldPolicy()'s own list.
for forbidden_field in token accessToken password privateKey sshKey credentials secret; do
  if [ "$(policy_type ".$forbidden_field")" != "absent" ]; then
    fail_immediately policy-corrupt "The identity-lock policy must not contain a \"$forbidden_field\" field -- it is non-secret by design."
  fi
done

EXPECTED_EMAIL=$(policy_scalar .expectedGitEmail)
EXPECTED_NAME=$(policy_scalar .expectedGitName)
IDENTITY_LABEL=$(policy_scalar .identityLabel)

# ==================== commit ====================

evaluate_commit() {
  # ---- identity: re-read fresh, right now — never a cached scan ----
  # `git var` reports the EFFECTIVE identity: it already reflects
  # GIT_AUTHOR_*/GIT_COMMITTER_*/EMAIL environment overrides, a
  # command-scoped `git -c user.name=/user.email=` (via
  # GIT_CONFIG_PARAMETERS), and `git commit --author=...` (Git exports it
  # to the hook's environment), exactly as the commit will record it.
  AUTHOR_IDENT=$(git var GIT_AUTHOR_IDENT 2>/dev/null) \
    || fail_immediately inspection-failed "Git could not determine the author identity for this commit (\"git var GIT_AUTHOR_IDENT\" failed -- is user.name/user.email configured?). The assigned identity cannot be checked, so the commit is blocked."
  COMMITTER_IDENT=$(git var GIT_COMMITTER_IDENT 2>/dev/null) \
    || fail_immediately inspection-failed "Git could not determine the committer identity for this commit (\"git var GIT_COMMITTER_IDENT\" failed). The assigned identity cannot be checked, so the commit is blocked."

  ident_name() { printf '%s' "$1" | sed -E 's/^(.*) <[^>]*> [0-9]+ [+-][0-9]+[[:space:]]*$/\1/'; }
  ident_email() { printf '%s' "$1" | sed -E 's/^.*<([^>]*)>.*$/\1/'; }

  AUTHOR_NAME=$(ident_name "$AUTHOR_IDENT")
  AUTHOR_EMAIL=$(ident_email "$AUTHOR_IDENT")
  COMMITTER_NAME=$(ident_name "$COMMITTER_IDENT")
  COMMITTER_EMAIL=$(ident_email "$COMMITTER_IDENT")

  # worktree ?? local ?? global — read fresh here, only to tell a config
  # mismatch apart from an environment/command-line override.
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

  if [ "$AUTHOR_OK" = 1 ] && [ "$COMMITTER_OK" = 1 ]; then
    return 0
  fi

  # Which identity (author, committer, or both) actually mismatched, and
  # the first mismatching one's values for the machine-readable prelude.
  if [ "$AUTHOR_OK" = 0 ] && [ "$COMMITTER_OK" = 0 ]; then
    FOUND_ROLE="author,committer"
  elif [ "$AUTHOR_OK" = 0 ]; then
    FOUND_ROLE="author"
  else
    FOUND_ROLE="committer"
  fi
  if [ "$AUTHOR_OK" = 0 ]; then
    FOUND_NAME="$AUTHOR_NAME"
    FOUND_EMAIL="$AUTHOR_EMAIL"
  else
    FOUND_NAME="$COMMITTER_NAME"
    FOUND_EMAIL="$COMMITTER_EMAIL"
  fi

  EXPECTED_DISPLAY="${EXPECTED_NAME:+$EXPECTED_NAME }<$EXPECTED_EMAIL>"
  PRELUDE=""
  if [ -n "$EXPECTED_NAME" ]; then
    PRELUDE="EXPECTED_NAME: $(one_line "$EXPECTED_NAME")
"
  fi
  PRELUDE="${PRELUDE}EXPECTED_EMAIL: $(one_line "$EXPECTED_EMAIL")
FOUND_NAME: $(one_line "$FOUND_NAME")
FOUND_EMAIL: $(one_line "$FOUND_EMAIL")
FOUND_ROLE: $FOUND_ROLE"

  FOUND_LINES=""
  [ "$AUTHOR_OK" = 0 ] && FOUND_LINES="  author:    ${AUTHOR_NAME:-(unknown)} <${AUTHOR_EMAIL:-(unknown)}>"
  if [ "$COMMITTER_OK" = 0 ]; then
    FOUND_LINES="${FOUND_LINES:+$FOUND_LINES
}  committer: ${COMMITTER_NAME:-(unknown)} <${COMMITTER_EMAIL:-(unknown)}>"
  fi

  if name_matches "$CONFIGURED_NAME" && email_matches "$CONFIGURED_EMAIL"; then
    block commit-identity-override "$PRELUDE" "This repository is locked to the identity \"$IDENTITY_LABEL\" ($EXPECTED_DISPLAY).
Git config for this repository already uses that identity, but this commit would be recorded as:
$FOUND_LINES

Something is overriding the configured identity for this commit: an environment variable
(GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL, EMAIL),
a \"git -c user.name=...\" / \"git -c user.email=...\" option, or \"git commit --author=...\".

What to do: remove that override (unset the variable, or drop the option), then retry the commit."
  fi

  block commit-identity-mismatch "$PRELUDE" "This repository is locked to the identity \"$IDENTITY_LABEL\" ($EXPECTED_DISPLAY),
but this commit would be recorded as:
$FOUND_LINES

What to do: switch this repository to the assigned identity, then retry the commit:${EXPECTED_NAME:+
  git config user.name \"$EXPECTED_NAME\"}
  git config user.email \"$EXPECTED_EMAIL\"
(In VS Code: \"Repo Identity Guard: Use Assigned Identity in Git Config\".)"
}

# ==================== push: GitHub SSH account verification ====================
#
# Establishes which GitHub account this push authenticates as, over the
# exact route the push itself will take, and compares it with the
# assigned identity's expected login. Only reached when the route is
# already a trusted SSH alias with no transport override (an untrusted or
# overridden route is blocked before this). Never reads private key
# contents, copies keys, edits SSH config, touches ssh-agent, or stores a
# password/passphrase. The only network activity is the ordinary SSH
# connection this push would make anyway.

# push_block <reason-id> <found-login-or-"unverified"> <detail-code> <human message>
push_block() {
  block "$1" "EXPECTED_GITHUB_LOGIN: $(one_line "$EXPECTED_GH_LOGIN")
FOUND_GITHUB_LOGIN: $(one_line "$2")
DETAIL: $3
REMOTE: $(one_line "${REMOTE_NAME:-(none)}")
ROUTE_HOST: $(one_line "${HOST:-(unknown)}")" "$4"
}

account_unverified() {
  # $1 = detail code, $2 = specific reason sentence
  push_block push-account-unverified unverified "$1" "This repository is locked to the identity \"$IDENTITY_LABEL\", which must push as the GitHub account \"$EXPECTED_GH_LOGIN\".
Repo Identity Guard could not verify which account this push would authenticate as:
  $2

What to do: fix the SSH route for \"${HOST}\" so it can be verified (see below), then retry the push.
  - Its ~/.ssh/config Host entry must point at github.com (or ssh.github.com) and set \"IdentitiesOnly yes\"
    with the IdentityFile of the $EXPECTED_GH_LOGIN key.
  - Its host key must already be in known_hosts (run \"ssh -T git@${HOST}\" once yourself and verify the fingerprint).
  - Check that the key is added to the $EXPECTED_GH_LOGIN GitHub account."
}

verify_github_account() {
  ALIAS="$1"
  SSH_USER_LOCAL="$2"
  EXPECTED="$3"
  URL_PORT_LOCAL="${4:-}"

  # ---- effective route resolution (Phase 8) ----
  #
  # An SSH alias is just a label in the user's own ~/.ssh/config. Nothing
  # stops `Host github-work` from carrying `HostName something-else`, and
  # nothing stops whatever answers there from replying with a
  # GitHub-shaped greeting. So the effective route is resolved first, with
  # `ssh -G` (purely local: reads the effective client configuration, makes
  # no network connection, reads no key material, writes nothing), and the
  # probe below is then required to travel that same route:
  #
  #   * the same alias, so every Host/Match block applies identically;
  #   * the same port -- if the remote URL carried an explicit port, git
  #     would pass it, so `-p` is passed to BOTH `ssh -G` and `ssh -T`;
  #   * the same login user, taken from the URL when it names one --
  #     and, when the URL named NONE, the bare alias, so OpenSSH itself
  #     determines the effective user exactly as the real push transport
  #     would. Inventing "git" here would ask a DIFFERENT question
  #     whenever the effective user is config-sensitive (`Match user`, a
  #     per-user `Host` block) and could authenticate the wrong login.
  #
  # If the effective HostName is not a GitHub SSH endpoint, no answer from
  # it can establish a github.com account, and verification fails closed.
  if [ -n "$SSH_USER_LOCAL" ]; then
    TARGET="${SSH_USER_LOCAL}@${ALIAS}"
  else
    TARGET="$ALIAS"
  fi
  PORT_ARGS_SET=0
  if [ -n "$URL_PORT_LOCAL" ]; then PORT_ARGS_SET=1; fi

  if [ "$PORT_ARGS_SET" = 1 ]; then
    CONFIG_OUTPUT=$(ssh -G -p "$URL_PORT_LOCAL" "$TARGET" 2>/dev/null) || CONFIG_OUTPUT=""
  else
    CONFIG_OUTPUT=$(ssh -G "$TARGET" 2>/dev/null) || CONFIG_OUTPUT=""
  fi
  LOWER_CONFIG=$(printf '%s\n' "$CONFIG_OUTPUT" | tr '[:upper:]' '[:lower:]')

  ssh_config_value() {
    printf '%s\n' "$LOWER_CONFIG" | awk -v k="$1" '$1 == k { $1 = ""; sub(/^[[:space:]]+/, ""); print; exit }'
  }

  EFFECTIVE_HOSTNAME=$(ssh_config_value hostname)
  EFFECTIVE_PORT=$(ssh_config_value port)
  [ -z "$EFFECTIVE_PORT" ] && EFFECTIVE_PORT=22
  # The effective `user` is deliberately NOT read back and compared:
  # `ssh -G` is asked about the very same "<user>@<alias>" string that the
  # `ssh -T` probe below connects with, so its answer for `user` is a
  # restatement of the input, not independent evidence.

  if [ -z "$EFFECTIVE_HOSTNAME" ]; then
    account_unverified route_unresolvable "\"ssh -G\" reported no effective hostname for this route, so the verification probe cannot be shown to take the same route the push would."
  fi

  # Must actually be GitHub. Mirrors isGitHubSshEndpoint() in
  # src/shield/githubSshVerification.ts exactly -- github.com,
  # ssh.github.com (GitHub's documented port-443 endpoint), or any
  # *.github.com. A GitHub Enterprise Server host is deliberately NOT
  # accepted: expectedGitHubLogin names a github.com username.
  case "$EFFECTIVE_HOSTNAME" in
    github.com|ssh.github.com|*.github.com) ;;
    *)
      account_unverified route_not_github "This SSH route's effective destination is ${EFFECTIVE_HOSTNAME}:${EFFECTIVE_PORT}, which is not a GitHub SSH endpoint, so nothing it reports can confirm a GitHub account. (The alias is resolved with \"ssh -G\" rather than trusted by name.)"
      ;;
  esac

  # A route can only be strongly bound to one account if ssh-agent can't
  # silently substitute a different key -- IdentitiesOnly must be in
  # effect for this alias. Local config inspection only, no network call.
  if [ "$(ssh_config_value identitiesonly)" != "yes" ]; then
    account_unverified identities_not_isolated "This SSH route's effective configuration does not set \"IdentitiesOnly yes\", so ssh-agent could offer a different, unrelated key than the one this route is meant to use."
  fi

  # GitHub's SSH endpoint replies to a noninteractive self-test even
  # though it commonly exits 1 on FULLY SUCCESSFUL authentication (it has
  # no shell to hand back) -- so the exit code is deliberately never
  # consulted, only the response text is. StrictHostKeyChecking=yes means
  # an unknown/changed host key fails the connection rather than silently
  # (or interactively) trusting it -- the lock never auto-accepts a host
  # key on the user's behalf. BatchMode=yes means no prompt can ever hang
  # a hook waiting for input.
  TIMEOUT="${REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT:-5}"
  set +e
  if [ "$PORT_ARGS_SET" = 1 ]; then
    AUTH_OUTPUT=$(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout="$TIMEOUT" -p "$URL_PORT_LOCAL" "$TARGET" 2>&1)
  else
    AUTH_OUTPUT=$(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout="$TIMEOUT" "$TARGET" 2>&1)
  fi
  set -e

  case "$AUTH_OUTPUT" in
    *"successfully authenticated"*)
      AUTH_ID=$(printf '%s' "$AUTH_OUTPUT" | sed -nE 's/.*Hi ([^!]+)!.*successfully authenticated.*/\1/p' | head -n1)
      case "$AUTH_ID" in
        "")
          account_unverified malformed "SSH's response while verifying the account could not be parsed."
          ;;
        */*)
          # GitHub names deploy-key/App-installation identities as
          # "owner/repo", never a personal username -- never comparable to
          # expectedGitHubLogin, so always unverifiable, never guessed at.
          account_unverified deploy_key "This route authenticated using a deploy-key-style identity (\"$AUTH_ID\") rather than a personal GitHub account."
          ;;
        *)
          if [ "$(lower "$AUTH_ID")" != "$(lower "$EXPECTED")" ]; then
            push_block push-account-mismatch "$AUTH_ID" account_mismatch "This repository is locked to the identity \"$IDENTITY_LABEL\", which must push as the GitHub account \"$EXPECTED\",
but the SSH route \"${HOST}\" authenticated as \"$AUTH_ID\".

What to do: push through an SSH host alias whose key belongs to \"$EXPECTED\" (one of: $TRUSTED_ALIASES_DISPLAY),
or fix the IdentityFile of \"Host ${HOST}\" in ~/.ssh/config, then retry the push."
          fi
          ;;
      esac
      ;;
    *"Permission denied"*)
      account_unverified permission_denied "SSH authentication to GitHub was refused (permission denied), so the account could not be confirmed."
      ;;
    *"Host key verification failed"*|*"know the"*"key fingerprint"*|*"host key is known"*)
      account_unverified host_key_unverified "This SSH host's key is not already trusted in known_hosts, so Repo Identity Guard refused to connect automatically."
      ;;
    *"timed out"*)
      account_unverified timeout "The SSH connection timed out while verifying the account."
      ;;
    *)
      account_unverified malformed "SSH's response while verifying the account could not be parsed."
      ;;
  esac
}

# ==================== push ====================

evaluate_push() {
  # Git's pre-push contract passes the remote NAME as $1 and its location
  # as $2. Only the location decides the route; the name is reported in
  # the block message for orientation only.
  REMOTE_NAME="${1:-}"
  REMOTE_URL="${2:-}"
  # Drain stdin (the real pre-push hook's ref lines) -- an identity
  # decision never needs them.
  cat >/dev/null 2>&1 || true

  # ---- push identity configured at all? ----
  # Push is ALWAYS governed for an assigned repository. With no expected
  # GitHub login there is no account any push could be verified as, so
  # every push is blocked -- before the route is even parsed, because no
  # route could make it verifiable. Mirrors evaluatePush() in
  # src/shield/evaluator.ts. The login is never guessed (not from the
  # commit email, the remote, the alias, or Git config).
  if [ -z "$EXPECTED_GH_LOGIN" ]; then
    block push-identity-not-configured "EXPECTED_GITHUB_LOGIN: (not configured)
DETAIL: github_login_not_configured
REMOTE: $(one_line "${REMOTE_NAME:-(none)}")" "This repository is locked to \"$IDENTITY_LABEL\", but that identity does not yet have
a GitHub account configured for push verification, so this push cannot be
attributed to the assigned identity.

What to do: configure the GitHub account for \"$IDENTITY_LABEL\" in Repo Identity Guard
(its expectedGitHubLogin, plus a trusted SSH host alias whose key belongs to that
account), then retry the push. Commits are still checked as usual."
  fi

  if [ -z "$REMOTE_URL" ]; then
    fail_immediately inspection-failed "No remote URL was provided to evaluate (expected: shield-evaluate.sh push <remote-name> <remote-url>)."
  fi

  # ---- parse the ACTUAL action-time remote URL (never a value predicted
  # earlier by an extension scan) — mirrors parseRemoteUrl() in
  # src/services/gitService.ts. Only the protocol, host, SSH user and
  # explicit port matter to an identity decision (they decide which route
  # the push authenticates over); the repository owner/path is
  # deliberately never parsed or compared -- the lock does not care WHICH
  # repository a push goes to, only WHO it authenticates as. ----
  PROTOCOL=unknown
  HOST=""
  # The scheme is detected with an ANCHORED match, exactly like
  # parseRemoteUrl()'s `/^[a-z][a-z0-9+.-]*:\/\//i` test -- not with a
  # `*://*` glob, which matches anywhere in the string.
  #
  # Phase 9 / Part 9 finding: the glob form took the URL branch for
  # "://github.com/acme/repo.git" (no scheme NAME at all), where the
  # scheme-stripping sed then did nothing, the host regex could not match a
  # leading ":", and the path fell out as "github.com/acme/repo.git" --
  # producing owner "acme", repo "repo" and ALLOWING the push. TypeScript
  # parses that same string to `{protocol: "unknown"}` with no owner and no
  # repo, and blocks. Same class of bug for a "://" appearing inside an
  # scp-like path ("git@host:a://b"), which TypeScript reads as scp-like.
  URL_SCHEME=$(lower "$(printf '%s' "$REMOTE_URL" | sed -nE 's#^([a-zA-Z][a-zA-Z0-9+.-]*)://.*$#\1#p')")

  if [ -n "$URL_SCHEME" ]; then
    # ---- a real <scheme>://... URL ----
    case "$URL_SCHEME" in
      https|http) PROTOCOL=https ;;
      ssh) PROTOCOL=ssh ;;
      # Any other scheme (git://, ftp://, file://, ...) -- mirrors
      # parseRemoteUrl()'s generic URL branch: only https/ssh get their own
      # label, everything else stays "unknown", but host/path are still
      # extracted the same way.
      *) PROTOCOL=unknown ;;
    esac
    rest=$(printf '%s' "$REMOTE_URL" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##')
    case "$rest" in
      /*)
        # An authority-less form (file:///path) has no host at all --
        # matching `new URL(...).hostname` being "" for that shape.
        HOST=""
        ;;
      *)
        # A bracketed IPv6 literal ("[2001:db8::1]") contains colons itself,
        # so the ordinary "[^/:]+" host pattern below stops at the FIRST
        # one -- e.g. it read "[2001" as the entire host of
        # "ssh://git@[2001:db8::1]/acme/repo.git". Found by the PART 9
        # differential corpus once the release-blocker fix made host
        # identity part of the (since removed) destination check. `new URL(...).hostname`
        # (the TypeScript side) keeps the brackets, so this matches that
        # exactly, brackets included.
        case "$rest" in
          '['*|*@'['*)
            HOST=$(printf '%s' "$rest" | sed -E 's#^([^/@]*@)?(\[[^]]*\]).*#\2#')
            ;;
          *)
            HOST=$(printf '%s' "$rest" | sed -E 's#^([^/@]*@)?([^/:]+).*#\2#')
            ;;
        esac
        ;;
    esac
  else
    case "$REMOTE_URL" in
    *:*)
      # scp-like: [user@]host:path (also covers a bare SSH host alias).
      #
      # Phase 9 / Part 9 finding, found by the URL differential harness:
      # this used to be `s/^([^@]*@)?([^:]+):.*/\2/` for the host and
      # `s/^[^:]*://` for the path, which accepted shapes parseRemoteUrl()
      # in src/services/gitService.ts rejects outright -- and did so
      # FAIL-OPEN. Two concrete cases:
      #
      #   ":acme/repo.git"            -- no host at all
      #   "://github.com/acme/repo.git" -- a "://" with no scheme name
      #
      # TypeScript's scp-like regex requires a NON-EMPTY host containing
      # neither "/" nor whitespace, so both parsed to `{protocol:
      # "unknown"}` with no host, while the shell produced a host for both
      # -- an unparseable, hostless URL must never read as a usable route.
      #
      # This now mirrors
      #   /^(?:[^@\/\s]+@)?([^:\/\s]+):(.+)$/
      # exactly: non-empty host, no "/" or whitespace in it, non-empty
      # path, whole-string anchored. No match leaves PROTOCOL "unknown"
      # with an empty host, which fails closed on the route check.
      SCP_LIKE='^([^@/[:space:]]+@)?([^:/[:space:]]+):(.+)$'
      SCP_HOST=$(printf '%s' "$REMOTE_URL" | sed -nE "s#$SCP_LIKE#\\2#p")
      if [ -n "$SCP_HOST" ]; then
        PROTOCOL=ssh
        HOST="$SCP_HOST"
      fi
      ;;
    esac
  fi

  # SSH connection user, e.g. "git" in "git@github-work:owner/repo.git" --
  # left EMPTY when the URL/alias doesn't specify one. Never defaulted to
  # "git" here: OpenSSH itself determines the effective user for a
  # user-less target (its own default, or a config-driven `User`
  # directive, possibly `Match user`-sensitive) exactly the way the real
  # push transport would, and canonicalizing against an invented "git"
  # would ask `ssh -G` a DIFFERENT question than the one the actual push
  # answers whenever that resolution is user-sensitive. See
  # verify_github_account's own empty-user handling, and
  # docs/SHIELD_MODE.md's "SSH user must never be invented" section.
  SSH_USER=$(printf '%s' "$REMOTE_URL" | sed -nE 's#^(ssh://)?([^@/:]+)@.*#\2#p')

  # Explicit port, e.g. `ssh://git@github-work:2222/owner/repo.git`. Only
  # the `ssh://` URL form can carry one -- in the scp-like `host:path`
  # shape everything after the colon is the PATH, never a port (that is
  # Git's own rule, and mirroring it is what keeps this parse consistent
  # with where the push actually goes). Captured so the account
  # verification probe can travel the same host:port route the push would
  # (Phase 8); an unparseable/absent port simply means "whatever this
  # alias's effective config says", which is also what git would use.
  URL_PORT=""
  # Keyed off the ANCHORED scheme detected above, not a `ssh://*` glob, so
  # this can never fire for a string that merely contains "ssh://".
  if [ "$URL_SCHEME" = "ssh" ]; then
    # A bracketed IPv6 literal host ("[2001:db8::1]") contains colons
    # itself, so the ordinary "[^/:]+" host pattern below stops at the
    # FIRST one and the whole match fails -- e.g.
    # "ssh://git@[2001:db8::1]:2222/acme/repo.git" silently extracted NO
    # port at all (found by port regression G, this suite's own corpus
    # differential, after the enable/repair port-canonicalization fix made
    # this extraction matter for MORE than the account-verification probe).
    # Handled the same way the HOST case statement above already handles
    # it: match the bracketed host explicitly first.
    case "$REMOTE_URL" in
      [sS][sS][hH]://*'@['*']:'[0-9]*|[sS][sS][hH]://'['*']:'[0-9]*)
        URL_PORT=$(printf '%s' "$REMOTE_URL" | sed -nE 's#^[sS][sS][hH]://([^/@]*@)?\[[^]]*\]:([0-9]+)(/.*)?$#\2#p')
        ;;
      *)
        URL_PORT=$(printf '%s' "$REMOTE_URL" | sed -nE 's#^[sS][sS][hH]://([^/@]*@)?[^/:]+:([0-9]+)(/.*)?$#\2#p')
        ;;
    esac
  fi

  IS_GENERIC=0
  case "$(lower "$HOST")" in
    github.com|gitlab.com|bitbucket.org) IS_GENERIC=1 ;;
  esac

  # ---- SSH transport overrides, computed BEFORE the route check below.
  # An SSH command override can redirect the connection regardless of
  # what the URL's host claims -- check this BEFORE trusting any alias,
  # since a "trusted" alias (and a live `ssh -T` probe through it) prove
  # nothing once the program that actually speaks SSH for this push might
  # not be the one ~/.ssh/config implies. None of these inspect key material, touch SSH
  # config, or make a network call -- they only check whether an override
  # is present.
  SSH_OVERRIDES=""
  [ -n "${GIT_SSH:-}" ] && SSH_OVERRIDES="GIT_SSH"
  [ -n "${GIT_SSH_COMMAND:-}" ] && SSH_OVERRIDES="${SSH_OVERRIDES:+$SSH_OVERRIDES, }GIT_SSH_COMMAND"
  CORE_SSH_COMMAND=$(git config --get core.sshCommand 2>/dev/null || true)
  [ -n "$CORE_SSH_COMMAND" ] && SSH_OVERRIDES="${SSH_OVERRIDES:+$SSH_OVERRIDES, }core.sshCommand"

  # Phase 9 / Part 3 finding: `ssh.variant` (and its GIT_SSH_VARIANT
  # environment form) changes HOW git invokes the ssh transport even when
  # NO command override is set at all -- so a route could diverge from what
  # the account probe checks with none of the three checks above noticing.
  #
  # Empirically confirmed against git 2.43.0, with a fake `ssh` on PATH and
  # no GIT_SSH/GIT_SSH_COMMAND/core.sshCommand set anywhere:
  #
  #   (default)                      ssh -o SendEnv=GIT_PROTOCOL git@host git-upload-pack '/o/r.git'
  #   -c ssh.variant=plink           ssh                          git@host git-upload-pack '/o/r.git'
  #   -c ssh.variant=simple          ssh                          git@host git-upload-pack '/o/r.git'
  #   GIT_SSH_VARIANT=tortoiseplink  ssh -batch                   git@host git-upload-pack '/o/r.git'
  #
  # i.e. git is driving that program under PuTTY/plink/"simple" argument
  # conventions, not OpenSSH's. The verification probe below is
  # unconditionally OpenSSH syntax (`ssh -G`, `-o BatchMode=yes`,
  # `-o StrictHostKeyChecking=yes`, `-p <port>`; plink spells the port
  # `-P` and has no `-G` at all). Under a non-OpenSSH variant the probe
  # therefore cannot be shown to reproduce the transport the push will use
  # -- and an unprovable route must read as UNVERIFIED and block for a
  # lock that expects a GitHub login, never be assumed equivalent.
  #
  # Only a genuinely non-OpenSSH variant counts: "auto" is git's default
  # and "ssh" explicitly asserts OpenSSH semantics, which is exactly what
  # the probe assumes, so neither is an override. GIT_SSH_VARIANT wins over
  # ssh.variant (git's own precedence), so the EFFECTIVE value is what is
  # judged -- `ssh.variant=plink` cancelled by `GIT_SSH_VARIANT=ssh` is not
  # a divergence and must not be blocked as one.
  #
  # Both forms are visible here: GIT_SSH_VARIANT is inherited by the hook,
  # and `git config --get ssh.variant` sees command-scoped `git -c
  # ssh.variant=...` too, because git propagates it through
  # GIT_CONFIG_PARAMETERS (empirically verified from inside a real hook).
  EFFECTIVE_SSH_VARIANT="${GIT_SSH_VARIANT:-}"
  SSH_VARIANT_SOURCE=GIT_SSH_VARIANT
  if [ -z "$EFFECTIVE_SSH_VARIANT" ]; then
    EFFECTIVE_SSH_VARIANT=$(git config --get ssh.variant 2>/dev/null || true)
    SSH_VARIANT_SOURCE=ssh.variant
  fi
  case "$(lower "$EFFECTIVE_SSH_VARIANT")" in
    ""|auto|ssh) ;;
    *) SSH_OVERRIDES="${SSH_OVERRIDES:+$SSH_OVERRIDES, }$SSH_VARIANT_SOURCE=$EFFECTIVE_SSH_VARIANT" ;;
  esac

  # ---- route: can this push carry account evidence at all? ----
  #
  # Only an SSH push, with no transport override, through one of the
  # identity's explicitly trusted aliases (never a generic shared host
  # such as github.com) can be bound to a specific GitHub account. Every
  # other route is unprovable, and an unprovable push identity is blocked
  # for a lock that expects a GitHub login -- never assumed correct.
  TRUSTED_ALIASES_DISPLAY=$(policy_array .trustedSshHostAliases | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')
  if [ -z "$TRUSTED_ALIASES_DISPLAY" ]; then
    # A login with no trusted alias at all: no route can ever be verified,
    # so EVERY push is blocked until one is added -- say so plainly
    # instead of suggesting the user pick from an empty list.
    ROUTE_FIX="\"$IDENTITY_LABEL\" lists no trusted SSH host alias, so no push route can be verified as \"$EXPECTED_GH_LOGIN\" --
every push from this repository is blocked until one is configured.

What to do: add a Host entry for the $EXPECTED_GH_LOGIN key to ~/.ssh/config (pointing at github.com,
with \"IdentitiesOnly yes\"), list that alias in the trusted SSH host aliases (trustedSshHostAliases) of
\"$IDENTITY_LABEL\" in Repo Identity Guard and run \"Repair Identity Lock\", then point the remote at
git@<alias>:<owner>/<repo>.git and retry the push."
  else
    ROUTE_FIX="What to do: push over SSH through one of the identity's trusted SSH host aliases ($TRUSTED_ALIASES_DISPLAY),
e.g. point the remote at git@<alias>:<owner>/<repo>.git, then retry the push."
  fi

  route_block() {
    # $1 = reason id, $2 = detail code, $3 = specific reason sentence
    push_block "$1" unverified "$2" "This repository is locked to the identity \"$IDENTITY_LABEL\", which must push as the GitHub account \"$EXPECTED_GH_LOGIN\".
$3

$ROUTE_FIX"
  }

  if [ "$PROTOCOL" = "ssh" ] && [ -n "$SSH_OVERRIDES" ]; then
    route_block push-route-override ssh_transport_override "An SSH transport override ($SSH_OVERRIDES) is in effect, so the route this push would actually use cannot be verified -- even though the URL's host (\"$HOST\") might otherwise be trusted. Remove the override for this push."
  elif [ "$PROTOCOL" = "https" ]; then
    route_block push-route-unverified https "This push is over HTTPS. The GitHub account that authenticates it cannot be verified locally."
  elif [ "$PROTOCOL" = "ssh" ] && [ "$IS_GENERIC" = 1 ]; then
    route_block push-route-unverified generic_ssh_host "This push uses the generic SSH host \"$HOST\", which authenticates with whichever key is used by default."
  elif [ "$PROTOCOL" = "ssh" ]; then
    LOWER_HOST=$(lower "$HOST")
    if ! policy_array .trustedSshHostAliases | while IFS= read -r a; do lower "$a"; done | grep -qxF "$LOWER_HOST"; then
      route_block push-route-unverified untrusted_alias "This push uses the SSH host alias \"$HOST\", which the identity does not list as a trusted alias."
    fi
  else
    route_block push-route-unverified unknown_protocol "This push's protocol could not be determined, so the account that would authenticate it cannot be verified."
  fi

  # ---- option-injection guard ----
  # An SSH user or host beginning with "-" would be read by `ssh` as a
  # command-line OPTION (e.g. "-oProxyCommand=..."), not as the
  # destination, by the probe below. Git itself refuses to connect to such
  # a URL, but this evaluator never relies on that: such a route is never
  # handed to ssh. Mirrors routeReasons() in src/shield/evaluator.ts.
  case "$SSH_USER" in
    -*) route_block push-route-unverified malformed "This push's SSH user begins with \"-\", which ssh would read as a command-line option, so the route is never probed." ;;
  esac
  case "$HOST" in
    -*) route_block push-route-unverified malformed "This push's SSH host begins with \"-\", which ssh would read as a command-line option, so the route is never probed." ;;
  esac

  # ---- account: live verification over the exact route ----
  verify_github_account "$HOST" "$SSH_USER" "$EXPECTED_GH_LOGIN" "$URL_PORT"
}

# ==================== run ====================

if [ "$ACTION" = "commit" ]; then
  evaluate_commit
else
  evaluate_push "${2:-}" "${3:-}"
fi

exit 0
