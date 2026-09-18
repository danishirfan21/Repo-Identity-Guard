import assert from "node:assert/strict";
import test from "node:test";
import { toWireShieldState, toWireState, SidebarModel } from "../ui/wireState";
import { ShieldHookInspection, ShieldInspection } from "../shield/manager";
import { Profile, RepoFacts, RepositorySafetyState, SafetyPreferences, StatusSummary, WorkspaceSafetyState } from "../types";

const preferences: SafetyPreferences = { requireLocalIdentity: false, includeMemoryInAiContext: false };

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    isGitRepo: true,
    repoRoot: "/repo",
    repoName: "acme-frontend",
    currentBranch: "main",
    remoteHost: "github.com",
    remoteOwner: "AcmeSoftware",
    remoteRepo: "acme-frontend",
    effectiveGitName: "Danish Irfan",
    effectiveGitEmail: "work@example.com",
    ...overrides,
  };
}

function summary(level: StatusSummary["level"], overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    level,
    repoName: "acme-frontend",
    capabilityResults: [],
    infoNotes: [],
    issueCount: level === "safe" ? 0 : 1,
    facts: facts(),
    ...overrides,
  };
}

function baseModel(overrides: Partial<SidebarModel> = {}): SidebarModel {
  return {
    summary: summary("safe"),
    workspace: { level: "safe", repos: [], safeCount: 1, notSafeCount: 0, uncheckedCount: 0 },
    selectedRepoId: "repo-1",
    memory: { notes: [], commands: [] },
    profiles: [],
    protectedBranches: ["main"],
    preferences,
    isWorkspaceTrusted: true,
    ...overrides,
  };
}

test("SAFE summary maps to a safe wire level with facts prefilled for onboarding/detect", () => {
  const wire = toWireState(baseModel());
  assert.equal(wire.level, "safe");
  assert.equal(wire.isGitRepo, true);
  assert.equal(wire.facts.canonicalRepo, "github.com/acmesoftware/acme-frontend");
  assert.equal(wire.facts.remoteOwner, "AcmeSoftware");
  assert.equal(wire.facts.effectiveGitEmail, "work@example.com");
});

test("NOT SAFE summary maps straight through, unmasked by anything else", () => {
  const wire = toWireState(baseModel({ summary: summary("not_safe") }));
  assert.equal(wire.level, "not_safe");
});

test("NOT CHECKED (no git repo) maps through with no canonical repo facts to prefill", () => {
  const wire = toWireState(
    baseModel({ summary: { level: "not_checked", capabilityResults: [], infoNotes: [], issueCount: 0, facts: { isGitRepo: false } } }),
  );
  assert.equal(wire.level, "not_checked");
  assert.equal(wire.isGitRepo, false);
  assert.equal(wire.facts.canonicalRepo, undefined);
});

test("multi-root workspace: a SAFE selected repo does not get to report a safe workspace level that hides a NOT SAFE sibling", () => {
  const repos: RepositorySafetyState[] = [
    { repoId: "repo-1", summary: summary("safe") },
    { repoId: "repo-2", summary: summary("not_safe") },
  ];
  const workspace: WorkspaceSafetyState = { level: "not_safe", repos, safeCount: 1, notSafeCount: 1, uncheckedCount: 0 };
  const wire = toWireState(
    baseModel({ summary: summary("safe"), workspace, selectedRepoId: "repo-1" }),
  );
  // The selected repo itself is safe...
  assert.equal(wire.level, "safe");
  // ...but the workspace-level aggregate (what Main must display as the
  // dominant verdict per the multi-root rule) still reports NOT SAFE.
  assert.equal(wire.workspace.level, "not_safe");
  assert.equal(wire.workspace.repos.length, 2);
  assert.equal(wire.workspace.repos.find((r) => r.repoId === "repo-2")?.level, "not_safe");
});

test("push_account results never claim a cryptographically verified account/key", () => {
  const pushAccountResult = {
    id: "push_account:confirmed",
    capability: "push_account" as const,
    state: "confirmed" as const,
    title: "Push account trusted",
    summary: "Dedicated SSH host alias — trusted from your Work profile configuration, not cryptographically verified.",
    blocksOverallSafety: false,
  };
  const wire = toWireState(
    baseModel({ summary: summary("safe", { capabilityResults: [pushAccountResult] }) }),
  );
  const result = wire.capabilityResults.find((r) => r.capability === "push_account");
  assert.ok(result);
  assert.doesNotMatch(result!.summary + (result!.whatWeExpected ?? "") + (result!.whatWeFound ?? ""), /verified account|verified key|cryptographic(ally)? verifies/i);
});

