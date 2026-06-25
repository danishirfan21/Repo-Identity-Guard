import * as vscode from "vscode";
import { IdentityEvaluation, IdentityState } from "./types";

export interface RepoIdentitySidebarActions {
  showDetails(): Promise<void>;
  setLocalIdentity(): Promise<void>;
  addRule(): Promise<void>;
  copyReport(): Promise<void>;
  rescan(): Promise<void>;
  openSettings(): Promise<void>;
}

export class RepoIdentitySidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private evaluation: IdentityEvaluation | undefined;

  public constructor(private readonly actions: RepoIdentitySidebarActions) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      void this.handleMessage(message.type);
    });
    this.render();
  }

  public update(evaluation: IdentityEvaluation): void {
    this.evaluation = evaluation;
    this.render();
  }

  private async handleMessage(type: string | undefined): Promise<void> {
    switch (type) {
      case "details":
        await this.actions.showDetails();
        break;
      case "setLocalIdentity":
        await this.actions.setLocalIdentity();
        break;
      case "addRule":
        await this.actions.addRule();
        break;
      case "copyReport":
        await this.actions.copyReport();
        break;
      case "rescan":
        await this.actions.rescan();
        break;
      case "settings":
        await this.actions.openSettings();
        break;
    }
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const nonce = getNonce();
    const state = encodeURIComponent(
      JSON.stringify(toWebviewState(this.evaluation)),
    );
    this.view.webview.html = getHtml(nonce, state);
  }
}

function toWebviewState(evaluation: IdentityEvaluation | undefined) {
  const current = evaluation?.current;
  const rule = evaluation?.rule;
  const localName = current?.localName ?? null;
  const localEmail = current?.localEmail ?? null;
  const localMissing = !localName || !localEmail;
  const effectiveIndicator = indicatorForEffective(evaluation);
  const localIndicator = indicatorForLocal(evaluation);
  const globalIndicator = indicatorForGlobal(evaluation);

  return {
    state: evaluation?.state ?? "unknown",
    statusLabel: evaluation ? statusLabel(evaluation.state) : "Not Scanned",
    statusMessage: evaluation
      ? statusMessage(evaluation)
      : "Repo ID has not scanned this workspace yet.",
    normalizedRemote: evaluation?.normalizedRemote ?? "Not set",
    rawRemote: current?.remoteUrl ?? "Not set",
    repoRoot: current?.repoRoot ?? "Not in a Git repo",
    ruleLabel: rule?.label ?? "No matched rule",
    ruleMatch: rule?.match ?? "None",
    expectedName: rule?.name ?? "Not set",
    expectedEmail: rule?.email ?? "Not set",
    effectiveName: current?.effectiveName ?? "Not set",
    effectiveEmail: current?.effectiveEmail ?? "Not set",
    localName: localMissing ? "Not set locally" : localName,
    localEmail: localMissing ? "Using global Git config" : localEmail,
    globalName: current?.globalName ?? "Not set",
    globalEmail: current?.globalEmail ?? "Not set",
    effectiveIndicator,
    localIndicator,
    globalIndicator,
    effectiveIndicatorLabel: indicatorLabel(effectiveIndicator),
    localIndicatorLabel: localMissing
      ? "Not pinned"
      : indicatorLabel(localIndicator),
    globalIndicatorLabel: indicatorLabel(globalIndicator),
    primaryAction:
      evaluation?.state === "localNeeded"
        ? "Set Local Identity"
        : "Fix Local Identity",
    canSetLocal: !!current && !!rule,
  };
}

function indicatorLabel(kind: string): string {
  switch (kind) {
    case "good":
      return "Match";
    case "warn":
      return "Check";
    case "bad":
      return "Wrong";
    default:
      return "-";
  }
}

function statusLabel(state: IdentityState): string {
  switch (state) {
    case "safe":
      return "Safe";
    case "wrong":
      return "Wrong";
    case "localNeeded":
      return "Local Needed";
    case "unknown":
      return "Unknown";
    case "notGitRepo":
      return "Not a Git Repo";
    case "error":
      return "Error";
  }
}

