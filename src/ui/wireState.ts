import {
  CapabilityResult,
  InfoNote,
  Profile,
  RepoMemory,
  SafetyLevel,
  SafetyPreferences,
  StatusSummary,
  WorkspaceSafetyState,
} from "../types";

/**
 * Shape of the data posted to the webview and the pure function that
 * derives it from the extension's in-memory model. Deliberately has no
 * `vscode` import, unlike SidebarProvider.ts itself, so it can be unit
 * tested with plain `node:test` outside an Extension Host.
 */
export interface SidebarModel {
  summary: StatusSummary;
  workspace: WorkspaceSafetyState;
  selectedRepoId?: string;
  memory: RepoMemory;
  profiles: Profile[];
  protectedBranches: string[];
  preferences: SafetyPreferences;
  isWorkspaceTrusted: boolean;
}

interface WireRepoListEntry {
  repoId: string;
  name: string;
  level: SafetyLevel;
  issueCount: number;
  nextFixTitle?: string;
  selected: boolean;
}

interface WireWorkspace {
  level: SafetyLevel;
  safeCount: number;
  notSafeCount: number;
  uncheckedCount: number;
  repos: WireRepoListEntry[];
}

/**
 * Facts surfaced to the webview purely to prefill forms (onboarding,
 * "Detect from current repo") — never anything from credential stores,
 * SSH keys, or tokens, and nothing beyond what `collectRepoFacts` already
 * read for the safety scan itself.
 */
interface WireFacts {
  canonicalRepo?: string;
  remoteOwner?: string;
  effectiveGitName?: string;
  effectiveGitEmail?: string;
}

export interface WireState {
  level: SafetyLevel;
  isGitRepo: boolean;
  repoName?: string;
  profileLabel?: string;
  branch?: string;
  issueCount: number;
  capabilityResults: CapabilityResult[];
  infoNotes: InfoNote[];
  nextFix?: CapabilityResult;
  pinnedNotePreview?: string;
  canFixIdentity: boolean;
  isWorkspaceTrusted: boolean;
  facts: WireFacts;
  memory: RepoMemory;
  profiles: Profile[];
  protectedBranches: string[];
  preferences: SafetyPreferences;
  workspace: WireWorkspace;
}

export function toWireState(model: SidebarModel): WireState {
  const { summary } = model;
  const facts = summary.facts;
  return {
    level: summary.level,
    isGitRepo: facts.isGitRepo,
    repoName: summary.repoName,
    profileLabel: summary.matchedProfile?.label,
    branch: facts.currentBranch,
    issueCount: summary.issueCount,
    capabilityResults: summary.capabilityResults,
    infoNotes: summary.infoNotes,
    nextFix: summary.nextFix,
    pinnedNotePreview: summary.pinnedMemoryPreview,
    canFixIdentity: !!summary.matchedProfile,
    isWorkspaceTrusted: model.isWorkspaceTrusted,
    facts: {
      canonicalRepo:
        facts.remoteHost && facts.remoteOwner && facts.remoteRepo
          ? `${facts.remoteHost}/${facts.remoteOwner}/${facts.remoteRepo}`.toLowerCase()
          : undefined,
      remoteOwner: facts.remoteOwner,
      effectiveGitName: facts.effectiveGitName,
      effectiveGitEmail: facts.effectiveGitEmail,
    },
    memory: model.memory,
    profiles: model.profiles,
    protectedBranches: model.protectedBranches,
    preferences: model.preferences,
    workspace: {
      level: model.workspace.level,
      safeCount: model.workspace.safeCount,
      notSafeCount: model.workspace.notSafeCount,
      uncheckedCount: model.workspace.uncheckedCount,
      repos: model.workspace.repos.map((repo) => ({
        repoId: repo.repoId,
        name: repo.summary.repoName || repo.workspaceFolderName || "(unnamed repo)",
        level: repo.summary.level,
        issueCount: repo.summary.issueCount,
        nextFixTitle: repo.summary.nextFix?.title,
        selected: repo.repoId === model.selectedRepoId,
      })),
    },
  };
}
