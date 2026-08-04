export type SafetyLevel = "safe" | "not_safe" | "not_checked";

export type RemoteProtocol = "ssh" | "https" | "unknown";

export type IssueCategory =
  | "commit_identity"
  | "push_setup"
  | "branch_safety"
  | "agent_guard"
  | "repo_memory";

export type IssueSeverity = "blocking" | "warning" | "info";

export type InProgressOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface RepoFacts {
  isGitRepo: boolean;
  repoRoot?: string;
  repoName?: string;
  currentBranch?: string;
  isDetachedHead?: boolean;
  hasUncommittedChanges?: boolean;
  hasMergeConflicts?: boolean;
  inProgressOperation?: InProgressOperation;
  isLinkedWorktree?: boolean;
  /** Whether this repo has `extensions.worktreeConfig` on; null/undefined means unknown/not queried. */
  worktreeConfigEnabled?: boolean;

  /** Effective author identity Git would use right now (`git var GIT_AUTHOR_IDENT`), including env overrides. */
  effectiveGitName?: string;
  effectiveGitEmail?: string;
  /** Effective committer identity (`git var GIT_COMMITTER_IDENT`) — usually equals author, but can diverge. */
  effectiveCommitterName?: string;
  effectiveCommitterEmail?: string;
  localGitName?: string;
  localGitEmail?: string;
  globalGitName?: string;
  globalGitEmail?: string;

  /** `origin`'s fetch URL — identifies whose repo this is, used for profile matching. */
  originRemoteUrl?: string;
  remoteProtocol?: RemoteProtocol;
  remoteHost?: string;
  remoteOwner?: string;
  remoteRepo?: string;

  /** Where a plain `git push` would actually go — may differ from `origin` via pushRemote/pushDefault/pushurl. */
  pushRemoteName?: string;
  pushRemoteUrl?: string;
  pushRemoteProtocol?: RemoteProtocol;
  pushRemoteHost?: string;
  pushRemoteOwner?: string;
  pushRemoteRepo?: string;

  gitError?: string;
}

export interface Profile {
  id: string;
  label: string;
  gitName?: string;
  gitEmail: string;
  expectedRemoteOwners?: string[];
  expectedBranchPatterns?: string[];
  strictPushSetup?: boolean;
}

export interface Issue {
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  message: string;
  whyItMatters?: string;
  whatWeExpected?: string;
  whatWeFound?: string;
  suggestedAction?: string;
  suggestedActionCommand?: SuggestedActionCommand;
  technicalDetails?: Record<string, unknown>;
}

export type SuggestedActionCommand =
  | "fixCommitIdentity"
  | "makePushSetupSafer"
  | "openRepoMemory"
  | "openSettings"
  | "addProfileForRepo"
  | "reviewDetails"
  | "enableWorkspaceTrust";

export interface StatusSummary {
  level: SafetyLevel;
  repoName?: string;
  matchedProfile?: Profile;
  issues: Issue[];
  issueCount: number;
  nextFix?: Issue;
  pinnedMemoryPreview?: string;
  facts: RepoFacts;
}

export interface MemoryNote {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: number;
}

export interface SavedCommand {
  id: string;
  label: string;
  command: string;
  createdAt: number;
}

export interface RepoMemory {
  notes: MemoryNote[];
  commands: SavedCommand[];
}

export function emptyRepoMemory(): RepoMemory {
  return { notes: [], commands: [] };
}

export interface SafetyPreferences {
  requireLocalIdentity: boolean;
  /** Off by default: pinned memory text may contain sensitive notes the user typed for themselves, not for export. */
  includeMemoryInAiContext: boolean;
}
