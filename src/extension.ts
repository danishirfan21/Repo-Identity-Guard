import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildAiContext, buildWorkspaceSafetySummary } from "./core/aiContext";
import { canonicalRepoKey, findOverlappingProfiles, resolveProfiles } from "./core/profileResolver";
import { computeStatus } from "./core/statusEngine";
import { computeWorkspaceSafetyState } from "./core/workspaceAggregate";
import { collectRepoFacts } from "./services/gitService";
import { copyToClipboard, runSavedCommand } from "./services/commandRunner";
import { SafeActionRunner } from "./services/safeActionRunner";
import {
  affectsRepoIdentityGuardConfig,
  getProfiles,
  getProtectedBranches,
  getSafetyPreferences,
  saveIncludeMemoryInAiContext,
  saveProfiles,
  saveProtectedBranches,
  saveRequireLocalIdentity,
} from "./storage/configStore";
import { MemoryStore } from "./storage/memoryStore";
import { RepoIdentitySidebarProvider, SidebarModel } from "./ui/SidebarProvider";
import { IdentityStatusBar } from "./statusBar";
import { Profile, RepoFacts, RepositorySafetyState, StatusSummary, WorkspaceSafetyState } from "./types";

function emptyNotCheckedSummary(gitError?: string): StatusSummary {
  return {
    level: "not_checked",
    capabilityResults: [],
    infoNotes: [],
    issueCount: 0,
    facts: { isGitRepo: false, gitError },
  };
}

function emptyWorkspaceState(): WorkspaceSafetyState {
  return { level: "not_checked", repos: [], safeCount: 0, notSafeCount: 0, uncheckedCount: 0 };
}

