import { parseRemoteUrl } from "../services/gitService";
import { InProgressOperation } from "../types";
import { GitHubAccountVerificationOutcome } from "./githubSshVerification";
import { ShieldPolicy, ShieldPolicyValidationResult } from "./policy";
import {
  ShieldAction,
  ShieldDecision,
  ShieldReason,
  decisionFromReasons,
} from "./types";

/**
 * Pure reference implementation of Shield's decision logic.
 *
 * This is the **spec**, not the shipped hook runtime — the actual artifact
 * a future Git hook invokes is `resources/shield/shield-evaluate.sh` (POSIX
 * shell + `git` only, no Node), per the "evaluator must be standalone and
 * must not assume Node/Python/jq/gh" requirement in docs/SHIELD_MODE.md.
 * This module exists so the decision semantics can be:
 *
 *  - unit tested exhaustively and fast, without spawning a shell/subprocess
 *    per case;
 *  - cross-checked against the shell script's actual behavior in
 *    `shieldEvaluatorCrossCheck.test.ts`, so the two never silently drift
 *    apart;
 *  - reviewed as one readable, typed source of truth for what Shield
 *    blocks and why.
 *
 * It deliberately does **not** call `computeStatus` — that function mixes
 * in VS Code-specific concepts (Workspace Trust) and predicts a plain push
 * from `RepoFacts.pushRemoteUrl` rather than evaluating the actual
 * pre-push action's real remote/URL. Reusing it here would silently pull
 * both problems into Shield. Instead this reuses only the specific pure
 * helpers that are actually still correct for hook-time evaluation
 * (`parseRemoteUrl`), and re-implements the rest against a narrower,
 * action-time fact shape that has no VS Code concepts in it at all.
 */

/** SSH/HTTPS hosts shared by many accounts — mirrors statusEngine.ts's GENERIC_REMOTE_HOSTS exactly; kept in sync by shieldEvaluatorCrossCheck.test.ts. */
const GENERIC_REMOTE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

// ==================== commit ====================

export interface CommitEvalFacts {
  /** Set only when Git inspection itself failed (e.g. a `git` command errored unexpectedly). When set, this is the only reason produced — nothing else can be trusted. */
  inspectionError?: string;

  effectiveAuthorName?: string;
  effectiveAuthorEmail?: string;
  effectiveCommitterName?: string;
  effectiveCommitterEmail?: string;

  /** `git config --worktree` ?? `--local` ?? `--global`, read fresh at action time — never a value cached from an earlier VS Code scan. */
  configuredName?: string;
  configuredEmail?: string;

  isDetachedHead: boolean;
  /** Undefined exactly when `isDetachedHead` is true. */
  currentBranch?: string;

  inProgressOperation?: InProgressOperation;
  hasMergeConflicts: boolean;
}

function identityReasons(policy: ShieldPolicy, facts: CommitEvalFacts): ShieldReason[] {
  const nameMatches = (name?: string) =>
    !policy.expectedGitName || normalize(name) === normalize(policy.expectedGitName);
  const emailMatches = (email?: string) => normalize(email) === normalize(policy.expectedGitEmail);

  const authorMismatch = !nameMatches(facts.effectiveAuthorName) || !emailMatches(facts.effectiveAuthorEmail);
  const committerMismatch =
    !nameMatches(facts.effectiveCommitterName) || !emailMatches(facts.effectiveCommitterEmail);

  if (!authorMismatch && !committerMismatch) {
    return [];
  }

  const who: string[] = [];
  if (authorMismatch) who.push(`author (${facts.effectiveAuthorName ?? "unknown"} <${facts.effectiveAuthorEmail ?? "unknown"}>)`);
  if (committerMismatch) who.push(`committer (${facts.effectiveCommitterName ?? "unknown"} <${facts.effectiveCommitterEmail ?? "unknown"}>)`);

  // Same distinction as commitIdentityWrongResult vs.
  // commitIdentityEnvironmentOverrideResult in capabilityFactory.ts: if
  // the *configured* identity already matches, an environment variable or
  // explicit --author/-c override is what's actually wrong, and writing
  // config again would not fix it.
  const configuredMatches = nameMatches(facts.configuredName) && emailMatches(facts.configuredEmail);

  if (configuredMatches) {
    return [
      {
        id: "commit-identity-override",
        message: `Git config for this repo is already set to ${policy.profileLabel}, but the effective identity for this commit's ${who.join(" and ")} is overridden by the environment or an explicit command-line option.`,
        capability: "commit_identity",
      },
    ];
  }

  return [
    {
      id: "commit-identity-mismatch",
      message: `This commit's ${who.join(" and ")} does not match the ${policy.profileLabel} profile (expected ${policy.expectedGitEmail}).`,
      capability: "commit_identity",
    },
  ];
}

