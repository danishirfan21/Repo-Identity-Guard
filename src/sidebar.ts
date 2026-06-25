import * as vscode from "vscode";
import { IdentityEvaluation, IdentityState } from "./types";

export interface RepoIdentitySidebarActions {
  showDetails(): Promise<void>;
  setLocalIdentity(): Promise<void>;
  setCustomLocalIdentity(name: string, email: string): Promise<void>;
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
    webviewView.webview.onDidReceiveMessage((message: {
      type?: string;
      name?: string;
      email?: string;
    }) => {
      void this.handleMessage(message);
    });
    this.render();
  }

  public update(evaluation: IdentityEvaluation): void {
    this.evaluation = evaluation;
    this.render();
  }

  private async handleMessage(message: {
    type?: string;
    name?: string;
    email?: string;
  }): Promise<void> {
    switch (message.type) {
      case "details":
        await this.actions.showDetails();
        break;
      case "setLocalIdentity":
        await this.actions.setLocalIdentity();
        break;
      case "setCustomLocalIdentity":
        await this.actions.setCustomLocalIdentity(
          message.name ?? "",
          message.email ?? "",
        );
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
  <header class="flex h-[42px] w-full shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container px-sidebar-padding">
    <div class="flex flex-col">
      <span class="text-[16px] font-bold leading-tight text-on-surface">Repo ID</span>
      <span class="text-[11px] leading-none text-on-surface-variant">Git identity safety</span>
    </div>
    <div class="flex gap-1">
      <button class="rounded p-1.5 text-on-surface-variant transition-colors hover:bg-secondary-container hover:text-on-surface" data-action="rescan" title="Rescan">↻</button>
      <button class="rounded p-1.5 text-on-surface-variant transition-colors hover:bg-secondary-container hover:text-on-surface" data-action="settings" title="Settings">⚙</button>
    </div>
  </header>

  <main class="flex flex-1 flex-col gap-lg p-sidebar-padding" id="app"></main>

  <div class="fixed inset-0 z-50 hidden items-center bg-black/70 p-2.5 backdrop-blur-[1px]" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <div class="w-full" id="modalContent"></div>
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
        <div class="vs-card flex flex-col gap-xs rounded-lg p-2 \${localCardClasses}">
          <div class="mb-0.5 flex items-center justify-between">
            <span class="font-label-caps text-[10px] uppercase tracking-wider \${variantClasses}">\${esc(label)}</span>
            <span class="text-[16px] leading-none \${indicatorClasses}">\${esc(symbolForIndicator(indicatorKind))}</span>
          </div>
          <div>
            <div class="break-words text-[14px] font-semibold text-on-surface \${missingClass}">\${esc(name)}</div>
            <div class="mt-0.5 break-all font-code-mono text-[12px] text-on-surface-variant \${missingClass}">\${esc(email)}</div>
          </div>
        </div>
      \`;
    };

    const localMissingClass = state.localIndicator === "warn" ? "italic opacity-90" : "";

    app.innerHTML = \`
      <div class="flex items-start gap-2 rounded-lg border border-tertiary-fixed-dim/30 bg-tertiary-container/20 p-2.5 shadow-sm">
        <span class="mt-0.5 text-[17px] leading-none text-tertiary-fixed-dim">\${esc(statusIcon)}</span>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-[14px] font-semibold text-tertiary-fixed-dim">\${esc(state.statusLabel)}</span>
          <p class="m-0 text-[12px] leading-[1.45] text-on-surface-variant">\${esc(state.statusMessage)}</p>
        </div>
      </div>

      <section class="flex flex-col gap-1.5">
        <span class="ml-1 font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Active Identities</span>
        \${identityCard("effective", "Effective Identity", state.effectiveName, state.effectiveEmail, state.effectiveIndicator)}
        \${identityCard("local", "Repo-Specific (Local)", state.localName, state.localEmail, state.localIndicator, localMissingClass)}
        \${identityCard("global", "Fallback Default (Global)", state.globalName, state.globalEmail, state.globalIndicator)}
      </section>

      <button class="flex w-full flex-col items-center justify-center rounded-lg bg-primary px-4 py-2 text-on-primary shadow-lg transition-all hover:bg-[#0062a3] active:scale-[0.98] \${state.canSetLocal ? "" : "cursor-not-allowed opacity-55"}" data-action="showSetModal" \${state.canSetLocal ? "" : "disabled"}>
        <span class="text-[14px] font-bold">\${esc(state.primaryAction)}</span>
        <span class="mt-0.5 text-[11px] opacity-90">Write expected identity to this repo</span>
      </button>

      <section class="vs-card flex flex-col gap-2 rounded-lg bg-surface-container-lowest/50 p-md">
        <div class="flex items-start gap-2">
          <span class="mt-0.5 text-[18px] text-on-surface-variant/70">☁</span>
          <div class="flex min-w-0 flex-col">
            <span class="font-label-caps text-[11px] uppercase tracking-wider text-on-surface-variant">Remote</span>
            <span class="mt-0.5 break-all font-code-mono text-[12px] text-on-surface">\${esc(state.normalizedRemote)}</span>
          </div>
        </div>
        <div class="flex items-start gap-2">
          <span class="mt-0.5 text-[18px] text-on-surface-variant/70">□</span>
          <div class="flex min-w-0 flex-col">
            <span class="font-label-caps text-[11px] uppercase tracking-wider text-on-surface-variant">Repo root</span>
            <span class="mt-0.5 break-all font-code-mono text-[12px] text-on-surface">\${esc(state.repoRoot)}</span>
          </div>
        </div>
      </section>

      <section class="vs-card flex flex-col gap-1.5 rounded-lg border-l-4 border-l-primary p-md">
        <span class="mb-0.5 truncate font-label-caps text-[10px] uppercase tracking-wider text-primary" title="Rule: \${esc(state.ruleLabel)}">Rule: \${esc(state.ruleLabel)}</span>
        <div class="flex items-center gap-2 text-on-surface-variant">
          <span class="text-[14px] leading-none">⌘</span>
          <span class="break-all font-code-mono text-[12px]">\${esc(state.ruleMatch)}</span>
        </div>
        <div class="rounded border border-outline-variant/30 bg-surface-container p-2">
          <span class="mb-1 block text-[10px] uppercase tracking-tight text-on-surface-variant">Expected Identity</span>
          <span class="break-words text-[13px] font-semibold text-on-surface">
            \${esc(state.expectedName)}
            <span class="font-normal text-on-surface-variant">(\${esc(state.expectedEmail)})</span>
          </span>
        </div>
      </section>

      <section class="mt-auto grid grid-cols-2 gap-2 border-t border-outline-variant/30 pt-2.5">
        <button class="vs-button-secondary flex h-8 items-center justify-center gap-1.5 rounded px-2 text-[12px] transition-colors" data-action="addRule">+ Add Rule</button>
        <button class="vs-button-secondary flex h-8 items-center justify-center gap-1.5 rounded px-2 text-[12px] transition-colors" data-action="copyReport">⧉ Copy Report</button>
        <button class="vs-button-secondary flex h-8 items-center justify-center gap-1.5 rounded px-2 text-[12px] transition-colors" data-action="rescan">↻ Rescan</button>
        <button class="vs-button-secondary flex h-8 items-center justify-center gap-1.5 rounded px-2 text-[12px] transition-colors" data-action="settings">⚙ Settings</button>
        <button class="vs-button-secondary col-span-2 mt-0.5 flex h-8 items-center justify-center gap-1.5 rounded px-2 text-[12px] transition-colors" data-action="details">ⓘ View Full Details</button>
      </section>
    \`;

    const modalContent = document.getElementById("modalContent");
    let modalMode = "view";

    const readonlyRow = (label, value, mono = false) => \`
      <div class="flex items-center justify-between gap-2 p-sm">
        <div class="flex min-w-0 flex-col">
          <span class="text-[10px] font-bold uppercase text-outline">\${esc(label)}</span>
          <span class="\${mono ? "font-code-mono text-code-mono text-primary" : "text-body-bold font-semibold text-on-surface"} break-all">\${esc(value)}</span>
        </div>
        <span class="shrink-0 text-outline/60">▣</span>
      </div>
    \`;

    const renderViewModal = () => \`
      <section class="max-h-[calc(100vh-20px)] overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-2xl">
        <div class="space-y-xs p-md">
          <div class="flex items-center gap-sm">
            <span class="text-primary">◉</span>
            <h1 class="m-0 text-headline-lg font-semibold text-on-surface" id="modalTitle">Set Local Identity</h1>
          </div>
          <p class="m-0 text-body-base text-on-surface-variant">Pin this repository to the expected Git identity.</p>
        </div>

        <div class="custom-scrollbar flex max-h-[55vh] flex-col gap-md overflow-y-auto px-md pb-md">
          <p class="m-0 text-[11px] leading-tight text-on-surface-variant opacity-80">
            This writes a repo-specific Git identity so future global Git config changes will not make this repository unsafe.
          </p>

          <div class="space-y-sm">
            <span class="font-label-caps text-label-caps uppercase text-outline">Expected Identity</span>
            <div class="divide-y divide-outline-variant rounded border border-outline-variant bg-surface-container-low">
              \${readonlyRow("Name", state.expectedName)}
              \${readonlyRow("Email", state.expectedEmail, true)}
            </div>
          </div>

          <div class="space-y-xs">
            <div class="flex items-start justify-between gap-2 py-xs">
              <span class="text-body-base text-on-surface-variant">Repository</span>
              <span class="max-w-[62%] break-all rounded bg-surface-variant px-xs text-right font-code-mono text-code-mono text-on-surface">\${esc(state.repoRoot)}</span>
            </div>
            <div class="flex items-center justify-between gap-2 py-xs">
              <span class="text-body-base text-on-surface-variant">Matched rule</span>
              <span class="flex items-center gap-xs text-body-bold font-semibold text-tertiary">
                <span class="h-1.5 w-1.5 rounded-full bg-tertiary"></span>
                \${esc(state.ruleLabel)}
              </span>
            </div>
          </div>

          <div class="flex gap-sm rounded border border-tertiary/20 bg-tertiary/10 p-sm">
            <span class="shrink-0 text-tertiary">⚠</span>
            <p class="m-0 text-[11px] leading-tight text-tertiary">
              Only this repository's local Git config will be changed. Your global Git identity will not be modified.
            </p>
          </div>
        </div>

        <div class="space-y-sm border-t border-outline-variant bg-surface-container-high p-md">
          <button class="flex h-[28px] w-full items-center justify-center gap-xs rounded bg-primary text-body-bold font-semibold text-on-primary shadow-sm transition-opacity hover:opacity-90" id="confirmSet">
            Set Local Identity
          </button>
          <div class="flex gap-sm">
            <button class="h-[26px] flex-1 rounded border border-outline-variant text-body-base text-on-surface transition-colors hover:bg-surface-variant" id="editModal">Edit</button>
            <button class="h-[26px] flex-1 rounded text-body-base text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface" id="cancelModal">Cancel</button>
          </div>
        </div>
      </section>
      <div class="mt-md text-center">
        <p class="m-0 flex items-center justify-center gap-xs text-[10px] font-bold uppercase tracking-widest text-outline opacity-60">
          <span class="h-1 w-1 animate-pulse rounded-full bg-primary"></span>
          Ready to Commit
        </p>
      </div>
    \`;

    const renderEditModal = (name = state.expectedName, email = state.expectedEmail, error = "") => \`
      <section class="max-h-[calc(100vh-20px)] overflow-hidden rounded-xl border border-outline-variant bg-surface-container shadow-2xl">
        <div class="flex h-[44px] items-center justify-between border-b border-outline-variant bg-surface-container-high px-sidebar-padding">
          <div class="flex items-center gap-2">
            <span class="text-primary">◉</span>
            <h1 class="m-0 text-headline-md font-semibold text-on-surface" id="modalTitle">Edit Local Identity</h1>
          </div>
          <button class="rounded px-2 py-1 text-on-surface-variant transition-colors hover:text-on-surface" id="closeModal" aria-label="Close modal">×</button>
        </div>

        <div class="custom-scrollbar flex max-h-[64vh] flex-col gap-md overflow-y-auto p-md">
          <div class="flex flex-col gap-md">
            <label class="flex flex-col gap-xs">
              <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Full Name</span>
              <input class="h-[28px] w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-1.5 text-body-base text-on-surface" id="editName" placeholder="Enter git name" type="text" value="\${esc(name)}" />
            </label>
            <label class="flex flex-col gap-xs">
              <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Email Address</span>
              <input class="h-[28px] w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-1.5 font-code-mono text-code-mono text-on-surface" id="editEmail" placeholder="name@example.com" type="email" value="\${esc(email)}" />
            </label>
            <p class="m-0 text-[11px] italic leading-[14px] text-on-surface-variant">
              Editing these values will set a custom local Git identity for this repository.
            </p>
            <p class="\${error ? "" : "hidden"} m-0 rounded border border-error/40 bg-error-container/30 p-2 text-[11px] leading-tight text-error" id="modalError">\${esc(error)}</p>
          </div>

          <div class="h-px w-full bg-outline-variant"></div>

          <div class="flex flex-col gap-sm">
            <div class="flex items-start justify-between gap-2">
              <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Repository</span>
              <span class="max-w-[62%] break-all text-right font-code-mono text-code-mono text-on-surface">\${esc(state.repoRoot)}</span>
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Matched rule</span>
              <span class="flex items-center gap-1.5 text-body-bold font-semibold text-on-surface">
                <span class="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(0,122,204,0.45)]"></span>
                \${esc(state.ruleLabel)}
              </span>
            </div>
          </div>

          <div class="flex flex-col gap-sm pt-1">
            <button class="flex h-[32px] w-full items-center justify-center gap-2 rounded-md bg-primary-container text-body-bold font-semibold text-on-primary-container transition-all hover:brightness-110" id="saveCustom">▣ Save Local Identity</button>
            <div class="grid grid-cols-2 gap-sm">
              <button class="h-[28px] rounded-md border border-outline-variant bg-surface-variant text-body-base text-on-surface transition-colors hover:bg-secondary-container" id="resetToRule">Reset to Rule</button>
              <button class="h-[28px] rounded-md text-body-base text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface" id="cancelModal">Cancel</button>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 border-t border-outline-variant bg-surface-container-lowest px-sidebar-padding py-2">
          <span class="text-[14px] text-outline">▣</span>
          <span class="font-label-caps text-[9px] uppercase tracking-widest text-outline">Isolated Workspace Security</span>
        </div>
      </section>
    \`;

    const showValidation = (message) => {
      const nameInput = document.getElementById("editName");
      const emailInput = document.getElementById("editEmail");
      renderModal("edit", nameInput?.value ?? state.expectedName, emailInput?.value ?? state.expectedEmail, message);
      document.getElementById("editName")?.focus();
    };

    const isEmailish = (email) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);

    const renderModal = (mode = modalMode, name = state.expectedName, email = state.expectedEmail, error = "") => {
      modalMode = mode;
      modalContent.innerHTML = mode === "edit"
        ? renderEditModal(name, email, error)
        : renderViewModal();

      if (mode === "edit") {
        const nameInput = document.getElementById("editName");
        nameInput?.focus();
        nameInput?.select();
      } else {
        document.getElementById("confirmSet")?.focus();
      }
    };

    const openModal = () => {
      modal.classList.remove("hidden");
      modal.classList.add("flex");
      renderModal("view");
    };

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.dataset.action;
      if (action === "showSetModal") {
        if (!state.canSetLocal) return;
        openModal();
        return;
      }

      vscode.postMessage({ type: action });
    });

    const closeModal = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    };

    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (target === modal) {
        closeModal();
        return;
      }

      if (!(target instanceof Element)) return;

      if (target.closest("#closeModal") || target.closest("#cancelModal")) {
        closeModal();
        return;
      }

      if (target.closest("#confirmSet")) {
        closeModal();
        vscode.postMessage({ type: "setLocalIdentity" });
        return;
      }

      if (target.closest("#editModal")) {
        renderModal("edit");
        return;
      }

      if (target.closest("#resetToRule")) {
        renderModal("edit", state.expectedName, state.expectedEmail);
        return;
      }

      if (target.closest("#saveCustom")) {
        const name = document.getElementById("editName")?.value.trim() ?? "";
        const email = document.getElementById("editEmail")?.value.trim() ?? "";

        if (!name) {
          showValidation("Name must not be empty.");
          return;
        }
        if (!email) {
          showValidation("Email must not be empty.");
          return;
        }
        if (!isEmailish(email)) {
          showValidation("Email should look like name@example.com.");
          return;
        }

        closeModal();
        vscode.postMessage({ type: "setCustomLocalIdentity", name, email });
      }
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
