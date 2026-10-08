import * as path from "node:path";
import * as vscode from "vscode";
import { RepositoryRef } from "./identity/assignment";
import { resolveCurrentRepo } from "./identity/currentRepo";
import { IdentityLockService, LockOperationResult, LockStatus } from "./identity/identityLockService";
import { Identity, RepoIdentityState } from "./identity/types";
import {
  canonicalizeRepoPath,
  getEffectiveAuthorIdent,
  getGitDir,
  getWorktreeConfigEnabled,
  resolveIdentityConfigScope,
} from "./services/gitService";
import { SafeActionRunner } from "./services/safeActionRunner";
import { IdentityStatusBar } from "./statusBar";
import {
  affectsRepoIdentityGuardConfig,
  getIdentities,
  getIdentityList,
  getLegacyProfilesRaw,
  migrateLegacyProfilesToIdentities,
} from "./storage/configStore";
import { MAX_IMPORT_FILE_BYTES, MemoryExport, MemoryKeys, MemoryLimitError, MemoryStore } from "./storage/memoryStore";
import { NoteMutationResult, RepoIdentitySidebarProvider } from "./ui/SidebarProvider";
import { SidebarModel } from "./ui/wireState";

/**
 * Repo Identity Guard does two things:
 *  1. explicit per-repository identity locking (`IdentityLockService`), and
 *  2. private per-repository notes (`MemoryStore`).
 *
 * This file only wires those into VS Code: repository discovery, Workspace
 * Trust gating, confirmations, commands, and the (placeholder) sidebar.
 * An unassigned repository is never touched — the only automatic Git
 * mutations are removing/migrating a LEGACY Shield installation and
 * upgrading an identity lock from an earlier version in place (assignment
 * kept, pushes made fail-closed), and only in a trusted workspace.
 */

interface RepoEntry {
  /** Canonical checkout root — unique per worktree (linked worktrees share `ref.repoKey`). */
  id: string;
  ref: RepositoryRef;
  folderName?: string;
  repoName: string;
  memoryKeys: MemoryKeys;
  status?: LockStatus;
  statusError?: string;
  gitDir?: string;
}

