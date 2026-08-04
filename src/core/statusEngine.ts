import {
  Issue,
  Profile,
  RepoFacts,
  SafetyPreferences,
  StatusSummary,
} from "../types";
import { branchMatchesAnyPattern, findMatchingProfiles, wildcardMatch } from "./profileResolver";
import {
  agentNotSafeIssue,
  branchPatternMismatchIssue,
  detachedHeadIssue,
  identityNotLockedIssue,
  inProgressOperationIssue,
  mergeConflictsIssue,
  noPinnedMemoryIssue,
  overlappingProfilesIssue,
  profileUnknownIssue,
  protectedBranchIssue,
  pushAccountUnverifiedIssue,
  pushDestinationMismatchIssue,
  pushDestinationUnresolvedIssue,
  shieldModeComingSoonIssue,
  uncommittedChangesIssue,
  untrustedWorkspaceIssue,
  wrongCommitIdentityIssue,
} from "./issueFactory";

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
      issues: [],
      issueCount: 0,
      facts,
    };
  }

  const matches = findMatchingProfiles(facts, input.profiles);
  const matchedProfile = matches.length === 1 ? matches[0] : undefined;
  const issues: Issue[] = [];

  if (matches.length > 1) {
    issues.push(overlappingProfilesIssue(facts, matches));
  } else if (!matchedProfile) {
    issues.push(profileUnknownIssue());
  } else {
    issues.push(...checkCommitIdentity(facts, matchedProfile, input.preferences));
    issues.push(...checkPushSetup(facts, matchedProfile));
    issues.push(...checkBranchSafety(facts, matchedProfile, input.protectedBranches));
  }

  // Repo operation state and workspace trust apply regardless of which (or whether a) profile matched.
  issues.push(...checkRepoOperationState(facts));
  if (input.isWorkspaceTrusted === false) {
    issues.push(untrustedWorkspaceIssue());
  }

  const hasBlockingIssue = issues.some((issue) => issue.severity === "blocking");

  if (hasBlockingIssue) {
    issues.push(agentNotSafeIssue());
  } else {
    issues.push(shieldModeComingSoonIssue());
  }

  if (!input.pinnedMemoryNote) {
    issues.push(noPinnedMemoryIssue());
  }

  const level = issues.some((issue) => issue.severity === "blocking")
    ? "not_safe"
    : "safe";

  const nextFix =
    issues.find((issue) => issue.severity === "blocking") ??
    issues.find((issue) => issue.severity === "warning");

  return {
    level,
    repoName: facts.repoName,
    matchedProfile,
    issues,
    issueCount: issues.filter((issue) => issue.severity !== "info").length,
    nextFix,
    pinnedMemoryPreview: input.pinnedMemoryNote,
    facts,
  };
}

function checkCommitIdentity(
  facts: RepoFacts,
  profile: Profile,
  preferences: SafetyPreferences,
): Issue[] {
  const nameMatches = (name?: string) =>
    !profile.gitName || name?.trim().toLocaleLowerCase() === profile.gitName.trim().toLocaleLowerCase();
  const emailMatches = (email?: string) =>
    email?.trim().toLocaleLowerCase() === profile.gitEmail.trim().toLocaleLowerCase();

  const authorMismatch = !nameMatches(facts.effectiveGitName) || !emailMatches(facts.effectiveGitEmail);
  const committerMismatch =
    !nameMatches(facts.effectiveCommitterName) || !emailMatches(facts.effectiveCommitterEmail);

  if (authorMismatch || committerMismatch) {
    return [wrongCommitIdentityIssue(facts, profile, { author: authorMismatch, committer: committerMismatch })];
  }

  if (preferences.requireLocalIdentity) {
    const localNameMatches = nameMatches(facts.localGitName);
    const localEmailMatches = emailMatches(facts.localGitEmail);

    if (!localNameMatches || !localEmailMatches) {
      return [identityNotLockedIssue(facts, profile)];
    }
  }

  return [];
}

/**
 * Push safety is two separate questions: does a plain `git push` even land
 * in the right place (destination), and can we tell which account
 * authenticates it (account)? Ambiguous destination resolution is always
 * blocking, regardless of a profile's strictness — that's not a judgment
 * call the way HTTPS-vs-SSH-alias is.
 */
function checkPushSetup(facts: RepoFacts, profile: Profile): Issue[] {
  if (!facts.pushRemoteUrl) {
    return [pushDestinationUnresolvedIssue(profile)];
  }

  const expectedOwners = profile.expectedRemoteOwners ?? [];
  const destinationMatches =
    expectedOwners.length === 0 ||
    (facts.pushRemoteOwner
      ? expectedOwners.some((pattern) => wildcardMatch(facts.pushRemoteOwner as string, pattern))
      : false);

  if (!destinationMatches) {
    return [pushDestinationMismatchIssue(facts, profile)];
  }

  const strict = !!profile.strictPushSetup;
  const host = facts.pushRemoteHost?.toLocaleLowerCase();

  if (facts.pushRemoteProtocol === "https" || facts.pushRemoteProtocol === "unknown") {
    return [pushAccountUnverifiedIssue(facts, profile, strict)];
  }

  if (facts.pushRemoteProtocol === "ssh" && host && GENERIC_REMOTE_HOSTS.has(host)) {
    return [pushAccountUnverifiedIssue(facts, profile, strict)];
  }

  return [];
}

function checkBranchSafety(
  facts: RepoFacts,
  profile: Profile,
  protectedBranches: string[],
): Issue[] {
  if (facts.isDetachedHead) {
    return [detachedHeadIssue()];
  }

  const branch = facts.currentBranch;
  if (!branch) {
    return [];
  }

  const isProtected = protectedBranches.some(
    (candidate) => candidate.trim().toLocaleLowerCase() === branch.trim().toLocaleLowerCase(),
  );
  if (isProtected) {
    return [protectedBranchIssue(branch)];
  }

  const patterns = profile.expectedBranchPatterns ?? [];
  if (patterns.length > 0 && !branchMatchesAnyPattern(branch, patterns)) {
    return [branchPatternMismatchIssue(branch, profile)];
  }

  return [];
}

/**
 * Conflicts and an unfinished merge/rebase/cherry-pick/revert block — an
 * agent operating on top of those can corrupt the repo. Ordinary dirty-tree
 * changes (staged/unstaged/untracked, nothing conflicted) are only a
 * warning: that's normal mid-development state, not a safety issue by
 * itself, so it must not keep the tool permanently red.
 */
function checkRepoOperationState(facts: RepoFacts): Issue[] {
  if (facts.inProgressOperation) {
    return [inProgressOperationIssue(facts.inProgressOperation)];
  }

  if (facts.hasMergeConflicts) {
    return [mergeConflictsIssue()];
  }

  if (facts.hasUncommittedChanges) {
    return [uncommittedChangesIssue()];
  }

  return [];
}
