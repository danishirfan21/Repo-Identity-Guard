import { ForkConflict } from "./profileResolver";
import {
  AgentRestriction,
  CapabilityResult,
  InProgressOperation,
  InfoNote,
  Profile,
  RepoFacts,
} from "../types";

function identity(name?: string, email?: string): string {
  if (!name && !email) {
    return "Unknown";
  }
  return `${name ?? "Unknown"} <${email ?? "unknown"}>`;
}

// ---- Agent restrictions: derived per-finding, not a parallel rule system ----

const NO_COMMIT: AgentRestriction = {
  id: "no-commit",
  description: "Don't commit until this is resolved.",
};
const NO_BRANCH_SWITCH: AgentRestriction = {
  id: "no-branch-switch",
  description: "Don't switch branches right now.",
};
const ASK_BEFORE_BRANCH_CHANGE: AgentRestriction = {
  id: "ask-before-branch-change",
  description: "Ask before committing here or changing branch.",
};
const PRESERVE_CHANGES: AgentRestriction = {
  id: "preserve-changes",
  description: "Preserve existing changes — don't reset, stash, or discard them.",
};
const NO_AGENT_OPERATION: AgentRestriction = {
  id: "no-agent-operation",
  description: "Don't run commands or make changes until the workspace is trusted.",
};

// ==================== commit_identity ====================

export function profileUnknownResult(): CapabilityResult {
  return {
    id: "commit_identity:profile_unknown",
    capability: "commit_identity",
    state: "unverified",
    title: "Repo profile is unknown",
    summary:
      "This repo isn't matched to any of your profiles, so we can't check whether commits or pushes will use the right account.",
    whyItMatters:
      "Without a matched profile, Repo Identity Guard has no expected identity to check against — an unverified repo is treated as unsafe.",
    whatWeExpected: "A profile (Work, Personal, etc.) matching this repo's remote owner",
    whatWeFound: "No matching profile",
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT],
    suggestedAction: "Add Profile for This Repo",
    suggestedActionCommand: "addProfileForRepo",
  };
}

export function overlappingProfilesResult(facts: RepoFacts, matches: Profile[]): CapabilityResult {
  const labels = matches.map((profile) => profile.label).join(", ");
  return {
    id: "commit_identity:profile_overlap",
    capability: "commit_identity",
    state: "contradicted",
    title: "Multiple profiles match this repo",
    summary: `This repo's remote owner matches more than one of your profiles (${labels}), so we can't tell which identity to expect.`,
    whyItMatters:
      "Ambiguous profile matching means commits could use the wrong identity for either profile — treated as unsafe until the overlap is fixed.",
    whatWeExpected: "Exactly one profile matching this repo's remote owner",
    whatWeFound: `${labels} all match "${facts.remoteOwner ?? "this repo's owner"}"`,
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT],
    suggestedAction: "Open Settings",
    suggestedActionCommand: "openSettings",
    technicalDetails: {
      remoteOwner: facts.remoteOwner,
      matchingProfileIds: matches.map((profile) => profile.id),
    },
  };
}

export function forkConflictResult(facts: RepoFacts, conflict: ForkConflict): CapabilityResult {
  return {
    id: "commit_identity:fork_conflict",
    capability: "commit_identity",
    state: "contradicted",
    title: "Origin and upstream imply different profiles",
    summary: `This repo's origin remote suggests ${conflict.originProfile.label}, but its upstream remote suggests ${conflict.upstreamProfile.label} — likely a fork. We won't guess which one applies.`,
    whyItMatters:
      "A personal fork of a company repo (or vice versa) can silently use the wrong identity if the tool just assumes origin is authoritative. Upstream is treated as evidence of a conflict, never as an automatic tiebreaker.",
    whatWeExpected: "Origin and upstream to imply the same profile, or an exact-repo override resolving which one applies",
    whatWeFound: `origin → ${conflict.originProfile.label}, upstream → ${conflict.upstreamProfile.label}`,
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT],
    suggestedAction: "Assign This Repo",
    suggestedActionCommand: "resolveProfileConflict",
    technicalDetails: {
      originRemoteUrl: facts.originRemoteUrl,
      remoteOwner: facts.remoteOwner,
      upstreamRemoteUrl: facts.upstreamRemoteUrl,
      upstreamOwner: facts.upstreamOwner,
    },
  };
}

