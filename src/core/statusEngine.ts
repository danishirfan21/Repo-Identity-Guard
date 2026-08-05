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
  commitIdentityNotLockedResult,
  commitIdentityWrongResult,
  forkConflictResult,
  noPinnedMemoryNote,
  overlappingProfilesResult,
  profileUnknownResult,
  pushAccountConfirmedResult,
  pushAccountNotApplicableResult,
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
  shieldModeComingSoonNote,
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
  infoNotes.push(shieldModeComingSoonNote());

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
  const matchesExactRepo = !!pushKey && exactRepoPatterns.some((pattern) => wildcardMatch(pushKey, pattern));

  const expectedOwners = profile.expectedRemoteOwners ?? [];
  const matchesOwnerPattern =
    expectedOwners.length === 0 ||
    (facts.pushRemoteOwner
      ? expectedOwners.some((pattern) => wildcardMatch(facts.pushRemoteOwner as string, pattern))
      : false);

  const destinationMatches = matchesExactRepo || matchesOwnerPattern;
  if (!destinationMatches) {
    return pushDestinationMismatchResult(facts, profile);
  }

  return pushDestinationConfirmedResult(facts, profile);
}

/** Can we tell *which account* authenticates the push? Evaluated independently of the destination match outcome. */
function checkPushAccount(facts: RepoFacts, profile: Profile | undefined): CapabilityResult {
  if (!profile || !facts.pushRemoteUrl) {
    return pushAccountNotApplicableResult();
  }

  const strict = !!profile.strictPushSetup;
  const host = facts.pushRemoteHost?.toLocaleLowerCase();

  if (facts.pushRemoteProtocol === "https" || facts.pushRemoteProtocol === "unknown") {
    return pushAccountUnverifiedResult(facts, profile, strict);
  }
  if (facts.pushRemoteProtocol === "ssh" && host && GENERIC_REMOTE_HOSTS.has(host)) {
    return pushAccountUnverifiedResult(facts, profile, strict);
  }

  return pushAccountConfirmedResult(facts, profile);
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