let repos: RepoEntry[] = [];
let selectedId: string | undefined;
let scanSequence = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
const repoWatchers = new Map<string, vscode.Disposable[]>();
/** Per-repository serialization of every lock mutation (assign/change/unlock/repair/migrate), so two overlapping triggers can never race on the same hooks. */
const repoMutationQueues = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoMutationQueues.get(repoKey) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  repoMutationQueues.set(
    repoKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBar = new IdentityStatusBar();
  const memoryStore = new MemoryStore(context);
  const safeActionRunner = new SafeActionRunner();
  const lockService = new IdentityLockService({
    evaluatorScriptSource: path.join(context.extensionPath, "resources", "shield", "shield-evaluate.sh"),
  });
  const notifiedMigrations = new Set<string>();

  const sidebarProvider = new RepoIdentitySidebarProvider(context.extensionUri, {
    selectRepo: async (id) => {
      if (repos.some((repo) => repo.id === id)) selectedId = id;
      refreshViews();
    },
    // Sidebar actions always act on the repository the sidebar shows as
    // selected — never on whatever repository the active editor happens to
    // be in (that is the Command Palette's rule, see `commandTarget`).
    assignIdentity: (identityId) => assignIdentity(identityId, "assign", selectedEntry()),
    changeIdentity: (identityId) => assignIdentity(identityId, "change", selectedEntry()),
    unlockRepository: () => unlockRepository(selectedEntry()),
    repairLock: () => repairLock(selectedEntry()),
    checkLock: () => checkLock({ target: selectedEntry() }),
    applyIdentityToGitConfig: () => applyIdentityToGitConfig(selectedEntry()),
    editIdentities: () => editIdentities(),

    addNote: (text) => noteMutation((keys) => memoryStore.addNote(keys, text)),
    updateNote: (id, text) => noteMutation((keys) => memoryStore.updateNote(keys, id, text)),
    removeNote: async (id) => {
      const entry = selectedEntry();
      if (!entry) return;
      const choice = await vscode.window.showWarningMessage("Delete this note? This can't be undone.", "Delete", "Cancel");
      if (choice !== "Delete") return;
      await noteMutation((keys) => memoryStore.removeNote(keys, id));
    },
    togglePinNote: async (id) => {
      await noteMutation((keys) => memoryStore.togglePin(keys, id));
    },
    copyNote: async (id) => {
      const entry = selectedEntry();
      if (!entry) return;
      const text = memoryStore.getNoteText(entry.memoryKeys, id);
      if (text === undefined) return;
      await vscode.env.clipboard.writeText(text);
      await vscode.window.showInformationMessage("Note copied to the clipboard.");
    },
    exportNotes: () => exportNotes(false),
    exportAllNotes: () => exportNotes(true),
    importNotes: () => importNotes(),
  });

  context.subscriptions.push(statusBar);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("repoIdentityGuard.statusView", sidebarProvider));

  // ==================== state ====================

  // Unlike `commandTarget()`, this never lets the active editor override an
  // explicit sidebar selection — the (legacy, placeholder-only) sidebar
  // repository picker still works exactly as before. The production
  // contract being built in this phase has no such picker at all (see
  // `src/identity/currentRepo.ts`); this function is not part of it.
  function selectedEntry(): RepoEntry | undefined {
    return repos.find((repo) => repo.id === selectedId) ?? repos[0];
  }

  /**
   * The ONE repository the sidebar and every Command Palette command act
   * on right now — see `src/identity/currentRepo.ts` for the rule. This is
   * also `selectedEntry()`'s and `commandTargetFrom()`'s single shared
   * implementation: there is no repository picker, so "the sidebar's
   * selection" and "the command's target" are the same resolved value.
   */
  function commandTarget(list: RepoEntry[] = repos): RepoEntry | undefined {
    const activeFile = vscode.window.activeTextEditor?.document;
    return resolveCurrentRepo({
      repos: list.map((entry) => ({ id: entry.id, repoRoot: entry.ref.repoRoot, entry })),
      activeFilePath: activeFile?.uri.scheme === "file" ? activeFile.uri.fsPath : undefined,
      previousId: selectedId,
    })?.entry;
  }

  function toState(entry: RepoEntry): RepoIdentityState {
    const notes = memoryStore.getMemory(entry.memoryKeys).notes;
    if (!entry.status) {
      return {
        repositoryPresent: true,
        repoKey: entry.ref.repoKey,
        repoName: entry.repoName,
        repoRoot: entry.ref.repoRoot,
        enforcement: {
          state: "unavailable",
          reason: entry.statusError ?? "This repository could not be inspected.",
          commitEnforced: false,
          push: "none",
          repairAvailable: false,
          unlockAvailable: false,
        },
        notes,
      };
    }
    return {
      repositoryPresent: true,
      repoKey: entry.ref.repoKey,
      repoName: entry.repoName,
      repoRoot: entry.ref.repoRoot,
      assignment: entry.status.assignmentView,
      enforcement: entry.status.enforcement,
      notes,
    };
  }

  function buildModel(): SidebarModel {
    const list = getIdentityList();
    return {
      repos: repos.map((entry) => ({ id: entry.id, folderName: entry.folderName, state: toState(entry) })),
      selectedId: selectedEntry()?.id,
      identities: list.identities,
      identityProblems: list.rejected.map((r) => `Identity #${r.index + 1} in settings is ignored: ${r.errors.join(" ")}`),
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    };
  }

  function refreshViews(): void {
    sidebarProvider.update(buildModel());
    const entry = selectedEntry();
    statusBar.update(entry ? toState(entry) : undefined);
  }

  async function requireTrust(what: string): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    await vscode.window.showWarningMessage(
      `This workspace isn't trusted, so Repo Identity Guard won't ${what}. Locking, changing or unlocking an identity installs or removes Git hooks and needs Workspace Trust; notes work without it.`,
    );
    return false;
  }

  // ==================== scanning ====================

  function getScanTargets(): { path: string; folderName?: string }[] {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders.map((folder) => ({ path: folder.uri.fsPath, folderName: folder.name }));
    const activeFile = vscode.window.activeTextEditor?.document;
    return activeFile?.uri.scheme === "file" ? [{ path: path.dirname(activeFile.uri.fsPath) }] : [];
  }

  /**
   * Passive refresh — cheap and read-only for every repository (no network,
   * no `ssh`). The exceptions, in a trusted workspace only: a legacy
   * Shield installation is migrated or removed, because an unassigned
   * repository must not keep hooks that block Git; and an identity lock
   * from an earlier version is upgraded in place, because its installed
   * evaluator could still let pushes through unchecked.
   */
  async function scan(): Promise<void> {
    const sequence = ++scanSequence;
    const identities = getIdentities();
    const next: RepoEntry[] = [];
    const seen = new Set<string>();

    for (const target of getScanTargets()) {
      try {
        const ref = await lockService.resolveRepository(target.path);
        if (!ref) continue;
        const id = await canonicalizeRepoPath(ref.repoRoot);
        if (seen.has(id)) continue;
        seen.add(id);

        const memoryKeys = await memoryStore.resolveKeys(ref.repoRoot, ref.gitCommonDir);
        await memoryStore.reconcileLegacyKeys(ref.repoRoot, memoryKeys);

        const entry: RepoEntry = { id, ref, folderName: target.folderName, repoName: path.basename(ref.repoRoot), memoryKeys };
        try {
          entry.status = await lockService.getStatus(ref, identities);
          if (entry.status.legacy && vscode.workspace.isTrusted) {
            entry.status = await migrateLegacyInstallation(ref, identities, entry.status);
          } else if (entry.status.inspection.policyNeedsUpgrade && vscode.workspace.isTrusted) {
            entry.status = await upgradePreviousLock(ref, identities, entry.status);
          }
        } catch (error) {
          entry.statusError = errorMessage(error);
        }
        entry.gitDir = (await getGitDir(ref.repoRoot).catch(() => null)) ?? undefined;
        next.push(entry);
      } catch {
        // One unreadable folder must never hide every other repository.
      }
    }

    if (sequence !== scanSequence) return;
    repos = next;
    if (!repos.some((repo) => repo.id === selectedId)) {
      selectedId = commandTargetFrom(next)?.id;
    }
    refreshViews();
    reconcileWatchers();
  }

  function commandTargetFrom(list: RepoEntry[]): RepoEntry | undefined {
    return commandTarget(list);
  }

  async function migrateLegacyInstallation(ref: RepositoryRef, identities: Identity[], current: LockStatus): Promise<LockStatus> {
    const outcome = await withRepoLock(ref.repoKey, () =>
      lockService.migrateLegacy(ref, { legacyProfiles: getLegacyProfilesRaw(), identities }),
    );
    if (outcome.kind === "none") return current;
    const name = path.basename(ref.repoRoot);
    if (!notifiedMigrations.has(ref.repoKey)) {
      notifiedMigrations.add(ref.repoKey);
      if (outcome.kind === "failed") {
        void vscode.window.showWarningMessage(`Repo Identity Guard (${name}): ${outcome.message} ${outcome.details.join(" ")}`);
      } else {
        void vscode.window.showInformationMessage(`Repo Identity Guard (${name}): ${outcome.message}`);
      }
    }
    return outcome.status ?? current;
  }

  /**
   * Upgrades an identity lock written by an earlier version in place —
   * assignment kept, commits still enforced, pushes now fail-closed when
   * the identity has no GitHub login. Never chains a foreign hook on its
   * own: that stays an explicit choice (offered by Repair).
   */
  async function upgradePreviousLock(ref: RepositoryRef, identities: Identity[], current: LockStatus): Promise<LockStatus> {
    const outcome = await withRepoLock(ref.repoKey, () => lockService.upgradePreviousLock(ref, { identities }));
    if (outcome.kind === "none") return current;
    const name = path.basename(ref.repoRoot);
    if (!notifiedMigrations.has(ref.repoKey)) {
      notifiedMigrations.add(ref.repoKey);
      if (outcome.kind === "failed") {
        void vscode.window.showWarningMessage(`Repo Identity Guard (${name}): ${outcome.message} ${outcome.details.join(" ")}`);
      } else if (outcome.status.enforcement.state !== "active") {
        void vscode.window.showWarningMessage(`Repo Identity Guard (${name}): ${outcome.message}`);
      } else {
        void vscode.window.showInformationMessage(`Repo Identity Guard (${name}): ${outcome.message}`);
      }
    }
    return outcome.status ?? current;
  }

  function scheduleScan(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void scan(), 300);
  }

  /**
   * Watches only what can change a lock's state: Git config (identity,
   * core.hooksPath), the lock's own storage directory, and the hook files
   * themselves (e.g. a hook deleted or replaced by another tool).
   */
  function reconcileWatchers(): void {
    const ids = new Set(repos.map((repo) => repo.id));
    for (const [id, disposables] of repoWatchers) {
      if (!ids.has(id)) {
        disposables.forEach((d) => d.dispose());
        repoWatchers.delete(id);
      }
    }
    for (const repo of repos) {
      if (repoWatchers.has(repo.id)) continue;
      const patterns: vscode.RelativePattern[] = [];
      for (const dir of new Set([repo.gitDir, repo.ref.gitCommonDir].filter((d): d is string => !!d))) {
        patterns.push(new vscode.RelativePattern(vscode.Uri.file(dir), "{config,config.worktree}"));
      }
      patterns.push(new vscode.RelativePattern(vscode.Uri.file(repo.ref.gitCommonDir), "repo-identity-guard/**"));
      const hooksDir = repo.status?.inspection.gitContext?.hooksDir;
      if (hooksDir) patterns.push(new vscode.RelativePattern(vscode.Uri.file(hooksDir), "{pre-commit,pre-merge-commit,pre-push}*"));
      const disposables = patterns.map((pattern) => {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(scheduleScan);
        watcher.onDidCreate(scheduleScan);
        watcher.onDidDelete(scheduleScan);
        return watcher;
      });
      repoWatchers.set(repo.id, disposables);
    }
  }

  // ==================== identity lock actions ====================

  function showOperationResult(result: LockOperationResult): void {
    const text = [result.message, ...result.details].filter(Boolean).join(" ");
    if (result.ok) void vscode.window.showInformationMessage(text);
    else void vscode.window.showErrorMessage(text);
  }

  async function pickIdentity(excludeId?: string): Promise<Identity | undefined> {
    const identities = getIdentities().filter((identity) => identity.id !== excludeId);
    if (identities.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        "No identities are configured yet. Add one (label, Git name/email, the GitHub login pushes must authenticate as, and a trusted SSH host alias) in settings first.",
        "Edit Identities",
      );
      if (choice) await editIdentities();
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      identities.map((identity) => ({
        label: identity.label,
        description: `${identity.gitName ? `${identity.gitName} ` : ""}<${identity.gitEmail}>`,
        detail: identity.expectedGitHubLogin
          ? `Pushes must authenticate as GitHub user ${identity.expectedGitHubLogin}`
          : "Incomplete: no GitHub login configured, so every push from a locked repository is blocked",
        identity,
      })),
      { title: "Repo Identity Guard: choose the identity to lock this repository to" },
    );
    return picked?.identity;
  }

  async function assignIdentity(identityId: string | undefined, mode: "assign" | "change", target: RepoEntry | undefined = commandTarget()): Promise<void> {
    const entry = target;
    if (!entry) {
      await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return;
    }
    const current = entry.status?.assignmentView;
    if (mode === "change" && !current) {
      await vscode.window.showInformationMessage("This repository has no assigned identity yet — use Assign Identity instead.");
      return;
    }
    const identity = identityId ? getIdentities().find((candidate) => candidate.id === identityId) : await pickIdentity(current?.identityId);
    if (!identity) {
      if (identityId) await vscode.window.showErrorMessage("That identity no longer exists in settings.");
      return;
    }
    if (!(await requireTrust("lock this repository"))) return;

    const pushLine = identity.expectedGitHubLogin
      ? (identity.trustedSshHostAliases ?? []).length > 0
        ? ` Pushes must authenticate to GitHub as ${identity.expectedGitHubLogin} through one of: ${(identity.trustedSshHostAliases ?? []).join(", ")}.`
        : ` WARNING: ${identity.label} expects GitHub user ${identity.expectedGitHubLogin} but lists no trusted SSH host alias, so every push will be blocked until one is added.`
      : ` WARNING: ${identity.label} has no GitHub account configured for push verification, so every push will be blocked until one is configured.`;
    const confirm = await vscode.window.showWarningMessage(
      `${current ? `Change ${entry.repoName} from "${current.identityLabel}" to` : `Lock ${entry.repoName} to`} "${identity.label}"?\n\nCommits whose author or committer is not ${identity.gitName ? `${identity.gitName} ` : ""}<${identity.gitEmail}> will be blocked.${pushLine}\n\nThis uses local Git hooks, so it applies in every terminal, Git GUI and AI agent, even with VS Code closed. Repository: ${entry.ref.repoRoot}`,
      { modal: true },
      current ? "Change Identity" : "Lock Repository",
    );
    if (!confirm) return;

    // A foreign hook already in a slot the lock needs is never touched
    // silently: chaining it is an explicit choice.
    let chainForeignHooks = false;
    if (entry.status) {
      const chain = await confirmChainingForeignHooks(entry.status);
      if (chain === undefined) return;
      chainForeignHooks = chain;
    }

    const result = await withRepoLock(entry.ref.repoKey, () =>
      lockService.assign(entry.ref, identity, { chainForeignHooks, identities: getIdentities() }),
    );
    showOperationResult(result);
    await scan();
    if (!result.ok) return;

    const effective = await getEffectiveAuthorIdent(entry.ref.repoRoot).catch(() => ({ email: undefined }));
    if ((effective.email ?? "").trim().toLowerCase() !== identity.gitEmail.trim().toLowerCase()) {
      const choice = await vscode.window.showWarningMessage(
        `Git currently commits here as ${effective.email ?? "an unknown identity"}, so commits will be blocked until this repository uses ${identity.gitEmail}.`,
        "Use Assigned Identity in Git Config",
      );
      if (choice) await applyIdentityToGitConfig(repos.find((repo) => repo.id === entry.id) ?? entry);
    }
    if (identity.expectedGitHubLogin && (identity.trustedSshHostAliases ?? []).length > 0) {
      await checkLock({ quietWhenVerified: true, target: repos.find((repo) => repo.id === entry.id) ?? entry });
    }
  }

  /**
   * A lock governs every hook slot (commit AND push). A foreign hook in any
   * of them is never touched silently: chaining it is an explicit choice.
   * Returns false when there is nothing to chain, true when the user chose
   * to chain, and undefined when they declined (abort).
   */
  async function confirmChainingForeignHooks(status: LockStatus): Promise<boolean | undefined> {
    const foreign = status.inspection.hooks.filter((hook) => hook.ownership === "foreign");
    if (foreign.length === 0) return false;
    const chain = await vscode.window.showWarningMessage(
      `This repository already has its own ${foreign.map((hook) => hook.fileName).join(", ")} hook. Repo Identity Guard can keep it: the identity check runs first, then your hook runs exactly as before (and is restored byte-for-byte on unlock).`,
      { modal: true },
      "Keep My Hook (Chain It)",
    );
    return chain ? true : undefined;
  }

  async function unlockRepository(target: RepoEntry | undefined = commandTarget()): Promise<void> {
    const entry = target;
    if (!entry) {
      await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return;
    }
    if (!entry.status?.enforcement.unlockAvailable) {
      await vscode.window.showInformationMessage(`${entry.repoName} is not locked.`);
      return;
    }
    if (!(await requireTrust("unlock this repository"))) return;
    const label = entry.status.assignmentView?.identityLabel;
    const confirm = await vscode.window.showWarningMessage(
      `Unlock ${entry.repoName}${label ? ` (currently locked to "${label}")` : ""}?\n\nRepo Identity Guard removes its hooks (restoring any hook it chained), and Git is no longer restricted in this repository. Your notes are kept.`,
      { modal: true },
      "Unlock",
    );
    if (!confirm) return;
    const result = await withRepoLock(entry.ref.repoKey, () => lockService.unlock(entry.ref, getIdentities()));
    showOperationResult(result);
    await scan();
  }

  async function repairLock(target: RepoEntry | undefined = commandTarget()): Promise<void> {
    const entry = target;
    if (!entry) {
      await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return;
    }
    if (!(await requireTrust("repair the identity lock"))) return;
    const identities = getIdentities();
    if (entry.status?.legacy) {
      notifiedMigrations.delete(entry.ref.repoKey);
      await migrateLegacyInstallation(entry.ref, identities, entry.status);
      await scan();
      return;
    }
    // Repair re-installs every hook slot; a foreign hook now occupying one
    // (e.g. a pre-push hook next to a lock from an earlier version that did
    // not need that slot) is only ever chained with explicit consent.
    const chainForeignHooks = entry.status ? await confirmChainingForeignHooks(entry.status) : false;
    if (chainForeignHooks === undefined) return;
    const result = await withRepoLock(entry.ref.repoKey, () => lockService.repair(entry.ref, identities, { chainForeignHooks }));
    showOperationResult(result);
    await scan();
  }

  /**
   * Explicit health check. The ONLY place (besides right after assigning)
   * that makes a network connection: it verifies the push account over the
   * real SSH route, exactly as the pre-push hook would.
   */
  async function checkLock(options: { quietWhenVerified?: boolean; target?: RepoEntry } = {}): Promise<void> {
    const entry = options.target ?? commandTarget();
    if (!entry) {
      await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return;
    }
    const identities = getIdentities();
    const status = await lockService.getStatus(entry.ref, identities);
    const view = status.assignmentView;
    if (!view) {
      await vscode.window.showInformationMessage(
        status.enforcement.state === "unassigned"
          ? `${entry.repoName} is not locked; Repo Identity Guard does not restrict Git here.`
          : `${entry.repoName}: ${status.enforcement.reason ?? "the identity lock needs attention."}`,
      );
      return;
    }
    const snapshot = status.inspection.policySnapshot;
    const identity: Identity = {
      id: view.identityId,
      label: view.identityLabel,
      gitName: view.gitName,
      gitEmail: view.gitEmail,
      expectedGitHubLogin: view.expectedGitHubLogin,
      trustedSshHostAliases: snapshot?.trustedSshHostAliases,
    };
    const push = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Repo Identity Guard: checking the push account…" },
      () => lockService.checkPushAccount(entry.ref, identity),
    );
    const lockLine =
      status.enforcement.state === "active"
        ? `${entry.repoName} is locked to "${view.identityLabel}".`
        : `${entry.repoName} (locked to "${view.identityLabel}") needs attention: ${status.enforcement.reason ?? ""}`;
    const message = `${lockLine} ${push.message}`;
    if (status.enforcement.state === "active" && push.status === "verified") {
      if (!options.quietWhenVerified) await vscode.window.showInformationMessage(message);
    } else {
      await vscode.window.showWarningMessage(message);
    }
  }

  async function applyIdentityToGitConfig(target: RepoEntry | undefined = commandTarget()): Promise<void> {
    const entry = target;
    const view = entry?.status?.assignmentView;
    if (!entry || !view) {
      await vscode.window.showInformationMessage("This repository has no assigned identity.");
      return;
    }
    if (!(await requireTrust("change this repository's Git config"))) return;
    const scope = resolveIdentityConfigScope(await getWorktreeConfigEnabled(entry.ref.repoRoot).catch(() => null));
    const confirm = await vscode.window.showWarningMessage(
      `Set ${entry.repoName}'s Git identity to ${view.gitName ? `${view.gitName} ` : ""}<${view.gitEmail}>? This writes user.${view.gitName ? "name/user." : ""}email with "git config --${scope}" for this repository only; your global Git config is never touched.`,
      { modal: true },
      "Set Git Identity",
    );
    if (!confirm) return;
    try {
      await safeActionRunner.setLocalIdentity(entry.ref.repoRoot, view.gitName, view.gitEmail, scope);
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not set the Git identity: ${errorMessage(error)}`);
      return;
    }
    const effective = await getEffectiveAuthorIdent(entry.ref.repoRoot).catch(() => ({ email: undefined }));
    if ((effective.email ?? "").trim().toLowerCase() === view.gitEmail.trim().toLowerCase()) {
      await vscode.window.showInformationMessage(`${entry.repoName} now commits as ${view.gitEmail}.`);
    } else {
      await vscode.window.showWarningMessage(
        `Git config was updated, but Git still resolves ${effective.email ?? "a different identity"} here — an environment variable (GIT_AUTHOR_EMAIL, GIT_COMMITTER_EMAIL, EMAIL) is overriding it in VS Code's environment.`,
      );
    }
    await scan();
  }

  async function editIdentities(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.openSettings", "repoIdentityGuard.identities");
  }

  // ==================== notes actions (no Workspace Trust needed: local data only, never executed) ====================

  async function noteMutation(mutate: (keys: MemoryKeys) => Promise<unknown>): Promise<NoteMutationResult> {
    const entry = selectedEntry();
    if (!entry) return { ok: false, error: "Open a Git repository first." };
    try {
      await mutate(entry.memoryKeys);
    } catch (error) {
      const message = error instanceof MemoryLimitError ? error.message : "Something went wrong saving the note.";
      await vscode.window.showWarningMessage(message);
      return { ok: false, error: message };
    }
    refreshViews();
    return { ok: true };
  }

  async function writeExport(data: MemoryExport, defaultFileName: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultFileName),
      filters: { "Repo Notes export": ["json"] },
      title: "Export Repo Notes",
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), "utf8"));
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not write the export file: ${errorMessage(error)}`);
      return;
    }
    await vscode.window.showInformationMessage(`Exported notes to ${uri.fsPath}`);
  }

  async function exportNotes(all: boolean): Promise<void> {
    if (all) {
      if (repos.length === 0) {
        await vscode.window.showInformationMessage("No repositories detected to export.");
        return;
      }
      // Labels are repository/folder names only — never a local path, since
      // an export is a file the user may share.
      await writeExport(
        memoryStore.exportAllMemory(repos.map((repo) => ({ label: repo.repoName || repo.folderName || "(unnamed repository)", keys: repo.memoryKeys }))),
        "repo-notes-all.json",
      );
      return;
    }
    const entry = selectedEntry();
    if (!entry) return;
    await writeExport(memoryStore.exportMemory(entry.memoryKeys, entry.repoName), `repo-notes-${entry.repoName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "repo"}.json`);
  }

  async function importNotes(): Promise<void> {
    const entry = selectedEntry();
    if (!entry) return;
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Repo Notes export": ["json"] }, title: "Import Repo Notes" });
    if (!uris || uris.length === 0) return;

    let raw: unknown;
    try {
      const stat = await vscode.workspace.fs.stat(uris[0]);
      if (stat.size > MAX_IMPORT_FILE_BYTES) {
        await vscode.window.showErrorMessage("That file is larger than a Repo Notes export can be — it is likely the wrong file.");
        return;
      }
      raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString("utf8"));
    } catch {
      await vscode.window.showErrorMessage("Could not read that file as JSON.");
      return;
    }

    const filePreview = memoryStore.previewImportFile(raw);
    if (!filePreview.valid) {
      await vscode.window.showErrorMessage(filePreview.error ?? "This file isn't a valid Repo Notes export.");
      return;
    }
    let entryIndex = 0;
    if (filePreview.entries.length > 1) {
      const picked = await vscode.window.showQuickPick(
        filePreview.entries.map((e) => ({ label: e.label, description: `${e.noteCount} note${e.noteCount === 1 ? "" : "s"}`, entryIndex: e.index })),
        { title: "Import Repo Notes", placeHolder: "This file has notes from more than one repository. Which one should be imported into the current repository?" },
      );
      if (!picked) return;
      entryIndex = picked.entryIndex;
    }
    const preview = memoryStore.previewImportEntry(entry.memoryKeys, raw, entryIndex);
    if (!preview.valid) {
      await vscode.window.showErrorMessage(preview.error ?? "This file isn't a valid Repo Notes export.");
      return;
    }
    const lines = [`This will import ${preview.noteCount} note(s) into ${entry.repoName}. Imported notes are plain text and are never run.`];
    if (preview.duplicateNoteIds.length > 0) lines.push(`${preview.duplicateNoteIds.length} note(s) already exist here and will be skipped unless you choose to overwrite them.`);
    const actions = preview.duplicateNoteIds.length > 0 ? ["Import (skip duplicates)", "Import and overwrite duplicates"] : ["Import"];
    const choice = await vscode.window.showInformationMessage(lines.join("\n\n"), { modal: true }, ...actions);
    if (!choice) return;
    try {
      await memoryStore.importMemory(entry.memoryKeys, raw, entryIndex, { overwriteDuplicates: choice === "Import and overwrite duplicates" });
    } catch (error) {
      await vscode.window.showWarningMessage(error instanceof MemoryLimitError ? error.message : "Something went wrong importing notes.");
      return;
    }
    refreshViews();
    await vscode.window.showInformationMessage("Notes imported.");
  }

  // ==================== registration ====================

  context.subscriptions.push(
    vscode.commands.registerCommand("repoIdentityGuard.open", () => vscode.commands.executeCommand("workbench.view.extension.repoIdentityGuard")),
    vscode.commands.registerCommand("repoIdentityGuard.assignIdentity", () => assignIdentity(undefined, "assign")),
    vscode.commands.registerCommand("repoIdentityGuard.changeIdentity", () => assignIdentity(undefined, "change")),
    vscode.commands.registerCommand("repoIdentityGuard.unlockRepository", () => unlockRepository()),
    vscode.commands.registerCommand("repoIdentityGuard.repairLock", () => repairLock()),
    vscode.commands.registerCommand("repoIdentityGuard.checkLock", () => checkLock()),
    vscode.commands.registerCommand("repoIdentityGuard.applyIdentityToGitConfig", () => applyIdentityToGitConfig()),
    vscode.commands.registerCommand("repoIdentityGuard.editIdentities", () => editIdentities()),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleScan()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void scan()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsRepoIdentityGuardConfig(event)) void scan();
    }),
    {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        for (const disposables of repoWatchers.values()) disposables.forEach((d) => d.dispose());
        repoWatchers.clear();
      },
    },
  );

  // One-time, idempotent data migrations: saved commands → notes (schema
  // v3), and legacy profiles → identities. Neither ever creates an
  // assignment or executes anything.
  await memoryStore.migrateStorage().catch(() => false);
  const identityMigration = await migrateLegacyProfilesToIdentities().catch(() => ({ migrated: 0, rejected: 0 }));
  if (identityMigration.migrated > 0 || identityMigration.rejected > 0) {
    void vscode.window.showInformationMessage(
      `Repo Identity Guard converted ${identityMigration.migrated} legacy profile(s) into identities${identityMigration.rejected > 0 ? ` (${identityMigration.rejected} could not be converted)` : ""}. Profiles no longer match repositories automatically: assign an identity to each repository you want locked.`,
    );
  }
  void scan();
}

export function deactivate(): void {
  for (const disposables of repoWatchers.values()) disposables.forEach((d) => d.dispose());
  repoWatchers.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
