import * as vscode from "vscode";
import { RepoIdentityState } from "./identity/types";

/**
 * Shows the identity lock of the SELECTED repository only — never an
 * aggregate across the workspace. Hidden for an unassigned repository:
 * Repo Identity Guard stays out of the way where nothing is locked.
 */
export class IdentityStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "repoIdentityGuard.open";
    this.item.name = "Repo Identity Guard";
  }

  public update(state: RepoIdentityState | undefined): void {
    this.item.backgroundColor = undefined;
    if (!state || !state.repositoryPresent || state.enforcement.state === "unassigned" || state.enforcement.state === "unavailable") {
      this.item.hide();
      return;
    }
    const label = state.assignment?.identityLabel ?? "Identity lock";
    if (state.enforcement.state === "active") {
      this.item.text = `$(lock) ${label}`;
      this.item.tooltip = `${state.repoName ?? "This repository"} is locked to ${label}.`;
    } else {
      this.item.text = `$(warning) ${label}`;
      this.item.tooltip = state.enforcement.reason ?? "The identity lock needs attention.";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}
