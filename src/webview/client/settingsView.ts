/**
 * Settings — Profiles (chip-based owners/exact-repos/branch patterns editor,
 * "Detect from current repo" prefill), Local Branch Policy, Safety
 * Preferences, and a Shield summary card.
 *
 * Shield Mode is real and enforcing as of Phase 4+ (see docs/SHIELD_MODE.md
 * and src/shield/) and has its own dedicated sidebar screen (OFF / ACTIVE /
 * DEGRADED / BROKEN / UNAVAILABLE — see shieldView.ts) reached from this
 * card's "Open Shield" button, which shows the live lifecycle badge and
 * surfaces Enable/Disable/Repair/Check Health there. The equivalent Command
 * Palette commands ("Repo Identity Guard: Enable/Disable/Repair Shield",
 * "Check Shield Health") still exist and call the exact same code paths —
 * the sidebar is not a separate implementation.
 *
 * "Detect from current repo" only ever prefills form fields from facts the
 * engine already collected this scan (repo owner, effective identity) — it
 * never writes Git config itself and never calls saveProfile on its own;
 * the user still has to press Save.
 *
 * Chip removal/add for owners/exact-repos/branch-patterns calls saveProfile
 * immediately with the modified array (same round trip every other mutation
 * here already uses) rather than staging local-only edits that could be
 * silently lost — there is no separate onboarding/draft storage.
 */
