import * as vscode from "vscode";
import {
  CapabilityResult,
  InfoNote,
  Profile,
  RepoMemory,
  SafetyPreferences,
  StatusSummary,
  WorkspaceSafetyState,
} from "../types";

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
}

export interface SidebarModel {
  summary: StatusSummary;
  workspace: WorkspaceSafetyState;
  selectedRepoId?: string;
  memory: RepoMemory;
  profiles: Profile[];
  protectedBranches: string[];
  preferences: SafetyPreferences;
}

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
        await a.selectRepo(String(message.id ?? ""));
        break;
      case "addMemoryNote":
        await a.addMemoryNote(String(message.text ?? ""), !!message.pinned);
        break;
      case "removeMemoryNote":
        await a.removeMemoryNote(String(message.id ?? ""));
        break;
      case "togglePinMemoryNote":
        await a.togglePinMemoryNote(String(message.id ?? ""));
        break;
      case "addSavedCommand":
        await a.addSavedCommand(String(message.label ?? ""), String(message.command ?? ""));
        break;
      case "removeSavedCommand":
        await a.removeSavedCommand(String(message.id ?? ""));
        break;
      case "runSavedCommand":
        await a.runSavedCommand(String(message.id ?? ""));
        break;
      case "copySavedCommand":
        await a.copySavedCommand(String(message.id ?? ""));
        break;
      case "saveProfile":
        await a.saveProfile(message.profile as Profile);
        break;
      case "deleteProfile":
        await a.deleteProfile(String(message.id ?? ""));
        break;
      case "saveProtectedBranches":
        await a.saveProtectedBranches((message.branches as string[]) ?? []);
        break;
      case "saveRequireLocalIdentity":
        await a.saveRequireLocalIdentity(!!message.value);
        break;
      case "saveIncludeMemoryInAiContext":
        await a.saveIncludeMemoryInAiContext(!!message.value);
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
<html class="dark" lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${cssUri}" rel="stylesheet" />
<title>Repo Identity Guard</title>
</head>
<body class="custom-scrollbar flex flex-col overflow-y-auto">
<header class="flex h-[42px] w-full shrink-0 items-center justify-between border-b border-outline-variant bg-surface-container px-sidebar-padding">
  <div class="flex items-center gap-1.5 min-w-0">
    <button class="hidden rounded p-1 text-on-surface-variant hover:bg-secondary-container hover:text-on-surface" id="backButton" title="Back">←</button>
    <div class="flex flex-col min-w-0">
      <span class="text-[14px] font-bold leading-tight text-on-surface truncate" id="headerTitle">Repo Identity Guard</span>
      <span class="text-[10px] leading-none text-on-surface-variant" id="headerSubtitle">Safe to work, commit, push?</span>
    </div>
  </div>
  <div class="flex gap-1 shrink-0">
    <button class="rounded p-1.5 text-on-surface-variant hover:bg-secondary-container hover:text-on-surface" data-nav="main" title="Home">⌂</button>
    <button class="rounded p-1.5 text-on-surface-variant hover:bg-secondary-container hover:text-on-surface" id="rescanButton" title="Rescan">↻</button>
    <button class="rounded p-1.5 text-on-surface-variant hover:bg-secondary-container hover:text-on-surface" data-nav="settings" title="Settings">⚙</button>
  </div>
</header>
<main class="flex flex-1 flex-col gap-lg p-sidebar-padding" id="app"></main>
<script nonce="${nonce}">
${clientScript()}
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => possible.charAt(Math.floor(Math.random() * possible.length))).join("");
}

// ---- Wire state (data sent to the webview) ----

type WireCapabilityResult = CapabilityResult;
type WireInfoNote = InfoNote;

interface WireRepoListEntry {
  repoId: string;
  name: string;
  level: "safe" | "not_safe" | "not_checked";
  issueCount: number;
  nextFixTitle?: string;
  selected: boolean;
}