function branchReasons(policy: ShieldPolicy, facts: CommitEvalFacts): ShieldReason[] {
  if (facts.isDetachedHead) {
    return [
      {
        id: "detached-head",
        message: "HEAD is detached. Commits made here aren't tracked by any branch and are easy to lose.",
        capability: "branch_policy",
      },
    ];
  }

  const branch = facts.currentBranch;
  if (!branch) {
    return [];
  }

  const isProtected = policy.protectedBranches.some((candidate) => normalize(candidate) === normalize(branch));
  if (isProtected) {
    return [
      {
        id: "protected-branch",
        message: `"${branch}" is locally protected. Commit directly on it is not allowed by this policy.`,
        capability: "branch_policy",
      },
    ];
  }

  // Branch-pattern mismatch is intentionally NOT evaluated here: it's a
  // non-blocking warning in the main safety engine
  // (branchPolicyPatternMismatchResult), and Shield must not silently
  // upgrade that into a hard block.
  return [];
}

function repoStateReasons(facts: CommitEvalFacts): ShieldReason[] {
  const reasons: ShieldReason[] = [];
  if (facts.inProgressOperation) {
    reasons.push({
      id: "repo-operation-in-progress",
      message: `A ${facts.inProgressOperation} is already in progress. Committing now could interfere with it.`,
      capability: "repo_operation_state",
    });
  }
  if (facts.hasMergeConflicts) {
    reasons.push({
      id: "merge-conflicts",
      message: "There are unresolved merge conflicts in the working tree.",
      capability: "repo_operation_state",
    });
  }
  // Ordinary uncommitted changes alone (no conflicts, no in-progress
  // operation) are deliberately never a reason here — matches
  // repoOperationDirtyResult being a non-blocking warning in the main
  // engine.
  return reasons;
}

export function evaluateCommit(policy: ShieldPolicy, facts: CommitEvalFacts, now: number = Date.now()): ShieldDecision {
  if (!policy.enabledActions.includes("commit")) {
    return decisionFromReasons("commit", [], now);
  }
  if (facts.inspectionError) {
    return decisionFromReasons(
      "commit",
      [{ id: "inspection-failed", message: `Git state could not be read: ${facts.inspectionError}` }],
      now,
    );
  }

  const reasons = [
    ...identityReasons(policy, facts),
    ...branchReasons(policy, facts),
    ...repoStateReasons(facts),
  ];
  return decisionFromReasons("commit", reasons, now);
}

// ==================== push ====================

export interface PushEvalFacts {
  /** As passed to a real `pre-push` hook's argv: the remote's name (e.g. "origin") and its literal URL/location, resolved fresh at push time — never `RepoFacts.pushRemoteUrl` predicted by an earlier scan. */
  remoteName: string;
  remoteUrl: string;
  /**
   * Raw `<local-ref> <local-sha1> <remote-ref> <remote-sha1>` lines as Git
   * feeds a real `pre-push` hook on stdin. Accepted now so this interface
   * matches the real hook contract from day one; per-ref inspection is
   * intentionally not implemented in this phase (destination/route
   * evaluation doesn't need it) — see docs/SHIELD_MODE.md "Push
   * evaluation."
   */
  refLines?: string[];
  /**
   * Non-empty entries among `GIT_SSH`, `GIT_SSH_COMMAND`, and the
   * *effective* `core.sshCommand` config (any scope, including a
   * command-scoped `-c core.sshCommand=...`) visible at push time —
   * whichever of the three were actually set, named for the message; empty
   * when none were. Any of these can redirect an ssh-protocol push through
   * a completely different SSH client/config than the one implied by the
   * URL's host, which is exactly what `trustedSshHostAliases` is trusted
   * evidence for — so their presence makes route trust unverifiable even
   * through an otherwise-trusted alias. Read fresh at push time, never
   * cached: see docs/SHIELD_MODE.md "Phase 4."
   */
  sshCommandOverrides: string[];

  /**
   * The result of Shield Mode Phase 5's live GitHub SSH account check,
   * when one was actually run — set only when the policy has an
   * `expectedGitHubLogin`, the profile is strict, and the route otherwise
   * resolved to a trusted SSH alias with no overrides (any of those
   * absent means verification was never attempted, and this is left
   * undefined; the reasons below then treat "required but never
   * attempted" as unverified, never as silently passing). Computed
   * outside this pure module — see `resources/shield/shield-evaluate.sh`'s
   * `verify_github_account`, which is what actually shells out to `ssh`
   * at hook time; this module only decides what a given outcome means.
   */
  githubAccountCheck?: GitHubAccountVerificationOutcome;
}

