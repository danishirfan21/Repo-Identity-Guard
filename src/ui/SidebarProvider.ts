import * as vscode from "vscode";
import { Profile } from "../types";
import { isNonEmptyString, sanitizeProfile, sanitizeStringArray } from "../validation";
import { SidebarModel, toWireState } from "./wireState";
import { ICONS_JS } from "../webview/client/icons";
import { COMPONENTS_JS } from "../webview/client/components";
import { ONBOARDING_VIEW_JS } from "../webview/client/onboardingView";
import { MAIN_VIEW_JS } from "../webview/client/mainView";
import { DETAILS_VIEW_JS } from "../webview/client/detailsView";
import { SHIELD_VIEW_JS } from "../webview/client/shieldView";
import { MEMORY_VIEW_JS } from "../webview/client/memoryView";
import { SETTINGS_VIEW_JS } from "../webview/client/settingsView";
import { NAVIGATION_JS } from "../webview/client/navigation";

export interface SidebarActions {
  rescan(): Promise<void>;
  fixCommitIdentity(): Promise<void>;
  unsetLocalIdentity(): Promise<void>;
  addProfileForRepo(): Promise<void>;
  openSettingsJson(): Promise<void>;
  copyContextForAI(): Promise<void>;
  copyWorkspaceSafetySummary(): Promise<void>;
  enableWorkspaceTrust(): Promise<void>;
  resolveProfileConflict(): Promise<void>;
  selectRepo(repoId: string): Promise<void>;

  addMemoryNote(text: string, pinned: boolean): Promise<void>;
  removeMemoryNote(id: string): Promise<void>;
  togglePinMemoryNote(id: string): Promise<void>;
  addSavedCommand(label: string, command: string): Promise<void>;
  removeSavedCommand(id: string): Promise<void>;
  runSavedCommand(id: string): Promise<void>;
  copySavedCommand(id: string): Promise<void>;

  saveProfile(profile: Profile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  saveProtectedBranches(branches: string[]): Promise<void>;
  saveRequireLocalIdentity(value: boolean): Promise<void>;
  saveIncludeMemoryInAiContext(value: boolean): Promise<void>;

  enableShield(chainForeignHooks: boolean): Promise<void>;
  disableShield(): Promise<void>;
  repairShield(): Promise<void>;
  checkShieldHealth(): Promise<void>;
}

export type { SidebarModel } from "./wireState";

export class RepoIdentitySidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private model: SidebarModel | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: SidebarActions,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    webviewView.webview.html = this.getHtml();
    this.postState();
  }

  public update(model: SidebarModel): void {
    this.model = model;
    this.postState();
  }

  private postState(): void {
    if (!this.view || !this.model) {
      return;
    }
    this.view.webview.postMessage({ type: "state", payload: toWireState(this.model) });
  }

  /**
   * The webview is a trust boundary (see `../validation`): even though its
   * only content today is this extension's own script, nothing here may
   * assume a message has the shape a TypeScript cast claims. A message that
   * fails validation for the field an action actually needs is dropped
   * entirely — never coerced (`String(anObject)` silently becomes
   * `"[object Object]"`, which is a worse failure mode than a no-op) and
   * never partially actioned with a guessed default in place of the
   * missing/malformed field.
   */
  private async handleMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    const a = this.actions;
    switch (message.type) {
      case "rescan":
        await a.rescan();
        break;
      case "fixCommitIdentity":
        await a.fixCommitIdentity();
        break;
      case "unsetLocalIdentity":
        await a.unsetLocalIdentity();
        break;
      case "addProfileForRepo":
        await a.addProfileForRepo();
        break;
      case "openSettingsJson":
        await a.openSettingsJson();
        break;
      case "copyContextForAI":
        await a.copyContextForAI();
        break;
      case "copyWorkspaceSafetySummary":
        await a.copyWorkspaceSafetySummary();
        break;
      case "enableWorkspaceTrust":
        await a.enableWorkspaceTrust();
        break;
      case "resolveProfileConflict":
        await a.resolveProfileConflict();
        break;
      case "selectRepo":
        if (isNonEmptyString(message.id)) await a.selectRepo(message.id);
        break;
      case "addMemoryNote":
        if (isNonEmptyString(message.text)) await a.addMemoryNote(message.text, message.pinned === true);
        break;
      case "removeMemoryNote":
        if (isNonEmptyString(message.id)) await a.removeMemoryNote(message.id);
        break;
      case "togglePinMemoryNote":
        if (isNonEmptyString(message.id)) await a.togglePinMemoryNote(message.id);
        break;
      case "addSavedCommand":
        if (isNonEmptyString(message.label) && isNonEmptyString(message.command)) {
          await a.addSavedCommand(message.label, message.command);
        }
        break;
      case "removeSavedCommand":
        if (isNonEmptyString(message.id)) await a.removeSavedCommand(message.id);
        break;
      case "runSavedCommand":
        if (isNonEmptyString(message.id)) await a.runSavedCommand(message.id);
        break;
      case "copySavedCommand":
        if (isNonEmptyString(message.id)) await a.copySavedCommand(message.id);
        break;
      case "saveProfile": {
        const profile = sanitizeProfile(message.profile);
        if (profile) await a.saveProfile(profile);
        break;
      }
      case "deleteProfile":
        if (isNonEmptyString(message.id)) await a.deleteProfile(message.id);
        break;
      case "saveProtectedBranches":
        await a.saveProtectedBranches(sanitizeStringArray(message.branches));
        break;
      case "saveRequireLocalIdentity":
        if (typeof message.value === "boolean") await a.saveRequireLocalIdentity(message.value);
        break;
      case "saveIncludeMemoryInAiContext":
        if (typeof message.value === "boolean") await a.saveIncludeMemoryInAiContext(message.value);
        break;
      case "enableShield":
        await a.enableShield(message.chainForeignHooks === true);
        break;
      case "disableShield":
        await a.disableShield();
        break;
      case "repairShield":
        await a.repairShield();
        break;
      case "checkShieldHealth":
        await a.checkShieldHealth();
        break;
    }
  }

  private getHtml(): string {
    if (!this.view) {
      return "";
    }
    const nonce = getNonce();
    const cssUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"),
    );
    const cspSource = this.view.webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${cssUri}" rel="stylesheet" />
