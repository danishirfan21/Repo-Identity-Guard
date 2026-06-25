import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  getEffectiveGitUserEmail,
  getEffectiveGitUserName,
  getGlobalGitUserEmail,
  getGlobalGitUserName,
  getLocalGitUserEmail,
  getLocalGitUserName,
  getOriginRemote,
  getRepoRoot,
  setLocalGitIdentity,
} from "./git";
import {
  buildExactRuleMatch,
  evaluateIdentity,
  loadRequireLocalIdentity,
  loadRules,
  normalizeRemoteUrl,
} from "./rules";
import { RepoIdentitySidebarProvider } from "./sidebar";
import { IdentityStatusBar } from "./statusBar";
import { CurrentIdentity, IdentityEvaluation } from "./types";

const ACTION_VIEW_DETAILS = "View Details";
const ACTION_FIX_IDENTITY = "Fix Local Git Identity";
const ACTION_ADD_RULE = "Add Rule for Current Repo";
const ACTION_COPY_REPORT = "Copy Diagnostic Report";
const ACTION_RESCAN = "Rescan";
const ACTION_OPEN_SETTINGS = "Open Settings";

const NOTIFICATION_ACTIONS = {
  details: "Details",
  fix: "Fix",
  setLocal: "Set Local",
  addRule: "Add Rule",
  copyReport: "Copy Report",
  rescan: "Rescan",
  settings: "Settings",
} as const;

let latestEvaluation: IdentityEvaluation = {
  state: "notGitRepo",
  requireLocalIdentity: false,
  message: "No repository has been scanned.",
};
let scanSequence = 0;
let gitConfigWatcher: vscode.FileSystemWatcher | undefined;
let watchedGitConfigRepoRoot: string | undefined;
let globalGitConfigWatchers: vscode.FileSystemWatcher[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new IdentityStatusBar();
  const sidebarProvider = new RepoIdentitySidebarProvider(
    context.extensionUri,
    {
      showDetails: () => showDetailsQuickPick(latestEvaluation),
      setLocalIdentity: () => setLocalIdentityFromRule(latestEvaluation, scan),
      setCustomLocalIdentity: (name, email) =>
        setCustomLocalIdentity(latestEvaluation, scan, name, email),
      addRule: () => addRuleForCurrentRepo(latestEvaluation, scan),
      copyReport: () => copyDiagnosticReport(latestEvaluation),
      rescan: () => scan(),
      openSettings: async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "repoIdentityGuard.rules",
        );
      },
    },
  );
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "repoIdentityGuard.statusView",
      sidebarProvider,
    ),
  );

  const scan = async (cwdOverride?: string): Promise<void> => {
    const sequence = ++scanSequence;
    const cwd = cwdOverride ?? getActiveCwd();

    try {
      const evaluation = await scanIdentity(cwd);
      if (sequence !== scanSequence) {
        return;
      }
      latestEvaluation = evaluation;
      statusBar.update(evaluation);
      sidebarProvider.update(evaluation);
      updateGitConfigWatcher(evaluation.current?.repoRoot, scan);
    } catch (error) {
      if (sequence !== scanSequence) {
        return;
      }
      const message = getErrorMessage(error);
      latestEvaluation = {
        state: "error",
        requireLocalIdentity: loadRequireLocalIdentity(),
        message: `Repo Identity Guard could not scan this repository: ${message}`,
      };
      statusBar.update(latestEvaluation);
      sidebarProvider.update(latestEvaluation);
      updateGitConfigWatcher(undefined, scan);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("repoIdentityGuard.scan", scan),
    vscode.commands.registerCommand(
      "repoIdentityGuard.showStatus",
      () => showStatus(latestEvaluation),
    ),
    vscode.commands.registerCommand(
      "repoIdentityGuard.fixIdentity",
      async () => {
        await fixIdentity(latestEvaluation, scan);
      },
    ),
    vscode.commands.registerCommand(
      "repoIdentityGuard.addRuleForCurrentRepo",
      async () => {
        await addRuleForCurrentRepo(latestEvaluation, scan);
      },
    ),
    vscode.commands.registerCommand(
      "repoIdentityGuard.copyDiagnosticReport",
      async () => {
        await copyDiagnosticReport(latestEvaluation);
      },
    ),
    vscode.commands.registerCommand(
      "repoIdentityGuard.openSettings",
      () =>
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "repoIdentityGuard.rules",
        ),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => void scan()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("repoIdentityGuard.rules") ||
        event.affectsConfiguration("repoIdentityGuard.requireLocalIdentity")
      ) {
        void scan();
      }
    }),
    {
      dispose: () => {
        gitConfigWatcher?.dispose();
        disposeGlobalGitConfigWatchers();
      },
    },
  );

  updateGlobalGitConfigWatchers(scan);
  void scan();
}

