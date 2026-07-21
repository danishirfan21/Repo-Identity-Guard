export type SafetyLevel = "safe" | "not_safe" | "not_checked";

export type RemoteProtocol = "ssh" | "https" | "unknown";

export type IssueCategory =
  | "commit_identity"
  | "push_setup"
  | "branch_safety"
  | "agent_guard"
  | "repo_memory";

export type IssueSeverity = "blocking" | "warning" | "info";

export interface RepoFacts {
  isGitRepo: boolean;
  repoRoot?: string;
  repoName?: string;
  currentBranch?: string;
  isDetachedHead?: boolean;
  hasUncommittedChanges?: boolean;
  effectiveGitName?: string;
  effectiveGitEmail?: string;
  localGitName?: string;
  localGitEmail?: string;
  globalGitName?: string;
  globalGitEmail?: string;
  originRemoteUrl?: string;
  remoteProtocol?: RemoteProtocol;
  remoteHost?: string;
  remoteOwner?: string;
  remoteRepo?: string;
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
  | "addProfileForRepo";

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
  agentGuardEnabled: boolean;
}
