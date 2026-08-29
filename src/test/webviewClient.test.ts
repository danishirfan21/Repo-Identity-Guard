import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { ICONS_JS } from "../webview/client/icons";
import { COMPONENTS_JS } from "../webview/client/components";
import { ONBOARDING_VIEW_JS } from "../webview/client/onboardingView";
import { MAIN_VIEW_JS } from "../webview/client/mainView";
import { DETAILS_VIEW_JS } from "../webview/client/detailsView";

/**
 * These tests load the actual client-script modules (the same strings
 * SidebarProvider concatenates into the webview's <script> tag) into a
 * sandboxed VM and exercise the pure rendering/derivation functions
 * directly, so a change to CAPABILITY_ORDER, statusMeta, or the onboarding
 * gate is caught without needing a real webview.
 */
// Top-level `const`/`let` declared inside a vm-executed script are NOT
// reflected as properties on the sandbox object (only `var`/function
// declarations are) — so anything a test needs to read or drive
// (CAPABILITY_ORDER, obScope, outgoing postMessage calls) is fetched
// through a small function-declared bridge appended after the real client
// script, in the same vm.runInContext call so it shares one lexical scope
// with the modules above it.
const TEST_BRIDGE_JS = `
function __testExports() { return { CAPABILITY_ORDER: CAPABILITY_ORDER, CAPABILITY_LABELS: CAPABILITY_LABELS }; }
function __setObScope(v) { obScope = v; }
`;

function loadClientSandbox(extraScript = ""): { sandbox: Record<string, unknown>; sent: { type: string; extra?: Record<string, unknown> }[] } {
  const sent: { type: string; extra?: Record<string, unknown> }[] = [];
  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({ postMessage: (msg: { type: string; [k: string]: unknown }) => sent.push({ type: msg.type, extra: msg }) }),
    console,
    CSS: { escape: (s: string) => s },
    document: {
      addEventListener: () => undefined,
      getElementById: () => ({ addEventListener: () => undefined, classList: { toggle: () => undefined } }),
    },
    window: { addEventListener: () => undefined },
  };
  vm.createContext(sandbox);
  const script = [ICONS_JS, COMPONENTS_JS, MAIN_VIEW_JS, DETAILS_VIEW_JS, ONBOARDING_VIEW_JS, TEST_BRIDGE_JS, extraScript].join("\n");
  vm.runInContext(script, sandbox);
  return { sandbox, sent };
}

test("the six capabilities render in the fixed spec order: Commit Identity, Push Destination, Push Account, Branch Policy, Repo State, Workspace Trust", () => {
  const { sandbox } = loadClientSandbox();
  // Values crossing the vm sandbox boundary come back as objects/arrays
  // from a different realm; round-tripping through JSON normalizes them to
  // plain host-realm values so assert.deepEqual compares content, not
  // cross-realm object identity.
  const testExports = JSON.parse(
    JSON.stringify((sandbox.__testExports as () => unknown)()),
  ) as { CAPABILITY_ORDER: string[]; CAPABILITY_LABELS: Record<string, string> };
  assert.deepEqual(testExports.CAPABILITY_ORDER, [
    "commit_identity",
    "push_destination",
    "push_account",
    "branch_policy",
    "repo_operation_state",
    "workspace_trust",
  ]);
  const labels = testExports.CAPABILITY_LABELS;
  assert.equal(labels.commit_identity, "Commit Identity");
  assert.equal(labels.push_destination, "Push Destination");
  assert.equal(labels.push_account, "Push Account");
  assert.equal(labels.branch_policy, "Branch Policy");
  assert.equal(labels.repo_operation_state, "Repo State");
  assert.equal(labels.workspace_trust, "Workspace Trust");
});

test("statusMeta covers exactly SAFE / NOT SAFE / NOT CHECKED, matching the product's three overall states", () => {
  const { sandbox } = loadClientSandbox();
  const statusMeta = sandbox.statusMeta as (level: string) => { label: string };
  assert.equal(statusMeta("safe").label, "SAFE");
  assert.equal(statusMeta("not_safe").label, "NOT SAFE");
  assert.equal(statusMeta("not_checked").label, "NOT CHECKED");
});

test("SAFE Main render shows the SAFE verdict and no blocking next-fix card", () => {
  const { sandbox } = loadClientSandbox("state = " + JSON.stringify({
    level: "safe",
    isGitRepo: true,
    repoName: "acme-frontend",
    profileLabel: "Work",
    branch: "feature/login",
    capabilityResults: [],
    workspace: { level: "safe", repos: [{ repoId: "r1", name: "acme-frontend", level: "safe", selected: true }] },
  }) + "; var out = renderMain();");
  const out = sandbox.out as string;
  assert.match(out, /SAFE/);
  assert.doesNotMatch(out, /NOT SAFE/);
});

