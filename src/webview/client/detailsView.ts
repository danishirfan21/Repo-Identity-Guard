/**
 * Review Details — one capability card per safety check, always in the
 * fixed order Commit Identity → Push Destination → Push Account → Branch
 * Policy → Repo State → Workspace Trust. Every field rendered here (state,
 * summary, expected/found, technical details, agent restrictions) comes
 * straight from the engine's own CapabilityResult — nothing is invented to
 * fill out the card layout, and a capability with no Expected/Found from
 * the engine simply renders without that row.
 */
export const DETAILS_VIEW_JS = `
function renderTechnicalDetails(result) {
  const hasDetails = result.technicalDetails && Object.keys(result.technicalDetails).length > 0;
  if (!hasDetails) return "";
  const rows = Object.entries(result.technicalDetails)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => \`<div class="flex gap-2"><span class="shrink-0 text-on-surface-variant">\${esc(k)}:</span><span class="min-w-0 break-all text-on-surface">\${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}</span></div>\`)
    .join("");
  return \`
    <details class="mt-1.5 border-t border-outline-variant/40 pt-1.5">
      <summary class="flex cursor-pointer select-none items-center gap-1 text-[10.5px] text-on-surface-variant hover:text-on-surface">\${icon("chevronRight", 11)}Technical Details</summary>
      <div class="mt-1.5 flex flex-col gap-1 rounded bg-surface-container-lowest p-2 font-code-mono text-code-mono text-on-surface-variant">\${rows}</div>
    </details>\`;
}

function renderExpectFound(result) {
  if (!result.whatWeExpected && !result.whatWeFound) return "";
  const foundCls = result.state === "contradicted" ? "text-error" : result.state === "warning" || result.state === "unverified" ? "text-tertiary" : "text-on-surface";
  return \`
    <div class="mt-1.5 grid grid-cols-[52px_1fr] gap-x-2 gap-y-0.5 rounded bg-surface-container-lowest p-2 font-code-mono text-code-mono">
      \${result.whatWeExpected ? \`<span class="text-on-surface-variant">Expected:</span><span class="min-w-0 break-words text-on-surface">\${esc(result.whatWeExpected)}</span>\` : ""}
      \${result.whatWeFound ? \`<span class="text-on-surface-variant">Found:</span><span class="min-w-0 break-words font-medium \${foundCls}">\${esc(result.whatWeFound)}</span>\` : ""}
    </div>\`;
}

function renderAgentRestrictions(result) {
  const restrictions = result.agentRestrictions;
  if (!restrictions || !restrictions.length) return "";
  return \`
    <div class="mt-1.5 flex items-start gap-1.5 text-[10.5px] text-on-surface-variant">
      <span class="mt-0.5 shrink-0">\${icon("block", 11)}</span>
      <span>\${restrictions.map((r) => esc(r.description)).join(" ")}</span>
    </div>\`;
}

function capabilityStateIconName(st) {
  if (st === "confirmed") return "checkCircle";
  if (st === "contradicted") return "xCircle";
  return "alertTriangle";
}

function capabilityStateIconCls(st) {
  if (st === "confirmed") return "text-success";
  if (st === "contradicted") return "text-error";
  if (st === "not_applicable") return "text-on-surface-variant";
  return "text-tertiary";
}

function renderCapabilityCard(result) {
  const dimmed = result.state === "not_applicable" ? "opacity-60" : "";
  return \`
    <section id="cap-\${esc(result.capability)}" class="vs-card flex flex-col gap-1 rounded p-2.5 \${dimmed}">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="\${capabilityStateIconCls(result.state)} shrink-0">\${icon(capabilityStateIconName(result.state), 14)}</span>
          <span class="truncate text-[12.5px] font-semibold text-on-surface">\${esc(CAPABILITY_LABELS[result.capability] || result.capability)}</span>
        </div>
        <div class="flex shrink-0 items-center gap-1">\${stateBadge(result.state)}</div>
      </div>
      \${result.blocksOverallSafety ? \`<div>\${blocksSafetyTag(result)}</div>\` : ""}
      <p class="m-0 text-[11px] leading-relaxed text-on-surface-variant">\${esc(result.whyItMatters || result.summary)}</p>
      \${renderExpectFound(result)}
      \${renderAgentRestrictions(result)}
      \${actionButtonForIssue(result)}
      \${renderTechnicalDetails(result)}
    </section>\`;
}

function renderInfoNoteCard(note) {
  return \`
    <section class="vs-card flex flex-col gap-1 rounded p-2.5 opacity-90">
      \${sectionLabel(note.title)}
      <p class="m-0 text-[11px] text-on-surface-variant">\${esc(note.message)}</p>
      \${actionButtonForIssue(note)}
    </section>\`;
}

function renderDetailsProgressBar() {
  const counts = { confirmed: 0, contradicted: 0, warning: 0, unverified: 0, not_applicable: 0 };
  for (const r of state.capabilityResults) counts[r.state] = (counts[r.state] || 0) + 1;
  const total = state.capabilityResults.length || 1;
  const seg = (n, cls) => (n > 0 ? \`<div class="h-full \${cls}" style="width:\${(100 * n) / total}%"></div>\` : "");
  return \`
    <div class="mb-1 flex h-1 w-full overflow-hidden rounded bg-surface-container-high">
      \${seg(counts.contradicted, "bg-error")}\${seg(counts.warning + counts.unverified, "bg-tertiary")}\${seg(counts.confirmed, "bg-success")}\${seg(counts.not_applicable, "bg-on-surface-variant")}
    </div>\`;
}

function renderDetails() {
  const multiRoot = state.workspace && state.workspace.repos.length > 1;
  const reviewingHeader = multiRoot
    ? \`<div class="rounded border border-outline-variant bg-surface-container-low p-2 text-[10.5px] text-on-surface-variant">Reviewing: <span class="font-semibold text-on-surface">\${esc(state.repoName || "Unknown repo")}</span></div>\`
    : "";

  const byCapability = {};
  for (const result of state.capabilityResults) byCapability[result.capability] = result;

  const cards = CAPABILITY_ORDER
    .map((capability) => (byCapability[capability] ? renderCapabilityCard(byCapability[capability]) : ""))
    .join("");

  const notes = state.infoNotes.length
    ? \`<section class="mt-1 flex flex-col gap-1.5">\${sectionLabel("Other notes")}\${state.infoNotes.map(renderInfoNoteCard).join("")}</section>\`
    : "";

  return reviewingHeader + renderDetailsProgressBar() + '<div class="flex flex-col gap-1.5">' + cards + '</div>' + notes;
}
`;
