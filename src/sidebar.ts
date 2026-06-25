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

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: RepoIdentitySidebarActions,
  ) {}

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
    const cssUri = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"),
    );

    this.view.webview.html = getHtml(
      nonce,
      state,
      cssUri,
      this.view.webview.cspSource,
    );
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

    localName: localMissing ? "Not pinned" : localName,
    localEmail: localMissing ? "Not set locally. Using global Git config" : localEmail,

    globalName: current?.globalName ?? "Not set",
    globalEmail: current?.globalEmail ?? "Not set",

    effectiveIndicator,
    localIndicator,
    globalIndicator,

    primaryAction:
      evaluation?.state === "localNeeded"
        ? "Set Local Identity"
        : "Fix Local Identity",

    canSetLocal: !!current && !!rule,
  };
}

function statusLabel(state: IdentityState): string {
  switch (state) {
    case "safe":
      return "Safe";
    case "wrong":
      return "Wrong Identity";
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

function getHtml(
  nonce: string,
  encodedState: string,
  cssUri: vscode.Uri,
  cspSource: string,
): string {
  return /* html */ `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${cssUri}" rel="stylesheet" />
  <title>Repo ID</title>
</head>
<body class="custom-scrollbar flex flex-col overflow-y-auto">
  <header class="flex h-[52px] w-full shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container px-sidebar-padding">
    <div class="flex flex-col">
      <span class="text-[18px] font-bold leading-tight text-on-surface">Repo ID</span>
      <span class="text-[11px] leading-none text-on-surface-variant">Git identity safety</span>
    </div>
    <div class="flex gap-1">
      <button class="rounded p-1.5 text-on-surface-variant transition-colors hover:bg-secondary-container hover:text-on-surface" data-action="rescan" title="Rescan">↻</button>
      <button class="rounded p-1.5 text-on-surface-variant transition-colors hover:bg-secondary-container hover:text-on-surface" data-action="settings" title="Settings">⚙</button>
    </div>
  </header>

  <main class="flex flex-1 flex-col gap-lg p-sidebar-padding" id="app"></main>

  <div class="fixed inset-0 z-50 hidden items-end bg-black/50 p-3" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <section class="w-full rounded-xl border border-outline-variant bg-surface-container p-md shadow-2xl">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="text-[15px] font-bold text-on-surface" id="modalTitle">Set Local Identity</div>
        <button class="rounded px-2 py-1 text-on-surface-variant hover:bg-secondary-container hover:text-on-surface" id="closeModal" aria-label="Close modal">×</button>
      </div>
      <div class="text-body-base text-on-surface-variant">
        This will write the expected name and email to this repository only.
      </div>
      <div class="my-3 rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
        <div class="text-body-bold text-on-surface" id="modalName"></div>
        <div class="break-all font-code-mono text-code-mono text-on-surface-variant" id="modalEmail"></div>
      </div>
      <div class="flex justify-end gap-2">
        <button class="rounded-lg bg-secondary-container px-3 py-2 text-body-base text-on-surface" id="cancelModal">Cancel</button>
        <button class="rounded-lg bg-primary px-3 py-2 text-body-bold text-on-primary" id="confirmSet">Set Identity</button>
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

    const symbolForIndicator = (kind) => {
      if (kind === "good") return "✓";
      if (kind === "bad") return "!";
      if (kind === "warn") return "⚠";
      return "○";
    };

    const statusIcon = {
      safe: "✓",
      wrong: "!",
      localNeeded: "⚠",
      unknown: "?",
      notGitRepo: "-",
      error: "!",
    }[state.state] ?? "?";

    const identityCard = (variant, label, name, email, indicatorKind, missingClass = "") => {
      const variantClasses = {
        effective: "text-primary",
        local: "text-tertiary-fixed-dim",
        global: "text-on-surface-variant/70",
      }[variant] ?? "text-on-surface-variant";
      const indicatorClasses = {
        good: "text-inverse-primary",
        warn: "text-tertiary-fixed-dim",
        bad: "text-error",
        neutral: "text-on-surface-variant/50",
      }[indicatorKind] ?? "text-on-surface-variant/50";
      const localCardClasses = variant === "local"
        ? "border-dashed border-tertiary-fixed-dim/40 bg-surface-container-low/50"
        : variant === "global"
          ? "bg-surface-container-low/30"
          : "";

      return \`
        <div class="vs-card flex flex-col gap-xs rounded-lg p-md \${localCardClasses}">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="font-label-caps text-[11px] uppercase tracking-wider \${variantClasses}">\${esc(label)}</span>
            <span class="text-[18px] leading-none \${indicatorClasses}">\${esc(symbolForIndicator(indicatorKind))}</span>
          </div>
          <div>
            <div class="break-words text-[16px] font-semibold text-on-surface \${missingClass}">\${esc(name)}</div>
            <div class="mt-1 break-all font-code-mono text-[13px] text-on-surface-variant \${missingClass}">\${esc(email)}</div>
          </div>
        </div>
      \`;
    };

    const localMissingClass = state.localIndicator === "warn" ? "italic opacity-90" : "";

    app.innerHTML = \`
      <div class="flex items-start gap-md rounded-lg border border-tertiary-fixed-dim/30 bg-tertiary-container/20 p-md shadow-sm">
        <span class="mt-0.5 text-[20px] leading-none text-tertiary-fixed-dim">\${esc(statusIcon)}</span>
        <div class="flex min-w-0 flex-col gap-1">
          <span class="text-[15px] font-semibold text-tertiary-fixed-dim">\${esc(state.statusLabel)}</span>
          <p class="m-0 text-[13px] leading-[1.5] text-on-surface-variant">\${esc(state.statusMessage)}</p>
        </div>
      </div>

      <section class="flex flex-col gap-sm">
        <span class="ml-1 font-label-caps text-label-caps uppercase text-on-surface-variant">Active Identities</span>
        \${identityCard("effective", "Effective Identity", state.effectiveName, state.effectiveEmail, state.effectiveIndicator)}
        \${identityCard("local", "Repo-Specific (Local)", state.localName, state.localEmail, state.localIndicator, localMissingClass)}
        \${identityCard("global", "Fallback Default (Global)", state.globalName, state.globalEmail, state.globalIndicator)}
      </section>

      <button class="flex w-full flex-col items-center justify-center rounded-lg bg-primary px-4 py-4 text-on-primary shadow-lg transition-all hover:bg-[#0062a3] active:scale-[0.98] \${state.canSetLocal ? "" : "cursor-not-allowed opacity-55"}" data-action="showSetModal" \${state.canSetLocal ? "" : "disabled"}>
        <span class="text-[16px] font-bold">\${esc(state.primaryAction)}</span>
        <span class="mt-1 text-[12px] opacity-90">Write expected identity to this repo</span>
      </button>

      <section class="vs-card flex flex-col gap-3 rounded-lg bg-surface-container-lowest/50 p-md">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 text-[20px] text-on-surface-variant/70">☁</span>
          <div class="flex min-w-0 flex-col">
            <span class="font-label-caps text-[11px] uppercase tracking-wider text-on-surface-variant">Remote</span>
            <span class="mt-0.5 break-all font-code-mono text-[13px] text-on-surface">\${esc(state.normalizedRemote)}</span>
          </div>
        </div>
        <div class="flex items-start gap-3">
          <span class="mt-0.5 text-[20px] text-on-surface-variant/70">□</span>
          <div class="flex min-w-0 flex-col">
            <span class="font-label-caps text-[11px] uppercase tracking-wider text-on-surface-variant">Repo root</span>
            <span class="mt-0.5 break-all font-code-mono text-[13px] text-on-surface">\${esc(state.repoRoot)}</span>
          </div>
        </div>
      </section>

      <section class="vs-card flex flex-col gap-2 rounded-lg border-l-4 border-l-primary p-md">
        <span class="mb-1 font-label-caps text-[11px] uppercase tracking-wider text-primary">Matched Rule: \${esc(state.ruleLabel)}</span>
        <div class="flex items-center gap-2 text-on-surface-variant">
          <span class="text-[16px] leading-none">⌘</span>
          <span class="break-all font-code-mono text-[13px]">\${esc(state.ruleMatch)}</span>
        </div>
        <div class="rounded border border-outline-variant/30 bg-surface-container p-3">
          <span class="mb-1.5 block text-[11px] uppercase tracking-tight text-on-surface-variant">Expected Identity</span>
          <span class="break-words text-[14px] font-semibold text-on-surface">
            \${esc(state.expectedName)}
            <span class="font-normal text-on-surface-variant">(\${esc(state.expectedEmail)})</span>
          </span>
        </div>
      </section>

      <section class="mt-auto grid grid-cols-2 gap-3 border-t border-outline-variant/30 pt-4">
        <button class="vs-button-secondary flex h-10 items-center justify-center gap-2 rounded px-3 text-[13px] transition-colors" data-action="addRule">+ Add Rule</button>
        <button class="vs-button-secondary flex h-10 items-center justify-center gap-2 rounded px-3 text-[13px] transition-colors" data-action="copyReport">⧉ Copy Report</button>
        <button class="vs-button-secondary flex h-10 items-center justify-center gap-2 rounded px-3 text-[13px] transition-colors" data-action="rescan">↻ Rescan</button>
        <button class="vs-button-secondary flex h-10 items-center justify-center gap-2 rounded px-3 text-[13px] transition-colors" data-action="settings">⚙ Settings</button>
        <button class="vs-button-secondary col-span-2 mt-1 flex h-10 items-center justify-center gap-2 rounded px-3 text-[13px] transition-colors" data-action="details">ⓘ View Full Details</button>
      </section>
    \`;

    document.getElementById("modalName").textContent = state.expectedName;
    document.getElementById("modalEmail").textContent = state.expectedEmail;

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.dataset.action;
      if (action === "showSetModal") {
        if (!state.canSetLocal) return;
        modal.classList.remove("hidden");
        modal.classList.add("flex");
        document.getElementById("confirmSet").focus();
        return;
      }

      vscode.postMessage({ type: action });
    });

    const closeModal = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    };

    document.getElementById("closeModal").addEventListener("click", closeModal);
    document.getElementById("cancelModal").addEventListener("click", closeModal);
    document.getElementById("confirmSet").addEventListener("click", () => {
      closeModal();
      vscode.postMessage({ type: "setLocalIdentity" });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModal();
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
