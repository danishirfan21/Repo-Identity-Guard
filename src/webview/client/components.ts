/**
 * Shared helpers used by every view module: HTML escaping, message
 * dispatch to the extension host, capability metadata/labels, and the small
 * bits of markup (badges, status banners) that appear on more than one
 * screen. Loaded before the view modules in SidebarProvider's client script.
 */
export const COMPONENTS_JS = `
const vscode = acquireVsCodeApi();

const esc = (v) => String(v ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const send = (type, extra) => vscode.postMessage({ type, ...(extra || {}) });

const CAPABILITY_LABELS = {
  commit_identity: "Commit Identity",
  push_destination: "Push Destination",
  push_account: "Push Account",
  branch_policy: "Branch Policy",
  repo_operation_state: "Repo State",
  workspace_trust: "Workspace Trust",
};

const CAPABILITY_ICONS = {
  commit_identity: "userCircle",
  push_destination: "folderCopy",
  push_account: "user",
  branch_policy: "compass",
  repo_operation_state: "gitBranch",
  workspace_trust: "lock",
};

const CAPABILITY_ORDER = [
  "commit_identity",
  "push_destination",
  "push_account",
  "branch_policy",
  "repo_operation_state",
  "workspace_trust",
];

/** SAFE / NOT SAFE / NOT CHECKED presentation — icon, label, and the verdict-* / text color classes shared by the banner and repo list rows. */
function statusMeta(level) {
  if (level === "safe") return { label: "SAFE", iconName: "shieldCheck", cls: "text-success", dotCls: "bg-success", verdictCls: "verdict-safe" };
  if (level === "not_safe") return { label: "NOT SAFE", iconName: "shieldAlert", cls: "text-error", dotCls: "bg-error", verdictCls: "verdict-not_safe" };
  return { label: "NOT CHECKED", iconName: "shieldQuestion", cls: "text-on-surface-variant", dotCls: "bg-on-surface-variant", verdictCls: "verdict-not_checked" };
}

function stateBadge(st) {
  const labels = { confirmed: "Confirmed", contradicted: "Contradicted", unverified: "Unverified", warning: "Warning", not_applicable: "Not applicable" };
  const cls = "badge-" + (st || "not_applicable");
  return '<span class="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ' + cls + '">' + (labels[st] || "Not applicable") + '</span>';
}

function blocksSafetyTag(result) {
  if (!result.blocksOverallSafety) return "";
  return '<span class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide badge-contradicted">' + icon("block", 10) + 'Blocks safety</span>';
}

function actionButtonForIssue(item, variant) {
  if (!item.suggestedAction) return "";
  const cls = variant === "primary" ? "vs-button-primary" : "vs-button-secondary";
  return '<button class="' + cls + ' mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded text-[12px] font-semibold" data-issue-action="' + esc(item.suggestedActionCommand || "") + '">' + esc(item.suggestedAction) + '</button>';
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

/** Section eyebrow label, e.g. "SECURITY CHECKS" — matches the Stitch design's small uppercase section headers. */
function sectionLabel(text) {
  return '<span class="font-label-caps text-label-caps text-on-surface-variant">' + esc(text) + '</span>';
}
`;
