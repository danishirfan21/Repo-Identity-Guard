import {
  CapabilityResult,
  InfoNote,
  Profile,
  RepoFacts,
  SafetyLevel,
  SafetyPreferences,
  StatusSummary,
} from "../types";
import { branchMatchesAnyPattern, canonicalRepoKey, resolveProfiles, wildcardMatch } from "./profileResolver";
import {
  IdentityMismatch,
  branchPolicyConfirmedResult,
  branchPolicyDetachedHeadResult,
  branchPolicyNotApplicableResult,
  branchPolicyPatternMismatchResult,
  branchPolicyProtectedResult,
  commitIdentityConfirmedResult,
  commitIdentityEnvironmentOverrideResult,
  commitIdentityNotLockedResult,
  commitIdentityWrongResult,
  forkConflictResult,
  noPinnedMemoryNote,
  overlappingProfilesResult,
  profileUnknownResult,
  pushAccountNotApplicableResult,
  pushAccountTrustedRouteResult,
  pushAccountUnverifiedResult,
  pushDestinationConfirmedResult,
  pushDestinationMismatchResult,
  pushDestinationNotApplicableResult,
  pushDestinationUnresolvedResult,
  repoInspectionFailedResult,
  repoOperationCleanResult,
  repoOperationConflictsResult,
  repoOperationDirtyResult,
  repoOperationInProgressResult,
  workspaceTrustedResult,
  workspaceUntrustedResult,
} from "./capabilityFactory";

/** SSH/HTTPS hosts shared by many accounts — can't tell which account will authenticate. */
const GENERIC_REMOTE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

export interface StatusEngineInput {
  facts: RepoFacts;
  profiles: Profile[];
  protectedBranches: string[];
  preferences: SafetyPreferences;
  pinnedMemoryNote?: string;
  /** Defaults to trusted (VS Code's own default for local folders) when omitted. */
  isWorkspaceTrusted?: boolean;
}

export function computeStatus(input: StatusEngineInput): StatusSummary {
  const { facts } = input;

  if (!facts.isGitRepo) {
    return {
      level: "not_checked",
      capabilityResults: [],
      infoNotes: [],
      issueCount: 0,
      facts,
    };
  }

  const resolution = resolveProfiles(facts, input.profiles);
  const matchedProfile = resolution.matches.length === 1 ? resolution.matches[0] : undefined;

  // Every capability produces exactly one result per scan — never zero, never
  // more than one — so Review Details always shows a complete checklist,
  // not just a list of problems.
  const capabilityResults: CapabilityResult[] = [
    checkCommitIdentity(facts, resolution, input.preferences),
    checkPushDestination(facts, matchedProfile),
    checkPushAccount(facts, matchedProfile),
    checkBranchPolicy(facts, matchedProfile, input.protectedBranches),
    checkRepoOperationState(facts),
    checkWorkspaceTrust(input.isWorkspaceTrusted),
  ];

  const infoNotes: InfoNote[] = [];
  if (!input.pinnedMemoryNote) {
    infoNotes.push(noPinnedMemoryNote());
  }

  const level: SafetyLevel = capabilityResults.some((result) => result.blocksOverallSafety)
    ? "not_safe"
    : "safe";

  const nextFix =
    capabilityResults.find((result) => result.blocksOverallSafety) ??
    capabilityResults.find((result) => result.state === "warning");

  const issueCount = capabilityResults.filter(
    (result) => result.state !== "confirmed" && result.state !== "not_applicable",
  ).length;

  return {
    level,
    repoName: facts.repoName,
    matchedProfile,
    capabilityResults,
    infoNotes,
    issueCount,
    nextFix,
    pinnedMemoryPreview: input.pinnedMemoryNote,
    facts,
  };
}