function statusMessage(evaluation: IdentityEvaluation): string {
  switch (evaluation.state) {
    case "safe":
      return "Git will commit with the expected identity for this repo.";
    case "wrong":
      return "Git would commit with an identity that does not match this repo's rule.";
    case "localNeeded":
      return "Effective identity matches, but this repo is not pinned locally. If global Git config changes, this repo may become unsafe.";
    case "unknown":
      return "No matching identity rule was found for this repo.";
    default:
      return evaluation.message;
  }
}

function indicatorForEffective(evaluation: IdentityEvaluation | undefined): string {
  if (!evaluation?.rule || !evaluation.current) {
    return "neutral";
  }
  return evaluation.state === "wrong" ? "bad" : "good";
}

function indicatorForLocal(evaluation: IdentityEvaluation | undefined): string {
  if (!evaluation?.rule || !evaluation.current) {
    return "neutral";
  }

  const nameMatches =
    evaluation.current.localName?.trim() === evaluation.rule.name.trim();
  const emailMatches =
    evaluation.current.localEmail?.trim().toLocaleLowerCase() ===
    evaluation.rule.email.trim().toLocaleLowerCase();
  return nameMatches && emailMatches ? "good" : "warn";
}

function indicatorForGlobal(evaluation: IdentityEvaluation | undefined): string {
  if (!evaluation?.rule || !evaluation.current) {
    return "neutral";
  }

  const nameMatches =
    evaluation.current.globalName?.trim() === evaluation.rule.name.trim();
  const emailMatches =
    evaluation.current.globalEmail?.trim().toLocaleLowerCase() ===
    evaluation.rule.email.trim().toLocaleLowerCase();
  return nameMatches && emailMatches ? "good" : "warn";
}

