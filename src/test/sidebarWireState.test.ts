import assert from "node:assert/strict";
import test from "node:test";
import { toWireState, SidebarModel } from "../ui/wireState";
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