test("profiles list length is the only onboarding signal carried to the client — no separate onboarding flag", () => {
  const wireNoProfiles = toWireState(baseModel({ profiles: [] }));
  const someProfile: Profile = { id: "work", label: "Work", gitEmail: "work@example.com" };
  const wireWithProfile = toWireState(baseModel({ profiles: [someProfile] }));
  assert.equal(wireNoProfiles.profiles.length, 0);
  assert.equal(wireWithProfile.profiles.length, 1);
});

// ==================== Shield state (Phase A: UI plumbing) ====================

function hook(overrides: Partial<ShieldHookInspection> = {}): ShieldHookInspection {
  return {
    fileName: "pre-commit",
    action: "commit",
    path: "/repo/.git/hooks/pre-commit",
    ownership: "shield",
    contentModified: false,
    hasChainedOriginal: false,
    fileKind: "executable-regular",
    ...overrides,
  };
}

function inspection(overrides: Partial<ShieldInspection> = {}): ShieldInspection {
  return {
    state: "active",
    reasons: [],
    hooks: [
      hook({ fileName: "pre-commit", action: "commit" }),
      hook({ fileName: "pre-merge-commit", action: "commit" }),
      hook({ fileName: "pre-push", action: "push" }),
    ],
    policyPresent: true,
    policyValid: true,
    policyProfileLabel: "Work",
    policySnapshot: {
      approvedRepositoryKey: "github.com/acmesoftware/acme-frontend",
      approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
      trustedSshHostAliases: ["github-work"],
      expectedGitHubLogin: "danish-work",
      strictPushSetup: true,
      enabledActions: ["commit", "push"],
    },
    evaluatorPresent: true,
    evaluatorOwned: true,
    evaluatorModified: false,
    hooksPathCustomized: false,
    policyProfileDrift: false,
    pushDestinationDrift: false,
    orphanedHookPaths: [],
    gitVersionRaw: "git version 2.43.0",
    gitVersionSupported: true,
    gitVersionKnownUnsupported: false,
    ...overrides,
  };
}

test("Shield state is never inferred from repository safety — it comes only from ShieldInspection", () => {
  // A SAFE repo with Shield off, and a NOT SAFE repo with Shield active,
  // are both valid and must both render exactly as inspected.
  const safeShieldOff = toWireState(
    baseModel({ summary: summary("safe"), workspace: { level: "safe", repos: [{ repoId: "repo-1", summary: summary("safe"), shieldInspection: inspection({ state: "off", hooks: [], policyPresent: false, policyValid: false, policySnapshot: undefined, evaluatorPresent: false, evaluatorOwned: false }) }], safeCount: 1, notSafeCount: 0, uncheckedCount: 0 } }),
  );
  assert.equal(safeShieldOff.level, "safe");
  assert.equal(safeShieldOff.shield.lifecycle, "off");

  const notSafeShieldActive = toWireState(
    baseModel({ summary: summary("not_safe"), workspace: { level: "not_safe", repos: [{ repoId: "repo-1", summary: summary("not_safe"), shieldInspection: inspection() }], safeCount: 0, notSafeCount: 1, uncheckedCount: 0 } }),
  );
  assert.equal(notSafeShieldActive.level, "not_safe");
  assert.equal(notSafeShieldActive.shield.lifecycle, "active");
});

test("toWireShieldState maps every ShieldLifecycleState through unchanged when Git supports Shield", () => {
  for (const state of ["off", "active", "degraded", "broken"] as const) {
    assert.equal(toWireShieldState(inspection({ state })).lifecycle, state);
  }
});

test("a Git too old to run Shield reports 'unavailable', even when Shield reports itself 'off' because it was never enabled", () => {
  const wire = toWireShieldState(inspection({ state: "off", gitVersionSupported: false, gitVersionKnownUnsupported: true, gitVersionRaw: "git version 2.20.0", hooks: [], policyPresent: false, policyValid: false, policySnapshot: undefined, evaluatorPresent: false, evaluatorOwned: false }));
  assert.equal(wire.lifecycle, "unavailable");
  assert.equal(wire.gitVersionRaw, "git version 2.20.0");
});

// Review finding: `!gitVersionSupported ? "unavailable" : inspection.state`
// used to map ANY inspection failure that never determined the Git version
// (e.g. `resolveGitContext` erroring before `git --version` was even read)
// to "unavailable / requires Git 2.31", regardless of the real reason. A
// generic BROKEN inspection failure must stay BROKEN unless Git was
// positively identified as unsupported.
test("a generic inspection failure (Git version never determined) stays BROKEN, not mislabeled 'unavailable'", () => {
  const wire = toWireShieldState(
    inspection({
      state: "broken",
      reasons: ["Could not inspect this repository's Git state: some unrelated error"],
      gitVersionSupported: false,
      gitVersionKnownUnsupported: false,
      gitVersionRaw: undefined,
      hooks: [],
      policyPresent: false,
      policyValid: false,
      policySnapshot: undefined,
      evaluatorPresent: false,
      evaluatorOwned: false,
    }),
  );
  assert.equal(wire.lifecycle, "broken");
});