interface WireWorkspace {
  level: "safe" | "not_safe" | "not_checked";
  safeCount: number;
  notSafeCount: number;
  uncheckedCount: number;
  repos: WireRepoListEntry[];
}

interface WireState {
  level: "safe" | "not_safe" | "not_checked";
  isGitRepo: boolean;
  repoName?: string;
  profileLabel?: string;
  branch?: string;
  issueCount: number;
  capabilityResults: WireCapabilityResult[];
  infoNotes: WireInfoNote[];
  nextFix?: WireCapabilityResult;
  pinnedNotePreview?: string;
  canFixIdentity: boolean;
  memory: RepoMemory;
  profiles: Profile[];
  protectedBranches: string[];
  preferences: SafetyPreferences;
  workspace: WireWorkspace;
}

function toWireState(model: SidebarModel): WireState {
  const { summary } = model;
  return {
    level: summary.level,
    isGitRepo: summary.facts.isGitRepo,
    repoName: summary.repoName,
    profileLabel: summary.matchedProfile?.label,
    branch: summary.facts.currentBranch,
    issueCount: summary.issueCount,
    capabilityResults: summary.capabilityResults,
    infoNotes: summary.infoNotes,
    nextFix: summary.nextFix,
    pinnedNotePreview: summary.pinnedMemoryPreview,
    canFixIdentity: !!summary.matchedProfile,
    memory: model.memory,
    profiles: model.profiles,
    protectedBranches: model.protectedBranches,
    preferences: model.preferences,
    workspace: {
      level: model.workspace.level,
      safeCount: model.workspace.safeCount,
      notSafeCount: model.workspace.notSafeCount,
      uncheckedCount: model.workspace.uncheckedCount,
      repos: model.workspace.repos.map((repo) => ({
        repoId: repo.repoId,
        name: repo.summary.repoName || repo.workspaceFolderName || "(unnamed repo)",
        level: repo.summary.level,
        issueCount: repo.summary.issueCount,
        nextFixTitle: repo.summary.nextFix?.title,
        selected: repo.repoId === model.selectedRepoId,
      })),
    },
  };
}

// ---- Client-side script (runs inside the webview) ----