function getHtml(nonce: string, encodedState: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Repo ID</title>
  <style>
    :root {
      --card: color-mix(in srgb, var(--vscode-sideBar-background) 86%, var(--vscode-editor-background));
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --ok: #42c983;
      --warn: #f2c94c;
      --bad: #ff6b6b;
      --blue: #4da3ff;
      --purple: #a78bfa;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button {
      font: inherit;
      color: inherit;
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
    }
    .shell { padding: 10px; }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 0 8px;
      gap: 8px;
    }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .logo {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: rgba(124, 92, 255, .18);
      color: var(--purple);
      font-size: 15px;
      flex: 0 0 auto;
    }
    h1 { margin: 0; font-size: 17px; line-height: 1.1; }
    .subtitle { color: var(--muted); margin-top: 1px; font-size: 12px; }
    .header-actions { display: flex; gap: 4px; }
    .icon-button {
      width: 28px;
      height: 28px;
      background: transparent;
      color: var(--muted);
      font-size: 14px;
      padding: 0;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 11px;
      padding: 10px;
      margin: 0 0 8px;
      background: var(--card);
      box-shadow: 0 8px 20px rgba(0,0,0,.10);
    }
    .card-title {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 7px;
      font-weight: 700;
      font-size: 13px;
    }
    .status-card {
      border-color: color-mix(in srgb, var(--status-color) 48%, var(--border));
      background: linear-gradient(135deg, color-mix(in srgb, var(--status-color) 12%, transparent), var(--card));
    }
    .status-row { display: flex; gap: 9px; align-items: flex-start; }
    .status-icon {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: color-mix(in srgb, var(--status-color) 16%, transparent);
      color: var(--status-color);
      border: 1px solid color-mix(in srgb, var(--status-color) 42%, transparent);
      flex: 0 0 auto;
      font-size: 15px;
      font-weight: 800;
    }
    .status-title { color: var(--status-color); font-size: 15px; font-weight: 800; margin-bottom: 3px; }
    .status-text { color: var(--vscode-foreground); line-height: 1.32; font-size: 12px; }
    .section-label {
      margin: 2px 2px 6px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: 800;
    }
    .kv { display: grid; gap: 6px; }
    .key { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .045em; }
    .value { overflow-wrap: anywhere; line-height: 1.25; }
    .secondary-text { color: var(--muted); font-size: 11px; }
    .pill {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--ok) 18%, transparent);
      color: var(--ok);
      border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent);
      font-weight: 700;
      margin-bottom: 6px;
    }
    .identity-stack {
      display: grid;
      gap: 6px;
      margin-bottom: 8px;
    }
    .identity-section {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 9px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-editor-background));
    }
    .identity-section.local.warn {
      border-style: dashed;
      border-color: color-mix(in srgb, var(--warn) 38%, var(--border));
      background: color-mix(in srgb, var(--warn) 7%, var(--card));
    }
    .identity-label { font-weight: 800; margin-bottom: 2px; font-size: 10px; text-transform: uppercase; letter-spacing: .045em; }
    .identity-label.effective { color: var(--blue); }
    .identity-label.local { color: var(--warn); }
    .identity-label.global { color: var(--purple); }
    .identity-meta { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
    .email { color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; font-size: 12px; }
    .indicator {
      border-radius: 999px;
      min-height: 19px;
      padding: 2px 7px;
      display: grid;
      place-items: center;
      font-size: 10px;
      font-weight: 800;
    }
    .indicator.good { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
    .indicator.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
    .indicator.bad { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); }
    .indicator.neutral { background: var(--vscode-input-background); color: var(--muted); }
    .primary {
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
      padding: 10px 11px;
      text-align: left;
      font-weight: 700;
      margin-bottom: 8px;
      box-shadow: 0 8px 22px color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
    }
    .primary small { display: block; opacity: .85; font-weight: 400; margin-top: 2px; font-size: 11px; }
    .grid-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 8px;
      text-align: left;
      min-height: 36px;
      font-weight: 600;
    }
    .secondary:hover, .icon-button:hover {
      background: var(--vscode-button-hoverBackground);
      color: var(--vscode-button-foreground);
    }
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.45);
      padding: 12px;
      align-items: end;
      z-index: 10;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      background: var(--vscode-editor-background);
      box-shadow: 0 18px 60px rgba(0,0,0,.35);
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .modal-title { font-weight: 800; font-size: 15px; }
    .expected-box {
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      margin: 10px 0;
      background: var(--vscode-input-background);
    }
    .modal-actions { display: flex; justify-content: flex-end; gap: 7px; }
    .modal-actions button { padding: 8px 11px; }
    .set-button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .cancel-button { background: var(--vscode-button-secondaryBackground); }
    .disabled { opacity: .55; cursor: not-allowed; }
  </style>