export interface IdentityMismatch {
  author: boolean;
  committer: boolean;
}

/**
 * "What we found" is built from Git's *effective* author/committer identity
 * (`git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`), which accounts for
 * environment overrides — not just `git config user.name/email`. Author and
 * committer can diverge (e.g. during a rebase), so both are checked and
 * named individually when they disagree.
 */
export function commitIdentityWrongResult(
  facts: RepoFacts,
  profile: Profile,
  mismatch: IdentityMismatch,
): CapabilityResult {
  const found: string[] = [];
  if (mismatch.author) {
    found.push(`Author: ${identity(facts.effectiveGitName, facts.effectiveGitEmail)}`);
  }
  if (mismatch.committer) {
    found.push(`Committer: ${identity(facts.effectiveCommitterName, facts.effectiveCommitterEmail)}`);
  }

  return {
    id: "commit_identity:wrong",
    capability: "commit_identity",
    state: "contradicted",
    title: "Wrong commit identity",
    summary: `Commits in this repo may be authored with the wrong identity instead of ${profile.label}.`,
    whyItMatters:
      "Commits with the wrong name or email can leak personal info into a work repo, or vice versa, and can't be un-pushed easily. This reflects Git's effective author/committer identity in the environment checked, including any environment-variable overrides — a command can still override it explicitly.",
    whatWeExpected: `${profile.label} identity: ${identity(profile.gitName, profile.gitEmail)}`,
    whatWeFound: found.join(" · ") || identity(facts.effectiveGitName, facts.effectiveGitEmail),
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT],
    suggestedAction: "Fix Commit Identity",
    suggestedActionCommand: "fixCommitIdentity",
    technicalDetails: {
      effectiveAuthorName: facts.effectiveGitName,
      effectiveAuthorEmail: facts.effectiveGitEmail,
      effectiveCommitterName: facts.effectiveCommitterName,
      effectiveCommitterEmail: facts.effectiveCommitterEmail,
      localGitName: facts.localGitName,
      localGitEmail: facts.localGitEmail,
      globalGitName: facts.globalGitName,
      globalGitEmail: facts.globalGitEmail,
    },
  };
}

export function commitIdentityNotLockedResult(facts: RepoFacts, profile: Profile): CapabilityResult {
  return {
    id: "commit_identity:not_locked",
    capability: "commit_identity",
    state: "warning",
    title: `Repo is not locked to ${profile.label} identity`,
    summary:
      "The identity currently used here is correct, but only because of your global Git config. That can change without warning.",
    whyItMatters:
      "If your global Git config ever changes (new machine, new default, another profile), this repo would silently start using the wrong identity.",
    whatWeExpected: `${profile.label} identity set locally in this repo`,
    whatWeFound: "Identity set only globally, not locally",
    blocksOverallSafety: false,
    suggestedAction: "Fix Commit Identity",
    suggestedActionCommand: "fixCommitIdentity",
    technicalDetails: {
      localGitName: facts.localGitName,
      localGitEmail: facts.localGitEmail,
      globalGitName: facts.globalGitName,
      globalGitEmail: facts.globalGitEmail,
    },
  };
}

export function commitIdentityConfirmedResult(profile: Profile): CapabilityResult {
  return {
    id: "commit_identity:confirmed",
    capability: "commit_identity",
    state: "confirmed",
    title: "Commit identity confirmed",
    summary: `Commits will be authored and committed as ${profile.label} (${identity(profile.gitName, profile.gitEmail)}).`,
    blocksOverallSafety: false,
  };
}

// ==================== push_destination ====================

/** The push destination couldn't be resolved at all — ambiguous, so always blocking regardless of profile strictness. */
export function pushDestinationUnresolvedResult(profile: Profile): CapabilityResult {
  return {
    id: "push_destination:unresolved",
    capability: "push_destination",
    state: "unverified",
    title: "Push destination is not verified",
    summary: "We couldn't work out where a plain `git push` would actually send commits from this branch.",
    whyItMatters:
      "With no resolvable remote, a push could fail, go somewhere unintended, or require a destination to be chosen on the spot — none of which is safe to assume for an AI agent.",
    whatWeExpected: `A push destination resolvable to ${profile.label}`,
    whatWeFound: "No configured pushRemote, pushDefault, branch remote, or origin",
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT],
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
  };
}