function clientScript(): string {
  return `
const vscode = acquireVsCodeApi();
const app = document.getElementById("app");
const headerTitle = document.getElementById("headerTitle");
const headerSubtitle = document.getElementById("headerSubtitle");
const backButton = document.getElementById("backButton");

let state = null;
let view = "main";

const esc = (v) => String(v ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const send = (type, extra) => vscode.postMessage({ type, ...extra });

function statusMeta(level) {
  if (level === "safe") return { label: "SAFE", icon: "🟢", cls: "text-inverse-primary" };
  if (level === "not_safe") return { label: "NOT SAFE", icon: "🔴", cls: "text-error" };
  return { label: "NOT CHECKED", icon: "⚪", cls: "text-on-surface-variant" };
}

const CAPABILITY_LABELS = {
  commit_identity: "Commit Identity",
  push_destination: "Push Destination",
  push_account: "Push Account",
  branch_policy: "Branch Policy",
  repo_operation_state: "Repo State",
  workspace_trust: "Workspace Trust",
};

const CAPABILITY_ORDER = [
  "commit_identity",
  "push_destination",
  "push_account",
  "branch_policy",
  "repo_operation_state",
  "workspace_trust",
];

function stateBadge(st) {
  if (st === "confirmed") return '<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-secondary-container text-on-secondary-container">Confirmed</span>';
  if (st === "contradicted") return '<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-error-container text-on-error-container">Contradicted</span>';
  if (st === "unverified") return '<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-tertiary-container text-on-tertiary-container">Unverified</span>';
  if (st === "warning") return '<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-tertiary-container text-on-tertiary-container">Warning</span>';
  return '<span class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-surface-container-high text-on-surface-variant">Not applicable</span>';
}

function blocksSafetyTag(result) {
  if (!result.blocksOverallSafety) return "";
  return '<span class="ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase bg-error text-on-error">Blocks Safety</span>';
}

function actionButtonForIssue(item) {
  if (!item.suggestedAction) return "";
  return \`<button class="vs-button-secondary mt-2 flex h-7 items-center justify-center rounded px-3 text-[12px]" data-issue-action="\${esc(item.suggestedActionCommand || "")}">\${esc(item.suggestedAction)}</button>\`;
}

function handleSuggestedAction(command) {
  if (!command) return;
  if (command === "fixCommitIdentity" || command === "makePushSetupSafer") { send("fixCommitIdentity"); return; }
  if (command === "openRepoMemory") { navigate("memory"); return; }
  if (command === "openSettings") { navigate("settings"); return; }
  if (command === "addProfileForRepo") { send("addProfileForRepo"); return; }
  if (command === "reviewDetails") { navigate("details"); return; }
  if (command === "enableWorkspaceTrust") { send("enableWorkspaceTrust"); return; }
  if (command === "resolveProfileConflict") { send("resolveProfileConflict"); return; }
}

// ---------- MAIN VIEW ----------
function renderRepoListRow(repo) {
  const meta = statusMeta(repo.level);
  const fixLine = repo.level === "not_safe" && repo.nextFixTitle
    ? \`<span class="block text-[11px] text-on-surface-variant">\${esc(repo.nextFixTitle)}</span>\`
    : "";
  const selectedCls = repo.selected ? "border-l-4 border-l-primary" : "";
  return \`
    <button class="vs-card flex w-full items-start gap-2 rounded-lg p-2 text-left \${selectedCls}" data-select-repo="\${esc(repo.repoId)}">
      <span class="text-[15px] leading-none">\${meta.icon}</span>
      <div class="flex min-w-0 flex-col">
        <span class="truncate text-[12px] font-semibold text-on-surface">\${esc(repo.name)}</span>
        \${fixLine}
      </div>
    </button>\`;
}

function renderWorkspaceSummary() {
  const ws = state.workspace;
  if (!ws || ws.repos.length <= 1) return "";
  const meta = statusMeta(ws.level);
  return \`
    <div class="flex items-start gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
      <span class="text-[22px] leading-none">\${meta.icon}</span>
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-[15px] font-bold \${meta.cls}">Workspace: \${meta.label}</span>
        <span class="text-[12px] text-on-surface-variant">\${ws.safeCount} safe, \${ws.notSafeCount} not safe, \${ws.uncheckedCount} unchecked of \${ws.repos.length} repos</span>
      </div>
    </div>
    <section class="flex flex-col gap-1.5">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Repositories</span>
      \${ws.repos.map(renderRepoListRow).join("")}
    </section>
    <button class="vs-button-secondary flex h-8 items-center justify-center rounded text-[12px]" id="copyWorkspaceSummaryButton">Copy Workspace Safety Summary</button>
  \`;
}

function renderMain() {
  const meta = statusMeta(state.level);
  const multiRoot = state.workspace && state.workspace.repos.length > 1;

  if (!state.isGitRepo && !multiRoot) {
    return \`
      <div class="flex flex-col items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-4 text-center">
        <span class="text-[28px]">⚪</span>
        <span class="text-[14px] font-semibold text-on-surface">NOT CHECKED</span>
        <p class="m-0 text-[12px] text-on-surface-variant">Open a folder that is a Git repository to check its safety.</p>
      </div>\`;
  }

  const workspaceSection = renderWorkspaceSummary();

  if (!state.isGitRepo) {
    // Multi-root workspace with no repo currently selected (e.g. active editor outside any repo).
    return workspaceSection;
  }

  const issueLine = state.issueCount === 0
    ? "Nothing needs fixing"
    : \`\${state.issueCount} thing\${state.issueCount === 1 ? "" : "s"} need\${state.issueCount === 1 ? "s" : ""} fixing\`;

  const pinned = state.pinnedNotePreview
    ? \`<section class="vs-card rounded-lg p-2.5">
        <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Pinned memory</span>
        <p class="m-0 mt-1 text-[12px] italic text-on-surface">"\${esc(state.pinnedNotePreview)}"</p>
      </section>\`
    : "";

  const nextFix = state.nextFix
    ? \`<section class="vs-card rounded-lg border-l-4 border-l-primary p-2.5">
        <span class="font-label-caps text-[10px] uppercase tracking-wider text-primary">Next fix</span>
        <p class="m-0 mt-1 text-[13px] font-semibold text-on-surface">\${esc(state.nextFix.title)}</p>
        \${actionButtonForIssue(state.nextFix)}
      </section>\`
    : \`<section class="vs-card rounded-lg p-2.5 text-center">
        <p class="m-0 text-[12px] text-on-surface-variant">All critical checks pass.</p>
      </section>\`;

  return \`
    \${workspaceSection}

    <div class="flex items-start gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
      <span class="text-[22px] leading-none">\${meta.icon}</span>
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-[15px] font-bold \${meta.cls}">\${meta.label}\${multiRoot ? " (selected repo)" : ""}</span>
        <span class="text-[12px] text-on-surface-variant">Repo: \${esc(state.repoName || "Unknown")}</span>
        <span class="text-[12px] text-on-surface-variant">Profile: \${esc(state.profileLabel || "Unknown")}</span>
      </div>
    </div>

    <p class="m-0 text-[13px] font-semibold text-on-surface">\${esc(issueLine)}</p>

    \${nextFix}
    \${pinned}

    <section class="mt-auto grid grid-cols-2 gap-2 border-t border-outline-variant/30 pt-2.5">
      <button class="vs-button-secondary col-span-2 flex h-8 items-center justify-center rounded text-[12px]" data-nav="details">Review Details</button>
      <button class="vs-button-secondary flex h-8 items-center justify-center rounded text-[12px]" data-nav="memory">Repo Memory</button>
      <button class="vs-button-secondary flex h-8 items-center justify-center rounded text-[12px]" id="copyContextButton">Copy Context for AI</button>
    </section>
  \`;
}

// ---------- REVIEW DETAILS VIEW ----------
function renderCapabilityCard(result) {
  const facts = result.technicalDetails && Object.keys(result.technicalDetails).length
    ? \`<details class="mt-2">
        <summary class="cursor-pointer text-[11px] text-on-surface-variant">Technical Details</summary>
        <pre class="mt-1 whitespace-pre-wrap break-all rounded bg-surface-container-lowest p-2 font-code-mono text-[11px] text-on-surface-variant">\${esc(JSON.stringify(result.technicalDetails, null, 2))}</pre>
      </details>\`
    : "";

  const expectFound = (result.whatWeExpected || result.whatWeFound)
    ? \`<div class="mt-1.5 grid grid-cols-1 gap-1 text-[11px]">
        \${result.whatWeExpected ? \`<div><span class="text-on-surface-variant">What we expected: </span><span class="text-on-surface">\${esc(result.whatWeExpected)}</span></div>\` : ""}
        \${result.whatWeFound ? \`<div><span class="text-on-surface-variant">What we found: </span><span class="text-on-surface">\${esc(result.whatWeFound)}</span></div>\` : ""}
      </div>\`
    : "";

  const restrictions = (result.agentRestrictions && result.agentRestrictions.length)
    ? \`<p class="m-0 mt-1.5 text-[11px] text-on-surface-variant">Agent restrictions: \${result.agentRestrictions.map((r) => esc(r.description)).join(" ")}</p>\`
    : "";

  const dimmed = result.state === "not_applicable" ? "opacity-50" : "";

  return \`
    <section class="vs-card rounded-lg p-2.5 \${dimmed}">
      <div class="flex items-center justify-between gap-2">
        <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">\${esc(CAPABILITY_LABELS[result.capability] || result.capability)}</span>
        <div class="flex items-center">\${stateBadge(result.state)}\${blocksSafetyTag(result)}</div>
      </div>
      <p class="m-0 mt-1 text-[13px] font-semibold text-on-surface">\${esc(result.title)}</p>
      \${result.whyItMatters ? \`<p class="m-0 mt-1 text-[11px] text-on-surface-variant">Why it matters: \${esc(result.whyItMatters)}</p>\` : \`<p class="m-0 mt-1 text-[11px] text-on-surface-variant">\${esc(result.summary)}</p>\`}
      \${expectFound}
      \${restrictions}
      \${actionButtonForIssue(result)}
      \${facts}
    </section>
  \`;
}

function renderInfoNoteCard(note) {
  return \`
    <section class="vs-card rounded-lg p-2.5 opacity-80">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Note</span>
      <p class="m-0 mt-1 text-[13px] font-semibold text-on-surface">\${esc(note.title)}</p>
      <p class="m-0 mt-1 text-[11px] text-on-surface-variant">\${esc(note.message)}</p>
      \${actionButtonForIssue(note)}
    </section>
  \`;
}

function renderDetails() {
  const multiRoot = state.workspace && state.workspace.repos.length > 1;
  const reviewingHeader = multiRoot
    ? \`<div class="rounded-lg border border-outline-variant bg-surface-container-low p-2 text-[11px] text-on-surface-variant">Reviewing: <span class="font-semibold text-on-surface">\${esc(state.repoName || "Unknown repo")}</span></div>\`
    : "";

  const byCapability = {};
  for (const result of state.capabilityResults) byCapability[result.capability] = result;

  const cards = CAPABILITY_ORDER
    .map((capability) => (byCapability[capability] ? renderCapabilityCard(byCapability[capability]) : ""))
    .join("");

  const notes = state.infoNotes.length
    ? \`<section class="mt-2 flex flex-col gap-1.5">
        <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Other Notes</span>
        \${state.infoNotes.map(renderInfoNoteCard).join("")}
      </section>\`
    : "";

  return reviewingHeader + cards + notes;
}

// ---------- REPO MEMORY VIEW ----------
function renderMemoryNote(note) {
  return \`
    <div class="vs-card flex items-start justify-between gap-2 rounded-lg p-2">
      <div class="flex min-w-0 flex-col">
        \${note.pinned ? '<span class="text-[9px] font-bold uppercase text-primary">Pinned</span>' : ""}
        <span class="break-words text-[12px] text-on-surface">\${esc(note.text)}</span>
      </div>
      <div class="flex shrink-0 gap-1">
        <button class="rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-secondary-container" data-pin-note="\${esc(note.id)}" title="Pin">\${note.pinned ? "Unpin" : "Pin"}</button>
        <button class="rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-secondary-container" data-remove-note="\${esc(note.id)}" title="Remove">✕</button>
      </div>
    </div>\`;
}

function renderSavedCommand(cmd) {
  return \`
    <div class="vs-card flex items-center justify-between gap-2 rounded-lg p-2">
      <div class="flex min-w-0 flex-col">
        <span class="text-[12px] font-semibold text-on-surface">\${esc(cmd.label)}</span>
        <span class="break-all font-code-mono text-[11px] text-on-surface-variant">\${esc(cmd.command)}</span>
      </div>
      <div class="flex shrink-0 gap-1">
        <button class="vs-button-secondary rounded px-2 py-1 text-[11px]" data-run-command="\${esc(cmd.id)}">Run</button>
        <button class="vs-button-secondary rounded px-2 py-1 text-[11px]" data-copy-command="\${esc(cmd.id)}">Copy</button>
        <button class="rounded px-1.5 py-1 text-[11px] text-on-surface-variant hover:bg-secondary-container" data-remove-command="\${esc(cmd.id)}">✕</button>
      </div>
    </div>\`;
}

function renderMemory() {
  const notes = state.memory.notes;
  const commands = state.memory.commands;
  return \`
    <section class="flex flex-col gap-1.5">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Notes</span>
      \${notes.length ? notes.map(renderMemoryNote).join("") : '<p class="text-[11px] text-on-surface-variant">No notes yet.</p>'}
      <div class="flex gap-1">
        <input id="newNoteText" class="h-7 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" placeholder="e.g. Run pnpm dev from frontend folder" />
        <button class="vs-button-secondary rounded px-2 text-[12px]" id="addNoteButton">Add</button>
      </div>
    </section>
    <section class="flex flex-col gap-1.5">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Saved Commands</span>
      \${commands.length ? commands.map(renderSavedCommand).join("") : '<p class="text-[11px] text-on-surface-variant">No saved commands yet.</p>'}
      <div class="flex flex-col gap-1">
        <input id="newCommandLabel" class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" placeholder="Label, e.g. Start dev server" />
        <input id="newCommandText" class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 font-code-mono text-[12px] text-on-surface" placeholder="Command, e.g. pnpm dev" />
        <button class="vs-button-secondary h-7 rounded text-[12px]" id="addCommandButton">Save Command</button>
      </div>
    </section>
  \`;
}

// ---------- SETTINGS VIEW ----------
function renderProfileEditor(profile) {
  const id = profile.id;
  return \`
    <details class="vs-card rounded-lg p-2.5" data-profile-id="\${esc(id)}">
      <summary class="cursor-pointer text-[13px] font-semibold text-on-surface">\${esc(profile.label || "Untitled profile")}</summary>
      <div class="mt-2 flex flex-col gap-1.5">
        <label class="flex flex-col gap-0.5 text-[11px] text-on-surface-variant">Label
          <input class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" data-field="label" value="\${esc(profile.label)}" />
        </label>
        <label class="flex flex-col gap-0.5 text-[11px] text-on-surface-variant">Git name
          <input class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" data-field="gitName" value="\${esc(profile.gitName || "")}" />
        </label>
        <label class="flex flex-col gap-0.5 text-[11px] text-on-surface-variant">Git email
          <input class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" data-field="gitEmail" value="\${esc(profile.gitEmail || "")}" />
        </label>
        <label class="flex flex-col gap-0.5 text-[11px] text-on-surface-variant">Expected remote owners (comma separated)
          <input class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" data-field="expectedRemoteOwners" value="\${esc((profile.expectedRemoteOwners || []).join(", "))}" />
        </label>
        <label class="flex flex-col gap-0.5 text-[11px] text-on-surface-variant">Exact repos (host/owner/repo, comma separated — always wins over owners above)
          <input class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 font-code-mono text-[12px] text-on-surface" data-field="exactRepos" placeholder="github.com/AcmeSoftware/secret-project" value="\${esc((profile.exactRepos || []).join(", "))}" />
        </label>
        <label class="flex flex-col gap-0.5 text-[11px] text-on-surface-variant">Expected branch patterns (comma separated)
          <input class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" data-field="expectedBranchPatterns" value="\${esc((profile.expectedBranchPatterns || []).join(", "))}" />
        </label>
        <label class="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
          <input type="checkbox" data-field="strictPushSetup" \${profile.strictPushSetup ? "checked" : ""} />
          Strict push setup (treat HTTPS/generic SSH as Not Safe)
        </label>
        <div class="mt-1 flex gap-1">
          <button class="vs-button-secondary h-7 flex-1 rounded text-[12px]" data-save-profile="\${esc(id)}">Save</button>
          <button class="h-7 rounded px-2 text-[12px] text-error hover:bg-error-container" data-delete-profile="\${esc(id)}">Delete</button>
        </div>
      </div>
    </details>\`;
}

function renderSettings() {
  return \`
    <section class="flex flex-col gap-1.5">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Profiles</span>
      \${state.profiles.length ? state.profiles.map(renderProfileEditor).join("") : '<p class="text-[11px] text-on-surface-variant">No profiles yet. Add Work and/or Personal.</p>'}
      <button class="vs-button-secondary h-7 rounded text-[12px]" id="addProfileButton">+ Add Profile</button>
    </section>

    <section class="vs-card flex flex-col gap-1.5 rounded-lg p-2.5">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Local Branch Policy</span>
      <p class="m-0 text-[11px] text-on-surface-variant">Branches treated as protected on this machine only — not synced with GitHub's own branch protection rules.</p>
      <input id="protectedBranchesInput" class="h-7 rounded border border-outline-variant bg-surface-container-lowest px-2 text-[12px] text-on-surface" value="\${esc(state.protectedBranches.join(", "))}" />
      <button class="vs-button-secondary h-7 rounded text-[12px]" id="saveBranchesButton">Save</button>
    </section>

    <section class="vs-card flex flex-col gap-2 rounded-lg p-2.5">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Safety Preferences</span>
      <label class="flex items-center gap-1.5 text-[12px] text-on-surface">
        <input type="checkbox" id="requireLocalIdentityCheckbox" \${state.preferences.requireLocalIdentity ? "checked" : ""} />
        Require identity to be locked locally per repo
      </label>
      <label class="flex items-start gap-1.5 text-[12px] text-on-surface">
        <input type="checkbox" id="includeMemoryCheckbox" class="mt-0.5" \${state.preferences.includeMemoryInAiContext ? "checked" : ""} />
        <span>Include pinned memory note in Copy Context for AI
          <span class="mt-0.5 block text-[10px] text-on-surface-variant">Off by default. Pinned notes are free text you wrote for yourself and may contain sensitive info — only turn this on if you're sure.</span>
        </span>
      </label>
    </section>

    <section class="vs-card flex flex-col gap-1 rounded-lg p-2.5 opacity-60">
      <span class="font-label-caps text-[10px] uppercase tracking-wider text-on-surface-variant">Shield Mode — Coming soon</span>
      <p class="m-0 text-[11px] text-on-surface-variant">Optional local Git hooks that would block unsafe commits/pushes. Not built yet — this is not currently protecting you, and there is no toggle for it.</p>
    </section>

    <button class="vs-button-secondary h-7 rounded text-[12px]" id="openSettingsJsonButton">Open settings.json</button>
  \`;
}

// ---------- ROUTER ----------
function headerFor(v) {
  if (v === "main") return ["Repo Identity Guard", "Safe to work, commit, push?"];
  if (v === "details") return ["Review Details", "Full issue list"];
  if (v === "memory") return ["Repo Memory", "Notes and saved commands"];
  return ["Settings", "Profiles and safety rules"];
}

function render() {
  if (!state) { app.innerHTML = '<p class="text-[12px] text-on-surface-variant">Loading…</p>'; return; }
  const [title, subtitle] = headerFor(view);
  headerTitle.textContent = title;
  headerSubtitle.textContent = subtitle;
  backButton.classList.toggle("hidden", view === "main");

  if (view === "main") app.innerHTML = renderMain();
  else if (view === "details") app.innerHTML = renderDetails();
  else if (view === "memory") app.innerHTML = renderMemory();
  else app.innerHTML = renderSettings();
}

function navigate(next) {
  view = next;
  render();
}

backButton.addEventListener("click", () => navigate("main"));
document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-nav]");
  if (el) { navigate(el.dataset.nav); return; }
});

document.getElementById("rescanButton").addEventListener("click", () => send("rescan"));

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const issueAction = target.closest("[data-issue-action]");
  if (issueAction) { handleSuggestedAction(issueAction.dataset.issueAction); return; }

  if (target.closest("#copyContextButton")) { send("copyContextForAI"); return; }
  if (target.closest("#copyWorkspaceSummaryButton")) { send("copyWorkspaceSafetySummary"); return; }

  const selectRepoBtn = target.closest("[data-select-repo]");
  if (selectRepoBtn) { send("selectRepo", { id: selectRepoBtn.dataset.selectRepo }); navigate("details"); return; }

  if (target.closest("#addNoteButton")) {
    const input = document.getElementById("newNoteText");
    const text = input.value.trim();
    if (text) { send("addMemoryNote", { text, pinned: false }); input.value = ""; }
    return;
  }
  const pinBtn = target.closest("[data-pin-note]");
  if (pinBtn) { send("togglePinMemoryNote", { id: pinBtn.dataset.pinNote }); return; }
  const removeNoteBtn = target.closest("[data-remove-note]");
  if (removeNoteBtn) { send("removeMemoryNote", { id: removeNoteBtn.dataset.removeNote }); return; }

  if (target.closest("#addCommandButton")) {
    const label = document.getElementById("newCommandLabel").value.trim();
    const command = document.getElementById("newCommandText").value.trim();
    if (label && command) {
      send("addSavedCommand", { label, command });
      document.getElementById("newCommandLabel").value = "";
      document.getElementById("newCommandText").value = "";
    }
    return;
  }
  const runBtn = target.closest("[data-run-command]");
  if (runBtn) { send("runSavedCommand", { id: runBtn.dataset.runCommand }); return; }
  const copyBtn = target.closest("[data-copy-command]");
  if (copyBtn) { send("copySavedCommand", { id: copyBtn.dataset.copyCommand }); return; }
  const removeCmdBtn = target.closest("[data-remove-command]");
  if (removeCmdBtn) { send("removeSavedCommand", { id: removeCmdBtn.dataset.removeCommand }); return; }

  if (target.closest("#addProfileButton")) {
    send("saveProfile", { profile: { id: "profile-" + Date.now().toString(36), label: "New Profile", gitEmail: "", expectedRemoteOwners: [], exactRepos: [], expectedBranchPatterns: [], strictPushSetup: false } });
    return;
  }
  const saveProfileBtn = target.closest("[data-save-profile]");
  if (saveProfileBtn) {
    const id = saveProfileBtn.dataset.saveProfile;
    const container = document.querySelector('[data-profile-id="' + CSS.escape(id) + '"]');
    const field = (name) => container.querySelector('[data-field="' + name + '"]');
    const listField = (name) => field(name).value.split(",").map((s) => s.trim()).filter(Boolean);
    send("saveProfile", {
      profile: {
        id,
        label: field("label").value.trim(),
        gitName: field("gitName").value.trim(),
        gitEmail: field("gitEmail").value.trim(),
        expectedRemoteOwners: listField("expectedRemoteOwners"),
        exactRepos: listField("exactRepos"),
        expectedBranchPatterns: listField("expectedBranchPatterns"),
        strictPushSetup: field("strictPushSetup").checked,
      },
    });
    return;
  }
  const deleteProfileBtn = target.closest("[data-delete-profile]");
  if (deleteProfileBtn) { send("deleteProfile", { id: deleteProfileBtn.dataset.deleteProfile }); return; }

  if (target.closest("#saveBranchesButton")) {
    const branches = document.getElementById("protectedBranchesInput").value.split(",").map((s) => s.trim()).filter(Boolean);
    send("saveProtectedBranches", { branches });
    return;
  }
  if (target.closest("#openSettingsJsonButton")) { send("openSettingsJson"); return; }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "requireLocalIdentityCheckbox") { send("saveRequireLocalIdentity", { value: target.checked }); return; }
  if (target.id === "includeMemoryCheckbox") { send("saveIncludeMemoryInAiContext", { value: target.checked }); return; }
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "state") {
    state = message.payload;
    render();
  }
});

render();
`;
}
