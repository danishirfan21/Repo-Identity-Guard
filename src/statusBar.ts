import * as vscode from "vscode";
import { StatusSummary } from "./types";

export class IdentityStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "repoIdentityGuard.showStatus";
    this.item.name = "Repo Identity Guard";
  }

  public update(summary: StatusSummary): void {
    this.item.backgroundColor = undefined;

    if (summary.level === "not_checked") {
      this.item.hide();
      return;
    }

    if (summary.level === "safe") {
      this.item.text = `$(shield) Safe${summary.matchedProfile ? ` (${summary.matchedProfile.label})` : ""}`;
    } else {
      this.item.text = "$(warning) Not Safe";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    this.item.tooltip = buildTooltip(summary);
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(summary: StatusSummary): vscode.MarkdownString {
  const lines = [
    "**Repo Identity Guard**",
    "",
    summary.level === "safe" ? "Safe to work, commit, and push." : "Not safe — see Review Details.",
    `Repo: \`${summary.repoName ?? "Unknown"}\``,
    `Profile: \`${summary.matchedProfile?.label ?? "Unknown"}\``,
  ];

  for (const issue of summary.issues.filter((issue) => issue.severity === "blocking")) {
    lines.push(`- ${issue.title}`);
  }

  return new vscode.MarkdownString(lines.join("\n"));
}
