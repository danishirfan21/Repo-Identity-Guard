import * as vscode from "vscode";
import { IdentityEvaluation } from "./types";

export class IdentityStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = "repoIdentityGuard.showStatus";
    this.item.name = "Repo Identity Guard";
  }

  public update(evaluation: IdentityEvaluation): void {
    this.item.backgroundColor = undefined;

    switch (evaluation.state) {
      case "safe":
        this.item.text = `$(shield) Repo ID: ${evaluation.rule?.label ?? "Safe"}`;
        break;
      case "localNeeded":
        this.item.text = "$(warning) Repo ID: Local Needed";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
      case "wrong":
        this.item.text = "$(warning) Repo ID: Wrong";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
      case "unknown":
        this.item.text = "$(question) Repo ID: Unknown";
        break;
      case "error":
        this.item.text = "$(error) Repo ID: Error";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
      case "notGitRepo":
        this.item.hide();
        return;
    }

    this.item.tooltip = buildTooltip(evaluation);
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(evaluation: IdentityEvaluation): vscode.MarkdownString {
  const lines = [`**Repo Identity Guard**`, "", evaluation.message];
  const { current, rule } = evaluation;

  if (current) {
    lines.push(
      "",
      `Remote: \`${current.remoteUrl ?? "Not configured"}\``,
      `Effective: \`${current.effectiveName ?? "Not set"} <${current.effectiveEmail ?? "not set"}>\``,
      `Local: \`${current.localName ?? "Not set"} <${current.localEmail ?? "not set"}>\``,
      `Global: \`${current.globalName ?? "Not set"} <${current.globalEmail ?? "not set"}>\``,
    );
  }

  if (rule) {
    lines.push(`Expected: \`${rule.name} <${rule.email}>\``);
  }

  lines.push(
    `Require local identity: \`${evaluation.requireLocalIdentity ? "Enabled" : "Disabled"}\``,
  );

  return new vscode.MarkdownString(lines.join("\n"));
}