let latestSummary: StatusSummary = emptyNotCheckedSummary();
/** All repos detected across the workspace this scan, and the derived aggregate — see `computeWorkspaceSafetyState`. */
let workspaceState: WorkspaceSafetyState = emptyWorkspaceState();
/** The repo mutating/executing actions apply to. Always a concrete repo from `workspaceState.repos`, never ambiguous. */
let selectedRepoId: string | undefined;
let scanSequence = 0;
let repoGitConfigWatcher: vscode.FileSystemWatcher | undefined;
let watchedRepoRoot: string | undefined;
let globalGitConfigWatchers: vscode.FileSystemWatcher[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new IdentityStatusBar();
  const memoryStore = new MemoryStore(context);
  const safeActionRunner = new SafeActionRunner();

  const buildModel = (): SidebarModel => ({
    summary: latestSummary,
    workspace: workspaceState,
    selectedRepoId,
    memory: latestSummary.facts.repoRoot ? memoryStore.getMemory(latestSummary.facts.repoRoot) : { notes: [], commands: [] },
    profiles: getProfiles(),
    protectedBranches: getProtectedBranches(),
    preferences: getSafetyPreferences(),
  });

  const sidebarProvider = new RepoIdentitySidebarProvider(context.extensionUri, {
    rescan: () => scan(),
    fixCommitIdentity: () => fixCommitIdentity(),
    unsetLocalIdentity: () => unsetLocalIdentity(),
    addProfileForRepo: () => addProfileForRepo(),
    openSettingsJson: async () => {
      await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    },
    copyContextForAI: () => copyContextForAI(),
    copyWorkspaceSafetySummary: () => copyWorkspaceSafetySummary(),
    enableWorkspaceTrust: async () => {
      await vscode.commands.executeCommand("workbench.trust.manage");
    },
    resolveProfileConflict: () => resolveProfileConflict(),
    selectRepo: async (repoId: string) => {
      selectRepo(repoId);
      refreshSidebar();
    },

    addMemoryNote: async (text, pinned) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot || !text.trim()) return;
      await memoryStore.addNote(repoRoot, text, pinned);
      refreshSidebar();
    },
    removeMemoryNote: async (id) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot) return;
      await memoryStore.removeNote(repoRoot, id);
      refreshSidebar();
    },
    togglePinMemoryNote: async (id) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot) return;
      await memoryStore.togglePin(repoRoot, id);
      await scan();
    },
    addSavedCommand: async (label, command) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot || !label.trim() || !command.trim()) return;
      await memoryStore.addCommand(repoRoot, label, command);
      refreshSidebar();
    },
    removeSavedCommand: async (id) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot) return;
      await memoryStore.removeCommand(repoRoot, id);
      refreshSidebar();
    },
    runSavedCommand: async (id) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot) return;
      if (!(await requireWorkspaceTrust())) return;
      const saved = memoryStore.getMemory(repoRoot).commands.find((c) => c.id === id);
      if (saved) runSavedCommand(repoRoot, saved.command);
    },
    copySavedCommand: async (id) => {
      const repoRoot = requireRepoRoot();
      if (!repoRoot) return;
      const saved = memoryStore.getMemory(repoRoot).commands.find((c) => c.id === id);
      if (saved) {
        await copyToClipboard(saved.command);
        await vscode.window.showInformationMessage(`Copied: ${saved.command}`);
      }
    },

    saveProfile: async (profile: Profile) => {
      const profiles = getProfiles();
      const index = profiles.findIndex((p) => p.id === profile.id);
      const next = index >= 0 ? profiles.map((p, i) => (i === index ? profile : p)) : [...profiles, profile];
      await saveProfiles(next);

      const overlapping = findOverlappingProfiles(profile, next);
      if (overlapping.length > 0) {
        await vscode.window.showWarningMessage(
          `"${profile.label}" shares an owner pattern with ${overlapping.map((p) => p.label).join(", ")}. Any repo matching both will show as Not Safe until you narrow the owners.`,
        );
      }

      await scan();
    },
    deleteProfile: async (id) => {
      await saveProfiles(getProfiles().filter((p) => p.id !== id));
      await scan();
    },
    saveProtectedBranches: async (branches) => {
      await saveProtectedBranches(branches);
      await scan();
    },
    saveRequireLocalIdentity: async (value) => {
      await saveRequireLocalIdentity(value);
      await scan();
    },
    saveIncludeMemoryInAiContext: async (value) => {
      await saveIncludeMemoryInAiContext(value);
      await scan();
    },
  });

  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("repoIdentityGuard.statusView", sidebarProvider),
  );

  function refreshSidebar(): void {
    sidebarProvider.update(buildModel());
  }

  function requireRepoRoot(): string | undefined {
    return latestSummary.facts.repoRoot;
  }

  /** Blocks mutating/executing actions when Workspace Trust is off, with a clear reason. */
  async function requireWorkspaceTrust(): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    await vscode.window.showWarningMessage(
      "This workspace isn't trusted, so Repo Identity Guard won't run commands or change Git identity here. Enable Workspace Trust first.",
    );
    return false;
  }

  /**
   * cwdOverride is only meaningful for the no-workspace-folder fallback (a
   * single loose file/folder). When real workspace folders exist, every
   * scan re-evaluates all of them — that's the only way to keep the
   * aggregate honest after acting on any one repo.
   */
  async function scan(cwdOverride?: string): Promise<void> {
    const sequence = ++scanSequence;

    try {
      const targets = getScanTargets(cwdOverride);
      const repos = await buildRepositoryStates(targets);
      if (sequence !== scanSequence) return;

      workspaceState = computeWorkspaceSafetyState(repos);

      if (!selectedRepoId || !repos.some((r) => r.repoId === selectedRepoId)) {
        selectedRepoId = pickDefaultRepoId(repos);
      }
      const selected = repos.find((r) => r.repoId === selectedRepoId);
      latestSummary = selected?.summary ?? emptyNotCheckedSummary();

      statusBar.update(workspaceState);
      refreshSidebar();
      updateRepoGitConfigWatcher(latestSummary.facts.repoRoot, scan);
    } catch (error) {
      if (sequence !== scanSequence) return;
      workspaceState = emptyWorkspaceState();
      selectedRepoId = undefined;
      latestSummary = emptyNotCheckedSummary(getErrorMessage(error));
      statusBar.update(workspaceState);
      refreshSidebar();
      updateRepoGitConfigWatcher(undefined, scan);
    }
  }

  /** Workspace folders to scan, or a single ad hoc folder when the window has none open as a workspace. */
  function getScanTargets(cwdOverride?: string): { path: string; folderName?: string }[] {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders.map((folder) => ({ path: folder.uri.fsPath, folderName: folder.name }));
    }
    const cwd = cwdOverride ?? getActiveCwd();
    return cwd ? [{ path: cwd }] : [];
  }

  /**
   * Scans every target and returns one entry per unique repo root — folders
   * that resolve to the same repo (a multi-folder workspace opened inside
   * one repo, or symlinked paths) collapse to a single entry via the
   * realpath-canonicalized root; linked worktrees have their own distinct
   * root and are always kept separate, since their branch/working-tree
   * state can differ. A folder that isn't a Git repo is excluded entirely —
   * it never counts toward "no repositories detected."
   */
  async function buildRepositoryStates(
    targets: { path: string; folderName?: string }[],
  ): Promise<RepositorySafetyState[]> {
    const scans = await Promise.all(
      targets.map(async (target) => ({ target, facts: await collectRepoFacts(target.path) })),
    );

    const byRepoId = new Map<string, RepositorySafetyState>();
    for (const { target, facts } of scans) {
      if (!facts.isGitRepo || !facts.repoRoot) continue;

      const repoId = await canonicalizeRepoRoot(facts.repoRoot);
      if (byRepoId.has(repoId)) continue;

      const pinnedNote = memoryStore.getPinnedNote(facts.repoRoot)?.text;
      const summary = computeStatus({
        facts,
        profiles: getProfiles(),
        protectedBranches: getProtectedBranches(),
        preferences: getSafetyPreferences(),
        pinnedMemoryNote: pinnedNote,
        isWorkspaceTrusted: vscode.workspace.isTrusted,
      });

      byRepoId.set(repoId, { repoId, workspaceFolderName: target.folderName, summary });
    }

    return [...byRepoId.values()];
  }

  async function canonicalizeRepoRoot(repoRoot: string): Promise<string> {
    try {
      return await fs.realpath(repoRoot);
    } catch {
      return repoRoot;
    }
  }

  /** Prefers the repo the active editor's file lives in, then the first workspace folder's repo. */
  function pickDefaultRepoId(repos: RepositorySafetyState[]): string | undefined {
    if (repos.length === 0) return undefined;
    const activeCwd = getActiveCwd();
    if (activeCwd) {
      const match = repos.find((r) => r.summary.facts.repoRoot && isSubpath(activeCwd, r.summary.facts.repoRoot));
      if (match) return match.repoId;
    }
    return repos[0].repoId;
  }

  function isSubpath(candidate: string, repoRoot: string): boolean {
    const rel = path.relative(repoRoot, candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /** Explicit repo selection for multi-root workspaces — every mutating/executing action reads the repo this points at, never an ambiguous mix. */
  function selectRepo(repoId: string): void {
    const repo = workspaceState.repos.find((r) => r.repoId === repoId);
    if (!repo) return;
    selectedRepoId = repoId;
    latestSummary = repo.summary;
    updateRepoGitConfigWatcher(latestSummary.facts.repoRoot, scan);
  }

  function worktreeWarning(facts: RepoFacts): string {
    if (!facts.isLinkedWorktree) return "";
    if (facts.worktreeConfigEnabled === true) {
      return " This repo is a linked worktree with per-worktree config enabled, so this change affects only this worktree.";
    }
    return " This repo is a linked worktree. Per-worktree config isn't enabled here, so this change may affect every worktree attached to this repository, not just this one.";
  }

  async function fixCommitIdentity(): Promise<void> {
    const { facts, matchedProfile } = latestSummary;
    if (!facts.repoRoot || !matchedProfile) {
      await vscode.window.showInformationMessage(
        "No matched profile for this repo yet. Add one from Settings first.",
      );
      return;
    }
    if (!(await requireWorkspaceTrust())) return;

    const confirmation = await vscode.window.showWarningMessage(
      `Set this repo's local Git identity to ${matchedProfile.label} (${matchedProfile.gitName ?? ""} <${matchedProfile.gitEmail}>)? This only changes this repo's local Git config — your global Git identity is never touched.${worktreeWarning(facts)}`,
      { modal: true },
      "Set Local Identity",
    );
    if (confirmation !== "Set Local Identity") return;

    try {
      await safeActionRunner.setLocalIdentity(
        facts.repoRoot,
        matchedProfile.gitName ?? matchedProfile.label,
        matchedProfile.gitEmail,
      );
      await vscode.window.showInformationMessage("Commit identity fixed for this repo.");
      await scan(facts.repoRoot);
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not fix commit identity: ${getErrorMessage(error)}`);
    }
  }

  async function unsetLocalIdentity(): Promise<void> {
    const { facts } = latestSummary;
    if (!facts.repoRoot) return;
    if (!(await requireWorkspaceTrust())) return;
    await safeActionRunner.unsetLocalIdentity(facts.repoRoot);
    await scan(facts.repoRoot);
  }

  async function addProfileForRepo(): Promise<void> {
    const { facts } = latestSummary;

    const label = await vscode.window.showInputBox({
      title: "Add Profile for This Repo",
      prompt: "Profile label",
      value: facts.remoteOwner ? `${facts.remoteOwner}` : "Work",
    });
    if (!label) return;

    const gitName = await vscode.window.showInputBox({
      title: "Add Profile for This Repo",
      prompt: "Git name for this profile",
      value: facts.effectiveGitName ?? "",
    });

    const gitEmail = await vscode.window.showInputBox({
      title: "Add Profile for This Repo",
      prompt: "Git email for this profile",
      value: facts.effectiveGitEmail ?? "",
    });
    if (!gitEmail) return;

    const owners = await vscode.window.showInputBox({
      title: "Add Profile for This Repo",
      prompt: "Expected remote owners (comma separated, e.g. github org or username)",
      value: facts.remoteOwner ?? "",
    });

    const profile: Profile = {
      id: `profile-${Date.now().toString(36)}`,
      label,
      gitName: gitName || undefined,
      gitEmail,
      expectedRemoteOwners: (owners ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      expectedBranchPatterns: [],
      strictPushSetup: false,
    };

    const nextProfiles = [...getProfiles(), profile];
    await saveProfiles(nextProfiles);

    const overlapping = findOverlappingProfiles(profile, nextProfiles);
    if (overlapping.length > 0) {
      await vscode.window.showWarningMessage(
        `"${label}" shares an owner pattern with ${overlapping.map((p) => p.label).join(", ")}. Any repo matching both will show as Not Safe until you narrow the owners.`,
      );
    } else {
      await vscode.window.showInformationMessage(`Added profile "${label}".`);
    }

    await scan(facts.repoRoot);
  }

  async function resolveProfileConflict(): Promise<void> {
    const { facts } = latestSummary;
    const resolution = resolveProfiles(facts, getProfiles());
    const conflict = resolution.forkConflict;
    if (!conflict) {
      await vscode.window.showInformationMessage("No origin/upstream profile conflict to resolve for this repo.");
      return;
    }

    const originKey = canonicalRepoKey(facts.remoteHost, facts.remoteOwner, facts.remoteRepo);
    if (!originKey) {
      await vscode.window.showInformationMessage("Could not determine this repo's canonical host/owner/repo.");
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: conflict.originProfile.label, description: "Matches this repo's origin remote", profile: conflict.originProfile },
        { label: conflict.upstreamProfile.label, description: "Matches this repo's upstream remote", profile: conflict.upstreamProfile },
      ],
      {
        title: "Assign This Repo to a Profile",
        placeHolder: `Which profile should ${originKey} always use?`,
      },
    );
    if (!choice) return;

    const profiles = getProfiles();
    const next = profiles.map((profile) =>
      profile.id === choice.profile.id
        ? { ...profile, exactRepos: [...(profile.exactRepos ?? []), originKey] }
        : profile,
    );
    await saveProfiles(next);
    await vscode.window.showInformationMessage(
      `Assigned ${originKey} to ${choice.profile.label}. This overrides owner-pattern matching for this exact repo.`,
    );
    await scan(facts.repoRoot);
  }

  async function copyContextForAI(): Promise<void> {
    const repoRoot = latestSummary.facts.repoRoot;
    const memory = repoRoot ? memoryStore.getMemory(repoRoot) : { notes: [], commands: [] };
    const { includeMemoryInAiContext } = getSafetyPreferences();
    const text = buildAiContext(latestSummary, memory, { includeMemory: includeMemoryInAiContext });

    await copyToClipboard(text);

    // Always show the exact text before it's used — this is the trust experience, not an afterthought.
    const previewDoc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
    await vscode.window.showTextDocument(previewDoc, { preview: true });
    await vscode.window.showInformationMessage(
      "Copied to clipboard. Review the preview before pasting it into your AI agent.",
    );
  }

  async function copyWorkspaceSafetySummary(): Promise<void> {
    const text = buildWorkspaceSafetySummary(workspaceState);
    await copyToClipboard(text);

    const previewDoc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
    await vscode.window.showTextDocument(previewDoc, { preview: true });
    await vscode.window.showInformationMessage(
      "Copied to clipboard. Review the preview before pasting it into your AI agent.",
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("repoIdentityGuard.scan", () => scan()),
    vscode.commands.registerCommand("repoIdentityGuard.showStatus", () => showStatus()),
    vscode.commands.registerCommand("repoIdentityGuard.fixIdentity", () => fixCommitIdentity()),
    vscode.commands.registerCommand("repoIdentityGuard.addRuleForCurrentRepo", () => addProfileForRepo()),
    vscode.commands.registerCommand("repoIdentityGuard.copyDiagnosticReport", () => copyContextForAI()),
    vscode.commands.registerCommand("repoIdentityGuard.copyWorkspaceSafetySummary", () => copyWorkspaceSafetySummary()),
    vscode.commands.registerCommand("repoIdentityGuard.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettingsJson"),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => void scan()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void scan()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsRepoIdentityGuardConfig(event)) void scan();
    }),
    {
      dispose: () => {
        repoGitConfigWatcher?.dispose();
        disposeGlobalGitConfigWatchers();
      },
    },
  );

  async function showStatus(): Promise<void> {
    const summary = latestSummary;
    const message =
      summary.level === "safe"
        ? `Safe to work here${summary.matchedProfile ? ` as ${summary.matchedProfile.label}` : ""}.`
        : summary.level === "not_safe"
          ? `Not safe: ${summary.nextFix?.title ?? "see Review Details"}.`
          : "This folder isn't a Git repository yet.";

    const choice = await (summary.level === "not_safe"
      ? vscode.window.showWarningMessage(message, "Review Details", "Repo Memory")
      : vscode.window.showInformationMessage(message, "Review Details", "Repo Memory"));

    if (choice === "Review Details") {
      await vscode.commands.executeCommand("workbench.view.extension.repoIdentityGuard");
    } else if (choice === "Repo Memory") {
      await vscode.commands.executeCommand("workbench.view.extension.repoIdentityGuard");
    }
  }

  updateGlobalGitConfigWatchers(scan);
  void scan();
}

export function deactivate(): void {
  repoGitConfigWatcher?.dispose();
  disposeGlobalGitConfigWatchers();
}

function getActiveCwd(): string | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument?.uri.scheme === "file") {
    return path.dirname(activeDocument.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function updateRepoGitConfigWatcher(
  repoRoot: string | undefined,
  scan: (cwdOverride?: string) => Promise<void>,
): void {
  if (repoRoot === watchedRepoRoot) return;

  repoGitConfigWatcher?.dispose();
  repoGitConfigWatcher = undefined;
  watchedRepoRoot = repoRoot;

  if (!repoRoot) return;

  repoGitConfigWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(repoRoot), ".git/{config,HEAD}"),
  );
  repoGitConfigWatcher.onDidChange(() => void scan(repoRoot));
  repoGitConfigWatcher.onDidCreate(() => void scan(repoRoot));
  repoGitConfigWatcher.onDidDelete(() => void scan(repoRoot));
}

function updateGlobalGitConfigWatchers(scan: (cwdOverride?: string) => Promise<void>): void {
  disposeGlobalGitConfigWatchers();

  const home = os.homedir();
  const configPaths = [path.join(home, ".gitconfig"), path.join(home, ".config", "git", "config")];

  globalGitConfigWatchers = configPaths.map((configPath) => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(configPath), path.basename(configPath)),
    );
    watcher.onDidChange(() => void scan());
    watcher.onDidCreate(() => void scan());
    watcher.onDidDelete(() => void scan());
    return watcher;
  });
}

function disposeGlobalGitConfigWatchers(): void {
  for (const watcher of globalGitConfigWatchers) watcher.dispose();
  globalGitConfigWatchers = [];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-exported for tests / type-only consumers.
export type { RepoFacts };
