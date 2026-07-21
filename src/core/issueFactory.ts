import { Issue, Profile, RepoFacts } from "../types";

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

export function wrongCommitIdentityIssue(facts: RepoFacts, profile: Profile): Issue {
  return {
    id: "commit_identity:wrong",
    category: "commit_identity",
    severity: "blocking",
    title: "Wrong commit identity",
    message: `Commits in this repo may be authored with the wrong identity instead of ${profile.label}.`,
    whyItMatters:
      "Commits with the wrong name or email can leak personal info into a work repo, or vice versa, and can't be un-pushed easily.",
    whatWeExpected: `${profile.label} identity: ${identity(profile.gitName, profile.gitEmail)}`,
    whatWeFound: identity(facts.effectiveGitName, facts.effectiveGitEmail),
    suggestedAction: "Fix Commit Identity",
    suggestedActionCommand: "fixCommitIdentity",
    technicalDetails: {
      effectiveGitName: facts.effectiveGitName,
      effectiveGitEmail: facts.effectiveGitEmail,
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

export function pushSetupHttpsIssue(facts: RepoFacts, profile: Profile, blocking: boolean): Issue {
  return {
    id: "push_setup:https_unverified",
    category: "push_setup",
    severity: blocking ? "blocking" : "warning",
    title: "Push setup is not verified",
    message:
      "This repo pushes over HTTPS. We can't tell which account will actually authenticate when you push.",
    whyItMatters:
      "Your credential manager could be signed into a different account than the one this repo expects, so a push could go out under the wrong name.",
    whatWeExpected: `A push setup clearly locked to ${profile.label}`,
    whatWeFound: `HTTPS remote (${facts.remoteHost ?? "unknown host"})`,
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
    technicalDetails: {
      originRemoteUrl: facts.originRemoteUrl,
      remoteProtocol: facts.remoteProtocol,
      remoteHost: facts.remoteHost,
    },
  };
}

export function pushSetupGenericSshIssue(facts: RepoFacts, profile: Profile, blocking: boolean): Issue {
  return {
    id: "push_setup:generic_ssh",
    category: "push_setup",
    severity: blocking ? "blocking" : "warning",
    title: `Repo is not locked to ${profile.label} identity`,
    message:
      "This repo uses a generic SSH host, so it will push with whichever SSH key is used by default — not necessarily the right account.",
    whyItMatters:
      "A generic SSH host doesn't guarantee that the account behind your default SSH key matches this repo's expected profile.",
    whatWeExpected: `A dedicated SSH host alias for ${profile.label}`,
    whatWeFound: `SSH remote using generic host: ${facts.remoteHost ?? "unknown"}`,
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
    technicalDetails: {
      originRemoteUrl: facts.originRemoteUrl,
      remoteProtocol: facts.remoteProtocol,
      remoteHost: facts.remoteHost,
    },
  };
}

export function noRemoteIssue(profile: Profile): Issue {
  return {
    id: "push_setup:no_remote",
    category: "push_setup",
    severity: "warning",
    title: "Push setup is not verified",
    message: "This repo has no origin remote yet, so push safety can't be checked.",
    whyItMatters: `Once a remote is added, we can verify it's locked to ${profile.label}.`,
    whatWeExpected: "An origin remote",
    whatWeFound: "No origin remote",
    suggestedAction: "Make Push Setup Safer",
    suggestedActionCommand: "makePushSetupSafer",
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
    message: `You're committing directly on ${branch}, the protected branch for this repo.`,
    whyItMatters: "Commits made directly on a protected branch skip review and can break things for everyone.",
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

export function agentNotSafeIssue(): Issue {
  return {
    id: "agent_guard:not_safe",
    category: "agent_guard",
    severity: "blocking",
    title: "Not safe for AI agent",
    message: "Fix the issues above before letting an AI coding agent commit, push, or run commands here.",
    whyItMatters: "An AI agent will inherit whatever identity, push setup, and branch you're currently on.",
    suggestedAction: "Review Details",
  };
}

export function agentGuardOffIssue(): Issue {
  return {
    id: "agent_guard:shield_off",
    category: "agent_guard",
    severity: "info",
    title: "Shield Mode is off",
    message: "Optional local safeguards that block unsafe commits or pushes are not turned on yet.",
    whyItMatters: "Shield Mode is opt-in and never installs anything automatically.",
    suggestedAction: "Open Settings",
    suggestedActionCommand: "openSettings",
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