/** The push destination resolved to a real remote, but its owner doesn't match the matched profile at all. */
export function pushDestinationMismatchResult(facts: RepoFacts, profile: Profile): CapabilityResult {
  return {
    id: "push_destination:mismatch",
    capability: "push_destination",
    state: "contradicted",
    title: `Push destination does not match ${profile.label}`,
    summary: `A plain \`git push\` from this branch would go to ${facts.pushRemoteOwner ?? "an owner"}, not ${profile.label}.`,
    whyItMatters:
      "This can happen when a branch's push remote points somewhere other than the repo's origin (e.g. an upstream fork) — pushing would land in the wrong place.",
    whatWeExpected: `Push destination owned by ${profile.label}`,
    whatWeFound: `Push remote "${facts.pushRemoteName ?? "unknown"}" → ${facts.pushRemoteOwner ?? "unknown owner"}`,
    blocksOverallSafety: true,
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
    technicalDetails: {
      pushRemoteName: facts.pushRemoteName,
      pushRemoteUrl: facts.pushRemoteUrl,
      originRemoteUrl: facts.originRemoteUrl,
    },
  };
}

export function pushDestinationConfirmedResult(facts: RepoFacts, profile: Profile): CapabilityResult {
  return {
    id: "push_destination:confirmed",
    capability: "push_destination",
    state: "confirmed",
    title: "Push destination confirmed",
    summary: `A plain \`git push\` goes to ${facts.pushRemoteOwner ?? "this repo's owner"}, matching ${profile.label}.`,
    blocksOverallSafety: false,
  };
}

export function pushDestinationNotApplicableResult(): CapabilityResult {
  return {
    id: "push_destination:not_applicable",
    capability: "push_destination",
    state: "not_applicable",
    title: "Push destination",
    summary: "Can't be checked until a profile is resolved for this repo.",
    blocksOverallSafety: false,
  };
}

// ==================== push_account ====================

/**
 * Push destination is confirmed correct, but we still can't say *which
 * account* will authenticate the push (HTTPS credential helper, or SSH with
 * no dedicated host alias). This is deliberately never phrased as verifying
 * the account — only ever "unverified," regardless of whether it blocks.
 */
export function pushAccountUnverifiedResult(facts: RepoFacts, profile: Profile, blocking: boolean): CapabilityResult {
  const isHttps = facts.pushRemoteProtocol === "https";
  return {
    id: isHttps ? "push_account:unverified_https" : "push_account:unverified_ssh",
    capability: "push_account",
    state: "unverified",
    title: "Push account is unverified",
    summary: isHttps
      ? "This repo pushes over HTTPS. We can't tell which account your credential manager will actually authenticate with."
      : "This repo's push remote uses a generic SSH host, so it authenticates with whichever SSH key is used by default — not necessarily the right account.",
    whyItMatters: isHttps
      ? "Your credential manager could be signed into a different account than the one this repo expects, so a push could go out under the wrong name."
      : "A generic SSH host doesn't guarantee that the account behind your default SSH key matches this repo's expected profile.",
    whatWeExpected: `An account trusted from your ${profile.label} profile configuration`,
    whatWeFound: isHttps
      ? `HTTPS remote (${facts.pushRemoteHost ?? "unknown host"})`
      : `SSH remote using generic host: ${facts.pushRemoteHost ?? "unknown"}`,
    blocksOverallSafety: blocking,
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
    technicalDetails: {
      pushRemoteName: facts.pushRemoteName,
      pushRemoteUrl: facts.pushRemoteUrl,
      pushRemoteProtocol: facts.pushRemoteProtocol,
      pushRemoteHost: facts.pushRemoteHost,
    },
  };
}

export function pushAccountConfirmedResult(facts: RepoFacts, profile: Profile): CapabilityResult {
  return {
    id: "push_account:confirmed",
    capability: "push_account",
    state: "confirmed",
    title: "Push account trusted",
    summary: `Dedicated SSH host alias (${facts.pushRemoteHost ?? "unknown"}) — trusted from your ${profile.label} profile configuration, not cryptographically verified.`,
    blocksOverallSafety: false,
  };
}

