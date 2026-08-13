import assert from "node:assert/strict";
import test from "node:test";
import { buildAiContextModel, isCapabilityRepresentedInModel, renderAiContext } from "../core/aiContext";
import { computeStatus } from "../core/statusEngine";
import { Profile, RepoFacts, RepoMemory, SafetyPreferences } from "../types";

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  expectedBranchPatterns: [],
  strictPushSetup: false,
};

const defaultPreferences: SafetyPreferences = {
  requireLocalIdentity: false,
  includeMemoryInAiContext: false,
};

function safeFacts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    isGitRepo: true,
    repoRoot: "/repo",
    repoName: "acme-frontend",
    currentBranch: "feature/login",
    isDetachedHead: false,
    hasUncommittedChanges: false,
    hasMergeConflicts: false,
    effectiveGitName: "Danish Irfan",
    effectiveGitEmail: "work@example.com",
    effectiveCommitterName: "Danish Irfan",
    effectiveCommitterEmail: "work@example.com",
    localGitName: "Danish Irfan",
    localGitEmail: "work@example.com",
    originRemoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git",
    remoteProtocol: "ssh",
    remoteHost: "github-work",
    remoteOwner: "AcmeSoftware",
    remoteRepo: "acme-frontend",
    pushRemoteName: "origin",
    pushRemoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git",
    pushRemoteProtocol: "ssh",
    pushRemoteHost: "github-work",
    pushRemoteOwner: "AcmeSoftware",
    pushRemoteRepo: "acme-frontend",
    ...overrides,
  };
}

function emptyMemory(): RepoMemory {
  return { notes: [], commands: [] };
}

// ---- Invariant: every capability result that blocks overall safety must be
// representable in the Copy Context model — as an issue entry or a derived
// restriction — never silently dropped. ----

function assertInvariantHolds(facts: RepoFacts, profiles: Profile[], preferences = defaultPreferences, isWorkspaceTrusted = true) {
  const summary = computeStatus({
    facts,
    profiles,
    protectedBranches: ["main", "master"],
    preferences,
    isWorkspaceTrusted,
  });
  const model = buildAiContextModel(summary, emptyMemory(), { includeMemory: false, now: new Date("2026-01-01") });

  for (const result of summary.capabilityResults) {
    if (!result.blocksOverallSafety) continue;
    assert.ok(
      isCapabilityRepresentedInModel(result, model),
      `blocking capability "${result.id}" (${result.title}) is not represented in the AI context model`,
    );
  }
}

test("invariant: wrong commit identity (config itself wrong) is represented in the AI context", () => {
  assertInvariantHolds(
    safeFacts({ effectiveGitEmail: "personal@example.com", localGitEmail: "personal@example.com" }),
    [workProfile],
  );
});

test("invariant: an environment-override commit identity mismatch is represented in the AI context", () => {
  // Config matches the profile; only the effective (env-influenced)
  // identity differs — a different capability result than the ordinary
  // wrong-config case, and it must be covered by the invariant too.
  assertInvariantHolds(safeFacts({ effectiveGitEmail: "personal@example.com" }), [workProfile]);
});

test("invariant: unknown profile is represented in the AI context", () => {
  assertInvariantHolds(safeFacts({ remoteOwner: "someone-else" }), [workProfile]);
});

test("invariant: unresolved push destination is represented in the AI context", () => {
  assertInvariantHolds(
    safeFacts({ pushRemoteName: undefined, pushRemoteUrl: undefined, pushRemoteProtocol: undefined }),
    [workProfile],
  );
});

test("invariant: protected branch (with derived restrictions) is represented in the AI context", () => {
  assertInvariantHolds(safeFacts({ currentBranch: "main" }), [workProfile]);
});

test("invariant: an in-progress rebase (with derived restrictions) is represented in the AI context", () => {
  assertInvariantHolds(safeFacts({ inProgressOperation: "rebase" }), [workProfile]);
});

test("invariant: untrusted workspace is represented in the AI context", () => {
  assertInvariantHolds(safeFacts(), [workProfile], defaultPreferences, false);
});