test("NOT SAFE Main render surfaces the blocking next fix and its primary action", () => {
  const nextFix = {
    capability: "commit_identity",
    state: "contradicted",
    title: "Wrong commit identity",
    summary: "Commits would be authored as personal@example.com instead of Work.",
    blocksOverallSafety: true,
    suggestedAction: "Fix Commit Identity",
    suggestedActionCommand: "fixCommitIdentity",
  };
  const { sandbox } = loadClientSandbox("state = " + JSON.stringify({
    level: "not_safe",
    isGitRepo: true,
    repoName: "acme-frontend",
    profileLabel: "Work",
    branch: "main",
    capabilityResults: [nextFix],
    nextFix,
    workspace: { level: "not_safe", repos: [{ repoId: "r1", name: "acme-frontend", level: "not_safe", selected: true }] },
  }) + "; var out = renderMain();");
  const out = sandbox.out as string;
  assert.match(out, /NOT SAFE/);
  assert.match(out, /Wrong commit identity/);
  assert.match(out, /Fix Commit Identity/);
});

test("NOT CHECKED Main render (no git repo, single-root) explains why, without a stray SAFE/NOT SAFE claim", () => {
  const { sandbox } = loadClientSandbox("state = " + JSON.stringify({
    level: "not_checked",
    isGitRepo: false,
    capabilityResults: [],
    workspace: { level: "not_checked", repos: [] },
  }) + "; var out = renderMain();");
  const out = sandbox.out as string;
  assert.match(out, /NOT CHECKED/);
  assert.doesNotMatch(out, /NOT SAFE/);
});

test("Review Details renders a card per capability result, in spec order, including a Push Account card that only ever says unverified/trusted — never a verified account or key", () => {
  const results = [
    { capability: "push_account", state: "unverified", title: "Push account is unverified", summary: "s", whatWeExpected: "Work account", whatWeFound: "SSH authentication through github.com", blocksOverallSafety: false },
    { capability: "commit_identity", state: "confirmed", title: "Commit identity confirmed", summary: "s", blocksOverallSafety: false },
  ];
  const { sandbox } = loadClientSandbox("state = " + JSON.stringify({
    capabilityResults: results,
    infoNotes: [],
    workspace: { repos: [] },
  }) + "; var out = renderDetails();");
  const out = sandbox.out as string;
  assert.match(out, /Commit Identity/);
  assert.match(out, /Push Account/);
  assert.doesNotMatch(out, /verified account|verified key|cryptographic/i);
  // Commit Identity must render before Push Account in the output, per the fixed capability order.
  assert.ok(out.indexOf("Commit Identity") < out.indexOf("Push Account"));
});

test("onboarding shows only when the repo has no usable profile, and never for a non-git folder", () => {
  const { sandbox } = loadClientSandbox();
  const shouldShow = sandbox.shouldShowOnboarding as () => boolean;

  (sandbox as { state?: unknown }).state = { isGitRepo: true, profiles: [] };
  assert.equal(shouldShow(), true);

  (sandbox as { state?: unknown }).state = { isGitRepo: true, profiles: [{ id: "work", label: "Work" }] };
  assert.equal(shouldShow(), false);

  (sandbox as { state?: unknown }).state = { isGitRepo: false, profiles: [] };
  assert.equal(shouldShow(), false);
});

test("onboarding scope maps 1:1 onto the existing Profile schema (exactRepos vs expectedRemoteOwners) with no invented fields", () => {
  const { sandbox, sent } = loadClientSandbox("var navigate = function(){};");
  (sandbox as { state?: unknown }).state = {
    facts: { canonicalRepo: "github.com/danishirfan21/repo-identity-guard", remoteOwner: "danishirfan21", effectiveGitName: "Danish Irfan", effectiveGitEmail: "danish@example.com" },
  };
  const submit = sandbox.submitOnboarding as () => void;
  const setObScope = sandbox.__setObScope as (v: string) => void;

  // See the note in the previous test: normalize the vm-realm payload
  // through JSON before comparing.
  const normalize = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

  setObScope("repo");
  submit();
  const repoScopedProfile = normalize(sent[0].extra?.profile);
  assert.deepEqual(repoScopedProfile.exactRepos, ["github.com/danishirfan21/repo-identity-guard"]);
  assert.deepEqual(repoScopedProfile.expectedRemoteOwners, []);

  setObScope("owner");
  submit();
  const ownerScopedProfile = normalize(sent[1].extra?.profile);
  assert.deepEqual(ownerScopedProfile.expectedRemoteOwners, ["danishirfan21"]);
  assert.deepEqual(ownerScopedProfile.exactRepos, []);
});

test("sidebar.css never redefines a --vscode-* variable with a fixed color and derives its own tokens from them instead", async () => {
  const cssPath = path.join(__dirname, "..", "..", "src", "webview", "sidebar.css");
  const css = await fs.readFile(cssPath, "utf8");
  // No `--vscode-xyz: #hex` (or rgb/rgba) redefinitions — only var(--vscode-xyz, fallback) reads.
  assert.doesNotMatch(css, /--vscode-[a-zA-Z-]+\s*:\s*(#|rgb)/);
  // The sidebar's own semantic scale must be present and must reference VS Code variables.
  assert.match(css, /--rig-bg:\s*var\(--vscode-/);
  assert.match(css, /--rig-fg:\s*var\(--vscode-foreground\)/);
});