export function pushAccountNotApplicableResult(): CapabilityResult {
  return {
    id: "push_account:not_applicable",
    capability: "push_account",
    state: "not_applicable",
    title: "Push account",
    summary: "Can't be checked until a push destination is resolved.",
    blocksOverallSafety: false,
  };
}

// ==================== branch_policy ====================

export function branchPolicyDetachedHeadResult(): CapabilityResult {
  return {
    id: "branch_policy:detached_head",
    capability: "branch_policy",
    state: "contradicted",
    title: "Working in detached HEAD",
    summary: "You're not on a branch. New commits here can be lost once you switch branches.",
    whyItMatters: "Commits made in detached HEAD aren't tracked by any branch and are easy to lose.",
    whatWeExpected: "Checked out on a named branch",
    whatWeFound: "Detached HEAD",
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT, NO_BRANCH_SWITCH],
    suggestedAction: "Check out a branch",
  };
}

export function branchPolicyProtectedResult(branch: string): CapabilityResult {
  return {
    id: "branch_policy:protected_branch",
    capability: "branch_policy",
    state: "contradicted",
    title: `Working directly on ${branch}`,
    summary: `You're committing directly on ${branch}, which your local branch policy treats as protected.`,
    whyItMatters:
      "Commits made directly on a protected branch skip review and can break things for everyone. Repo Identity Guard treats this branch as protected locally — it does not check or sync with GitHub's own branch protection settings.",
    whatWeExpected: "A feature branch",
    whatWeFound: `Current branch: ${branch}`,
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT, ASK_BEFORE_BRANCH_CHANGE],
    suggestedAction: "Switch to a feature branch",
  };
}

export function branchPolicyPatternMismatchResult(branch: string, profile: Profile): CapabilityResult {
  return {
    id: "branch_policy:pattern_mismatch",
    capability: "branch_policy",
    state: "warning",
    title: "Branch does not match repo rules",
    summary: `${profile.label} expects branch names like ${(profile.expectedBranchPatterns ?? []).join(", ")}.`,
    whyItMatters: "Branch naming rules help keep automation and teammates from getting confused about intent.",
    whatWeExpected: (profile.expectedBranchPatterns ?? []).join(", "),
    whatWeFound: branch,
    blocksOverallSafety: false,
    suggestedAction: "Rename or switch branch",
  };
}

export function branchPolicyConfirmedResult(branch: string): CapabilityResult {
  return {
    id: "branch_policy:confirmed",
    capability: "branch_policy",
    state: "confirmed",
    title: "Branch policy confirmed",
    summary: `Currently on \`${branch}\`, which is allowed.`,
    blocksOverallSafety: false,
  };
}

export function branchPolicyNotApplicableResult(): CapabilityResult {
  return {
    id: "branch_policy:not_applicable",
    capability: "branch_policy",
    state: "not_applicable",
    title: "Branch policy",
    summary: "Can't be checked until a profile is resolved for this repo.",
    blocksOverallSafety: false,
  };
}

// ==================== repo_operation_state ====================

const OPERATION_LABEL: Record<InProgressOperation, string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
};

export function repoOperationInProgressResult(operation: InProgressOperation): CapabilityResult {
  const label = OPERATION_LABEL[operation];
  return {
    id: "repo_operation_state:in_progress",
    capability: "repo_operation_state",
    state: "contradicted",
    title: `A ${label} is in progress`,
    summary: `This repo has an unfinished ${label}. Committing, pushing, or running other Git commands now can make it worse.`,
    whyItMatters: `An AI agent that doesn't recognize an in-progress ${label} could commit half-resolved changes or abandon it mid-way.`,
    whatWeExpected: "No unfinished Git operation",
    whatWeFound: `${label} in progress`,
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT, NO_BRANCH_SWITCH],
    suggestedAction: `Finish or abort the ${label} first`,
  };
}

export function repoOperationConflictsResult(): CapabilityResult {
  return {
    id: "repo_operation_state:conflicts",
    capability: "repo_operation_state",
    state: "contradicted",
    title: "Unresolved merge conflicts",
    summary: "This repo has unresolved conflict markers. Committing now could bake broken code into history.",
    whyItMatters: "An agent that commits over unresolved conflicts can silently corrupt the merge result.",
    whatWeExpected: "No unresolved conflicts",
    whatWeFound: "Conflicted files present",
    blocksOverallSafety: true,
    agentRestrictions: [NO_COMMIT],
    suggestedAction: "Resolve conflicts first",
  };
}