</head>
<body>
  <main class="shell" id="app"></main>
  <div class="modal-backdrop" id="modal">
    <section class="modal">
      <div class="modal-header">
        <div class="modal-title">Set Local Identity</div>
        <button class="icon-button" id="closeModal" aria-label="Close">x</button>
      </div>
      <div class="status-text">This will write the expected name and email to this repository only.</div>
      <div class="expected-box">
        <div class="value" id="modalName"></div>
        <div class="email" id="modalEmail"></div>
      </div>
      <div class="modal-actions">
        <button class="cancel-button" id="cancelModal">Cancel</button>
        <button class="set-button" id="confirmSet">Set Identity</button>
      </div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = JSON.parse(decodeURIComponent("${encodedState}"));
    const app = document.getElementById("app");
    const modal = document.getElementById("modal");

    const esc = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

    const statusMeta = {
      safe: { color: "var(--ok)", icon: "✓" },
      wrong: { color: "var(--bad)", icon: "!" },
      localNeeded: { color: "var(--warn)", icon: "⚠" },
      unknown: { color: "var(--muted)", icon: "?" },
      notGitRepo: { color: "var(--muted)", icon: "-" },
      error: { color: "var(--bad)", icon: "X" },
    }[state.state] ?? { color: "var(--muted)", icon: "?" };

    const indicator = (kind, label) => {
      return '<div class="indicator ' + esc(kind) + '">' + esc(label) + '</div>';
    };

    const identityBlock = (label, meta, cls, name, email, kind) => \`
      <div class="identity-section \${cls} \${kind}">
        <div>
          <div class="identity-label \${cls}">\${esc(label)}</div>
          <div class="identity-meta">\${esc(meta)}</div>
          <div class="value">\${esc(name)}</div>
          <div class="email">\${esc(email)}</div>
        </div>
        \${indicator(kind, state[cls + "IndicatorLabel"])}
      </div>\`;

    app.innerHTML = \`
      <header class="header">
        <div class="brand">
          <div class="logo">ID</div>
          <div>
            <h1>Repo ID</h1>
            <div class="subtitle">Git identity safety</div>
          </div>
        </div>
        <div class="header-actions">
          <button class="icon-button" data-action="rescan" title="Rescan">↻</button>
          <button class="icon-button" data-action="settings" title="Settings">⚙</button>
        </div>
      </header>

      <section class="card status-card" style="--status-color: \${statusMeta.color}">
        <div class="status-row">
          <div class="status-icon">\${statusMeta.icon}</div>
          <div>
            <div class="status-title">\${esc(state.statusLabel)}</div>
            <div class="status-text">\${esc(state.statusMessage)}</div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-label">Active Identities</div>
        <div class="identity-stack">
          \${identityBlock("Effective identity", "Used for commits", "effective", state.effectiveName, state.effectiveEmail, state.effectiveIndicator)}
          \${identityBlock("Repo-specific (local)", "Repo-specific", "local", state.localName, state.localEmail, state.localIndicator)}
          \${identityBlock("Fallback default (global)", "Fallback default", "global", state.globalName, state.globalEmail, state.globalIndicator)}
        </div>
      </section>

      <button class="primary \${state.canSetLocal ? "" : "disabled"}" data-action="showSetModal" \${state.canSetLocal ? "" : "disabled"}>
        \${esc(state.primaryAction)}
        <small>Write expected identity to this repo</small>
      </button>

      <section class="card">
        <div class="card-title">Repository</div>
        <div class="kv">
          <div><div class="key">Remote</div><div class="value">\${esc(state.normalizedRemote)}</div></div>
          <div><div class="key">Repo root</div><div class="secondary-text">\${esc(state.repoRoot)}</div></div>
          <div><div class="key">Raw remote</div><div class="secondary-text">\${esc(state.rawRemote)}</div></div>
        </div>
      </section>

      <section class="card">
        <div class="card-title">Matched Rule</div>
        <div class="pill">\${esc(state.ruleLabel)}</div>
        <div class="kv">
          <div><div class="key">Pattern</div><div class="value">\${esc(state.ruleMatch)}</div></div>
          <div class="secondary-text">Expected: \${esc(state.expectedName)} &lt;\${esc(state.expectedEmail)}&gt;</div>
        </div>
      </section>

      <section class="card">
        <div class="card-title">Actions</div>
        <div class="grid-actions">
          <button class="secondary" data-action="addRule">+ Add Rule</button>
          <button class="secondary" data-action="copyReport">⧉ Copy Report</button>
          <button class="secondary" data-action="rescan">↻ Rescan</button>
          <button class="secondary" data-action="settings">⚙ Settings</button>
          <button class="secondary" data-action="details">ⓘ View Full Details</button>
        </div>
      </section>\`;

    document.getElementById("modalName").textContent = state.expectedName;
    document.getElementById("modalEmail").textContent = state.expectedEmail;

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "showSetModal") {
        modal.classList.add("open");
      } else {
        vscode.postMessage({ type: action });
      }
    });

    document.getElementById("closeModal").addEventListener("click", () => modal.classList.remove("open"));
    document.getElementById("cancelModal").addEventListener("click", () => modal.classList.remove("open"));
    document.getElementById("confirmSet").addEventListener("click", () => {
      modal.classList.remove("open");
      vscode.postMessage({ type: "setLocalIdentity" });
    });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    possible.charAt(Math.floor(Math.random() * possible.length)),
  ).join("");
}