test("a generic degraded state with an unreadable Git version also stays as reported, not 'unavailable'", () => {
  const wire = toWireShieldState(
    inspection({
      state: "degraded",
      reasons: ["Shield's evaluator copy is missing or was modified outside Repo Identity Guard."],
      gitVersionSupported: false,
      gitVersionKnownUnsupported: false,
      gitVersionRaw: undefined,
    }),
  );
  assert.equal(wire.lifecycle, "degraded");
});

test("Active Shield exposes real available fields — approved destination, trusted alias, expected GitHub login — never fabricated", () => {
  const wire = toWireShieldState(inspection());
  assert.equal(wire.lifecycle, "active");
  assert.equal(wire.profileLabel, "Work");
  assert.equal(wire.approvedRepositoryKey, "github.com/acmesoftware/acme-frontend");
  assert.equal(wire.approvedPushDestinationDisplay, "github.com:AcmeSoftware/acme-frontend");
  assert.deepEqual(wire.trustedSshHostAliases, ["github-work"]);
  assert.equal(wire.expectedGitHubLogin, "danish-work");
  assert.equal(wire.commitProtection, true);
  assert.equal(wire.mergeCommitProtection, true);
  assert.equal(wire.pushProtection, true);
});

test("missing optional Shield fields are hidden, never fabricated as placeholders", () => {
  const wire = toWireShieldState(
    inspection({
      policySnapshot: {
        approvedRepositoryKey: undefined,
        approvedPushDestination: undefined,
        trustedSshHostAliases: [],
        expectedGitHubLogin: undefined,
        strictPushSetup: false,
        enabledActions: ["commit", "push"],
      },
    }),
  );
  assert.equal(wire.approvedRepositoryKey, undefined);
  assert.equal(wire.approvedPushDestinationDisplay, undefined);
  assert.deepEqual(wire.trustedSshHostAliases, []);
  assert.equal(wire.expectedGitHubLogin, undefined);
});

test("a chainable foreign hook is surfaced for the Enable Shield confirmation flow, off by default (not active)", () => {
  const wire = toWireShieldState(
    inspection({
      state: "off",
      hooks: [hook({ ownership: "foreign", fileKind: "executable-regular" })],
      policyPresent: false,
      policyValid: false,
      policySnapshot: undefined,
      evaluatorPresent: false,
      evaluatorOwned: false,
    }),
  );
  assert.equal(wire.lifecycle, "off");
  assert.ok(wire.foreignHook);
  assert.equal(wire.foreignHook!.chainable, true);
});

test("a non-chainable foreign hook (symlink) is surfaced as such, so the UI never offers a Chain option for it", () => {
  const wire = toWireShieldState(
    inspection({
      state: "off",
      hooks: [hook({ ownership: "foreign", fileKind: "symlink" })],
      policyPresent: false,
      policyValid: false,
      policySnapshot: undefined,
      evaluatorPresent: false,
      evaluatorOwned: false,
    }),
  );
  assert.ok(wire.foreignHook);
  assert.equal(wire.foreignHook!.chainable, false);
});

test("an already-active Shield never reports a foreign-hook conflict, even if inspection somehow listed one", () => {
  const wire = toWireShieldState(inspection({ state: "active", hooks: [hook({ ownership: "foreign" })] }));
  assert.equal(wire.foreignHook, undefined);
});

test("multi-root: each repo carries its OWN Shield lifecycle — there is no workspace-wide Shield state", () => {
  const repos: RepositorySafetyState[] = [
    { repoId: "repo-a", summary: summary("safe"), shieldInspection: inspection({ state: "active" }) },
    { repoId: "repo-b", summary: summary("not_safe"), shieldInspection: inspection({ state: "off", hooks: [], policyPresent: false, policyValid: false, policySnapshot: undefined, evaluatorPresent: false, evaluatorOwned: false }) },
  ];
  const workspace: WorkspaceSafetyState = { level: "not_safe", repos, safeCount: 1, notSafeCount: 1, uncheckedCount: 0 };
  const wire = toWireState(baseModel({ workspace, selectedRepoId: "repo-a" }));
  assert.equal(wire.workspace.repos.find((r) => r.repoId === "repo-a")?.shieldLifecycle, "active");
  assert.equal(wire.workspace.repos.find((r) => r.repoId === "repo-b")?.shieldLifecycle, "off");
  // The selected repo's own Shield detail (used by the Shield screen) also
  // reflects repo-a specifically, not some workspace-wide value.
  assert.equal(wire.shield.lifecycle, "active");
});
