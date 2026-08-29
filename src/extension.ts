import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildAiContext, buildWorkspaceSafetySummary } from "./core/aiContext";
import { canonicalRepoKey, findOverlappingProfiles, resolveProfiles } from "./core/profileResolver";
import { computeStatus } from "./core/statusEngine";
import { computeWorkspaceSafetyState, workspaceProblemCount } from "./core/workspaceAggregate";
import { collectRepoFacts, resolveIdentityConfigScope } from "./services/gitService";
import { copyToClipboard, runSavedCommand } from "./services/commandRunner";
import { SafeActionRunner } from "./services/safeActionRunner";
import { ShieldManager } from "./shield";
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
/** One or more watchers per repo (its gitDir and, for linked worktrees, gitCommonDir too), reconciled by repoId after every scan — see `reconcileRepoWatchers`. */
let repoWatchers = new Map<string, vscode.Disposable[]>();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let globalGitConfigWatchers: vscode.FileSystemWatcher[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new IdentityStatusBar();
  const memoryStore = new MemoryStore(context);
  const safeActionRunner = new SafeActionRunner();
  const shieldManager = new ShieldManager();
  const shieldEvaluatorScriptSource = path.join(context.extensionPath, "resources", "shield", "shield-evaluate.sh");

  const buildModel = (): SidebarModel => ({
    summary: latestSummary,
    workspace: workspaceState,
    selectedRepoId,
    memory: latestSummary.facts.repoRoot ? memoryStore.getMemory(latestSummary.facts.repoRoot) : { notes: [], commands: [] },
    profiles: getProfiles(),
    protectedBranches: getProtectedBranches(),
    preferences: getSafetyPreferences(),
    isWorkspaceTrusted: vscode.workspace.isTrusted,
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
      reconcileRepoWatchers(repos);
    } catch (error) {
      if (sequence !== scanSequence) return;
      workspaceState = emptyWorkspaceState();
      selectedRepoId = undefined;
      latestSummary = emptyNotCheckedSummary(getErrorMessage(error));
      statusBar.update(workspaceState);
      refreshSidebar();
      reconcileRepoWatchers([]);
    }
  }

  function scheduleDebouncedScan(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void scan(), 300);
  }

  /**
   * Keeps one set of Git-state watchers per repo in sync with what the last
   * scan actually found — added for newly discovered repos, disposed for
   * repos that dropped out (closed folder, no longer a Git repo). Every
   * in-scope repo gets watched, not just the currently selected one, so a
   * non-selected repo going unsafe (branch switch, new conflict, identity
   * change) still triggers a rescan and the aggregate can't go stale.
   *
   * Watches the resolved `gitDir`/`gitCommonDir` (not a guessed
   * `<repoRoot>/.git`, which is wrong for linked worktrees) for the files
   * that drive Commit Identity, Branch Policy, and Repo State: HEAD,
   * config, config.worktree (an external `git config --worktree` edit must
   * also trigger a rescan, not just `--local`), the index, the
   * merge/cherry-pick/revert markers, and the rebase-in-progress
   * directories. This does not watch the working tree
   * itself (recursively watching every file in every repo would be
   * expensive); `onDidSaveTextDocument` below gives ordinary edits a
   * lighter-weight nudge instead.
   */
  function reconcileRepoWatchers(repos: RepositorySafetyState[]): void {
    const currentIds = new Set(repos.map((r) => r.repoId));

    for (const [repoId, disposables] of repoWatchers) {
      if (!currentIds.has(repoId)) {
        disposables.forEach((d) => d.dispose());
        repoWatchers.delete(repoId);
      }
    }

    for (const repo of repos) {
      if (repoWatchers.has(repo.repoId)) continue;

      const facts = repo.summary.facts;
      const dirs = new Set([facts.gitDir, facts.gitCommonDir].filter((d): d is string => !!d));
      if (dirs.size === 0) continue;

      const disposables: vscode.Disposable[] = [];
      for (const dir of dirs) {
        const stateWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), "{HEAD,config,config.worktree,index,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD}"),
        );
        const operationWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), "{rebase-merge,rebase-apply}/**"),
        );
        for (const watcher of [stateWatcher, operationWatcher]) {
          watcher.onDidChange(() => scheduleDebouncedScan());
          watcher.onDidCreate(() => scheduleDebouncedScan());
          watcher.onDidDelete(() => scheduleDebouncedScan());
          disposables.push(watcher);
        }
      }
      repoWatchers.set(repo.repoId, disposables);
    }
  }

  function disposeRepoWatchers(): void {
    for (const disposables of repoWatchers.values()) disposables.forEach((d) => d.dispose());
    repoWatchers.clear();
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
    // Promise.allSettled, not Promise.all: one target must never be able to
    // take the rest of the workspace down with it. collectRepoFacts already
    // catches its own expected failures, but this is defense in depth
    // against an unanticipated exception from any step below.
    const outcomes = await Promise.allSettled(
      targets.map(async (target) => ({ target, facts: await collectRepoFacts(target.path) })),
    );

    const byRepoId = new Map<string, RepositorySafetyState>();
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      const target = targets[i];

      try {
        if (outcome.status === "rejected") {
          addInspectionFailedRepo(byRepoId, target, getErrorMessage(outcome.reason));
          continue;
        }

        const { facts } = outcome.value;
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
      } catch (error) {
        // Same guarantee for the synchronous half of the pipeline
        // (canonicalization, computeStatus): a bug evaluating one repo
        // must not hide every other repo in the workspace.
        addInspectionFailedRepo(byRepoId, target, getErrorMessage(error));
      }
    }

    return [...byRepoId.values()];
  }

  function addInspectionFailedRepo(
    byRepoId: Map<string, RepositorySafetyState>,
    target: { path: string; folderName?: string },
    errorMessage: string,
  ): void {
    const repoId = target.path;
    if (byRepoId.has(repoId)) return;
    const summary = computeStatus({
      facts: { isGitRepo: true, repoRoot: repoId, gitError: errorMessage },
      profiles: getProfiles(),
      protectedBranches: getProtectedBranches(),
      preferences: getSafetyPreferences(),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    });
    byRepoId.set(repoId, { repoId, workspaceFolderName: target.folderName, summary });
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
  }

  /** Repo/profile identity for a mutation confirmation dialog — never leave "this repo" ambiguous once more than one is open. */
  function repoIdentityLines(facts: RepoFacts, profile: Profile): string {
    return `\n\nRepository: ${facts.repoName ?? "Unknown"}\nLocal path: ${facts.repoRoot}\nProfile: ${profile.label}`;
  }

  function worktreeWarning(facts: RepoFacts, scope: "local" | "worktree"): string {
    const hasMultipleWorktrees = (facts.worktreeCount ?? 1) > 1;

    if (scope === "worktree") {
      return hasMultipleWorktrees
        ? " This repo has other worktrees attached; per-worktree config is enabled, so this is written with `git config --worktree` and affects only this worktree."
        : " Per-worktree config is enabled for this repo, so this is written with `git config --worktree` (this worktree's own config) rather than the shared repo config — that matters even with only one worktree right now, since a worktree-scoped value always overrides `--local`.";
    }

    if (!hasMultipleWorktrees) return "";
    return " This repo has other worktrees attached, and per-worktree config isn't enabled, so this is written with `git config --local` and will be shared by every worktree attached to this repository, not just this one.";
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

    const scope = resolveIdentityConfigScope(facts.worktreeConfigEnabled);

    const confirmation = await vscode.window.showWarningMessage(
      `Set this repo's Git identity to ${matchedProfile.label} (${matchedProfile.gitName ?? ""} <${matchedProfile.gitEmail}>)? Your global Git identity is never touched.${worktreeWarning(facts, scope)}${repoIdentityLines(facts, matchedProfile)}`,
      { modal: true },
      "Set Local Identity",
    );
    if (confirmation !== "Set Local Identity") return;

    try {
      await safeActionRunner.setLocalIdentity(
        facts.repoRoot,
        matchedProfile.gitName ?? matchedProfile.label,
        matchedProfile.gitEmail,
        scope,
      );

      // Outcome-based, not just "the write didn't throw": an environment
      // variable (GIT_AUTHOR_EMAIL, etc.) or command-line override can
      // still win over the config this just wrote, in which case saying
      // "fixed" would be false. This check is deliberately independent of
      // the shared scan()/latestSummary path: a watcher-triggered scan
      // (possibly fired by this very config write) can supersede scan()'s
      // own sequence guard and return without publishing, which would let
      // this read stale global state and report a false "still overridden"
      // warning. Re-collecting and re-computing this one repo directly
      // sidesteps that race entirely.
      const freshFacts = await collectRepoFacts(facts.repoRoot);
      const freshSummary = computeStatus({
        facts: freshFacts,
        profiles: getProfiles(),
        protectedBranches: getProtectedBranches(),
        preferences: getSafetyPreferences(),
        pinnedMemoryNote: freshFacts.repoRoot ? memoryStore.getPinnedNote(freshFacts.repoRoot)?.text : undefined,
        isWorkspaceTrusted: vscode.workspace.isTrusted,
      });
      const commitIdentity = freshSummary.capabilityResults.find((r) => r.capability === "commit_identity");

      await scan(facts.repoRoot); // still refresh the shared sidebar/workspace state

      if (commitIdentity?.state === "confirmed") {
        await vscode.window.showInformationMessage("Commit identity fixed for this repo.");
      } else {
        await vscode.window.showWarningMessage(
          "Git config was updated, but this repo's effective commit identity is still not correct — likely an environment variable (GIT_AUTHOR_EMAIL/GIT_COMMITTER_EMAIL) or command-line override winning over config. Repo Identity Guard can only change Git config, not your shell environment or a command's own arguments.",
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not fix commit identity: ${getErrorMessage(error)}`);
    }
  }

  async function unsetLocalIdentity(): Promise<void> {
    const { facts } = latestSummary;
    if (!facts.repoRoot) return;
    if (!(await requireWorkspaceTrust())) return;
    const scope = resolveIdentityConfigScope(facts.worktreeConfigEnabled);
    await safeActionRunner.unsetLocalIdentity(facts.repoRoot, scope);
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

  /**
   * Minimal command-palette-only entry points for Phase 3 (Shield's
   * install/repair/disable/health-check lifecycle) — deliberately not
   * wired into the sidebar yet; that's a later, dedicated UI phase. Every
   * write goes through `requireWorkspaceTrust()` first, same as Fix
   * Commit Identity, since installing a Git hook is exactly the kind of
   * mutating action Workspace Trust exists to gate; a plain health check
   * is read-only and works regardless.
   */
  /**
   * Re-collects everything a durable Shield policy is built from, right
   * now, immediately before the write that persists it.
   *
   * Phase 8 finding: `enableShield`/`repairShield` used to build a policy
   * out of `latestSummary.facts` — the shared module-level snapshot that a
   * background file watcher, a sidebar scan, or a workspace-folder switch
   * writes to, and which can therefore be arbitrarily old (or belong to a
   * *different* repository) by the time the command runs. That snapshot is
   * fine for painting UI, which is refreshed constantly and costs nothing
   * when wrong. It is not fine for `approvedPushDestination`,
   * `approvedRepositoryKey`, `expectedGitEmail`, or the matched profile:
   * those get written to disk and then enforced by hooks, with VS Code
   * closed, until someone explicitly repairs them. A stale fact there is a
   * silently wrong enforcement rule with a long lifetime.
   *
   * `collectRepoFacts` re-runs every underlying `git` invocation
   * (including the full `branch.<name>.pushRemote` → `remote.pushDefault`
   * → `branch.<name>.remote` → `origin` push-remote resolution and
   * `remote get-url --push`), and profiles/protected branches are re-read
   * from Settings, so the profile match and the push destination are both
   * resolved from live state rather than inherited from the scan.
   *
   * `repoRoot` is passed in from the summary only as a *starting
   * directory* — the freshly collected facts' own `repoRoot` is what is
   * then used, so even a repo-root change is picked up rather than
   * assumed.
   */
  async function collectFreshShieldInputs(startDir: string): Promise<
    { ok: true; facts: RepoFacts; profiles: Profile[]; protectedBranches: string[] } | { ok: false; message: string }
  > {
    const facts = await collectRepoFacts(startDir);
    if (!facts.isGitRepo || !facts.repoRoot) {
      return { ok: false, message: "This folder is no longer a Git repository. Nothing was changed." };
    }
    if (facts.gitError) {
      return {
        ok: false,
        message: `Shield refused to act because this repository's current state could not be read: ${facts.gitError}. Nothing was changed.`,
      };
    }
    return { ok: true, facts, profiles: getProfiles(), protectedBranches: getProtectedBranches() };
  }

  async function enableShield(): Promise<void> {
    const startDir = latestSummary.facts.repoRoot;
    if (!startDir) {
      await vscode.window.showInformationMessage("Open a Git repository first.");
      return;
    }
    if (!(await requireWorkspaceTrust())) return;

    const fresh = await collectFreshShieldInputs(startDir);
    if (!fresh.ok) {
      await vscode.window.showWarningMessage(`Could not enable Shield: ${fresh.message}`);
      return;
    }
    const { facts } = fresh;

    try {
      const result = await shieldManager.enable(facts.repoRoot as string, shieldEvaluatorScriptSource, {
        facts,
        profiles: fresh.profiles,
        protectedBranches: fresh.protectedBranches,
      });
      if (result.ok) {
        await vscode.window.showInformationMessage(
          `Shield enabled for ${facts.repoName ?? facts.repoRoot} (${result.inspection.policyProfileLabel ?? "matched profile"}).`,
        );
      } else {
        await vscode.window.showWarningMessage(
          `Shield could not be fully enabled: ${result.inspection.reasons[0] ?? "see Shield health check for details."}`,
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not enable Shield: ${getErrorMessage(error)}`);
    }
  }

  async function repairShield(): Promise<void> {
    const startDir = latestSummary.facts.repoRoot;
    if (!startDir) {
      await vscode.window.showInformationMessage("Open a Git repository first.");
      return;
    }
    if (!(await requireWorkspaceTrust())) return;

    // Same fresh-facts rule as enableShield: a repair rewrites the durable
    // policy, so it must never be built from a cached scan either. Repair
    // is in fact the more important of the two — it exists precisely to
    // re-sync a policy after something changed, and reading a stale
    // snapshot would re-persist the very drift the user is repairing.
    const fresh = await collectFreshShieldInputs(startDir);
    if (!fresh.ok) {
      await vscode.window.showWarningMessage(`Could not repair Shield: ${fresh.message}`);
      return;
    }
    const { facts } = fresh;

    try {
      const result = await shieldManager.repair(facts.repoRoot as string, shieldEvaluatorScriptSource, {
        facts,
        profiles: fresh.profiles,
        protectedBranches: fresh.protectedBranches,
      });
      if (result.ok) {
        await vscode.window.showInformationMessage(`Shield repaired for ${facts.repoName ?? facts.repoRoot}.`);
      } else {
        await vscode.window.showWarningMessage(
          `Shield is still not fully active: ${result.inspection.reasons[0] ?? "see Shield health check for details."}`,
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not repair Shield: ${getErrorMessage(error)}`);
    }
  }

  async function disableShield(): Promise<void> {
    const { facts } = latestSummary;
    if (!facts.repoRoot) {
      await vscode.window.showInformationMessage("Open a Git repository first.");
      return;
    }
    if (!(await requireWorkspaceTrust())) return;

    const confirmation = await vscode.window.showWarningMessage(
      `Disable Shield for ${facts.repoName ?? facts.repoRoot}? This removes Shield's own pre-commit hook and policy for this repository only — no other Git config, hooks, or credentials are touched.`,
      { modal: true },
      "Disable Shield",
    );
    if (confirmation !== "Disable Shield") return;

    try {
      await shieldManager.disable(facts.repoRoot);
      await vscode.window.showInformationMessage(`Shield disabled for ${facts.repoName ?? facts.repoRoot}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not disable Shield: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Shield health check — a FULL integrity check, not a file-presence
   * check.
   *
   * Phase 8 finding: this command called `healthCheck(repoRoot)` with no
   * options at all. `ShieldManager.inspect` supports three drift checks,
   * and every one of them is opt-in via an input the caller must supply —
   * so with none supplied, all three were silently skipped and a Shield
   * whose evaluator had been hand-edited (marker and version comment left
   * intact), whose profile had since changed `trustedSshHostAliases` /
   * `expectedGitHubLogin` / `strictPushSetup` / Git identity, or whose
   * push destination had moved, reported a confident "Shield is active."
   * The checks existed and were tested at the manager level; nothing in
   * the product ever turned them on.
   *
   * All three inputs are gathered live here, for the same reason
   * `collectFreshShieldInputs` exists: a drift check against a cached
   * snapshot can only detect drift that the snapshot already happens to
   * know about.
   *
   * `inspect()` remains strictly read-only — this reports drift, it never
   * repairs it. Turning degraded back into active stays an explicit
   * "Repair Shield".
   */
  async function checkShieldHealth(): Promise<void> {
    const startDir = latestSummary.facts.repoRoot;
    if (!startDir) {
      await vscode.window.showInformationMessage("Open a Git repository first.");
      return;
    }
    try {
      const facts = await collectRepoFacts(startDir);
      if (!facts.isGitRepo || !facts.repoRoot) {
        await vscode.window.showInformationMessage("Open a Git repository first.");
        return;
      }
      const { summary, state } = await shieldManager.healthCheck(facts.repoRoot, {
        // Content drift of Shield's own evaluator copy: compared
        // byte-for-byte against the bundled source, which is the only way
        // to catch a hand edit that kept the ownership/version marker.
        evaluatorScriptSource: shieldEvaluatorScriptSource,
        // Profile drift: the live profile list from Settings, so an
        // `expectedGitHubLogin`/`trustedSshHostAliases`/`strictPushSetup`/
        // identity change made after Shield was enabled is reported.
        currentProfiles: getProfiles(),
        // Push-destination drift: the freshly resolved plain-push
        // destination (branch.<name>.pushRemote / remote.pushDefault /
        // pushurl all honoured by collectRepoFacts), not origin's fetch
        // URL — the same fact Shield's policy approves.
        currentPushDestination: {
          host: facts.pushRemoteHost,
          owner: facts.pushRemoteOwner,
          repo: facts.pushRemoteRepo,
        },
      });
      if (state === "active") {
        await vscode.window.showInformationMessage(summary);
      } else {
        await vscode.window.showWarningMessage(summary);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not check Shield health: ${getErrorMessage(error)}`);
    }
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
    vscode.commands.registerCommand("repoIdentityGuard.enableShield", () => enableShield()),
    vscode.commands.registerCommand("repoIdentityGuard.disableShield", () => disableShield()),
    vscode.commands.registerCommand("repoIdentityGuard.repairShield", () => repairShield()),
    vscode.commands.registerCommand("repoIdentityGuard.checkShieldHealth", () => checkShieldHealth()),
    vscode.window.onDidChangeActiveTextEditor(() => void scan()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void scan()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsRepoIdentityGuardConfig(event)) void scan();
    }),
    // A lighter-weight nudge for ordinary working-tree edits, which the
    // Git-dir watchers above don't cover (see reconcileRepoWatchers).
    vscode.workspace.onDidSaveTextDocument(() => scheduleDebouncedScan()),
    {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        disposeRepoWatchers();
        disposeGlobalGitConfigWatchers();
      },
    },
  );

  /**
   * In a multi-root workspace, this reflects `workspaceState` — the same
   * thing the status bar badge shows — never just the selected repo. A
   * status bar reading "Not Safe (1/2 repos)" whose click says "Safe to
   * work here" would be a trust-breaking contradiction.
   */
  async function showStatus(): Promise<void> {
    if (workspaceState.repos.length > 1) {
      const problems = workspaceProblemCount(workspaceState);
      const message =
        workspaceState.level === "safe"
          ? `Workspace is safe: all ${workspaceState.repos.length} repositories checked and safe.`
          : `Workspace is not safe: ${problems} of ${workspaceState.repos.length} repositories need attention.`;

      const choice = await (workspaceState.level === "safe"
        ? vscode.window.showInformationMessage(message, "Show Repositories")
        : vscode.window.showWarningMessage(message, "Show Repositories"));

      if (choice === "Show Repositories") {
        await vscode.commands.executeCommand("workbench.view.extension.repoIdentityGuard");
      }
      return;
    }

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
  for (const disposables of repoWatchers.values()) disposables.forEach((d) => d.dispose());
  repoWatchers.clear();
  disposeGlobalGitConfigWatchers();
}

function getActiveCwd(): string | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument?.uri.scheme === "file") {
    return path.dirname(activeDocument.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
