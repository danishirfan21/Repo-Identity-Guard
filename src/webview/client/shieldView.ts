/**
 * Shield — the dedicated enforcement screen (OFF / ACTIVE / DEGRADED /
 * BROKEN / UNAVAILABLE) plus the Enable Shield confirmation flow, including
 * the foreign-hook coexistence decision when one applies.
 *
 * Shield Enforcement is a completely separate axis from Repository Safety
 * (SAFE / NOT SAFE / NOT CHECKED) — never inferred from it, never merged
 * with it. Every field rendered here comes straight from WireShieldState
 * (itself a direct, non-fabricated projection of ShieldManager's own
 * inspection); a value ShieldManager didn't report simply isn't shown.
 */
export const SHIELD_VIEW_JS = `
function shieldMeta(lifecycle) {
  if (lifecycle === "active") return { label: "ACTIVE", iconName: "shieldCheck", cls: "text-success", badgeCls: "badge-shield-active" };
  if (lifecycle === "degraded") return { label: "DEGRADED", iconName: "shieldAlert", cls: "text-tertiary", badgeCls: "badge-shield-degraded" };
  if (lifecycle === "broken") return { label: "BROKEN", iconName: "xCircle", cls: "text-error", badgeCls: "badge-shield-broken" };
  if (lifecycle === "unavailable") return { label: "UNAVAILABLE", iconName: "shieldQuestion", cls: "text-on-surface-variant", badgeCls: "badge-shield-unavailable" };
  return { label: "OFF", iconName: "shield", cls: "text-on-surface-variant", badgeCls: "badge-shield-off" };
}

/** Compact summary block + the ONE real action for the current state — embedded on Main, right below the checks grid. Never synthesizes a lifecycle from the safety capabilities above it. */
function renderShieldSummary() {
  const shield = state.shield;
  const meta = shieldMeta(shield.lifecycle);
  const actionLabel = shield.lifecycle === "active" ? "View Shield"
    : shield.lifecycle === "off" ? "Enable Shield"
    : shield.lifecycle === "degraded" ? "Review Shield"
    : shield.lifecycle === "broken" ? "Repair Shield"
    : null;
  const subtitle = shield.lifecycle === "active" ? "Commit and push protection are active."
    : shield.lifecycle === "off" ? "Repo Identity Guard still checks safety, but ordinary unsafe Git operations are not actively blocked."
    : shield.lifecycle === "degraded" ? (shield.reasons[0] || "Some protections are not currently active.")
    : shield.lifecycle === "broken" ? (shield.reasons[0] || "Shield's enforcement files are missing or modified.")
    : "Shield requires Git 2.31 or newer. Repository safety checks are still available.";
  const navTarget = shield.lifecycle === "off" ? "shieldEnable" : "shield";
  const button = actionLabel
    ? \`<button class="vs-button-secondary mt-1 flex h-7 items-center justify-center gap-1.5 self-start rounded px-2.5 text-[11px] font-semibold" data-nav="\${navTarget}">\${esc(actionLabel)}</button>\`
    : "";
  return \`
    <div class="vs-card flex flex-col gap-1 rounded p-2.5 border-l-2" style="border-left-color:var(--rig-\${shield.lifecycle === "active" ? "success" : shield.lifecycle === "degraded" ? "warning" : shield.lifecycle === "broken" ? "error" : "border"})">
      <div class="flex items-center justify-between gap-2">
        <span class="flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-wide \${meta.cls}">\${icon(meta.iconName, 13)}Shield — \${meta.label}</span>
      </div>
      <p class="m-0 text-[11px] leading-relaxed text-on-surface-variant">\${esc(subtitle)}</p>
      \${button}
    </div>\`;
}

function shieldDetailRow(label, value) {
  if (value === undefined || value === null || value === "") return "";
  return \`<div class="flex items-center justify-between gap-2"><span class="text-on-surface-variant">\${esc(label)}</span><span class="min-w-0 truncate text-on-surface" title="\${esc(value)}">\${esc(value)}</span></div>\`;
}

function protectionRow(label, active) {
  return \`
    <div class="flex items-center gap-1.5">
      <span class="\${active ? "text-success" : "text-on-surface-variant"}">\${icon(active ? "checkCircle" : "xCircle", 13)}</span>
      <span class="text-[11px] \${active ? "text-on-surface" : "text-on-surface-variant"}">\${esc(label)}</span>
    </div>\`;
}

function renderShieldHeaderBanner(lifecycle) {
  const meta = shieldMeta(lifecycle);
  return \`
    <div class="flex flex-col items-center gap-1.5 rounded-lg p-3.5 \${meta.badgeCls}">
      <span class="\${meta.cls}" style="width:28px;height:28px">\${icon(meta.iconName, 28)}</span>
      <span class="text-[14px] font-extrabold uppercase tracking-widest \${meta.cls}">SHIELD — \${meta.label}</span>
    </div>\`;
}

function renderShieldReasons(reasons) {
  if (!reasons || !reasons.length) return "";
  return \`
    <section class="flex flex-col gap-1.5">
      \${sectionLabel("Why")}
      \${reasons.map((r) => \`<div class="vs-card rounded p-2 text-[11px] leading-relaxed text-on-surface-variant">\${esc(r)}</div>\`).join("")}
    </section>\`;
}

function renderShieldActionButtons(buttons) {
  return \`<div class="flex flex-col gap-1.5">\${buttons.join("")}</div>\`;
}

function shieldActionButton(label, iconName, id, variant) {
  const cls = variant === "primary" ? "vs-button-primary" : variant === "danger" ? "vs-button-secondary" : "vs-button-secondary";
  const style = variant === "danger" ? ' style="color:var(--rig-error);border-color:color-mix(in srgb, var(--rig-error) 40%, transparent)"' : "";
  return \`<button class="\${cls} flex h-8 items-center justify-center gap-1.5 rounded text-[12px] font-semibold" id="\${id}"\${style}>\${icon(iconName, 13)}\${esc(label)}</button>\`;
}

function renderShieldOff() {
  return \`
    \${renderShieldHeaderBanner("off")}
    <p class="m-0 text-[11px] leading-relaxed text-on-surface-variant">Repo Identity Guard still checks safety, but ordinary unsafe Git operations (a wrong commit identity, a protected-branch commit, a push to the wrong destination) are not actively blocked.</p>
    \${renderShieldActionButtons([shieldActionButton("Enable Shield", "power", "shieldGoToEnableButton", "primary")])}\`;
}

function renderShieldActive() {
  const s = state.shield;
  return \`
    \${renderShieldHeaderBanner("active")}
    <div class="vs-card flex flex-col gap-1.5 rounded p-2.5">
      \${sectionLabel("Protection")}
      \${protectionRow("Commit protection", s.commitProtection)}
      \${protectionRow("Merge-commit protection", s.mergeCommitProtection)}
      \${protectionRow("Push protection", s.pushProtection)}
    </div>
    <div class="vs-card flex flex-col gap-1 rounded p-2.5 font-code-mono text-code-mono">
      \${sectionLabel("Policy")}
      \${shieldDetailRow("Profile", s.profileLabel)}
      \${shieldDetailRow("Approved repository", s.approvedRepositoryKey)}
      \${shieldDetailRow("Approved push destination", s.approvedPushDestinationDisplay)}
      \${s.trustedSshHostAliases.length ? shieldDetailRow("Trusted SSH route", s.trustedSshHostAliases.join(", ")) : ""}
      \${shieldDetailRow("Expected GitHub account", s.expectedGitHubLogin)}
      \${shieldDetailRow("Strict push setup", s.strictPushSetup ? "On" : "Off")}
    </div>
    \${s.policyProfileDrift || s.pushDestinationDrift ? \`<div class="vs-card rounded p-2.5 text-[11px] leading-relaxed text-tertiary border-l-2" style="border-left-color:var(--rig-warning)">Shield's saved policy no longer matches your current profile or push destination. Run Check Health for details, then Repair Shield.</div>\` : ""}
    \${renderShieldActionButtons([
      shieldActionButton("Check Health", "pulse", "shieldCheckHealthButton"),
      shieldActionButton("Disable Shield", "power", "shieldDisableButton", "danger"),
    ])}\`;
}

function renderShieldDegraded() {
  const s = state.shield;
  const buttons = [];
  if (s.foreignHook) buttons.push(shieldActionButton("Resolve Hook Conflict", "link", "shieldGoToEnableButton", "primary"));
  buttons.push(shieldActionButton("Check Health", "pulse", "shieldCheckHealthButton"));
  buttons.push(shieldActionButton("Repair Shield", "wrench", "shieldRepairButton", "primary"));
  return \`
    \${renderShieldHeaderBanner("degraded")}
    \${renderShieldReasons(s.reasons)}
    <div class="vs-card flex flex-col gap-1.5 rounded p-2.5">
      \${sectionLabel("Protection remaining")}
      \${protectionRow("Commit protection", s.commitProtection)}
      \${protectionRow("Merge-commit protection", s.mergeCommitProtection)}
      \${protectionRow("Push protection", s.pushProtection)}
    </div>
    \${renderShieldActionButtons(buttons)}\`;
}

function renderShieldBroken() {
  const s = state.shield;
  return \`
    \${renderShieldHeaderBanner("broken")}
    \${renderShieldReasons(s.reasons)}
    \${renderShieldActionButtons([
      shieldActionButton("Repair Shield", "wrench", "shieldRepairButton", "primary"),
      shieldActionButton("Disable Shield", "power", "shieldDisableButton", "danger"),
    ])}\`;
}

function renderShieldUnavailable() {
  const s = state.shield;
  return \`
    \${renderShieldHeaderBanner("unavailable")}
    <p class="m-0 text-[11px] leading-relaxed text-on-surface-variant">Shield requires Git 2.31 or newer. Repository safety checks are still available.</p>
    \${s.gitVersionRaw ? \`<div class="vs-card rounded p-2 font-code-mono text-code-mono text-on-surface-variant">Detected: \${esc(s.gitVersionRaw)}</div>\` : ""}\`;
}

function renderShield() {
  const lifecycle = state.shield.lifecycle;
  if (lifecycle === "active") return renderShieldActive();
  if (lifecycle === "degraded") return renderShieldDegraded();
  if (lifecycle === "broken") return renderShieldBroken();
  if (lifecycle === "unavailable") return renderShieldUnavailable();
  return renderShieldOff();
}

// ==================== Enable Shield confirmation ====================

/** Radio choice for a chainable foreign hook conflict; reset every time the confirmation screen is (re)entered. */
let shieldChainChoice = "leave";

function renderHookConflictSection() {
  const hook = state.shield.foreignHook;
  if (!hook) return "";
  if (!hook.chainable) {
    return \`
      <div class="vs-card flex flex-col gap-1.5 rounded p-2.5 border-l-2" style="border-left-color:var(--rig-warning)">
        \${sectionLabel("Existing Git Hook Detected")}
        <div class="flex items-center gap-1.5 font-code-mono text-code-mono text-on-surface"><span class="text-tertiary">\${icon("alertTriangle", 12)}</span>\${esc(hook.fileName)}</div>
        <p class="m-0 text-[11px] leading-relaxed text-on-surface-variant">This hook type cannot be safely chained. Repo Identity Guard left it unchanged.</p>
      </div>\`;
  }
  return \`
    <div class="vs-card flex flex-col gap-2 rounded p-2.5">
      \${sectionLabel("Existing Git Hook Detected")}
      <div class="flex items-center gap-1.5 font-code-mono text-code-mono text-on-surface">\${icon("terminal", 12)}\${esc(hook.fileName)}</div>
      <div class="flex flex-col gap-1.5">
        <label class="flex items-start gap-2 rounded border p-2 text-[11px]" style="border-color:\${shieldChainChoice === "leave" ? "var(--rig-primary)" : "var(--rig-border)"}">
          <input type="radio" name="shieldChain" value="leave" \${shieldChainChoice === "leave" ? "checked" : ""} />
          <span class="text-on-surface">Leave existing hook unchanged</span>
        </label>
        <label class="flex items-start gap-2 rounded border p-2 text-[11px]" style="border-color:\${shieldChainChoice === "chain" ? "var(--rig-primary)" : "var(--rig-border)"}">
          <input type="radio" name="shieldChain" value="chain" \${shieldChainChoice === "chain" ? "checked" : ""} />
          <span class="text-on-surface">Chain Repo Identity Guard with the existing hook</span>
        </label>
      </div>
      <p class="m-0 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-on-surface-variant"><span class="mt-0.5 shrink-0">\${icon("link", 11)}</span>When chaining is enabled, Repo Identity Guard preserves the existing hook and restores it when Shield is disabled.</p>
    </div>\`;
}

function renderShieldEnable() {
  const s = state.shield;
  return \`
    <div class="vs-card flex flex-col gap-1 rounded p-2.5 font-code-mono text-code-mono">
      \${shieldDetailRow("Repository", state.repoName)}
      \${shieldDetailRow("Profile", state.profileLabel)}
    </div>
    \${renderHookConflictSection()}
    <section class="flex flex-col gap-1.5">
      \${sectionLabel("Shield can block")}
      <ul class="m-0 flex flex-col gap-1 pl-4 text-[11px] leading-relaxed text-on-surface-variant">
        <li>A commit with the wrong effective Git identity</li>
        <li>A commit on a protected branch</li>
        <li>A commit while the repository is in an unsafe Git operation state</li>
        <li>A push to an unapproved destination</li>
        <li>A push over an untrusted/unverified route, when a strict policy requires one</li>
        <li>A push authenticating as the wrong GitHub account, when configured</li>
      </ul>
    </section>
    <section class="flex flex-col gap-1.5">
      \${sectionLabel("Shield does not")}
      <ul class="m-0 flex flex-col gap-1 pl-4 text-[11px] leading-relaxed text-on-surface-variant">
        <li>Manage SSH private keys, passwords, tokens, or credential stores</li>
        <li>Change GitHub permissions</li>
        <li>Create a security sandbox</li>
      </ul>
      <p class="m-0 text-[10.5px] leading-relaxed text-on-surface-variant">Deliberate local bypasses (e.g. <code>--no-verify</code>) are outside Shield's protection boundary.</p>
    </section>
    <div class="flex gap-1.5 border-t border-outline-variant/40 pt-2.5">
      <button class="vs-button-secondary flex h-8 flex-1 items-center justify-center rounded text-[12px] font-semibold" data-nav="main">Cancel</button>
      <button class="vs-button-primary flex h-8 flex-1 items-center justify-center gap-1.5 rounded text-[12px] font-semibold" id="shieldEnableConfirmButton">\${icon("power", 13)}Enable Shield</button>
    </div>\`;
}
`;