export const SETTINGS_VIEW_JS = `
let selectedProfileId = null;

function currentProfile() {
  if (!state.profiles.length) return undefined;
  return state.profiles.find((p) => p.id === selectedProfileId) || state.profiles[0];
}

function patchProfile(id, partial) {
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return;
  send("saveProfile", { profile: Object.assign({}, profile, partial) });
}

function removeChip(id, field, value) {
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return;
  const next = (profile[field] || []).filter((v) => v !== value);
  patchProfile(id, { [field]: next });
}

function addChipFromInput(id, field, inputEl) {
  const value = inputEl.value.trim();
  if (!value) return;
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return;
  const existing = profile[field] || [];
  if (existing.includes(value)) { inputEl.value = ""; return; }
  patchProfile(id, { [field]: [...existing, value] });
  inputEl.value = "";
}

function renderChipRow(profile, field, placeholder) {
  const values = profile[field] || [];
  const chips = values
    .map((v) => \`<span class="vs-chip flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-code-mono text-code-mono">\${esc(v)}<button class="text-on-surface-variant hover:text-error" data-remove-chip="\${esc(field)}" data-remove-chip-value="\${esc(v)}" title="Remove">\${icon("close", 9)}</button></span>\`)
    .join("");
  return \`
    <div class="flex flex-wrap gap-1 \${values.length ? "mb-1" : ""}">\${chips}</div>
    <input class="vs-input h-7 w-full rounded px-2 font-code-mono text-code-mono" data-add-chip="\${esc(field)}" placeholder="\${esc(placeholder)}" />\`;
}

function renderProfileChipTabs() {
  return state.profiles
    .map((p) => {
      const active = currentProfile() && currentProfile().id === p.id;
      const cls = active ? "border-primary bg-primary-container text-on-surface" : "border-outline-variant text-on-surface-variant hover:border-outline-strong";
      return \`<button class="rounded border px-2.5 py-1 text-[11.5px] font-medium \${cls}" data-select-profile="\${esc(p.id)}">\${esc(p.label || "Untitled")}</button>\`;
    })
    .join("");
}

function renderProfileEditor() {
  const profile = currentProfile();
  if (!profile) {
    return \`<p class="text-[11px] text-on-surface-variant">No profiles yet. Add one to start matching repositories to an identity.</p>\`;
  }
  const id = profile.id;
  return \`
    <div class="vs-card flex flex-col rounded" data-profile-id="\${esc(id)}" style="border-left:2px solid var(--rig-primary)">
      <div class="flex items-center gap-1.5 border-b border-outline-variant bg-surface-container px-2.5 py-1.5">
        \${icon("userCircle", 13)}<span class="text-[12px] font-semibold text-on-surface">Profile Editor</span>
      </div>
      <div class="flex flex-col gap-2.5 p-2.5">
        <div class="flex flex-col gap-1.5">
          <label class="flex flex-col gap-0.5 text-[10.5px] text-on-surface-variant">Profile name
            <input class="vs-input h-7 rounded px-2 text-[12px]" data-field="label" value="\${esc(profile.label)}" />
          </label>
          <label class="flex flex-col gap-0.5 text-[10.5px] text-on-surface-variant">Git name
            <input class="vs-input h-7 rounded px-2 font-code-mono text-code-mono" data-field="gitName" value="\${esc(profile.gitName || "")}" />
          </label>
          <label class="flex flex-col gap-0.5 text-[10.5px] text-on-surface-variant">Git email
            <input class="vs-input h-7 rounded px-2 font-code-mono text-code-mono" data-field="gitEmail" value="\${esc(profile.gitEmail || "")}" />
          </label>
          <button class="vs-button-secondary mt-0.5 flex h-7 items-center justify-center gap-1.5 rounded text-[11.5px]" id="detectFromRepoButton">\${icon("compass", 12)}Detect from current repo</button>
        </div>

        <div class="flex flex-col gap-1.5 border-t border-outline-variant pt-2.5">
          <label class="text-[10.5px] text-on-surface-variant">Repository owners / orgs</label>
          \${renderChipRow(profile, "expectedRemoteOwners", "Add owner, e.g. AcmeSoftware")}
          <label class="mt-1 text-[10.5px] text-on-surface-variant">Exact repositories <span class="opacity-70">(always wins over owners above)</span></label>
          \${renderChipRow(profile, "exactRepos", "host/owner/repo, e.g. github.com/acme/secret")}
        </div>

        <div class="flex flex-col gap-1.5 border-t border-outline-variant pt-2.5">
          <label class="text-[10.5px] text-on-surface-variant">Expected branch patterns</label>
          \${renderChipRow(profile, "expectedBranchPatterns", "Add pattern, e.g. feature/*")}
          <label class="mt-1 flex items-center gap-1.5 text-[11px] text-on-surface">
            <input type="checkbox" data-field="strictPushSetup" \${profile.strictPushSetup ? "checked" : ""} />
            Strict push setup (treat HTTPS/generic SSH as Not Safe)
          </label>
        </div>

        <div class="flex flex-col gap-1.5 border-t border-outline-variant pt-2.5">
          <label class="text-[10.5px] text-on-surface-variant">Trusted SSH host aliases <span class="opacity-70">(e.g. a Host entry in ~/.ssh/config — only these route as a trusted push, never just because a host looks dedicated)</span></label>
          \${renderChipRow(profile, "trustedSshHostAliases", "Add alias, e.g. github-work")}
          <label class="mt-1 flex flex-col gap-0.5 text-[10.5px] text-on-surface-variant">Expected GitHub login <span class="opacity-70">(optional — the GitHub <em>username</em> a trusted SSH route must authenticate as when Shield performs strict GitHub account verification. Not your commit email, not the repo owner/org, and not the SSH alias.)</span>
            <input class="vs-input h-7 rounded px-2 font-code-mono text-code-mono" data-field="expectedGitHubLogin" value="\${esc(profile.expectedGitHubLogin || "")}" placeholder="e.g. danish-work" />
          </label>
        </div>

        <div class="mt-1 flex gap-1.5">
          <button class="vs-button-primary h-7 flex-1 rounded text-[12px] font-semibold" data-save-profile="\${esc(id)}">Save</button>
          <button class="h-7 rounded px-2.5 text-[12px] text-error hover:bg-error-container" data-delete-profile="\${esc(id)}">Delete</button>
        </div>
      </div>
    </div>\`;
}

function renderSettings() {
  const facts = state.facts || {};
  return \`
    <section class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">\${sectionLabel("Profiles")}<button class="rounded p-1 text-on-surface-variant hover:text-primary" id="addProfileButton" title="Add profile">\${icon("plus", 13)}</button></div>
      <div class="flex flex-wrap gap-1.5">\${renderProfileChipTabs()}</div>
      \${renderProfileEditor()}
    </section>

    <section class="vs-card flex flex-col gap-1.5 rounded p-2.5">
      \${sectionLabel("Local branch policy")}
      <p class="m-0 text-[10.5px] text-on-surface-variant">Branches treated as protected on this machine only — not synced with GitHub's own branch protection rules.</p>
      <input id="protectedBranchesInput" class="vs-input h-7 rounded px-2 font-code-mono text-code-mono" value="\${esc(state.protectedBranches.join(", "))}" />
      <button class="vs-button-secondary h-7 rounded text-[12px]" id="saveBranchesButton">Save</button>
    </section>

    <section class="vs-card flex flex-col gap-2 rounded p-2.5">
      \${sectionLabel("Safety preferences")}
      <label class="flex items-start gap-1.5 text-[11.5px] text-on-surface">
        <input type="checkbox" class="mt-0.5" id="requireLocalIdentityCheckbox" \${state.preferences.requireLocalIdentity ? "checked" : ""} />
        Require repo-local identity (don't trust global config alone)
      </label>
      <label class="flex items-start gap-1.5 text-[11.5px] text-on-surface">
        <input type="checkbox" class="mt-0.5" id="includeMemoryCheckbox" \${state.preferences.includeMemoryInAiContext ? "checked" : ""} />
        <span>Include pinned Repo Memory note in AI context
          <span class="mt-0.5 block text-[10px] text-on-surface-variant">Off by default — pinned notes are free text you wrote for yourself and may contain sensitive info.</span>
        </span>
      </label>
    </section>

    <section class="vs-card flex flex-col gap-1.5 rounded p-2.5">
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-1.5 text-[12px] font-semibold text-on-surface-variant">\${icon("shield", 13)}Shield</span>
        <span class="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide \${shieldMeta(state.shield.lifecycle).badgeCls}">\${shieldMeta(state.shield.lifecycle).label}</span>
      </div>
      <p class="m-0 text-[10.5px] leading-relaxed text-on-surface-variant">Shield can block ordinary unsafe commits and pushes locally, for the currently selected repository.</p>
      <button class="vs-button-secondary h-7 self-start rounded px-2.5 text-[11px] font-semibold" data-nav="\${state.shield.lifecycle === "off" ? "shieldEnable" : "shield"}">Open Shield</button>
    </section>

    <button class="vs-button-secondary h-7 rounded text-[12px]" id="openSettingsJsonButton">Open settings.json</button>
  \`;
}
`;