function checkCommitIdentity(
  facts: RepoFacts,
  resolution: ReturnType<typeof resolveProfiles>,
  preferences: SafetyPreferences,
): CapabilityResult {
  if (resolution.matches.length > 1) {
    return overlappingProfilesResult(facts, resolution.matches);
  }
  if (resolution.forkConflict) {
    return forkConflictResult(facts, resolution.forkConflict);
  }

  const profile = resolution.matches[0];
  if (!profile) {
    return profileUnknownResult();
  }

  const nameMatches = (name?: string) =>
    !profile.gitName || name?.trim().toLocaleLowerCase() === profile.gitName.trim().toLocaleLowerCase();
  const emailMatches = (email?: string) =>
    email?.trim().toLocaleLowerCase() === profile.gitEmail.trim().toLocaleLowerCase();

  const authorMismatch = !nameMatches(facts.effectiveGitName) || !emailMatches(facts.effectiveGitEmail);
  const committerMismatch =
    !nameMatches(facts.effectiveCommitterName) || !emailMatches(facts.effectiveCommitterEmail);

  if (authorMismatch || committerMismatch) {
    const mismatch: IdentityMismatch = { author: authorMismatch, committer: committerMismatch };

    // If the *configured* identity (worktree/local/global config, no
    // environment involved) already matches the profile, the effective
    // mismatch can only be an environment variable or command-line
    // override winning over config — writing config again would not fix
    // it, so this must not be reported as the ordinary config-fixable case.
    const configuredName = facts.worktreeGitName ?? facts.localGitName ?? facts.globalGitName;
    const configuredEmail = facts.worktreeGitEmail ?? facts.localGitEmail ?? facts.globalGitEmail;
    if (nameMatches(configuredName) && emailMatches(configuredEmail)) {
      return commitIdentityEnvironmentOverrideResult(facts, profile, mismatch);
    }

    return commitIdentityWrongResult(facts, profile, mismatch);
  }

  if (preferences.requireLocalIdentity) {
    // An explicit non-global override can live in either scope — Fix
    // Commit Identity writes `--worktree` instead of `--local` when
    // `extensions.worktreeConfig` is on (see `resolveIdentityConfigScope`).
    // Checking `localGitName`/`localGitEmail` alone would keep reporting
    // "not locked" even after a successful worktree-scoped fix.
    const scopedName = facts.worktreeGitName ?? facts.localGitName;
    const scopedEmail = facts.worktreeGitEmail ?? facts.localGitEmail;
    const scopedNameMatches = nameMatches(scopedName);
    const scopedEmailMatches = emailMatches(scopedEmail);

    if (!scopedNameMatches || !scopedEmailMatches) {
      return commitIdentityNotLockedResult(facts, profile);
    }
  }

  return commitIdentityConfirmedResult(profile);
}

/**
 * Does a plain `git push` even land in the right place? Ambiguous or
 * mismatched destination resolution is always blocking, regardless of a
 * profile's strictness — that's not a judgment call the way HTTPS-vs-SSH-
 * alias (push *account*) is.
 */
function checkPushDestination(facts: RepoFacts, profile: Profile | undefined): CapabilityResult {
  if (!profile) {
    return pushDestinationNotApplicableResult();
  }
  if (!facts.pushRemoteUrl) {
    return pushDestinationUnresolvedResult(profile);
  }

  const pushKey = canonicalRepoKey(facts.pushRemoteHost, facts.pushRemoteOwner, facts.pushRemoteRepo);
  const exactRepoPatterns = profile.exactRepos ?? [];
  const expectedOwners = profile.expectedRemoteOwners ?? [];

  // ==================== the one destination rule ====================
  //
  // Phase 8 finding. The previous rule was
  //
  //   matchesExactRepo || expectedOwners.length === 0 || ownerPatternMatches
  //
  // whose middle term is an unconditional `true` for any profile that
  // lists `exactRepos` but no `expectedRemoteOwners` — so such a profile
  // reported "destination confirmed" for LITERALLY ANY push destination,
  // including one whose repository is not among its exact repos and whose
  // owner is a complete stranger. Empirically reproduced (see
  // statusEngine.test.ts, "a profile that lists exactRepos but no owner
  // patterns…"). It also read a destination whose owner could not be
  // parsed at all as confirmed, on the same path.
  //
  // The rule now, stated once and shared by the sidebar and Shield:
  //
  //  1. A profile that declares NO destination constraint at all (neither
  //     `exactRepos` nor `expectedRemoteOwners`) makes no claim about
  //     where pushes may go, so any resolvable destination is confirmed.
  //     This is the only "everything passes" case, and it now requires
  //     the profile to actually be unconstrained rather than merely to
  //     have left one of the two lists empty.
  //  2. Otherwise the destination must positively satisfy at least one
  //     declared constraint: its canonical `host/owner/repo` key matches
  //     an `exactRepos` pattern, OR its owner matches an
  //     `expectedRemoteOwners` pattern. Owner-level matching is retained
  //     deliberately — a fork, a mirror, or a new repository under an
  //     owner the profile already trusts is a legitimate destination, and
  //     requiring an exact repo listing for those would make the feature
  //     unusable — but it is now a *positive* match, never a default.
  //  3. Missing evidence is never a match. An unparseable owner cannot
  //     satisfy an owner pattern, and an unparseable owner/repo cannot
  //     produce a canonical key to satisfy an exact-repo pattern; a
  //     constrained profile therefore reports mismatch rather than
  //     confirming a destination it could not identify.
  //
  // How this stays consistent with Shield rather than contradicting it:
  // this check answers "is this destination within the PROFILE's declared
  // scope?", while Shield's `push-destination-mismatch` answers the
  // strictly narrower "is this the exact owner/repo that was approved
  // when Shield was enabled or repaired?". Shield's approved destination
  // is always a single concrete owner/repo drawn from the push remote, so
  // anything Shield allows this check also allows; the reverse is not
  // true, and when they diverge (the repo moved within a trusted owner)
  // Shield reports `pushDestinationDrift` and asks for an explicit
  // Repair. Neither ever calls a destination the other rejects "safe".
  const declaresConstraint = exactRepoPatterns.length > 0 || expectedOwners.length > 0;
  const matchesExactRepo = !!pushKey && exactRepoPatterns.some((pattern) => wildcardMatch(pushKey, pattern));
  const matchesOwnerPattern =
    !!facts.pushRemoteOwner && expectedOwners.some((pattern) => wildcardMatch(facts.pushRemoteOwner as string, pattern));

  const destinationMatches = !declaresConstraint || matchesExactRepo || matchesOwnerPattern;
  if (!destinationMatches) {
    return pushDestinationMismatchResult(facts, profile);
  }

  return pushDestinationConfirmedResult(facts, profile);
}

