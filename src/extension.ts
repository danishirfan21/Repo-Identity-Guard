import * as path from "node:path";
import * as vscode from "vscode";
import {
  getLocalGitUserEmail,
  getLocalGitUserName,
  getOriginRemote,
  getRepoRoot,
  setLocalGitIdentity,
} from "./git";
import { evaluateIdentity, loadRules } from "./rules";
import { IdentityStatusBar } from "./statusBar";
import { CurrentIdentity, IdentityEvaluation } from "./types";

let latestEvaluation: IdentityEvaluation = {
  state: "notGitRepo",
  message: "No repository has been scanned.",
};
let scanSequence = 0;
let gitConfigWatcher: vscode.FileSystemWatcher | undefined;
let watchedGitConfigRepoRoot: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = new IdentityStatusBar();
  context.subscriptions.push(statusBar);

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
      updateGitConfigWatcher(evaluation.current?.repoRoot, scan);
    } catch (error) {
      if (sequence !== scanSequence) {
        return;
      }
      const message = getErrorMessage(error);
      latestEvaluation = {
        state: "error",
        message: `Repo Identity Guard could not scan this repository: ${message}`,
      };
      statusBar.update(latestEvaluation);
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
      if (event.affectsConfiguration("repoIdentityGuard.rules")) {
        void scan();
      }
    }),
    {
      dispose: () => {
        gitConfigWatcher?.dispose();
      },
    },
  );

  void scan();
}

export function deactivate(): void {
  gitConfigWatcher?.dispose();
}

async function scanIdentity(cwd: string | undefined): Promise<IdentityEvaluation> {
  if (!cwd) {
    return evaluateIdentity(null, loadRules());
  }

  const repoRoot = await getRepoRoot(cwd);
  if (!repoRoot) {
    return evaluateIdentity(null, loadRules());
  }

  const [remoteUrl, name, email] = await Promise.all([
    getOriginRemote(repoRoot),
    getLocalGitUserName(repoRoot),
    getLocalGitUserEmail(repoRoot),
  ]);
  const current: CurrentIdentity = { repoRoot, remoteUrl, name, email };

  return evaluateIdentity(current, loadRules());
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

async function showStatus(evaluation: IdentityEvaluation): Promise<void> {
  const details = formatDetails(evaluation);
  let actions: string[];

  switch (evaluation.state) {
    case "wrong":
      actions = ["Fix local Git identity", "Rescan", "Open Settings"];
      break;
    case "safe":
      actions = ["Rescan", "Open Settings"];
      break;
    default:
      actions = ["Open Settings", "Rescan"];
      break;
  }

  const choice =
    evaluation.state === "wrong"
      ? await vscode.window.showWarningMessage(details, ...actions)
      : await vscode.window.showInformationMessage(details, ...actions);

  if (choice === "Fix local Git identity") {
    await vscode.commands.executeCommand("repoIdentityGuard.fixIdentity");
  } else if (choice === "Rescan") {
    await vscode.commands.executeCommand("repoIdentityGuard.scan");
  } else if (choice === "Open Settings") {
    await vscode.commands.executeCommand("repoIdentityGuard.openSettings");
  }
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

function formatDetails(evaluation: IdentityEvaluation): string {
  const lines = [evaluation.message];
  const { current, rule } = evaluation;

  if (current) {
    lines.push(`Remote: ${current.remoteUrl ?? "Not configured"}`);
    lines.push(
      `Current: ${current.name ?? "Not set"} <${current.email ?? "not set"}>`,
    );
  }
  if (rule) {
    lines.push(`Expected: ${rule.name} <${rule.email}>`);
  }

  return lines.join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