<title>Repo Identity Guard</title>
</head>
<body class="custom-scrollbar flex flex-col overflow-y-auto">
<header class="flex h-[38px] w-full shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container px-sidebar-padding">
  <div class="flex min-w-0 items-center gap-1.5">
    <button class="hidden shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" id="backButton" title="Back"></button>
    <span class="shrink-0 text-primary" id="headerIcon"></span>
    <div class="flex min-w-0 flex-col leading-none">
      <span class="truncate text-[12.5px] font-bold text-on-surface" id="headerTitle">Repo Identity Guard</span>
      <span class="truncate text-[9.5px] text-on-surface-variant" id="headerSubtitle">Safe to work, commit, push?</span>
    </div>
  </div>
  <div class="flex shrink-0 gap-0.5">
    <button class="rounded p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" data-nav="main" title="Home" id="homeButton"></button>
    <button class="rounded p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" id="rescanButton" title="Rescan"></button>
    <button class="rounded p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" data-nav="settings" title="Settings" id="settingsNavButton"></button>
  </div>
</header>
<main class="flex flex-1 flex-col gap-lg p-sidebar-padding" id="app"></main>
<script nonce="${nonce}">
${ICONS_JS}
${COMPONENTS_JS}
${ONBOARDING_VIEW_JS}
${MAIN_VIEW_JS}
${SHIELD_VIEW_JS}
${DETAILS_VIEW_JS}
${MEMORY_VIEW_JS}
${SETTINGS_VIEW_JS}
${NAVIGATION_JS}
document.getElementById("backButton").innerHTML = icon("arrowLeft", 14);
document.getElementById("headerIcon").innerHTML = icon("shield", 15);
document.getElementById("homeButton").innerHTML = icon("home", 14);
document.getElementById("rescanButton").innerHTML = icon("refresh", 14);
document.getElementById("settingsNavButton").innerHTML = icon("settings", 14);
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => possible.charAt(Math.floor(Math.random() * possible.length))).join("");
}
