import { InProgressOperation, Issue, Profile, RepoFacts } from "../types";

function identity(name?: string, email?: string): string {
  if (!name && !email) {
    return "Unknown";
  }
  return `${name ?? "Unknown"} <${email ?? "unknown"}>`;
}

export function profileUnknownIssue(): Issue {
  return {
    id: "commit_identity:profile_unknown",
    category: "commit_identity",
    severity: "blocking",
    title: "Repo profile is unknown",
    message:
      "This repo isn't matched to any of your profiles, so we can't check whether commits or pushes will use the right account.",
    whyItMatters:
      "Without a matched profile, Repo Identity Guard has no expected identity to check against — an unverified repo is treated as unsafe.",
    whatWeExpected: "A profile (Work, Personal, etc.) matching this repo's remote owner",
    whatWeFound: "No matching profile",
    suggestedAction: "Add Profile for This Repo",
    suggestedActionCommand: "addProfileForRepo",
    technicalDetails: {
      remoteOwner: undefined,
    },
  };
}

export function overlappingProfilesIssue(facts: RepoFacts, matches: Profile[]): Issue {
  const labels = matches.map((profile) => profile.label).join(", ");
  return {
    id: "commit_identity:profile_overlap",
    category: "commit_identity",
    severity: "blocking",
    title: "Multiple profiles match this repo",
    message: `This repo's remote owner matches more than one of your profiles (${labels}), so we can't tell which identity to expect.`,
    whyItMatters:
      "Ambiguous profile matching means commits could use the wrong identity for either profile — treated as unsafe until the overlap is fixed.",
    whatWeExpected: "Exactly one profile matching this repo's remote owner",
    whatWeFound: `${labels} all match "${facts.remoteOwner ?? "this repo's owner"}"`,
    suggestedAction: "Open Settings",
    suggestedActionCommand: "openSettings",
    technicalDetails: {
      remoteOwner: facts.remoteOwner,
      matchingProfileIds: matches.map((profile) => profile.id),
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
export function wrongCommitIdentityIssue(
  facts: RepoFacts,
  profile: Profile,
  mismatch: IdentityMismatch,
): Issue {
  const found: string[] = [];
  if (mismatch.author) {
    found.push(`Author: ${identity(facts.effectiveGitName, facts.effectiveGitEmail)}`);
  }
  if (mismatch.committer) {
    found.push(`Committer: ${identity(facts.effectiveCommitterName, facts.effectiveCommitterEmail)}`);
  }

  return {
    id: "commit_identity:wrong",
    category: "commit_identity",
    severity: "blocking",
    title: "Wrong commit identity",
    message: `Commits in this repo may be authored with the wrong identity instead of ${profile.label}.`,
    whyItMatters:
      "Commits with the wrong name or email can leak personal info into a work repo, or vice versa, and can't be un-pushed easily. This reflects Git's effective author/committer identity in the environment checked, including any environment-variable overrides — a command can still override it explicitly.",
    whatWeExpected: `${profile.label} identity: ${identity(profile.gitName, profile.gitEmail)}`,
    whatWeFound: found.join(" · ") || identity(facts.effectiveGitName, facts.effectiveGitEmail),
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

export function identityNotLockedIssue(facts: RepoFacts, profile: Profile): Issue {
  return {
    id: "commit_identity:not_locked",
    category: "commit_identity",
    severity: "warning",
    title: `Repo is not locked to ${profile.label} identity`,
    message:
      "The identity currently used here is correct, but only because of your global Git config. That can change without warning.",
    whyItMatters:
      "If your global Git config ever changes (new machine, new default, another profile), this repo would silently start using the wrong identity.",
    whatWeExpected: `${profile.label} identity set locally in this repo`,
    whatWeFound: "Identity set only globally, not locally",
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

/** The push destination couldn't be resolved at all — ambiguous, so always blocking regardless of profile strictness. */
export function pushDestinationUnresolvedIssue(profile: Profile): Issue {
  return {
    id: "push_setup:destination_unresolved",
    category: "push_setup",
    severity: "blocking",
    title: "Push destination is not verified",
    message: "We couldn't work out where a plain `git push` would actually send commits from this branch.",
    whyItMatters:
      "With no resolvable remote, a push could fail, go somewhere unintended, or require a destination to be chosen on the spot — none of which is safe to assume for an AI agent.",
    whatWeExpected: `A push destination resolvable to ${profile.label}`,
    whatWeFound: "No configured pushRemote, pushDefault, branch remote, or origin",
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
  };
}

/** The push destination resolved to a real remote, but its owner doesn't match the matched profile at all. */
export function pushDestinationMismatchIssue(facts: RepoFacts, profile: Profile): Issue {
  return {
    id: "push_setup:destination_mismatch",
    category: "push_setup",
    severity: "blocking",
    title: `Push destination does not match ${profile.label}`,
    message: `A plain \`git push\` from this branch would go to ${facts.pushRemoteOwner ?? "an owner"}, not ${profile.label}.`,
    whyItMatters:
      "This can happen when a branch's push remote points somewhere other than the repo's origin (e.g. an upstream fork) — pushing would land in the wrong place.",
    whatWeExpected: `Push destination owned by ${profile.label}`,
    whatWeFound: `Push remote "${facts.pushRemoteName ?? "unknown"}" → ${facts.pushRemoteOwner ?? "unknown owner"}`,
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
    technicalDetails: {
      pushRemoteName: facts.pushRemoteName,
      pushRemoteUrl: facts.pushRemoteUrl,
      originRemoteUrl: facts.originRemoteUrl,
    },
  };
}

/**
 * Push destination is confirmed correct, but we still can't say *which
 * account* will authenticate the push (HTTPS credential helper, or SSH with
 * no dedicated host alias). This is deliberately never phrased as verifying
 * the account — only the destination is confirmed.
 */
export function pushAccountUnverifiedIssue(facts: RepoFacts, profile: Profile, blocking: boolean): Issue {
  const isHttps = facts.pushRemoteProtocol === "https";
  return {
    id: isHttps ? "push_setup:account_unverified_https" : "push_setup:account_unverified_ssh",
    category: "push_setup",
    severity: blocking ? "blocking" : "warning",
    title: "Push account is unverified",
    message: isHttps
      ? "This repo pushes over HTTPS. We can't tell which account your credential manager will actually authenticate with."
      : "This repo's push remote uses a generic SSH host, so it authenticates with whichever SSH key is used by default — not necessarily the right account.",
    whyItMatters: isHttps
      ? "Your credential manager could be signed into a different account than the one this repo expects, so a push could go out under the wrong name."
      : "A generic SSH host doesn't guarantee that the account behind your default SSH key matches this repo's expected profile.",
    whatWeExpected: `An account trusted from your ${profile.label} profile configuration`,
    whatWeFound: isHttps
      ? `HTTPS remote (${facts.pushRemoteHost ?? "unknown host"})`
      : `SSH remote using generic host: ${facts.pushRemoteHost ?? "unknown"}`,
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

export function detachedHeadIssue(): Issue {
  return {
    id: "branch_safety:detached_head",
    category: "branch_safety",
    severity: "blocking",
    title: "Working in detached HEAD",
    message: "You're not on a branch. New commits here can be lost once you switch branches.",
    whyItMatters: "Commits made in detached HEAD aren't tracked by any branch and are easy to lose.",
    whatWeExpected: "Checked out on a named branch",
    whatWeFound: "Detached HEAD",
    suggestedAction: "Check out a branch",
  };
}

export function protectedBranchIssue(branch: string): Issue {
  return {
    id: "branch_safety:protected_branch",
    category: "branch_safety",
    severity: "blocking",
    title: `Working directly on ${branch}`,
    message: `You're committing directly on ${branch}, which your local branch policy treats as protected.`,
    whyItMatters:
      "Commits made directly on a protected branch skip review and can break things for everyone. Repo Identity Guard treats this branch as protected locally — it does not check or sync with GitHub's own branch protection settings.",
    whatWeExpected: "A feature branch",
    whatWeFound: `Current branch: ${branch}`,
    suggestedAction: "Switch to a feature branch",
  };
}

export function branchPatternMismatchIssue(branch: string, profile: Profile): Issue {
  return {
    id: "branch_safety:pattern_mismatch",
    category: "branch_safety",
    severity: "warning",
    title: "Branch does not match repo rules",
    message: `${profile.label} expects branch names like ${(profile.expectedBranchPatterns ?? []).join(", ")}.`,
    whyItMatters: "Branch naming rules help keep automation and teammates from getting confused about intent.",
    whatWeExpected: (profile.expectedBranchPatterns ?? []).join(", "),
    whatWeFound: branch,
    suggestedAction: "Rename or switch branch",
  };
}

const OPERATION_LABEL: Record<InProgressOperation, string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
};

export function inProgressOperationIssue(operation: InProgressOperation): Issue {
  const label = OPERATION_LABEL[operation];
  return {
    id: "agent_guard:operation_in_progress",
    category: "agent_guard",
    severity: "blocking",
    title: `A ${label} is in progress`,
    message: `This repo has an unfinished ${label}. Committing, pushing, or running other Git commands now can make it worse.`,
    whyItMatters: `An AI agent that doesn't recognize an in-progress ${label} could commit half-resolved changes or abandon it mid-way.`,
    whatWeExpected: "No unfinished Git operation",
    whatWeFound: `${label} in progress`,
    suggestedAction: `Finish or abort the ${label} first`,
  };
}

export function mergeConflictsIssue(): Issue {
  return {
    id: "agent_guard:merge_conflicts",
    category: "agent_guard",
    severity: "blocking",
    title: "Unresolved merge conflicts",
    message: "This repo has unresolved conflict markers. Committing now could bake broken code into history.",
    whyItMatters: "An agent that commits over unresolved conflicts can silently corrupt the merge result.",
    whatWeExpected: "No unresolved conflicts",
    whatWeFound: "Conflicted files present",
    suggestedAction: "Resolve conflicts first",
  };
}

/**
 * Ordinary staged/unstaged/untracked changes are normal during development —
 * this is a restriction/warning, not a blocker, so the tool isn't
 * permanently red the moment you start editing.
 */
export function uncommittedChangesIssue(): Issue {
  return {
    id: "agent_guard:uncommitted_changes",
    category: "agent_guard",
    severity: "warning",
    title: "Uncommitted changes present",
    message: "This repo has uncommitted changes.",
    whyItMatters: "An AI agent should preserve existing work here — not reset, stash, or broadly rewrite it.",
    whatWeExpected: "Agent should preserve existing changes",
    whatWeFound: "Staged, unstaged, or untracked changes present",
    suggestedAction: "Review Details",
    suggestedActionCommand: "reviewDetails",
  };
}

export function untrustedWorkspaceIssue(): Issue {
  return {
    id: "agent_guard:workspace_untrusted",
    category: "agent_guard",
    severity: "blocking",
    title: "Workspace is not trusted",
    message: "VS Code Workspace Trust is off for this folder, so running commands or changing Git identity here is blocked.",
    whyItMatters: "Workspace Trust exists specifically to stop untrusted code from running automatically.",
    whatWeExpected: "A trusted workspace",
    whatWeFound: "Untrusted workspace",
    suggestedAction: "Enable Workspace Trust",
    suggestedActionCommand: "enableWorkspaceTrust",
  };
}

export function agentNotSafeIssue(): Issue {
  return {
    id: "agent_guard:not_safe",
    category: "agent_guard",
    severity: "blocking",
    title: "Not safe for AI agent",
    message: "Fix the issues above before letting an AI coding agent commit, push, or run commands here.",
    whyItMatters: "An AI agent will inherit whatever identity, push setup, branch, and repo state you're currently in.",
    suggestedAction: "Review Details",
    suggestedActionCommand: "reviewDetails",
  };
}

/**
 * Shield Mode (local Git hooks) is not implemented yet. This is a static,
 * always-shown info note — never gated behind a settings toggle a user
 * could mistake for something that's actually protecting them.
 */
export function shieldModeComingSoonIssue(): Issue {
  return {
    id: "agent_guard:shield_mode_coming_soon",
    category: "agent_guard",
    severity: "info",
    title: "Shield Mode is not built yet",
    message: "Optional local Git hooks that would block unsafe commits/pushes don't exist yet — nothing is enforcing this automatically.",
    whyItMatters: "This is informational only. No hooks are installed, and none will be installed without explicit action later.",
  };
}

export function noPinnedMemoryIssue(): Issue {
  return {
    id: "repo_memory:no_pin",
    category: "repo_memory",
    severity: "info",
    title: "No pinned repo memory",
    message: "Pin a note so important context, like \"Do not push directly to main\", isn't lost.",
    suggestedAction: "Open Repo Memory",
    suggestedActionCommand: "openRepoMemory",
  };
}