/**
 * Ordinary staged/unstaged/untracked changes are normal during development —
 * this is a warning, not a blocker, so the tool isn't permanently red the
 * moment you start editing.
 */
export function repoOperationDirtyResult(): CapabilityResult {
  return {
    id: "repo_operation_state:dirty",
    capability: "repo_operation_state",
    state: "warning",
    title: "Uncommitted changes present",
    summary: "This repo has uncommitted changes.",
    whyItMatters: "An AI agent should preserve existing work here — not reset, stash, or broadly rewrite it.",
    whatWeExpected: "Agent should preserve existing changes",
    whatWeFound: "Staged, unstaged, or untracked changes present",
    blocksOverallSafety: false,
    agentRestrictions: [PRESERVE_CHANGES],
    suggestedAction: "Review Details",
    suggestedActionCommand: "reviewDetails",
  };
}

export function repoOperationCleanResult(): CapabilityResult {
  return {
    id: "repo_operation_state:clean",
    capability: "repo_operation_state",
    state: "confirmed",
    title: "Working tree is clean",
    summary: "No uncommitted changes, conflicts, or in-progress Git operations.",
    blocksOverallSafety: false,
  };
}

export function repoInspectionFailedResult(gitError: string): CapabilityResult {
  return {
    id: "repo_operation_state:inspection_failed",
    capability: "repo_operation_state",
    state: "unverified",
    title: "Could not fully inspect this repository",
    summary: "A Git command failed while checking this repo, so its safety can't be confirmed.",
    whyItMatters: "Working tree state, branch, and identity may all be stale or missing — treating this as safe would be a guess.",
    whatWeExpected: "All read-only Git checks to succeed",
    whatWeFound: gitError,
    blocksOverallSafety: true,
    technicalDetails: { gitError },
    suggestedAction: "Review Details",
    suggestedActionCommand: "reviewDetails",
  };
}

// ==================== workspace_trust ====================

export function workspaceUntrustedResult(): CapabilityResult {
  return {
    id: "workspace_trust:untrusted",
    capability: "workspace_trust",
    state: "contradicted",
    title: "Workspace is not trusted",
    summary: "VS Code Workspace Trust is off for this folder, so running commands or changing Git identity here is blocked.",
    whyItMatters: "Workspace Trust exists specifically to stop untrusted code from running automatically.",
    whatWeExpected: "A trusted workspace",
    whatWeFound: "Untrusted workspace",
    blocksOverallSafety: true,
    agentRestrictions: [NO_AGENT_OPERATION],
    suggestedAction: "Enable Workspace Trust",
    suggestedActionCommand: "enableWorkspaceTrust",
  };
}

export function workspaceTrustedResult(): CapabilityResult {
  return {
    id: "workspace_trust:confirmed",
    capability: "workspace_trust",
    state: "confirmed",
    title: "Workspace is trusted",
    summary: "VS Code Workspace Trust is on for this folder.",
    blocksOverallSafety: false,
  };
}

// ==================== info notes (not safety capabilities) ====================

export function noPinnedMemoryNote(): InfoNote {
  return {
    id: "repo_memory:no_pin",
    category: "repo_memory",
    title: "No pinned repo memory",
    message: "Pin a note so important context, like \"Do not push directly to main\", isn't lost.",
    suggestedAction: "Open Repo Memory",
    suggestedActionCommand: "openRepoMemory",
  };
}

/**
 * Shield Mode (local Git hooks) is not implemented yet. This is a static,
 * always-shown info note — feature-availability metadata, not a safety
 * verdict, and never gated behind a settings toggle a user could mistake
 * for something that's actually protecting them.
 */
export function shieldModeComingSoonNote(): InfoNote {
  return {
    id: "agent_guard:shield_mode_coming_soon",
    category: "agent_guard_meta",
    title: "Shield Mode is not built yet",
    message: "Optional local Git hooks that would block unsafe commits/pushes don't exist yet — nothing is enforcing this automatically.",
  };
}