test("invariant: strict push account requirement is represented in the AI context", () => {
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true };
  assertInvariantHolds(
    safeFacts({ pushRemoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git", pushRemoteProtocol: "https", pushRemoteHost: "github.com" }),
    [strictProfile],
  );
});

// ---- Behavioral tests ----

test("not_applicable capability results are omitted from the AI context entirely", () => {
  const summary = computeStatus({
    facts: safeFacts({ remoteOwner: "someone-else" }),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  const model = buildAiContextModel(summary, emptyMemory(), { includeMemory: false });
  const notApplicableIds = summary.capabilityResults
    .filter((r) => r.state === "not_applicable")
    .map((r) => r.id);
  assert.ok(notApplicableIds.length > 0, "expected at least one not_applicable result for this fixture");

  const allSourceIds = [...model.confirmedFacts, ...model.contradictions, ...model.unverifiedFacts, ...model.warnings].map(
    (entry) => entry.sourceId,
  );
  for (const id of notApplicableIds) {
    assert.ok(!allSourceIds.includes(id), `not_applicable result ${id} should not appear in the AI context`);
  }
});

test("pinned memory is omitted by default and included only when explicitly opted in", () => {
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
    pinnedMemoryNote: "Do not push directly to main.",
  });
  const memory: RepoMemory = {
    notes: [{ id: "n1", text: "Secret internal URL", pinned: true, createdAt: 1 }],
    commands: [],
  };

  const withoutOptIn = buildAiContextModel(summary, memory, { includeMemory: false });
  assert.equal(withoutOptIn.pinnedMemoryIncluded, false);
  assert.equal(withoutOptIn.pinnedMemoryText, undefined);
  const renderedWithout = renderAiContext(withoutOptIn);
  assert.ok(!renderedWithout.includes("Secret internal URL"));

  const withOptIn = buildAiContextModel(summary, memory, { includeMemory: true });
  assert.equal(withOptIn.pinnedMemoryIncluded, true);
  assert.equal(withOptIn.pinnedMemoryText, "Secret internal URL");
  const renderedWith = renderAiContext(withOptIn);
  assert.ok(renderedWith.includes("Secret internal URL"));
});

test("baseline restrictions always appear regardless of findings", () => {
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  const model = buildAiContextModel(summary, emptyMemory(), { includeMemory: false });
  const rendered = renderAiContext(model);
  assert.match(rendered, /Do not run `git push`\./);
  assert.match(rendered, /Do not change Git identity, remotes, SSH config, or credential settings\./);
});

test("derived restrictions are deduplicated across capabilities that share one", () => {
  // Detached HEAD (branch_policy) and an in-progress rebase (repo_operation_state)
  // both emit "no-commit" — it should appear exactly once, sourced from both.
  const summary = computeStatus({
    facts: safeFacts({ currentBranch: undefined, isDetachedHead: true, inProgressOperation: "rebase" }),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  const model = buildAiContextModel(summary, emptyMemory(), { includeMemory: false });
  const noCommitEntries = model.derivedRestrictions.filter((r) => r.restriction.id === "no-commit");
  assert.equal(noCommitEntries.length, 1);
  assert.ok(noCommitEntries[0].sourceCapabilityIds.length >= 2);

  const rendered = renderAiContext(model);
  const occurrences = rendered.split(noCommitEntries[0].restriction.description).length - 1;
  assert.equal(occurrences, 1);
});

test("rendered output never includes raw remote URLs, tokens, or Git config", () => {
  const summary = computeStatus({
    facts: safeFacts({
      originRemoteUrl: "https://ghp_supersecrettoken123@github.com/AcmeSoftware/acme-frontend.git",
    }),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  const rendered = buildAiContextModel(summary, emptyMemory(), { includeMemory: false });
  const text = renderAiContext(rendered);
  assert.ok(!text.includes("ghp_supersecrettoken123"));
  assert.ok(!text.includes("originRemoteUrl"));
});
