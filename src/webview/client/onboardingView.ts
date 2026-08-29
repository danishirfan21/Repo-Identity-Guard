/**
 * First-run onboarding — shown only when there are no usable profiles yet
 * and the current folder is a Git repository. There is no separate
 * onboarding storage: "has usable profiles" (state.profiles.length > 0) is
 * the only signal, derived from the same configuration profiles already
 * used everywhere else, per the product spec.
 *
 * The two scope choices map directly onto the existing Profile schema —
 * nothing new is invented:
 *   "This repository only"            -> profile.exactRepos = [facts.canonicalRepo]
 *   "Repositories owned by <owner>"   -> profile.expectedRemoteOwners = [facts.remoteOwner]
 *
 * Creating the profile calls the same saveProfile message every other
 * profile edit uses (which already rescans on the extension side), then
 * this view hands control back to Main.
 */
export const ONBOARDING_VIEW_JS = `
let obLabel = "Personal";
let obCustomLabel = "";
let obScope = "repo";

function shouldShowOnboarding() {
  return !!state && state.isGitRepo && state.profiles.length === 0;
}

function renderProfileChoiceButton(value, label, iconName) {
  const active = obLabel === value;
  const cls = active
    ? "border-primary bg-primary-container text-primary"
    : "border-outline-variant text-on-surface-variant hover:border-outline-strong hover:text-primary";
  return \`<button class="flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[12px] font-medium \${cls}" data-ob-label="\${esc(value)}">\${icon(iconName, 13)}\${esc(label)}</button>\`;
}

function renderOnboarding() {
  const facts = state.facts || {};
  const repoLine = facts.canonicalRepo
    ? \`<p class="m-0 break-all font-code-mono text-code-mono text-on-surface-variant">\${esc(facts.canonicalRepo)}</p>\`
    : \`<p class="m-0 text-[11px] text-on-surface-variant">No remote configured yet — this repo has no GitHub owner to detect.</p>\`;

  const identityLine = facts.effectiveGitEmail || facts.effectiveGitName
    ? \`<p class="m-0 text-on-surface">\${esc(facts.effectiveGitName || "Unknown name")}</p><p class="m-0 font-code-mono text-code-mono text-primary">\${esc(facts.effectiveGitEmail || "unknown@unknown")}</p>\`
    : \`<p class="m-0 text-[11px] text-on-surface-variant">Git has no identity configured yet.</p>\`;

  const ownerScopeLabel = facts.remoteOwner ? "Repositories owned by " + facts.remoteOwner : "Repositories owned by this remote's owner";
  const ownerScopeDisabled = !facts.remoteOwner;

  return \`
    <div class="flex flex-col gap-3">
      <p class="m-0 text-[13px] leading-relaxed text-on-surface">Repo Identity Guard checks your Git identity and repository safety before you commit, push, or let an AI agent run commands.</p>

      <div class="vs-card flex flex-col gap-1 rounded p-2.5">
        <span class="flex items-center gap-1.5 text-[11px] font-semibold text-on-surface">\${icon("folder", 13)}Repository found</span>
        \${repoLine}
      </div>

      <div class="vs-card flex flex-col gap-1 rounded p-2.5">
        <span class="flex items-center gap-1.5 text-[11px] font-semibold text-on-surface">\${icon("user", 13)}Current Git identity</span>
        \${identityLine}
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-[11.5px] font-medium text-on-surface">Which profile should use this identity?</label>
        <div class="grid grid-cols-2 gap-1.5">
          \${renderProfileChoiceButton("Personal", "Personal", "user")}
          \${renderProfileChoiceButton("Work", "Work", "folder")}
        </div>
        \${obLabel === "Other" ? \`<input id="obCustomLabelInput" class="vs-input mt-1 h-7 rounded px-2 text-[12px]" placeholder="Profile name" value="\${esc(obCustomLabel)}" />\` : ""}
        <button class="flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[12px] font-medium \${obLabel === "Other" ? "border-primary text-primary" : "border-outline-variant text-on-surface-variant hover:border-outline-strong hover:text-primary"}" data-ob-label="Other">\${icon("plus", 12)}Other…</button>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-[11.5px] font-medium text-on-surface">Apply this profile to:</label>
        <label class="flex cursor-pointer items-center gap-2 text-[12px] text-on-surface">
          <input type="radio" name="obScope" value="repo" \${obScope === "repo" ? "checked" : ""} \${facts.canonicalRepo ? "" : "disabled"} />
          This repository only
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-[12px] \${ownerScopeDisabled ? "text-on-surface-variant opacity-60" : "text-on-surface"}">
          <input type="radio" name="obScope" value="owner" \${obScope === "owner" ? "checked" : ""} \${ownerScopeDisabled ? "disabled" : ""} />
          \${esc(ownerScopeLabel)}
        </label>
      </div>

      <button class="vs-button-primary mt-1 h-8 rounded text-[13px] font-semibold" id="obCreateButton">Create Profile &amp; Check Repository</button>
    </div>\`;
}

function submitOnboarding() {
  const facts = state.facts || {};
  const label = obLabel === "Other" ? (obCustomLabel.trim() || "Custom") : obLabel;
  const profile = {
    id: "profile-" + Date.now().toString(36),
    label,
    gitName: facts.effectiveGitName || "",
    gitEmail: facts.effectiveGitEmail || "",
    expectedRemoteOwners: [],
    exactRepos: [],
    expectedBranchPatterns: [],
    strictPushSetup: false,
  };
  if (obScope === "owner" && facts.remoteOwner) {
    profile.expectedRemoteOwners = [facts.remoteOwner];
  } else if (facts.canonicalRepo) {
    profile.exactRepos = [facts.canonicalRepo];
  }
  send("saveProfile", { profile });
  navigate("main");
}
`;
