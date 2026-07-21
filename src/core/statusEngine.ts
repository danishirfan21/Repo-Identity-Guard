import {
  Issue,
  Profile,
  RepoFacts,
  SafetyPreferences,
  StatusSummary,
} from "../types";
import { branchMatchesAnyPattern, resolveProfile } from "./profileResolver";
import {
  agentGuardOffIssue,
  agentNotSafeIssue,
  branchPatternMismatchIssue,
  detachedHeadIssue,
  identityNotLockedIssue,
  noPinnedMemoryIssue,
  noRemoteIssue,
  profileUnknownIssue,
  protectedBranchIssue,
  pushSetupGenericSshIssue,
  pushSetupHttpsIssue,
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

  const matchedProfile = resolveProfile(facts, input.profiles);
  const issues: Issue[] = [];

  if (!matchedProfile) {
    issues.push(profileUnknownIssue());
  } else {
    issues.push(...checkCommitIdentity(facts, matchedProfile, input.preferences));
    issues.push(...checkPushSetup(facts, matchedProfile));
    issues.push(...checkBranchSafety(facts, matchedProfile, input.protectedBranches));
  }

  const hasBlockingIssue = issues.some((issue) => issue.severity === "blocking");

  if (hasBlockingIssue) {
    issues.push(agentNotSafeIssue());
  } else if (!input.preferences.agentGuardEnabled) {
    issues.push(agentGuardOffIssue());
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
  const nameMatches =
    !profile.gitName ||
    facts.effectiveGitName?.trim().toLocaleLowerCase() ===
      profile.gitName.trim().toLocaleLowerCase();
  const emailMatches =
    facts.effectiveGitEmail?.trim().toLocaleLowerCase() ===
    profile.gitEmail.trim().toLocaleLowerCase();

  if (!nameMatches || !emailMatches) {
    return [wrongCommitIdentityIssue(facts, profile)];
  }

  if (preferences.requireLocalIdentity) {
    const localNameMatches =
      !profile.gitName ||
      facts.localGitName?.trim().toLocaleLowerCase() ===
        profile.gitName.trim().toLocaleLowerCase();
    const localEmailMatches =
      facts.localGitEmail?.trim().toLocaleLowerCase() ===
      profile.gitEmail.trim().toLocaleLowerCase();

    if (!localNameMatches || !localEmailMatches) {
      return [identityNotLockedIssue(facts, profile)];
    }
  }

  return [];
}

function checkPushSetup(facts: RepoFacts, profile: Profile): Issue[] {
  if (!facts.originRemoteUrl) {
    return [noRemoteIssue(profile)];
  }

  const strict = !!profile.strictPushSetup;
  const host = facts.remoteHost?.toLocaleLowerCase();

  if (facts.remoteProtocol === "https") {
    return [pushSetupHttpsIssue(facts, profile, strict)];
  }

  if (facts.remoteProtocol === "ssh" && host && GENERIC_REMOTE_HOSTS.has(host)) {
    return [pushSetupGenericSshIssue(facts, profile, strict)];
  }

  if (facts.remoteProtocol === "unknown") {
    return [pushSetupHttpsIssue(facts, profile, strict)];
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
