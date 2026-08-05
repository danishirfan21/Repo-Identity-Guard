import * as vscode from "vscode";
import { formatWorkspaceProblems } from "./core/workspaceAggregate";
import { WorkspaceSafetyState } from "./types";

export class IdentityStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "repoIdentityGuard.showStatus";
    this.item.name = "Repo Identity Guard";
  }

  public update(workspace: WorkspaceSafetyState): void {
    this.item.backgroundColor = undefined;

    if (workspace.level === "not_checked") {
      this.item.hide();
      return;
    }

    const multiRoot = workspace.repos.length > 1;
    const profileSuffix = !multiRoot && workspace.repos[0]?.summary.matchedProfile
      ? ` (${workspace.repos[0].summary.matchedProfile.label})`
      : "";

    if (workspace.level === "safe") {
      this.item.text = multiRoot
        ? `$(shield) Safe (${workspace.safeCount}/${workspace.repos.length} repos)`
        : `$(shield) Safe${profileSuffix}`;
    } else {
      this.item.text = multiRoot
        ? `$(warning) Not Safe (${formatWorkspaceProblems(workspace)})`
        : "$(warning) Not Safe";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    this.item.tooltip = buildTooltip(workspace);
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(workspace: WorkspaceSafetyState): vscode.MarkdownString {
  if (workspace.repos.length <= 1) {
    const summary = workspace.repos[0]?.summary;
    const lines = [
      "**Repo Identity Guard**",
      "",
      workspace.level === "safe" ? "Safe to work, commit, and push." : "Not safe — see Review Details.",
      `Repo: \`${summary?.repoName ?? "Unknown"}\``,
      `Profile: \`${summary?.matchedProfile?.label ?? "Unknown"}\``,
    ];

    for (const result of (summary?.capabilityResults ?? []).filter((r) => r.blocksOverallSafety)) {
      lines.push(`- ${result.title}`);
    }

    return new vscode.MarkdownString(lines.join("\n"));
  }

  const lines = [
    "**Repo Identity Guard — Workspace**",
    "",
    `${workspace.safeCount} safe, ${workspace.notSafeCount} not safe, ${workspace.uncheckedCount} unchecked of ${workspace.repos.length} repositories`,
    "",
  ];

  for (const repo of workspace.repos) {
    const icon = repo.summary.level === "safe" ? "🟢" : repo.summary.level === "not_safe" ? "🔴" : "⚪";
    lines.push(`${icon} ${repo.summary.repoName ?? repo.workspaceFolderName ?? "(unnamed repo)"}`);
  }

  return new vscode.MarkdownString(lines.join("\n"));
}
