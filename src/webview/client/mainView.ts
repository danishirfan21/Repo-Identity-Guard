/**
 * Main View — the dominant SAFE / NOT SAFE / NOT CHECKED verdict, repo /
 * profile / branch identity, the single most important next action, the
 * six-capability check grid, and secondary actions (Review Details, Repo
 * Memory, Copy Context for AI).
 *
 * Multi-root rule (do not weaken): when more than one repository is open,
 * the dominant verdict shown here is always the *workspace* aggregate, never
 * the currently selected repo's own level — a SAFE selected repo must never
 * visually override a NOT SAFE workspace. The selected repo's own status is
 * shown as a secondary line whenever it differs from the workspace verdict.
 */
export const MAIN_VIEW_JS = `
function renderVerdictBanner(level, subtitle) {
  const meta = statusMeta(level);
  return \`
    <div class="verdict-banner flex flex-col items-center gap-1.5 rounded-lg p-3.5 \${meta.verdictCls}">
      <span class="\${meta.cls}" style="width:30px;height:30px">\${icon(meta.iconName, 30)}</span>
      <span class="text-[15px] font-extrabold uppercase tracking-widest \${meta.cls}">\${meta.label}</span>
      \${subtitle ? \`<span class="text-[11px] text-on-surface-variant">\${esc(subtitle)}</span>\` : ""}
    </div>\`;
}

function renderRepoListRow(repo) {
  const meta = statusMeta(repo.level);
  const shieldChip = shieldMeta(repo.shieldLifecycle);
  const fixLine = repo.level === "not_safe" && repo.nextFixTitle
    ? \`<span class="block truncate text-[10px] text-on-surface-variant">\${esc(repo.nextFixTitle)}</span>\`
    : "";
  const selectedCls = repo.selected ? "border-l-2 border-l-primary" : "border-l-2 border-l-transparent";
  return \`
    <button class="vs-card flex w-full items-center gap-2 rounded p-2 text-left \${selectedCls}" data-select-repo="\${esc(repo.repoId)}">
      <span class="\${meta.cls} shrink-0">\${icon(meta.iconName, 13)}</span>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-[11px] font-semibold text-on-surface">\${esc(repo.name)}</span>
        \${fixLine}
      </div>
      <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide \${shieldChip.badgeCls}">\${shieldChip.label}</span>
    </button>\`;
}

function renderMultiRepoList() {
  const ws = state.workspace;
  if (!ws || ws.repos.length <= 1) return "";
  return \`
    <section class="flex flex-col gap-1">
      \${sectionLabel("Repositories in this workspace")}
      \${ws.repos.map(renderRepoListRow).join("")}
    </section>\`;
}

function renderIdentityCard() {
  return \`
    <div class="vs-card flex flex-col gap-1 rounded p-2.5 font-code-mono text-code-mono">
      <div class="flex items-center justify-between gap-2">
        <span class="text-on-surface-variant">Repository</span>
        <span class="truncate text-primary" title="\${esc(state.repoName || "Unknown")}">\${esc(state.repoName || "Unknown")}</span>
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-on-surface-variant">Profile</span>
        <span class="flex min-w-0 items-center gap-1.5 text-on-surface">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full \${state.profileLabel ? "bg-primary" : "bg-on-surface-variant"}"></span>
          <span class="truncate">\${esc(state.profileLabel || "Unmatched")}</span>
        </span>
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-on-surface-variant">Branch</span>
        <span class="flex min-w-0 items-center gap-1 text-on-surface">\${icon("gitBranch", 11)}<span class="truncate">\${esc(state.branch || "—")}</span></span>
      </div>
    </div>\`;
}

function renderNextAction() {
  if (!state.nextFix) {
    return \`<div class="vs-card rounded p-2.5 text-center text-[11px] text-on-surface-variant">All critical checks pass. Nothing needs fixing right now.</div>\`;
  }
  const fix = state.nextFix;
  const borderCls = fix.blocksOverallSafety ? "border-l-2 border-l-error" : "border-l-2 border-l-tertiary";
  const iconCls = fix.blocksOverallSafety ? "text-error" : "text-tertiary";
  return \`
    <div class="vs-card flex flex-col gap-1.5 rounded p-2.5 \${borderCls}">
      <div class="flex items-center gap-1.5">
        <span class="\${iconCls}">\${icon("alertTriangle", 14)}</span>
        <span class="text-[12.5px] font-semibold text-on-surface">\${esc(fix.title)}</span>
      </div>
      <p class="m-0 text-[11px] leading-relaxed text-on-surface-variant">\${esc(fix.summary)}</p>
      \${actionButtonForIssue(fix, "primary")}
    </div>\`;
}

function checkDotClass(state_) {
  if (state_ === "confirmed") return "bg-success";
  if (state_ === "contradicted") return "bg-error";
  if (state_ === "warning" || state_ === "unverified") return "bg-tertiary";
  return "bg-on-surface-variant";
}

function renderCheckGridItem(result) {
  const label = CAPABILITY_LABELS[result.capability] || result.capability;
  const iconName = CAPABILITY_ICONS[result.capability] || "shield";
  const problematic = result.state === "contradicted" || result.state === "warning" || result.state === "unverified";
  const cardCls = problematic
    ? (result.blocksOverallSafety ? "border-error/40" : "border-tertiary/40")
    : "border-outline-variant";
  return \`
    <button class="vs-card flex items-center gap-1.5 rounded p-2 text-left" style="border-color:\${problematic ? (result.blocksOverallSafety ? "var(--rig-error)" : "var(--rig-warning)") : "var(--rig-border)"}" data-nav="details" data-scroll-to="\${esc(result.capability)}">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full \${checkDotClass(result.state)}"></span>
      <span class="text-on-surface-variant">\${icon(iconName, 13)}</span>
      <span class="truncate text-[11px] font-medium text-on-surface">\${esc(label)}</span>
    </button>\`;
}

function renderChecksGrid() {
  const byCapability = {};
  for (const result of state.capabilityResults) byCapability[result.capability] = result;
  const items = CAPABILITY_ORDER.filter((c) => byCapability[c]).map((c) => renderCheckGridItem(byCapability[c]));
  return \`
    <section class="flex flex-col gap-1.5">
      \${sectionLabel("Security checks")}
      <div class="grid grid-cols-2 gap-1.5">\${items.join("")}</div>
    </section>\`;
}

function renderPinnedMemory() {
  if (!state.pinnedNotePreview) return "";
  return \`
    <div class="vs-card flex items-start gap-1.5 rounded p-2 border-l-2" style="border-left-color:var(--rig-warning)">
      <span class="mt-0.5 text-tertiary">\${icon("pin", 12)}</span>
      <p class="m-0 text-[11px] italic text-on-surface">\${esc(state.pinnedNotePreview)}</p>
    </div>\`;
}

function renderSecondaryActions() {
  return \`
    <section class="flex flex-col gap-1.5 border-t border-outline-variant/40 pt-2.5">
      <button class="vs-button-secondary flex h-7.5 items-center justify-center gap-1.5 rounded text-[12px]" style="height:30px" data-nav="details">\${icon("eye", 13)}Review Details</button>
      <div class="grid grid-cols-2 gap-1.5">
        <button class="vs-button-secondary flex items-center justify-center gap-1.5 rounded text-[12px]" style="height:30px" data-nav="memory">\${icon("memory", 13)}Repo Memory</button>
        <button class="vs-button-secondary flex items-center justify-center gap-1.5 rounded text-[12px]" style="height:30px" id="copyContextButton">\${icon("clipboard", 13)}Copy for AI</button>
      </div>
    </section>\`;
}

function renderMain() {
  const multiRoot = state.workspace && state.workspace.repos.length > 1;

  if (!state.isGitRepo && !multiRoot) {
    return \`
      <div class="flex flex-col items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-4 text-center">
        \${icon("shieldQuestion", 28)}
        <span class="text-[13px] font-semibold text-on-surface">NOT CHECKED</span>
        <p class="m-0 text-[11px] text-on-surface-variant">Open a folder that is a Git repository to check its safety.</p>
      </div>\`;
  }

  if (!state.isGitRepo) {
    // Multi-root workspace, but nothing is currently selected as a repo
    // (e.g. active editor sits outside any of the open repos).
    return renderVerdictBanner(state.workspace.level, state.workspace.repos.length + " repositories tracked") + renderMultiRepoList();
  }

  // Multi-root: the dominant verdict is always the workspace aggregate —
  // never let a SAFE selected repo visually stand in for a NOT SAFE
  // workspace. The selected repo's own level shows underneath whenever it
  // differs.
  const dominantLevel = multiRoot ? state.workspace.level : state.level;
  const selectedDiffers = multiRoot && state.workspace.level !== state.level;
  const subtitle = multiRoot
    ? (selectedDiffers ? "Selected repo (" + (state.repoName || "this repo") + ") is " + statusMeta(state.level).label : state.workspace.repos.length + " repositories, all accounted for")
    : undefined;

  return \`
    \${renderVerdictBanner(dominantLevel, subtitle)}
    \${renderIdentityCard()}
    \${renderNextAction()}
    \${renderPinnedMemory()}
    \${renderChecksGrid()}
    \${renderShieldSummary()}
    \${renderSecondaryActions()}
    \${renderMultiRepoList()}
  \`;
}
`;
