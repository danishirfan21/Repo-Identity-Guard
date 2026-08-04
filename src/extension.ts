import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildAiContext } from "./core/aiContext";
import { findOverlappingProfiles } from "./core/profileResolver";
import { computeStatus } from "./core/statusEngine";
import { collectRepoFacts } from "./services/gitService";
import { copyToClipboard, runSavedCommand } from "./services/commandRunner";
import { SafeActionRunner } from "./services/safeActionRunner";
import {
  affectsRepoIdentityGuardConfig,
  getProfiles,
  getProtectedBranches,
  getSafetyPreferences,
  saveAgentGuardEnabled,
  saveProfiles,
  saveProtectedBranches,
  saveRequireLocalIdentity,
} from "./storage/configStore";
import { MemoryStore } from "./storage/memoryStore";
import { RepoIdentitySidebarProvider, SidebarModel } from "./ui/SidebarProvider";
import { IdentityStatusBar } from "./statusBar";
import { Profile, RepoFacts, StatusSummary } from "./types";

let latestSummary: StatusSummary = {
  level: "not_checked",
  issues: [],
  issueCount: 0,
  facts: { isGitRepo: false },
};
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
    saveAgentGuardEnabled: async (value) => {
      await saveAgentGuardEnabled(value);
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

  async function scan(cwdOverride?: string): Promise<void> {
    const sequence = ++scanSequence;
    const cwd = cwdOverride ?? getActiveCwd();

    try {
      const facts = await collectRepoFacts(cwd);
      if (sequence !== scanSequence) return;

      const pinnedNote = facts.repoRoot ? memoryStore.getPinnedNote(facts.repoRoot)?.text : undefined;

      const summary = computeStatus({
        facts,
        profiles: getProfiles(),
        protectedBranches: getProtectedBranches(),
        preferences: getSafetyPreferences(),
        pinnedMemoryNote: pinnedNote,
      });

      latestSummary = summary;
      statusBar.update(summary);
      refreshSidebar();
      updateRepoGitConfigWatcher(facts.repoRoot, scan);
    } catch (error) {
      if (sequence !== scanSequence) return;
      latestSummary = {
        level: "not_checked",
        issues: [],
        issueCount: 0,
        facts: { isGitRepo: false, gitError: getErrorMessage(error) },
      };
      statusBar.update(latestSummary);
      refreshSidebar();
      updateRepoGitConfigWatcher(undefined, scan);
    }
  }

  async function fixCommitIdentity(): Promise<void> {
    const { facts, matchedProfile } = latestSummary;
    if (!facts.repoRoot || !matchedProfile) {
      await vscode.window.showInformationMessage(
        "No matched profile for this repo yet. Add one from Settings first.",
      );
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Set this repo's local Git identity to ${matchedProfile.label} (${matchedProfile.gitName ?? ""} <${matchedProfile.gitEmail}>)? This only changes this repo's local Git config — your global Git identity is never touched.`,
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

  async function copyContextForAI(): Promise<void> {
    const repoRoot = latestSummary.facts.repoRoot;
    const memory = repoRoot ? memoryStore.getMemory(repoRoot) : { notes: [], commands: [] };
    const text = buildAiContext(latestSummary, memory);
    await copyToClipboard(text);
    await vscode.window.showInformationMessage("Repo context copied. Paste it into your AI agent.");
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("repoIdentityGuard.scan", () => scan()),
    vscode.commands.registerCommand("repoIdentityGuard.showStatus", () => showStatus()),
    vscode.commands.registerCommand("repoIdentityGuard.fixIdentity", () => fixCommitIdentity()),
    vscode.commands.registerCommand("repoIdentityGuard.addRuleForCurrentRepo", () => addProfileForRepo()),
    vscode.commands.registerCommand("repoIdentityGuard.copyDiagnosticReport", () => copyContextForAI()),
    vscode.commands.registerCommand("repoIdentityGuard.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettingsJson"),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => void scan()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
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
