import { parseRemoteUrl } from "../services/gitService";
import { InProgressOperation } from "../types";
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
  // If policy never recorded an approved destination (e.g. the repo had no
  // resolvable remote when the policy was generated), there is nothing to
  // compare against — deliberately not reported as a mismatch, since that
  // would be guessing. See docs/SHIELD_MODE.md "Push evaluation" for why
  // this is a known, documented gap rather than a silent assumption.
  if (!approved || !approved.owner) {
    return [];
  }
  const ownerMatches = normalize(approved.owner) === normalize(owner);
  const repoMatches = !approved.repo || !repo || normalize(approved.repo) === normalize(repo);
  if (ownerMatches && repoMatches) {
    return [];
  }
  return [
    {
      id: "push-destination-mismatch",
      message: `This push would go to ${owner ?? "an unknown owner"}${repo ? `/${repo}` : ""}, not the approved destination (${approved.owner}${approved.repo ? `/${approved.repo}` : ""}).`,
      capability: "push_destination",
    },
  ];
}

function routeReasons(policy: ShieldPolicy, protocol: string, host: string | undefined): ShieldReason[] {
  const trustedAliases = policy.trustedSshHostAliases.map(normalize);
  const isGenericHost = !!host && GENERIC_REMOTE_HOSTS.has(normalize(host));
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

export function evaluatePush(policy: ShieldPolicy, facts: PushEvalFacts, now: number = Date.now()): ShieldDecision {
  if (!policy.enabledActions.includes("push")) {
    return decisionFromReasons("push", [], now);
  }

  const parsed = parseRemoteUrl(facts.remoteUrl);
  const reasons = destinationReasons(policy, parsed.owner, parsed.repo);
  const route = routeReasons(policy, parsed.protocol, parsed.host);

  // An unverified/untrusted route only blocks when the profile is strict —
  // same strictPushSetup semantics as Phase 0's push_account capability.
  // A destination mismatch always blocks, regardless of strictness — it
  // isn't a judgment call the way route trust is.
  const blockingRoute = policy.strictPushSetup ? route : [];

  return decisionFromReasons("push", [...reasons, ...blockingRoute], now);
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