/**
 * Can we tell *which account* authenticates the push? Evaluated
 * independently of the destination match outcome.
 *
 * A non-generic SSH host alias is a *push route*, not a verified account —
 * and it is never trusted just because its name looks dedicated. It's only
 * ever trusted when the matched profile explicitly lists it in
 * `trustedSshHostAliases`; anything else (HTTPS, an unrecognized protocol,
 * a well-known generic host, or an alias the profile hasn't listed) reads
 * as unverified. This is the fix for the pre-Shield-Mode weakness where any
 * non-generic SSH host was auto-trusted, which would have let, e.g., a
 * `github-personal` alias read as trusted under a Work profile.
 */
function checkPushAccount(facts: RepoFacts, profile: Profile | undefined): CapabilityResult {
  if (!profile || !facts.pushRemoteUrl) {
    return pushAccountNotApplicableResult();
  }

  const strict = !!profile.strictPushSetup;
  const host = facts.pushRemoteHost?.toLocaleLowerCase();

  if (facts.pushRemoteProtocol === "https") {
    return pushAccountUnverifiedResult(facts, profile, strict, "https");
  }
  if (facts.pushRemoteProtocol === "unknown") {
    return pushAccountUnverifiedResult(facts, profile, strict, "unknown_protocol");
  }
  if (host && GENERIC_REMOTE_HOSTS.has(host)) {
    return pushAccountUnverifiedResult(facts, profile, strict, "generic_ssh_host");
  }

  const trustedAliases = (profile.trustedSshHostAliases ?? []).map((alias) => alias.toLocaleLowerCase());
  if (host && trustedAliases.includes(host)) {
    return pushAccountTrustedRouteResult(facts, profile);
  }

  return pushAccountUnverifiedResult(facts, profile, strict, "untrusted_alias");
}

function checkBranchPolicy(
  facts: RepoFacts,
  profile: Profile | undefined,
  protectedBranches: string[],
): CapabilityResult {
  if (facts.isDetachedHead) {
    return branchPolicyDetachedHeadResult();
  }
  if (!profile) {
    return branchPolicyNotApplicableResult();
  }

  const branch = facts.currentBranch;
  if (!branch) {
    return branchPolicyNotApplicableResult();
  }

  const isProtected = protectedBranches.some(
    (candidate) => candidate.trim().toLocaleLowerCase() === branch.trim().toLocaleLowerCase(),
  );
  if (isProtected) {
    return branchPolicyProtectedResult(branch);
  }

  const patterns = profile.expectedBranchPatterns ?? [];
  if (patterns.length > 0 && !branchMatchesAnyPattern(branch, patterns)) {
    return branchPolicyPatternMismatchResult(branch, profile);
  }

  return branchPolicyConfirmedResult(branch);
}

/**
 * Conflicts and an unfinished merge/rebase/cherry-pick/revert block — an
 * agent operating on top of those can corrupt the repo. Ordinary dirty-tree
 * changes (staged/unstaged/untracked, nothing conflicted) are only a
 * warning: that's normal mid-development state, not a safety issue by
 * itself, so it must not keep the tool permanently red.
 */
function checkRepoOperationState(facts: RepoFacts): CapabilityResult {
  if (facts.gitError) {
    return repoInspectionFailedResult(facts.gitError);
  }
  if (facts.inProgressOperation) {
    return repoOperationInProgressResult(facts.inProgressOperation);
  }
  if (facts.hasMergeConflicts) {
    return repoOperationConflictsResult();
  }
  if (facts.hasUncommittedChanges) {
    return repoOperationDirtyResult();
  }
  return repoOperationCleanResult();
}

function checkWorkspaceTrust(isWorkspaceTrusted: boolean | undefined): CapabilityResult {
  if (isWorkspaceTrusted === false) {
    return workspaceUntrustedResult();
  }
  return workspaceTrustedResult();
}
