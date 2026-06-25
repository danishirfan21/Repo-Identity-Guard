import * as vscode from "vscode";
import { IdentityEvaluation, IdentityState } from "./types";

interface SidebarTreeItem extends vscode.TreeItem {
  children?: SidebarTreeItem[];
}

export class RepoIdentitySidebarProvider
  implements vscode.TreeDataProvider<SidebarTreeItem>
{
  private evaluation: IdentityEvaluation | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<
    SidebarTreeItem | undefined | null | void
  >();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public update(evaluation: IdentityEvaluation): void {
    this.evaluation = evaluation;
    this.changeEmitter.fire();
  }

  public getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SidebarTreeItem): SidebarTreeItem[] {
    if (element) {
      return element.children ?? [];
    }

    return this.buildRootItems();
  }

  private buildRootItems(): SidebarTreeItem[] {
    const evaluation = this.evaluation;
    if (!evaluation) {
      return [
        item("Status", "Not scanned yet", "repoIdentityGuard.scan", "sync"),
      ];
    }

    const { current, rule } = evaluation;
    const items: SidebarTreeItem[] = [
      item(
        "Status",
        sidebarStatusLabel(evaluation.state),
        "repoIdentityGuard.showStatus",
        statusIcon(evaluation.state),
      ),
    ];

    if (rule) {
      items.push(
        item(
          "Matched rule",
          `${rule.label} - ${rule.match}`,
          undefined,
          "symbol-ruler",
        ),
      );
    }

    if (current) {
      items.push(
        item("Remote", current.remoteUrl ?? "Not configured", undefined, "repo"),
        item(
          "Effective identity",
          formatIdentity(current.effectiveName, current.effectiveEmail),
          undefined,
          "person",
        ),
        item(
          "Local identity",
          formatIdentity(current.localName, current.localEmail),
          undefined,
          "file-code",
        ),
        item(
          "Global identity",
          formatIdentity(current.globalName, current.globalEmail),
          undefined,
          "globe",
        ),
      );
    }

    items.push(
      item(
        "Details",
        "Open readable identity details",
        "repoIdentityGuard.showStatus",
        "list-selection",
      ),
      item(
        "Fix / Set Local",
        "Write expected identity locally",
        "repoIdentityGuard.fixIdentity",
        "tools",
      ),
      item(
        "Add Rule",
        "Create a rule for this repo",
        "repoIdentityGuard.addRuleForCurrentRepo",
        "add",
      ),
      item(
        "Copy Report",
        "Copy diagnostic report",
        "repoIdentityGuard.copyDiagnosticReport",
        "copy",
      ),
      item("Rescan", "Refresh status", "repoIdentityGuard.scan", "sync"),
      item(
        "Settings",
        "Edit Repo ID settings",
        "repoIdentityGuard.openSettings",
        "settings-gear",
      ),
    );

    return items;
  }
}

function item(
  label: string,
  description: string,
  commandId?: string,
  icon?: string,
): SidebarTreeItem {
  return {
    label,
    description,
    tooltip: description,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    iconPath: icon ? new vscode.ThemeIcon(icon) : undefined,
    command: commandId
      ? {
          command: commandId,
          title: label,
        }
      : undefined,
  };
}

function sidebarStatusLabel(state: IdentityState): string {
  switch (state) {
    case "safe":
      return "Safe";
    case "localNeeded":
      return "Local Needed";
    case "wrong":
      return "Wrong";
    case "unknown":
      return "Unknown";
    case "notGitRepo":
      return "Not a Git repo";
    case "error":
      return "Error";
  }
}

function statusIcon(state: IdentityState): string {
  switch (state) {
    case "safe":
      return "shield";
    case "localNeeded":
    case "wrong":
      return "warning";
    case "unknown":
      return "question";
    case "notGitRepo":
      return "circle-slash";
    case "error":
      return "error";
  }
}

function formatIdentity(name: string | null, email: string | null): string {
  return `${name ?? "Not set"} <${email ?? "not set"}>`;
}