/**
 * Destination matching is deliberately OWNER-based, not host-based —
 * mirroring checkPushDestination in statusEngine.ts exactly. A push
 * through a trusted SSH alias (e.g. "github-work") has a literally
 * different hostname than the repo's canonical remote host ("github.com")
 * despite going to the exact same account; comparing hosts here would
 * falsely flag every alias-based push as a destination mismatch, which is
 * precisely the case `trustedSshHostAliases` exists to allow. `host` is
 * still recorded on the policy (useful context, and future exact-repo-key
 * matching), but is never part of this equality check.
 */
function destinationReasons(policy: ShieldPolicy, owner: string | undefined, repo: string | undefined): ShieldReason[] {
  const approved = policy.approvedPushDestination;
  // Fail closed, per docs/SHIELD_MODE.md "Phase 4": if Shield never
  // resolved an approved destination for this repository (e.g. no remote
  // existed when it was last enabled/repaired), there is no way to confirm
  // THIS push is compatible with what was approved — ambiguity is treated
  // as a mismatch, not silently allowed. This also covers a direct
  // `git push <url>` to an ad hoc destination that was never part of any
  // remote Shield had visibility into.
  if (!approved || !approved.owner) {
    return [
      {
        id: "push-destination-mismatch",
        message: `Shield has no approved push destination on file for the ${policy.profileLabel} profile in this repository (none was resolved the last time Shield was enabled or repaired). Refresh Shield after confirming the intended remote before pushing.`,
        capability: "push_destination",
      },
    ];
  }
  const ownerMatches = normalize(approved.owner) === normalize(owner);
  const repoMatches = !approved.repo || !repo || normalize(approved.repo) === normalize(repo);
  if (ownerMatches && repoMatches) {
    return [];
  }
  return [
    {
      id: "push-destination-mismatch",
      message: `Profile: ${policy.profileLabel}\nExpected approved destination: ${approved.host ?? "(unknown host)"}:${approved.owner}${approved.repo ? `/${approved.repo}` : ""}\nReason: Push destination changed since Shield approval (this push would go to ${owner ?? "an unknown owner"}${repo ? `/${repo}` : ""}).`,
      capability: "push_destination",
    },
  ];
}

function routeReasons(
  policy: ShieldPolicy,
  protocol: string,
  host: string | undefined,
  sshCommandOverrides: string[],
): ShieldReason[] {
  const isGenericHost = !!host && GENERIC_REMOTE_HOSTS.has(normalize(host));

  // An SSH command override can redirect the connection regardless of what
  // the URL's host claims, so it must be checked before trusting an alias
  // — a "trusted" alias proves nothing once the program that actually
  // speaks SSH for this push might not be the one `~/.ssh/config` implies.
  if (protocol === "ssh" && sshCommandOverrides.length > 0) {
    return [
      {
        id: "push-route-override",
        message: `An SSH command override (${sshCommandOverrides.join(", ")}) was detected, so the route this push would actually use cannot be verified against the ${policy.profileLabel} profile's trusted SSH host aliases — even though the URL's host ("${host ?? "unknown"}") might otherwise be trusted.`,
        capability: "push_account",
      },
    ];
  }

  const trustedAliases = policy.trustedSshHostAliases.map(normalize);
  const isTrustedAlias = protocol === "ssh" && !!host && !isGenericHost && trustedAliases.includes(normalize(host));

  if (isTrustedAlias) {
    return [];
  }

  const message =
    protocol === "https"
      ? "This push is over HTTPS. The account that authenticates it cannot be verified locally."
      : protocol === "ssh" && isGenericHost
        ? `This push uses the generic SSH host "${host}", which authenticates with whichever key is used by default.`
        : protocol === "ssh"
          ? `This push uses SSH host alias "${host}", which is not listed as trusted by the ${policy.profileLabel} profile.`
          : "This push's protocol could not be determined, so the account that would authenticate it cannot be verified locally.";

  return [{ id: "push-route-unverified", message, capability: "push_account" }];
}

/**
 * Verified GitHub account binding (Phase 5) — goes beyond "this route is a
 * trusted alias" to "this route currently authenticates as the specific
 * GitHub login this profile expects." Only ever consulted when:
 *  - the profile actually set `expectedGitHubLogin` (otherwise Shield
 *    makes no claim about the authenticated account at all — route trust
 *    alone, as in Phase 0-4, is what's being asked for); and
 *  - `isTrustedRoute` is true, i.e. `routeReasons` found nothing wrong —
 *    an untrusted/unverified/overridden route already produces its own
 *    blocking reason, and duplicating that here would just repeat it
 *    under a different id.
 *
 * `facts.githubAccountCheck` being absent here means verification was
 * *required* (the two conditions above held) but never actually ran —
 * this is deliberately treated the same as any other "could not confirm"
 * outcome, never as an implicit pass. Do not invent certainty.
 */
