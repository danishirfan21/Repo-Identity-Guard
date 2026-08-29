export type SafetyLevel = "safe" | "not_safe" | "not_checked";

export type RemoteProtocol = "ssh" | "https" | "unknown";

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
  /** From `git worktree list --porcelain`; >1 means other worktrees are attached to this repository, even from its main worktree. */
  worktreeCount?: number;
  /** Resolved `--git-dir`/`--git-common-dir`, kept so callers can watch the actual Git state directories, not a guessed `<repoRoot>/.git`. */
  gitDir?: string;
  gitCommonDir?: string;

  /** Effective author identity Git would use right now (`git var GIT_AUTHOR_IDENT`), including env overrides. */
  effectiveGitName?: string;
  effectiveGitEmail?: string;
  /** Effective committer identity (`git var GIT_COMMITTER_IDENT`) — usually equals author, but can diverge. */
  effectiveCommitterName?: string;
  effectiveCommitterEmail?: string;
  localGitName?: string;
  localGitEmail?: string;
  /** From `git config --worktree`; only actually distinct from `--local` when `extensions.worktreeConfig` is on. May hold a value `Fix Commit Identity` wrote here instead of `--local` — see `resolveIdentityConfigScope`. */
  worktreeGitName?: string;
  worktreeGitEmail?: string;
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

  /** The `upstream` remote, if one exists (the conventional fork-tracking remote name). Evidence only — never auto-selects a profile by itself. */
  upstreamRemoteUrl?: string;
  upstreamHost?: string;
  upstreamOwner?: string;
  upstreamRepo?: string;

  gitError?: string;
}

export interface Profile {
  id: string;
  label: string;
  gitName?: string;
  gitEmail: string;
  expectedRemoteOwners?: string[];
  /**
   * Exact-repository overrides, canonicalized as `host/owner/repo` (wildcards
   * allowed). Always takes precedence over `expectedRemoteOwners` — this is
   * how a specific repo gets pinned to a profile regardless of its owner
   * pattern, e.g. to resolve a fork/upstream conflict. Never keyed by disk
   * path or written into the repo itself.
   */
  exactRepos?: string[];
  expectedBranchPatterns?: string[];
  strictPushSetup?: boolean;
  /**
   * SSH host aliases (e.g. `github-work`, from a `~/.ssh/config` `Host`
   * entry) this profile explicitly trusts as an approved push route.
   * Matched case-insensitively against `RepoFacts.pushRemoteHost`. This is
   * the *only* thing that can make a non-generic SSH host's Push Account
   * check read as a trusted route — a custom alias is never trusted just
   * because it isn't one of the well-known generic hosts. Listing an alias
   * here is never cryptographic proof of who controls the account behind
   * it — it only records that you, the user, vouch for this alias under
   * this profile.
   */
  trustedSshHostAliases?: string[];
}

export type SuggestedActionCommand =
  | "fixCommitIdentity"
  | "makePushSetupSafer"
  | "openRepoMemory"
  | "openSettings"
  | "addProfileForRepo"
  | "reviewDetails"
  | "enableWorkspaceTrust"
  | "resolveProfileConflict";

/**
 * Epistemic status of a safety check, independent of whether it blocks
 * overall safety — see {@link CapabilityResult.blocksOverallSafety}. E.g. an
 * unverified push account blocks SAFE only when a profile requires strict
 * push setup; a plain dirty working tree never blocks at all.
 */
export type CheckState = "confirmed" | "contradicted" | "unverified" | "warning" | "not_applicable";

/**
 * The six safety questions Repo Identity Guard evaluates every scan. Each
 * capability produces exactly one {@link CapabilityResult} per scan — never
 * zero, never more than one — so Review Details can always show a complete
 * checklist, not just a list of problems.
 */
export type Capability =
  | "commit_identity"
  | "push_destination"
  | "push_account"
  | "branch_policy"
  | "repo_operation_state"
  | "workspace_trust";

/**
 * A restriction an AI agent should follow, derived from a specific
 * capability finding (e.g. an in-progress rebase implies `no-branch-switch`
 * and `no-commit`). Distinct from the fixed baseline rules (never push,
 * never touch Git/SSH/credential config) that apply regardless of findings.
 */
export type AgentRestrictionId =
  | "no-commit"
  | "no-branch-switch"
  | "ask-before-branch-change"
  | "preserve-changes"
  | "no-agent-operation"
  | "no-push"
  | "no-identity-change";

export interface AgentRestriction {
  id: AgentRestrictionId;
  description: string;
}

export interface CapabilityResult {
  id: string;
  capability: Capability;
  state: CheckState;
  title: string;
  summary: string;
  whyItMatters?: string;
  whatWeExpected?: string;
  whatWeFound?: string;
  technicalDetails?: Record<string, unknown>;
  /** Whether this specific result should flip overall status to NOT SAFE. Not derivable from `state` alone. */
  blocksOverallSafety: boolean;
  /** Restrictions an AI agent should follow as a direct consequence of this finding. */
  agentRestrictions?: AgentRestriction[];
  suggestedAction?: string;
  suggestedActionCommand?: SuggestedActionCommand;
}

/**
 * Non-safety information shown alongside capability results — context data
 * (Repo Memory) or feature-availability metadata (Shield Mode's "coming
 * soon" state), not a safety verdict. Never affects `blocksOverallSafety`.
 */
export interface InfoNote {
  id: string;
  category: "repo_memory" | "agent_guard_meta";
  title: string;
  message: string;
  suggestedAction?: string;
  suggestedActionCommand?: SuggestedActionCommand;
}

export interface StatusSummary {
  level: SafetyLevel;
  repoName?: string;
  matchedProfile?: Profile;
  capabilityResults: CapabilityResult[];
  infoNotes: InfoNote[];
  issueCount: number;
  nextFix?: CapabilityResult;
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

/**
 * Which Git config file `Fix Commit Identity` writes to. `--local` writes
 * the repo-level config shared by every worktree attached to a repo;
 * `--worktree` writes `config.worktree`, which is only actually
 * per-worktree when `extensions.worktreeConfig` is on. Never assume
 * `--local` is worktree-scoped just because a repo happens to be a linked
 * worktree — see `resolveIdentityConfigScope`.
 */
export type IdentityConfigScope = "local" | "worktree";

export interface SafetyPreferences {
  requireLocalIdentity: boolean;
  /** Off by default: pinned memory text may contain sensitive notes the user typed for themselves, not for export. */
  includeMemoryInAiContext: boolean;
}

/**
 * One repository's fully independent safety evaluation, as it contributes to
 * a multi-root workspace. `repoId` is a canonical (symlink-resolved) disk
 * path used only in-memory to deduplicate workspace folders that resolve to
 * the same repo root — never persisted, never shown raw in Copy Context.
 * Capability results stay strictly repo-scoped: this never mixes checks from
 * different repos into one result.
 */
export interface RepositorySafetyState {
  repoId: string;
  workspaceFolderName?: string;
  summary: StatusSummary;
}

/**
 * A derived roll-up of {@link RepositorySafetyState}s for the whole
 * workspace. Deliberately conservative, not a plain OR:
 * - `safe` only when every detected repo has been checked and is safe.
 * - `not_safe` when any repo is blocking, unresolved, or couldn't be
 *   checked reliably.
 * - `not_checked` only when no repositories have been evaluated/detected.
 */
export interface WorkspaceSafetyState {
  level: SafetyLevel;
  repos: RepositorySafetyState[];
  safeCount: number;
  notSafeCount: number;
  uncheckedCount: number;
}
