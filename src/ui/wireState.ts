import { ShieldHookInspection, ShieldInspection } from "../shield/manager";
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
 * Shield's lifecycle as the UI presents it — a superset of
 * `ShieldLifecycleState` ("off" | "active" | "degraded" | "broken") that adds
 * "unavailable" for a Git too old to run Shield at all (see
 * `docs/SHIELD_MODE.md`; Phase 8's `gitVersionSupported`). Deliberately
 * never derived from `SafetyLevel` — Repository Safety and Shield
 * Enforcement are two independent axes (SAFE + Shield OFF, and NOT SAFE +
 * Shield ACTIVE, are both valid and must both render correctly).
 */
export type ShieldUiLifecycle = "off" | "active" | "degraded" | "broken" | "unavailable";

/** One foreign (non-Shield-owned) hook occupying a slot Shield wants — surfaced so Enable Shield can offer the real chaining decision instead of silently succeeding or failing. */
export interface WireForeignHook {
  fileName: string;
  path: string;
  /** Mirrors `ShieldManager`'s own chainability rule (`fileKind === "executable-regular"`) — never widened here. */
  chainable: boolean;
}

export interface WireShieldState {
  lifecycle: ShieldUiLifecycle;
  /** Human-readable diagnostic lines already produced by `ShieldManager.inspect()` — never re-derived or reworded here. */
  reasons: string[];
  gitVersionRaw?: string;
  profileLabel?: string;
  approvedRepositoryKey?: string;
  approvedPushDestinationDisplay?: string;
  trustedSshHostAliases: string[];
  expectedGitHubLogin?: string;
  strictPushSetup?: boolean;
  commitProtection: boolean;
  mergeCommitProtection: boolean;
  pushProtection: boolean;
  policyProfileDrift: boolean;
  pushDestinationDrift: boolean;
  /** Present only when Shield isn't "active" AND a foreign hook occupies one of its governed slots — the case Enable Shield must ask the user about before acting. */
  foreignHook?: WireForeignHook;
}

function hookIsChainable(hook: ShieldHookInspection): boolean {
  // Mirrors ShieldManager's own foreignHookRefusalReason rule exactly —
  // never broaden it here. Any HookFileKind other than "executable-regular"
  // (symlink, non-executable, "other") is refused.
  return hook.fileKind === "executable-regular";
}

function approvedDestinationDisplay(destination?: { host?: string; owner?: string; repo?: string }): string | undefined {
  if (!destination || (!destination.host && !destination.owner)) return undefined;
  const host = destination.host ?? "(unknown host)";
  const path = [destination.owner, destination.repo].filter(Boolean).join("/");
  return path ? `${host}:${path}` : host;
}

export function toWireShieldState(inspection: ShieldInspection | undefined): WireShieldState {
  if (!inspection) {
    return {
      lifecycle: "off",
      reasons: [],
      trustedSshHostAliases: [],
      commitProtection: false,
      mergeCommitProtection: false,
      pushProtection: false,
      policyProfileDrift: false,
      pushDestinationDrift: false,
    };
  }

  // Only a POSITIVELY identified unsupported Git overrides the underlying
  // state with the fixed "requires Git 2.31" screen — an unrelated
  // inspection failure (e.g. `resolveGitContext` erroring before Git's
  // version was ever read) must surface as whatever it actually is
  // (broken, degraded, ...), never mislabeled as a Git-version problem it
  // has nothing to do with. See `ShieldInspection.gitVersionKnownUnsupported`.
  const lifecycle: ShieldUiLifecycle = inspection.gitVersionKnownUnsupported ? "unavailable" : inspection.state;
  const snapshot = inspection.policySnapshot;
  const enabledActions = snapshot?.enabledActions ?? [];
  const shieldOwnedActive = (fileName: string) =>
    inspection.state === "active" && inspection.hooks.some((h) => h.fileName === fileName && h.ownership === "shield");

  // A foreign hook is only a live decision to surface when Shield ISN'T
  // already active (an active Shield never has a foreign occupant in a
  // governed slot — see `ShieldManager.inspect`'s "degraded" branch for
  // exactly that case). Picks the first one, matching the order Enable
  // Shield's own hook loop reports them in.
  const foreignHookInspection =
    lifecycle !== "active" ? inspection.hooks.find((h) => h.ownership === "foreign") : undefined;
  const foreignHook: WireForeignHook | undefined = foreignHookInspection
    ? { fileName: foreignHookInspection.fileName, path: foreignHookInspection.path, chainable: hookIsChainable(foreignHookInspection) }
    : undefined;

  return {
    lifecycle,
    reasons: inspection.reasons,
    gitVersionRaw: inspection.gitVersionRaw,
    profileLabel: inspection.policyProfileLabel,
    approvedRepositoryKey: snapshot?.approvedRepositoryKey,
    approvedPushDestinationDisplay: approvedDestinationDisplay(snapshot?.approvedPushDestination),
    trustedSshHostAliases: snapshot?.trustedSshHostAliases ?? [],
    expectedGitHubLogin: snapshot?.expectedGitHubLogin,
    strictPushSetup: snapshot?.strictPushSetup,
    commitProtection: shieldOwnedActive("pre-commit") && enabledActions.includes("commit"),
    mergeCommitProtection: shieldOwnedActive("pre-merge-commit") && enabledActions.includes("commit"),
    pushProtection: shieldOwnedActive("pre-push") && enabledActions.includes("push"),
    policyProfileDrift: inspection.policyProfileDrift,
    pushDestinationDrift: inspection.pushDestinationDrift,
    foreignHook,
  };
}

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
  /** Per-repo, always — see the FINAL Multi-Repository Workspace design: there is no workspace-wide Shield state. */
  shieldLifecycle: ShieldUiLifecycle;
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
  shield: WireShieldState;
}

export function toWireState(model: SidebarModel): WireState {
  const { summary } = model;
  const facts = summary.facts;
  const selectedRepo = model.workspace.repos.find((r) => r.repoId === model.selectedRepoId);
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
    shield: toWireShieldState(selectedRepo?.shieldInspection),
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
        shieldLifecycle: toWireShieldState(repo.shieldInspection).lifecycle,
      })),
    },
  };
}
