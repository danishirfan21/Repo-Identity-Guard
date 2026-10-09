import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { OperationResult, parseWebviewMessage } from "./protocol";
import { RepoIdentityUiState } from "./productionState";
import { PRODUCTION_VIEW_JS } from "../webview/client/productionView";

/**
 * Everything the production webview can ask the extension host to do.
 * Every handler re-validates its own preconditions (current repository,
 * Workspace Trust for anything that mutates Git hooks/config) — the
 * webview is never trusted to have done so; see `parseWebviewMessage` for
 * the runtime validation boundary this provider sits behind.
 *
 * Methods that correspond to a `requestId`-bearing `WebviewMessage`
 * return an `OperationResult`, which this provider echoes back as an
 * `operationResult` ACK — see "OPERATION RESULT RULE" in the task spec:
 * `ok: true` must mean the backend operation succeeded AND the
 * authoritative state has already been (or is about to be) refreshed via
 * a separate `state` push.
 */
export interface ProductionSidebarActions {
  getState(): Promise<RepoIdentityUiState>;
  /**
   * Every repo-scoped action below takes the `repoId` the webview sent —
   * the repository id the VISIBLE SCREEN was bound to, never a picker
   * (see `src/ui/protocol.ts`). Implementations must validate it against
   * the ACTUAL current repository before doing anything (see
   * `validateRepoTarget` in `extension.ts`) and must reject a mismatch
   * with `{ ok: false, code: "repository_changed" }` rather than silently
   * acting on either repository — this interface only carries the id
   * through; it is not itself the enforcement point.
   */
  assignIdentity(repoId: string, identityId: string): Promise<OperationResult>;
  changeIdentity(repoId: string, identityId: string): Promise<OperationResult>;
  unlockRepository(repoId: string): Promise<OperationResult>;
  repairLock(repoId: string): Promise<OperationResult>;
  verifyLock(repoId: string): Promise<OperationResult>;
  applyAssignedIdentity(repoId: string): Promise<OperationResult>;
  /** Not repo-scoped — identity-settings CRUD, no `repoId`. */
  saveIdentity(identity: unknown): Promise<OperationResult>;
  deleteIdentity(identityId: string): Promise<OperationResult>;
  addNote(repoId: string, text: string): Promise<OperationResult>;
  updateNote(repoId: string, noteId: string, text: string): Promise<OperationResult>;
  deleteNote(repoId: string, noteId: string): Promise<OperationResult>;
  togglePinNote(repoId: string, noteId: string): Promise<OperationResult>;
  /** Ack-based (see "COPY MUST NOT ANNOUNCE SUCCESS BEFORE SUCCESS"): resolves only after the clipboard write actually succeeds or fails. */
  copyNote(repoId: string, noteId: string): Promise<OperationResult>;
  importNotes(repoId: string): Promise<void>;
  exportNotes(repoId: string): Promise<void>;
  /** The real VS Code "open folder" flow, for the No-Repository screen's one action — not repo-scoped (there is no repository yet). */
  openFolder(): Promise<void>;
}

/** The production Repo Identity Guard sidebar — see `src/webview/client/productionView.ts`. */
export class RepoIdentitySidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: ProductionSidebarActions,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage((raw) => void this.handleMessage(raw));
    webviewView.webview.html = this.getHtml();
    void this.postState();
  }

  /** Called by extension.ts whenever the authoritative state may have changed (scan, mutation, config/trust change, active-editor change). */
  public update(): void {
    void this.postState();
  }

  private async handleMessage(raw: unknown): Promise<void> {
    // Runtime validation boundary: a stale/compromised/future-version
    // webview can send anything, and TS types vouch for nothing at
    // runtime — see "CSP/WEBVIEW SECURITY" in the task spec. A message
    // that doesn't parse is silently dropped, never partially acted on.
    const message = parseWebviewMessage(raw);
    if (!message) return;

    switch (message.type) {
      case "ready":
        await this.postState();
        return;
      case "assignIdentity":
        await this.runOperation(message.requestId, () => this.actions.assignIdentity(message.repoId, message.identityId));
        return;
      case "changeIdentity":
        await this.runOperation(message.requestId, () => this.actions.changeIdentity(message.repoId, message.identityId));
        return;
      case "unlockRepository":
        await this.runOperation(message.requestId, () => this.actions.unlockRepository(message.repoId));
        return;
      case "repairLock":
        await this.runOperation(message.requestId, () => this.actions.repairLock(message.repoId));
        return;
      case "verifyLock":
        await this.runOperation(message.requestId, () => this.actions.verifyLock(message.repoId));
        return;
      case "applyAssignedIdentity":
        await this.runOperation(message.requestId, () => this.actions.applyAssignedIdentity(message.repoId));
        return;
      case "saveIdentity":
        await this.runOperation(message.requestId, () => this.actions.saveIdentity(message.identity));
        return;
      case "deleteIdentity":
        await this.runOperation(message.requestId, () => this.actions.deleteIdentity(message.identityId));
        return;
      case "addNote":
        await this.runOperation(message.requestId, () => this.actions.addNote(message.repoId, message.text));
        return;
      case "updateNote":
        await this.runOperation(message.requestId, () => this.actions.updateNote(message.repoId, message.noteId, message.text));
        return;
      case "deleteNote":
        await this.runOperation(message.requestId, () => this.actions.deleteNote(message.repoId, message.noteId));
        return;
      case "togglePinNote":
        await this.runOperation(message.requestId, () => this.actions.togglePinNote(message.repoId, message.noteId));
        return;
      case "copyNote":
        await this.runOperation(message.requestId, () => this.actions.copyNote(message.repoId, message.noteId));
        return;
      case "importNotes":
        await this.actions.importNotes(message.repoId);
        return;
      case "exportNotes":
        await this.actions.exportNotes(message.repoId);
        return;
      case "openFolder":
        await this.actions.openFolder();
        return;
      default:
        return;
    }
  }

  private async runOperation(requestId: string, run: () => Promise<OperationResult>): Promise<void> {
    let result: OperationResult;
    try {
      result = await run();
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.postOperationResult(requestId, result);
    // A state push always follows an operation result, success or
    // failure, so the webview's own authoritative render reflects reality
    // regardless of which message arrives first — see "OPERATION RESULT
    // RULE" in the task spec.
    await this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const payload = await this.actions.getState();
    void this.view.webview.postMessage({ type: "state", payload });
  }

  private postOperationResult(requestId: string, result: OperationResult): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "operationResult", requestId, ...result });
  }

  private getHtml(): string {
    if (!this.view) return "";
    const nonce = getNonce();
    const cssUri = this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"));
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
<body>
<main id="app"></main>
<script nonce="${nonce}">
${PRODUCTION_VIEW_JS}
</script>
</body>
</html>`;
  }
}

/** CSP script nonce — from a CSPRNG, never Math.random(). */
function getNonce(): string {
  return crypto.randomBytes(24).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}