export function deactivate(): void {
  gitConfigWatcher?.dispose();
  disposeGlobalGitConfigWatchers();
}

async function scanIdentity(cwd: string | undefined): Promise<IdentityEvaluation> {
  const rules = loadRules();
  const requireLocalIdentity = loadRequireLocalIdentity();

  if (!cwd) {
    return evaluateIdentity(null, rules, { requireLocalIdentity });
  }

  const repoRoot = await getRepoRoot(cwd);
  if (!repoRoot) {
    return evaluateIdentity(null, rules, { requireLocalIdentity });
  }

  const [
    remoteUrl,
    effectiveName,
    effectiveEmail,
    localName,
    localEmail,
    globalName,
    globalEmail,
  ] = await Promise.all([
    getOriginRemote(repoRoot),
    getEffectiveGitUserName(repoRoot),
    getEffectiveGitUserEmail(repoRoot),
    getLocalGitUserName(repoRoot),
    getLocalGitUserEmail(repoRoot),
    getGlobalGitUserName(),
    getGlobalGitUserEmail(),
  ]);
  const current: CurrentIdentity = {
    repoRoot,
    remoteUrl,
    effectiveName,
    effectiveEmail,
    localName,
    localEmail,
    globalName,
    globalEmail,
  };

  return evaluateIdentity(current, rules, { requireLocalIdentity });
}

function getActiveCwd(): string | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument?.uri.scheme === "file") {
    return path.dirname(activeDocument.uri.fsPath);
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function updateGitConfigWatcher(
  repoRoot: string | undefined,
  scan: (cwdOverride?: string) => Promise<void>,
): void {
  if (repoRoot === watchedGitConfigRepoRoot) {
    return;
  }

  gitConfigWatcher?.dispose();
  gitConfigWatcher = undefined;
  watchedGitConfigRepoRoot = repoRoot;

  if (!repoRoot) {
    return;
  }

  gitConfigWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(repoRoot), ".git/config"),
  );

  gitConfigWatcher.onDidChange(() => void scan(repoRoot));
  gitConfigWatcher.onDidCreate(() => void scan(repoRoot));
  gitConfigWatcher.onDidDelete(() => void scan(repoRoot));
}

function updateGlobalGitConfigWatchers(
  scan: (cwdOverride?: string) => Promise<void>,
): void {
  disposeGlobalGitConfigWatchers();

  const home = os.homedir();
  const configPaths = [
    path.join(home, ".gitconfig"),
    path.join(home, ".config", "git", "config"),
  ];

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
  for (const watcher of globalGitConfigWatchers) {
    watcher.dispose();
  }
  globalGitConfigWatchers = [];
}

async function showStatus(evaluation: IdentityEvaluation): Promise<void> {
  const actions = getNotificationActions(evaluation);

  const choice =
    evaluation.state === "wrong" || evaluation.state === "localNeeded"
      ? await vscode.window.showWarningMessage(
          getShortStatusMessage(evaluation),
          ...actions,
        )
      : await vscode.window.showInformationMessage(
          getShortStatusMessage(evaluation),
          ...actions,
        );

  await handleNotificationAction(choice, evaluation);
}