function accountReasons(policy: ShieldPolicy, isTrustedRoute: boolean, facts: PushEvalFacts): ShieldReason[] {
  if (!policy.expectedGitHubLogin || !isTrustedRoute) {
    return [];
  }

  const header = `Profile: ${policy.profileLabel}\nExpected GitHub account: ${policy.expectedGitHubLogin}`;
  const unverified = (reason: string): ShieldReason[] => [
    { id: "push-account-unverified", message: `${header}\nReason: ${reason}`, capability: "push_account" },
  ];

  const check = facts.githubAccountCheck;
  if (!check) {
    return unverified("This push's SSH route was not checked against GitHub before pushing, so the authenticated account is unconfirmed.");
  }

  switch (check.kind) {
    case "authenticated-user":
      if (normalize(check.login) === normalize(policy.expectedGitHubLogin)) {
        return [];
      }
      return [
        {
          id: "push-account-mismatch",
          message: `${header}\nAuthenticated GitHub account: ${check.login}\nReason: The configured SSH route is authenticating as the wrong GitHub account.`,
          capability: "push_account",
        },
      ];
    case "authenticated-deploy-key":
      return unverified(
        `This route authenticated using a deploy-key-style identity ("${check.identity}") rather than a personal GitHub account, so it cannot be confirmed against the expected account.`,
      );
    case "permission-denied":
      return unverified("SSH authentication to GitHub was refused (permission denied), so the account could not be confirmed.");
    case "host-key-unverified":
      return unverified(
        "This SSH host's key is not already trusted in known_hosts, so Shield refused to connect automatically. Verify the host key fingerprint yourself (e.g. run the SSH command once interactively) and accept it before relying on strict account verification.",
      );
    case "timeout":
      return unverified("The SSH connection timed out while verifying the account.");
    case "identities-not-isolated":
      return unverified(
        'This SSH route\'s effective configuration does not set "IdentitiesOnly yes", so ssh-agent could offer a different, unrelated key than the one this route is meant to use — the route cannot be strongly bound to an expected account without it.',
      );
    case "malformed":
      return unverified("SSH's response while verifying the account could not be parsed.");
  }
}

export function evaluatePush(policy: ShieldPolicy, facts: PushEvalFacts, now: number = Date.now()): ShieldDecision {
  if (!policy.enabledActions.includes("push")) {
    return decisionFromReasons("push", [], now);
  }

  const parsed = parseRemoteUrl(facts.remoteUrl);
  const reasons = destinationReasons(policy, parsed.owner, parsed.repo);
  const route = routeReasons(policy, parsed.protocol, parsed.host, facts.sshCommandOverrides);
  // routeReasons returns [] in exactly one case: an ssh protocol, no
  // overrides, host matched against a trusted alias — i.e. an empty
  // result IS "trusted route," not merely "no complaints yet."
  const isTrustedRoute = route.length === 0;

  // An unverified/untrusted route only blocks when the profile is strict —
  // same strictPushSetup semantics as Phase 0's push_account capability.
  // A destination mismatch always blocks, regardless of strictness — it
  // isn't a judgment call the way route trust is. Account verification
  // (Phase 5) is likewise strict-only: expectedGitHubLogin never does
  // anything under a non-strict profile.
  const blockingRoute = policy.strictPushSetup ? route : [];
  const account = policy.strictPushSetup ? accountReasons(policy, isTrustedRoute, facts) : [];

  return decisionFromReasons("push", [...reasons, ...blockingRoute, ...account], now);
}

/**
 * Produces a decision directly from a policy *load* result (missing,
 * invalid, or valid), so a caller (the shell script's TS-equivalent test
 * harness, or a future in-process caller) never has to special-case
 * "there was no policy" separately from "the policy was garbage" — both
 * collapse to a single denial with the appropriate reason, before any
 * Git-state evaluation happens at all.
 */
export function evaluateFromPolicyLoad(
  action: ShieldAction,
  policyLoad: { found: false } | ({ found: true } & ShieldPolicyValidationResult),
  facts: CommitEvalFacts | PushEvalFacts,
  now: number = Date.now(),
): ShieldDecision {
  if (!policyLoad.found) {
    return decisionFromReasons(action, [{ id: "policy-missing", message: "Shield is enabled but no policy file was found." }], now);
  }
  if (!policyLoad.ok) {
    const detail = policyLoad.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    return decisionFromReasons(action, [{ id: "policy-corrupt", message: `Shield's policy file is invalid: ${detail}` }], now);
  }
  return action === "commit"
    ? evaluateCommit(policyLoad.policy, facts as CommitEvalFacts, now)
    : evaluatePush(policyLoad.policy, facts as PushEvalFacts, now);
}
