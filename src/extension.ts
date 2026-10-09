import * as path from "node:path";
import * as vscode from "vscode";
import { RepositoryRef } from "./identity/assignment";
import { resolveCurrentRepo } from "./identity/currentRepo";
import { checkEffectiveIdentity, EffectiveIdentityCheck } from "./identity/effectiveIdentityCheck";
import { IdentityDraft } from "./identity/identityCrud";
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
  createIdentitySetting,
  deleteIdentitySetting,
  getIdentities,
  getLegacyProfilesRaw,
  migrateLegacyProfilesToIdentities,
  updateIdentitySetting,
} from "./storage/configStore";
import { MAX_IMPORT_FILE_BYTES, MemoryExport, MemoryKeys, MemoryLimitError, MemoryStore } from "./storage/memoryStore";
import { ProductionSidebarActions, RepoIdentitySidebarProvider } from "./ui/SidebarProvider";
import { buildRepoIdentityUiState, RepoIdentityUiState } from "./ui/productionState";
import { OperationResult } from "./ui/protocol";

/**
 * Repo Identity Guard does two things:
 *  1. explicit per-repository identity locking (`IdentityLockService`), and
 *  2. private per-repository notes (`MemoryStore`).
 *
 * This file only wires those into VS Code: repository discovery, Workspace
 * Trust gating, confirmations, commands, and the production sidebar. An
 * unassigned repository is never touched — the only automatic Git
 * mutations are removing/migrating a LEGACY Shield installation and
 * upgrading an identity lock from an earlier version in place (assignment
 * kept, pushes made fail-closed), and only in a trusted workspace.
 *
 * There are two distinct entry points into the same underlying operations:
 *  - Command Palette commands, which have no webview and so still confirm
 *    destructive/consequential actions with NATIVE VS Code dialogs
 *    (`showWarningMessage`), exactly as before this phase;
 *  - the production webview (`src/ui/SidebarProvider.ts` /
 *    `src/webview/client/productionView.ts`), which shows its OWN
 *    confirmation screens (Assign/Unlock) — see "ASSIGNMENT CONFIRMATION"
 *    in the task spec. To avoid confirming twice, webview-driven calls
 *    pass `{ silent: true }`, which skips ONLY the native "are you sure"
 *    dialog; Workspace Trust enforcement (`requireTrust`) and the
 *    foreign-hook-chaining decision (`confirmChainingForeignHooks`, a
 *    separate, rare, meaningful decision kept as a native dialog on
 *    purpose) are never skipped.
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
/** The last repository `commandTarget()` resolved to — fed back in as `previousId` so switching to an unrelated file (an output panel, a diff view) doesn't make the UI jump to a different repository than the one the user was just working in (see `src/identity/currentRepo.ts` rule C). Not a user-facing selection: there is no repository picker. */
let lastResolvedRepoId: string | undefined;
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

  // ==================== state ====================

  /**
   * The ONE repository the sidebar and every Command Palette command act
   * on right now — see `src/identity/currentRepo.ts` for the rule.
   */
  function commandTarget(list: RepoEntry[] = repos): RepoEntry | undefined {
    const activeFile = vscode.window.activeTextEditor?.document;
    const resolved = resolveCurrentRepo({
      repos: list.map((entry) => ({ id: entry.id, repoRoot: entry.ref.repoRoot, entry })),
      activeFilePath: activeFile?.uri.scheme === "file" ? activeFile.uri.fsPath : undefined,
      previousId: lastResolvedRepoId,
    });
    lastResolvedRepoId = resolved?.id;
    return resolved?.entry;
  }

  /**
   * Host-side defense against the webview targeting race: the UI shows
   * repo A; the active editor switches to repo B; the debounced scan/state
   * push hasn't reached the webview yet; the user clicks a repo-A action.
   * `repoId` is the id the VISIBLE SCREEN was bound to (never a picker —
   * see `src/ui/protocol.ts`); this resolves the ACTUAL current repository
   * right now and returns it ONLY when it still matches `repoId`. A
   * mismatch returns `undefined` and the caller must reject the request
   * (never act on A, the stale target, and never act on B, the resolver's
   * current answer, either) with `{ code: "repository_changed" }` and
   * refresh the webview's authoritative state — see `repositoryChanged()`.
   *
   * Once a caller has a validated target, it must pass that SAME
   * `RepoEntry` explicitly into whatever it calls next (`assignIdentity`,
   * `unlockRepository`, `noteMutation`, …) rather than letting that
   * function fall back to its own `commandTarget()` default — a second
   * resolution deeper in the same request would reopen the exact race
   * this function exists to close.
   */
  function validateRepoTarget(repoId: string): RepoEntry | undefined {
    const current = commandTarget();
    return current && current.id === repoId ? current : undefined;
  }

  const REPOSITORY_CHANGED_RESULT: OperationResult = {
    ok: false,
    code: "repository_changed",
    message: "The current repository changed. Please try again.",
  };

  /** Called when `validateRepoTarget` rejects a stale repo-scoped request. Mutates nothing; only pushes the webview's authoritative state so it can reconcile (e.g. drop a now-stale screen) on its own. */
  function repositoryChanged(): OperationResult {
    refreshViews();
    return REPOSITORY_CHANGED_RESULT;
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

  /**
   * The production UI's DTO for whatever repository is current right now
   * — see `src/ui/productionState.ts`. The passive effective-identity
   * check is only ever run for a FULLY active lock (see that module's
   * doc comment), and only against the CURRENT repository: it is a cheap
   * `git var` read, not a network call, but there is no reason to pay it
   * for every other known repository on each refresh.
   */
  async function buildProductionState(): Promise<RepoIdentityUiState> {
    const identities = getIdentities();
    const entry = commandTarget();
    if (!entry) {
      return buildRepoIdentityUiState({ liveIdentities: identities, notes: [], isWorkspaceTrusted: vscode.workspace.isTrusted });
    }
    const notes = memoryStore.getMemory(entry.memoryKeys).notes;
    let passiveIdentityCheck: EffectiveIdentityCheck | undefined;
    if (entry.status?.enforcement.state === "active") {
      const snapshot = entry.status.inspection.policySnapshot;
      const view = entry.status.assignmentView;
      const expectedGitEmail = snapshot?.expectedGitEmail ?? view?.gitEmail;
      const expectedGitName = snapshot?.expectedGitName ?? view?.gitName;
      if (expectedGitEmail) {
        passiveIdentityCheck = await checkEffectiveIdentity(entry.ref.repoRoot, { gitEmail: expectedGitEmail, gitName: expectedGitName }).catch(
          (): EffectiveIdentityCheck => ({ inspectionFailed: true, matches: false, effectiveAuthor: {}, effectiveCommitter: {}, authorViolates: false, committerViolates: false }),
        );
      }
    }
    return buildRepoIdentityUiState({
      repo: { id: entry.id, name: entry.repoName },
      status: entry.status,
      liveIdentities: identities,
      passiveIdentityCheck,
      notes,
      isWorkspaceTrusted: vscode.workspace.isTrusted,
    });
  }

  const sidebarProvider = new RepoIdentitySidebarProvider(context.extensionUri, buildProductionActions());

  context.subscriptions.push(statusBar);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("repoIdentityGuard.statusView", sidebarProvider));

  function refreshViews(): void {
    sidebarProvider.update();
    const entry = commandTarget();
    statusBar.update(entry ? toState(entry) : undefined);
  }

  async function requireTrust(what: string, notify = true): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    if (notify) {
      await vscode.window.showWarningMessage(
        `This workspace isn't trusted, so Repo Identity Guard won't ${what}. Locking, changing or unlocking an identity installs or removes Git hooks and needs Workspace Trust; notes work without it.`,
      );
    }
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
    refreshViews();
    reconcileWatchers();
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

  /**
   * A lock governs every hook slot (commit AND push). A foreign hook in any
   * of them is never touched silently: chaining it is an explicit choice —
   * see this file's top doc comment on why this native dialog is kept for
   * BOTH the Command Palette and the webview path.
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

  /**
   * Assigns/changes the identity for `target`. `opts.silent` is set by the
   * webview path: it already showed its OWN confirmation screen (see
   * "ASSIGNMENT CONFIRMATION"), so the big native confirm dialog below is
   * skipped — Workspace Trust and foreign-hook-chaining are not. Always
   * returns a result; the Command Palette path additionally shows native
   * notifications (`showOperationResult`) the webview path does not need
   * (its own screen already reflects the outcome).
   */
  async function assignIdentity(
    identityId: string | undefined,
    mode: "assign" | "change",
    target: RepoEntry | undefined = commandTarget(),
    opts: { silent?: boolean } = {},
  ): Promise<LockOperationResult> {
    const entry = target;
    if (!entry) {
      if (!opts.silent) await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return { ok: false, message: "Open a Git repository first.", details: [] };
    }
    const current = entry.status?.assignmentView;
    if (mode === "change" && !current) {
      if (!opts.silent) await vscode.window.showInformationMessage("This repository has no assigned identity yet — use Assign Identity instead.");
      return { ok: false, message: "This repository has no assigned identity yet.", details: [] };
    }
    const identity = identityId ? getIdentities().find((candidate) => candidate.id === identityId) : await pickIdentity(current?.identityId);
    if (!identity) {
      if (identityId && !opts.silent) await vscode.window.showErrorMessage("That identity no longer exists in settings.");
      return { ok: false, message: "That identity no longer exists in settings.", details: [] };
    }
    if (!(await requireTrust("lock this repository", !opts.silent))) {
      return { ok: false, message: "This workspace isn't trusted, so Repo Identity Guard can't lock this repository.", details: [] };
    }

    if (!opts.silent) {
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
      if (!confirm) return { ok: false, message: "Cancelled.", details: [] };
    }

    // A foreign hook already in a slot the lock needs is never touched
    // silently: chaining it is an explicit choice, in BOTH paths.
    let chainForeignHooks = false;
    if (entry.status) {
      const chain = await confirmChainingForeignHooks(entry.status);
      if (chain === undefined) return { ok: false, message: "Cancelled.", details: [] };
      chainForeignHooks = chain;
    }

    const result = await withRepoLock(entry.ref.repoKey, () =>
      lockService.assign(entry.ref, identity, { chainForeignHooks, identities: getIdentities() }),
    );
    if (!opts.silent) showOperationResult(result);
    await scan();
    if (!result.ok) return result;

    if (!opts.silent) {
      // These native-dialog nudges are only useful alongside native
      // notifications; the webview path instead reflects the SAME
      // underlying facts declaratively (Needs Attention / git_identity_mismatch,
      // push_identity_incomplete) via the next `state` push.
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
    return result;
  }

  async function unlockRepository(target: RepoEntry | undefined = commandTarget(), opts: { silent?: boolean } = {}): Promise<LockOperationResult> {
    const entry = target;
    if (!entry) {
      if (!opts.silent) await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return { ok: false, message: "Open a Git repository first.", details: [] };
    }
    if (!entry.status?.enforcement.unlockAvailable) {
      if (!opts.silent) await vscode.window.showInformationMessage(`${entry.repoName} is not locked.`);
      return { ok: false, message: `${entry.repoName} is not locked.`, details: [] };
    }
    if (!(await requireTrust("unlock this repository", !opts.silent))) {
      return { ok: false, message: "This workspace isn't trusted, so Repo Identity Guard can't unlock this repository.", details: [] };
    }
    if (!opts.silent) {
      const label = entry.status.assignmentView?.identityLabel;
      const confirm = await vscode.window.showWarningMessage(
        `Unlock ${entry.repoName}${label ? ` (currently locked to "${label}")` : ""}?\n\nRepo Identity Guard removes its hooks (restoring any hook it chained), and Git is no longer restricted in this repository. Your notes are kept.`,
        { modal: true },
        "Unlock",
      );
      if (!confirm) return { ok: false, message: "Cancelled.", details: [] };
    }
    const result = await withRepoLock(entry.ref.repoKey, () => lockService.unlock(entry.ref, getIdentities()));
    if (!opts.silent) showOperationResult(result);
    await scan();
    return result;
  }

  async function repairLock(target: RepoEntry | undefined = commandTarget(), opts: { silent?: boolean } = {}): Promise<LockOperationResult> {
    const entry = target;
    if (!entry) {
      if (!opts.silent) await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return { ok: false, message: "Open a Git repository first.", details: [] };
    }
    if (!(await requireTrust("repair the identity lock", !opts.silent))) {
      return { ok: false, message: "This workspace isn't trusted, so Repo Identity Guard can't repair this repository's identity lock.", details: [] };
    }
    const identities = getIdentities();
    if (entry.status?.legacy) {
      notifiedMigrations.delete(entry.ref.repoKey);
      const status = await migrateLegacyInstallation(entry.ref, identities, entry.status);
      await scan();
      return { ok: status.enforcement.state !== "unavailable", message: "Legacy installation migrated.", details: [], status };
    }
    // Repair re-installs every hook slot; a foreign hook now occupying one
    // is only ever chained with explicit consent.
    const chainForeignHooks = entry.status ? await confirmChainingForeignHooks(entry.status) : false;
    if (chainForeignHooks === undefined) return { ok: false, message: "Cancelled.", details: [] };
    const result = await withRepoLock(entry.ref.repoKey, () => lockService.repair(entry.ref, identities, { chainForeignHooks }));
    if (!opts.silent) showOperationResult(result);
    await scan();
    return result;
  }

  /**
   * Explicit health check. The ONLY place (besides right after assigning)
   * that makes a network connection: it verifies the push account over the
   * real SSH route, exactly as the pre-push hook would.
   */
  async function checkLock(options: { quietWhenVerified?: boolean; target?: RepoEntry; silent?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const entry = options.target ?? commandTarget();
    if (!entry) {
      if (!options.silent) await vscode.window.showInformationMessage("Open a folder inside a Git repository first.");
      return { ok: false, message: "Open a Git repository first." };
    }
    const identities = getIdentities();
    const status = await lockService.getStatus(entry.ref, identities);
    const view = status.assignmentView;
    if (!view) {
      const message =
        status.enforcement.state === "unassigned"
          ? `${entry.repoName} is not locked; Repo Identity Guard does not restrict Git here.`
          : `${entry.repoName}: ${status.enforcement.reason ?? "the identity lock needs attention."}`;
      if (!options.silent) await vscode.window.showInformationMessage(message);
      return { ok: false, message };
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
    const push = options.silent
      ? await lockService.checkPushAccount(entry.ref, identity)
      : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Repo Identity Guard: checking the push account…" }, () =>
          lockService.checkPushAccount(entry.ref, identity),
        );
    const lockLine =
      status.enforcement.state === "active"
        ? `${entry.repoName} is locked to "${view.identityLabel}".`
        : `${entry.repoName} (locked to "${view.identityLabel}") needs attention: ${status.enforcement.reason ?? ""}`;
    const message = `${lockLine} ${push.message}`;
    const verified = status.enforcement.state === "active" && push.status === "verified";
    if (!options.silent) {
      if (verified) {
        if (!options.quietWhenVerified) await vscode.window.showInformationMessage(message);
      } else {
        await vscode.window.showWarningMessage(message);
      }
    }
    return { ok: verified, message };
  }

  async function applyIdentityToGitConfig(target: RepoEntry | undefined = commandTarget(), opts: { silent?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const entry = target;
    const view = entry?.status?.assignmentView;
    if (!entry || !view) {
      if (!opts.silent) await vscode.window.showInformationMessage("This repository has no assigned identity.");
      return { ok: false, message: "This repository has no assigned identity." };
    }
    if (!(await requireTrust("change this repository's Git config", !opts.silent))) {
      return { ok: false, message: "This workspace isn't trusted, so Repo Identity Guard can't change this repository's Git config." };
    }
    const scope = resolveIdentityConfigScope(await getWorktreeConfigEnabled(entry.ref.repoRoot).catch(() => null));
    if (!opts.silent) {
      const confirm = await vscode.window.showWarningMessage(
        `Set ${entry.repoName}'s Git identity to ${view.gitName ? `${view.gitName} ` : ""}<${view.gitEmail}>? This writes user.${view.gitName ? "name/user." : ""}email with "git config --${scope}" for this repository only; your global Git config is never touched.`,
        { modal: true },
        "Set Git Identity",
      );
      if (!confirm) return { ok: false, message: "Cancelled." };
    }
    try {
      await safeActionRunner.setLocalIdentity(entry.ref.repoRoot, view.gitName, view.gitEmail, scope);
    } catch (error) {
      const message = `Could not set the Git identity: ${errorMessage(error)}`;
      if (!opts.silent) await vscode.window.showErrorMessage(message);
      return { ok: false, message };
    }
    const effective = await getEffectiveAuthorIdent(entry.ref.repoRoot).catch(() => ({ email: undefined }));
    let message: string;
    let ok: boolean;
    if ((effective.email ?? "").trim().toLowerCase() === view.gitEmail.trim().toLowerCase()) {
      message = `${entry.repoName} now commits as ${view.gitEmail}.`;
      ok = true;
      if (!opts.silent) await vscode.window.showInformationMessage(message);
    } else {
      message = `Git config was updated, but Git still resolves ${effective.email ?? "a different identity"} here — an environment variable (GIT_AUTHOR_EMAIL, GIT_COMMITTER_EMAIL, EMAIL) is overriding it in VS Code's environment.`;
      ok = false;
      if (!opts.silent) await vscode.window.showWarningMessage(message);
    }
    await scan();
    return { ok, message };
  }

  async function editIdentities(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.openSettings", "repoIdentityGuard.identities");
  }

  // ==================== notes actions (no Workspace Trust needed: local data only, never executed) ====================

  /**
   * `entry` must already be a validated target (see `validateRepoTarget`)
   * — this never re-resolves the current repository itself, so a caller
   * that validated repo A at the start of a request stays bound to A for
   * that whole request, even if the active editor moves on in the
   * meantime.
   */
  async function noteMutation(entry: RepoEntry, mutate: (keys: MemoryKeys) => Promise<unknown>): Promise<OperationResult> {
    try {
      await mutate(entry.memoryKeys);
    } catch (error) {
      const message = error instanceof MemoryLimitError ? error.message : "Something went wrong saving the note.";
      return { ok: false, message };
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

  /**
   * `repoId` is only meaningful (and required) when `all` is false —
   * exportAllNotes covers every repository and is never repo-scoped. For
   * the single-repo export, the target is validated and captured HERE,
   * before anything async, and used throughout: see
   * `validateRepoTarget`'s doc comment on why a validated target must not
   * be re-resolved later in the same request (the save dialog below is
   * async, and the user could switch repos while it's open).
   */
  async function exportNotes(all: boolean, repoId?: string): Promise<void> {
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
    const entry = repoId !== undefined ? validateRepoTarget(repoId) : undefined;
    if (!entry) {
      if (repoId !== undefined) {
        refreshViews();
        vscode.window.setStatusBarMessage("Repo Identity Guard: the current repository changed. Please try again.", 4000);
      }
      return;
    }
    await writeExport(memoryStore.exportMemory(entry.memoryKeys, entry.repoName), `repo-notes-${entry.repoName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "repo"}.json`);
  }

  /**
   * The target is validated and captured BEFORE the native open dialog —
   * never re-resolved afterward — because the dialog is async and the
   * user could switch repos while it's open (see `validateRepoTarget`).
   */
  async function importNotes(repoId: string): Promise<void> {
    const entry = validateRepoTarget(repoId);
    if (!entry) {
      refreshViews();
      vscode.window.setStatusBarMessage("Repo Identity Guard: the current repository changed. Please try again.", 4000);
      return;
    }
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

  // ==================== production webview actions ====================

  function toOperationResult(result: LockOperationResult): OperationResult {
    return { ok: result.ok, message: result.message, details: result.details.length ? result.details : undefined };
  }

  /**
   * `saveIdentity` is settings-only (no Git mutation), so it needs no
   * Workspace Trust — see `operationRequiresTrust` in `src/ui/protocol.ts`.
   */
  async function webviewSaveIdentity(raw: unknown): Promise<OperationResult> {
    const draft = raw as IdentityDraft;
    const result = draft.id ? await updateIdentitySetting(draft) : await createIdentitySetting(draft);
    if (!result.ok) return { ok: false, code: result.code, message: result.errors.join(" "), details: result.errors.length > 1 ? result.errors : undefined };
    await scan();
    return { ok: true, message: `Saved "${result.identity.label}".` };
  }

  async function webviewDeleteIdentity(identityId: string): Promise<OperationResult> {
    const openAssignments = repos
      .filter((entry) => entry.status?.assignmentView?.identityId === identityId)
      .map((entry) => ({ repoName: entry.repoName }));
    const result = await deleteIdentitySetting(identityId, openAssignments);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.errors.join(" "),
        details: result.code === "identity_in_use" ? result.repoNames : undefined,
      };
    }
    await scan();
    return { ok: true, message: "Identity deleted." };
  }

  function buildProductionActions(): ProductionSidebarActions {
    return {
      getState: () => buildProductionState(),
      // Every repo-scoped action below validates `repoId` against the
      // ACTUAL current repository FIRST (see `validateRepoTarget`) and,
      // once validated, passes that SAME `RepoEntry` explicitly into
      // whatever it calls next — never `commandTarget()` again in the
      // same request (see that function's doc comment on why a second
      // resolution would reopen the exact race this closes).
      assignIdentity: async (repoId, identityId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return toOperationResult(await assignIdentity(identityId, "assign", target, { silent: true }));
      },
      changeIdentity: async (repoId, identityId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return toOperationResult(await assignIdentity(identityId, "change", target, { silent: true }));
      },
      unlockRepository: async (repoId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return toOperationResult(await unlockRepository(target, { silent: true }));
      },
      repairLock: async (repoId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return toOperationResult(await repairLock(target, { silent: true }));
      },
      verifyLock: async (repoId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        const result = await checkLock({ silent: true, target });
        return { ok: result.ok, message: result.message };
      },
      applyAssignedIdentity: async (repoId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        const result = await applyIdentityToGitConfig(target, { silent: true });
        return { ok: result.ok, message: result.message };
      },
      saveIdentity: (identity) => webviewSaveIdentity(identity),
      deleteIdentity: (identityId) => webviewDeleteIdentity(identityId),
      addNote: async (repoId, text) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return noteMutation(target, (keys) => memoryStore.addNote(keys, text));
      },
      updateNote: async (repoId, noteId, text) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return noteMutation(target, (keys) => memoryStore.updateNote(keys, noteId, text));
      },
      deleteNote: async (repoId, noteId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return noteMutation(target, (keys) => memoryStore.removeNote(keys, noteId));
      },
      togglePinNote: async (repoId, noteId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        return noteMutation(target, (keys) => memoryStore.togglePin(keys, noteId));
      },
      copyNote: async (repoId, noteId) => {
        const target = validateRepoTarget(repoId);
        if (!target) return repositoryChanged();
        const text = memoryStore.getNoteText(target.memoryKeys, noteId);
        if (text === undefined) return { ok: false, message: "That note no longer exists." };
        try {
          await vscode.env.clipboard.writeText(text);
        } catch (error) {
          return { ok: false, message: `Couldn't copy the note (${errorMessage(error)}).` };
        }
        return { ok: true };
      },
      importNotes: (repoId) => importNotes(repoId),
      exportNotes: (repoId) => exportNotes(false, repoId),
      openFolder: async () => {
        await vscode.commands.executeCommand("vscode.openFolder");
      },
    };
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