function getNotificationActions(evaluation: IdentityEvaluation): string[] {
  if (isFirstRunNoRules(evaluation)) {
    return [
      NOTIFICATION_ACTIONS.addRule,
      NOTIFICATION_ACTIONS.settings,
      NOTIFICATION_ACTIONS.rescan,
    ];
  }

  if (evaluation.state === "wrong" || evaluation.state === "localNeeded") {
    return [
      NOTIFICATION_ACTIONS.details,
      evaluation.state === "localNeeded"
        ? NOTIFICATION_ACTIONS.setLocal
        : NOTIFICATION_ACTIONS.fix,
      NOTIFICATION_ACTIONS.addRule,
      NOTIFICATION_ACTIONS.copyReport,
      NOTIFICATION_ACTIONS.rescan,
      NOTIFICATION_ACTIONS.settings,
    ];
  }

  return [
    NOTIFICATION_ACTIONS.details,
    NOTIFICATION_ACTIONS.addRule,
    NOTIFICATION_ACTIONS.copyReport,
    NOTIFICATION_ACTIONS.rescan,
    NOTIFICATION_ACTIONS.settings,
  ];
}

function getShortStatusMessage(evaluation: IdentityEvaluation): string {
  if (isFirstRunNoRules(evaluation)) {
    return "No identity rules are configured yet. Add a rule for this repo to start using Repo ID.";
  }

  if (evaluation.state === "safe" && evaluation.rule) {
    return `Repo identity is safe for ${evaluation.rule.label}.`;
  }

  return evaluation.message;
}

async function handleNotificationAction(
  choice: string | undefined,
  evaluation: IdentityEvaluation,
): Promise<void> {
  if (choice === NOTIFICATION_ACTIONS.details) {
    await handleStatusAction(ACTION_VIEW_DETAILS, evaluation);
  } else if (choice === NOTIFICATION_ACTIONS.fix) {
    await handleStatusAction(ACTION_FIX_IDENTITY, evaluation);
  } else if (choice === NOTIFICATION_ACTIONS.setLocal) {
    await handleStatusAction(ACTION_FIX_IDENTITY, evaluation);
  } else if (choice === NOTIFICATION_ACTIONS.addRule) {
    await handleStatusAction(ACTION_ADD_RULE, evaluation);
  } else if (choice === NOTIFICATION_ACTIONS.copyReport) {
    await handleStatusAction(ACTION_COPY_REPORT, evaluation);
  } else if (choice === NOTIFICATION_ACTIONS.rescan) {
    await handleStatusAction(ACTION_RESCAN, evaluation);
  } else if (choice === NOTIFICATION_ACTIONS.settings) {
    await handleStatusAction(ACTION_OPEN_SETTINGS, evaluation);
  }
}

async function handleStatusAction(
  choice: string | undefined,
  evaluation: IdentityEvaluation,
): Promise<void> {
  if (choice === ACTION_VIEW_DETAILS) {
    await showDetailsQuickPick(evaluation);
  } else if (choice === ACTION_FIX_IDENTITY) {
    await vscode.commands.executeCommand("repoIdentityGuard.fixIdentity");
  } else if (choice === ACTION_ADD_RULE) {
    await vscode.commands.executeCommand("repoIdentityGuard.addRuleForCurrentRepo");
  } else if (choice === ACTION_COPY_REPORT) {
    await vscode.commands.executeCommand("repoIdentityGuard.copyDiagnosticReport");
  } else if (choice === ACTION_RESCAN) {
    await vscode.commands.executeCommand("repoIdentityGuard.scan");
  } else if (choice === ACTION_OPEN_SETTINGS) {
    await vscode.commands.executeCommand("repoIdentityGuard.openSettings");
  }
}

interface DetailQuickPickItem extends vscode.QuickPickItem {
  action?: string;
}

