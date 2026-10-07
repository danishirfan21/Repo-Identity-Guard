import * as vscode from "vscode";
import { NoteMutationResult, SidebarActions, dispatchSidebarMessage } from "./sidebarMessages";
import { PLACEHOLDER_VIEW_JS } from "../webview/client/placeholderView";
import { SidebarModel, toWireState } from "./wireState";

export type { NoteMutationResult, SidebarActions } from "./sidebarMessages";

/** Placeholder sidebar host — see `src/webview/client/placeholderView.ts`. */
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
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") {
        this.postState();
        return;
      }
      void dispatchSidebarMessage(this.actions, message ?? {}, (requestId, result) => this.postNoteResult(requestId, result));
    });
    webviewView.webview.html = this.getHtml();
    this.postState();
  }

  public update(model: SidebarModel): void {
    this.model = model;
    this.postState();
  }

  private postState(): void {
    if (!this.view || !this.model) return;
    void this.view.webview.postMessage({ type: "state", payload: toWireState(this.model) });
  }

  private postNoteResult(requestId: unknown, result: NoteMutationResult): void {
    if (!this.view || typeof requestId !== "string" || !requestId) return;
    void this.view.webview.postMessage({ type: "noteResult", requestId, ok: result.ok, error: result.error });
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
${PLACEHOLDER_VIEW_JS}
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => possible.charAt(Math.floor(Math.random() * possible.length))).join("");
}