async function showDetailsQuickPick(
  evaluation: IdentityEvaluation,
): Promise<void> {
  const picked = await vscode.window.showQuickPick(buildDetailsItems(evaluation), {
    title: "Repo Identity Guard",
    placeHolder: "Review identity details or choose an action",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  await handleStatusAction(picked?.action, evaluation);
}

function buildDetailsItems(
  evaluation: IdentityEvaluation,
): DetailQuickPickItem[] {
  const { current, rule } = evaluation;
  const items: DetailQuickPickItem[] = [
    {
      label: "$(info) Status",
      description: evaluation.state,
      detail: evaluation.message,
    },
  ];

  if (current) {
    items.push(
      {
        label: "$(repo) Remote",
        description: current.remoteUrl ?? "Not configured",
      },
      {
        label: "$(person) Effective identity",
        description: formatIdentity(
          current.effectiveName,
          current.effectiveEmail,
        ),
        detail: "This is what Git will use for commits in this repo.",
      },
      {
        label: "$(file-code) Local identity",
        description: formatIdentity(current.localName, current.localEmail),
        detail: "From this repository's .git/config.",
      },
      {
        label: "$(globe) Global identity",
        description: formatIdentity(current.globalName, current.globalEmail),
        detail: "From your user-level Git config.",
      },
    );
  }

  items.push({
    label: "$(check) Expected identity",
    description: rule ? formatIdentity(rule.name, rule.email) : "No matched rule",
  });

  items.push({
    label: "$(symbol-ruler) Matched rule",
    description: rule ? `${rule.label} — ${rule.match}` : "No rule matched",
  });

  items.push({
    label: "$(settings) Require local identity",
    description: evaluation.requireLocalIdentity ? "Enabled" : "Disabled",
  });

  items.push(
    {
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label:
        evaluation.state === "localNeeded"
          ? "$(tools) Set Local Identity"
          : "$(tools) Fix Local Git Identity",
      detail: "Write the expected name/email to this repo's local Git config.",
      action: ACTION_FIX_IDENTITY,
    },
    {
      label: "$(add) Add Rule for Current Repo",
      detail: "Create a settings rule from this repo's remote and identity.",
      action: ACTION_ADD_RULE,
    },
    {
      label: "$(copy) Copy Diagnostic Report",
      detail: "Copy a plain text identity report to the clipboard.",
      action: ACTION_COPY_REPORT,
    },
    {
      label: "$(sync) Rescan",
      detail: "Refresh the current repo identity status.",
      action: ACTION_RESCAN,
    },
    {
      label: "$(settings-gear) Open Settings",
      detail: "Edit repoIdentityGuard.rules.",
      action: ACTION_OPEN_SETTINGS,
    },
  );

  return items;
}

async function copyDiagnosticReport(
  evaluation: IdentityEvaluation,
): Promise<void> {
  await vscode.env.clipboard.writeText(buildDiagnosticReport(evaluation));
  await vscode.window.showInformationMessage(
    "Repo ID diagnostic report copied to clipboard.",
  );
}

function buildDiagnosticReport(evaluation: IdentityEvaluation): string {
  const { current, rule } = evaluation;
  const rawRemote = current?.remoteUrl ?? "Not set";
  const normalizedRemote = current?.remoteUrl
    ? normalizeRemoteUrl(current.remoteUrl)
    : "Not set";

  return [
    "Repo ID Diagnostic Report",
    "",
    `Repo root: ${current?.repoRoot ?? "Not in a Git repo"}`,
    `Normalized remote: ${evaluation.normalizedRemote ?? normalizedRemote}`,
    `Raw remote: ${rawRemote}`,
    `Status: ${evaluation.state}`,
    `Matched rule label: ${rule?.label ?? "None"}`,
    `Matched rule pattern: ${rule?.match ?? "None"}`,
    `Effective name: ${current?.effectiveName ?? "Not set"}`,
    `Effective email: ${current?.effectiveEmail ?? "Not set"}`,
    `Local name: ${current?.localName ?? "Not set"}`,
    `Local email: ${current?.localEmail ?? "Not set"}`,
    `Global name: ${current?.globalName ?? "Not set"}`,
    `Global email: ${current?.globalEmail ?? "Not set"}`,
    `Expected name: ${rule?.name ?? "None"}`,
    `Expected email: ${rule?.email ?? "None"}`,
    `Require local identity: ${evaluation.requireLocalIdentity}`,
  ].join("\n");
}

async function addRuleForCurrentRepo(
  evaluation: IdentityEvaluation,
  scan: (cwdOverride?: string) => Promise<void>,
): Promise<void> {
  const { current } = evaluation;
  if (!current) {
    await vscode.window.showInformationMessage(
      "Open a Git repository before adding an identity rule.",
    );
    return;
  }
  if (!current.remoteUrl) {
    await vscode.window.showInformationMessage(
      "This repository has no origin remote to match.",
    );
    return;
  }

  const match = await vscode.window.showInputBox({
    title: "Add Rule for Current Repo",
    prompt: "Remote match pattern",
    value: buildExactRuleMatch(current.remoteUrl),
  });
  if (!match) {
    return;
  }

  const label = await vscode.window.showInputBox({
    title: "Add Rule for Current Repo",
    prompt: "Short label shown in the status bar",
    value: "Personal",
  });
  if (!label) {
    return;
  }

  const name = await vscode.window.showInputBox({
    title: "Add Rule for Current Repo",
    prompt: "Expected Git user.name",
    value: current.effectiveName ?? current.localName ?? current.globalName ?? "",
  });
  if (!name) {
    return;
  }

  const email = await vscode.window.showInputBox({
    title: "Add Rule for Current Repo",
    prompt: "Expected Git user.email",
    value: current.effectiveEmail ?? current.localEmail ?? current.globalEmail ?? "",
  });
  if (!email) {
    return;
  }

  const rules = loadRules();
  const nextRules = [...rules, { match, label, name, email }];
  await vscode.workspace
    .getConfiguration("repoIdentityGuard")
    .update("rules", nextRules, vscode.ConfigurationTarget.Global);
  await vscode.window.showInformationMessage(
    `Added Repo Identity Guard rule for ${label}.`,
  );
  await scan(current.repoRoot);
}

async function fixIdentity(
  evaluation: IdentityEvaluation,
  scan: (cwdOverride?: string) => Promise<void>,
): Promise<void> {
  const { current, rule } = evaluation;
  if (!current || !rule) {
    await vscode.window.showInformationMessage(
      "No matching identity rule is available for this repository.",
    );
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Set local Git identity for this repo to ${rule.name} <${rule.email}>?`,
    { modal: true },
    "Set Local Identity",
  );
  if (confirmation !== "Set Local Identity") {
    return;
  }

  await setLocalIdentityFromRule(evaluation, scan);
}

async function setLocalIdentityFromRule(
  evaluation: IdentityEvaluation,
  scan: (cwdOverride?: string) => Promise<void>,
): Promise<void> {
  const { current, rule } = evaluation;
  if (!current || !rule) {
    await vscode.window.showInformationMessage(
      "No matching identity rule is available for this repository.",
    );
    return;
  }

  try {
    await setLocalGitIdentity(current.repoRoot, rule.name, rule.email);
    await vscode.window.showInformationMessage(
      `Local Git identity set to ${rule.name} <${rule.email}>.`,
    );
    await scan(current.repoRoot);
  } catch (error) {
    await vscode.window.showErrorMessage(
      `Could not set local Git identity: ${getErrorMessage(error)}`,
    );
  }
}

async function setCustomLocalIdentity(
  evaluation: IdentityEvaluation,
  scan: (cwdOverride?: string) => Promise<void>,
  name: string,
  email: string,
): Promise<void> {
  const { current, rule } = evaluation;
  if (!current || !rule) {
    await vscode.window.showInformationMessage(
      "No matching identity rule is available for this repository.",
    );
    return;
  }

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (!trimmedName || !trimmedEmail) {
    await vscode.window.showErrorMessage(
      "Name and email are required to set a local Git identity.",
    );
    return;
  }

  try {
    await setLocalGitIdentity(current.repoRoot, trimmedName, trimmedEmail);
    await vscode.window.showInformationMessage(
      `Local Git identity set to ${trimmedName} <${trimmedEmail}>.`,
    );
    await scan(current.repoRoot);
  } catch (error) {
    await vscode.window.showErrorMessage(
      `Could not set local Git identity: ${getErrorMessage(error)}`,
    );
  }
}

function formatIdentity(name: string | null, email: string | null): string {
  return `${name ?? "Not set"} <${email ?? "not set"}>`;
}

function isFirstRunNoRules(evaluation: IdentityEvaluation): boolean {
  return (
    evaluation.state === "unknown" &&
    !!evaluation.current?.remoteUrl &&
    loadRules().length === 0
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
