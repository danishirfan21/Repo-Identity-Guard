import assert from "node:assert/strict";
import test from "node:test";
import { computeStatus } from "../core/statusEngine";
import { Profile, RepoFacts, SafetyPreferences } from "../types";

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
  agentGuardEnabled: true,
};

function safeFacts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    isGitRepo: true,
    repoRoot: "/repo",
    repoName: "acme-frontend",
    currentBranch: "feature/login",
    isDetachedHead: false,
    effectiveGitName: "Danish Irfan",
    effectiveGitEmail: "work@example.com",
    localGitName: "Danish Irfan",
    localGitEmail: "work@example.com",
    originRemoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git",
    remoteProtocol: "ssh",
    remoteHost: "github-work",
    remoteOwner: "AcmeSoftware",
    remoteRepo: "acme-frontend",
    ...overrides,
  };
}

function run(facts: RepoFacts, preferences: SafetyPreferences = defaultPreferences) {
  return computeStatus({
    facts,
    profiles: [workProfile],
    protectedBranches: ["main", "master"],
    preferences,
    pinnedMemoryNote: "Do not push directly to main.",
  });
}

test("non-Git folders are NOT CHECKED, never SAFE or NOT SAFE", () => {
  const summary = computeStatus({
    facts: { isGitRepo: false },
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_checked");
  assert.equal(summary.issues.length, 0);
});

test("a fully matching repo is SAFE", () => {
  const summary = run(safeFacts());
  assert.equal(summary.level, "safe");
  assert.equal(summary.matchedProfile?.id, "work");
});

test("wrong commit identity is NOT SAFE", () => {
  const summary = run(safeFacts({ effectiveGitEmail: "personal@example.com" }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Wrong commit identity"));
});

test("an unmatched/unknown profile is NOT SAFE", () => {
  const summary = run(safeFacts({ remoteOwner: "someone-else" }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Repo profile is unknown"));
});

test("a repo matching two profiles (overlapping freelance clients) is NOT SAFE and unresolved", () => {
  const clientA: Profile = {
    id: "client-a",
    label: "Freelance Client A",
    gitEmail: "danish@client-a.com",
    expectedRemoteOwners: ["shared-org"],
  };
  const clientB: Profile = {
    id: "client-b",
    label: "Freelance Client B",
    gitEmail: "danish@client-b.com",
    expectedRemoteOwners: ["shared-org"],
  };

  const summary = computeStatus({
    facts: safeFacts({ remoteOwner: "shared-org" }),
    profiles: [clientA, clientB],
    protectedBranches: ["main", "master"],
    preferences: defaultPreferences,
  });

  assert.equal(summary.level, "not_safe");
  assert.equal(summary.matchedProfile, undefined);
  assert.ok(summary.issues.some((issue) => issue.title === "Multiple profiles match this repo"));
});

test("HTTPS remote is NOT SAFE only when the profile requires strict push setup", () => {
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true };

  const httpsFacts = safeFacts({
    originRemoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git",
    remoteProtocol: "https",
    remoteHost: "github.com",
  });

  const relaxed = computeStatus({
    facts: httpsFacts,
    profiles: [relaxedProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(relaxed.level, "safe");
  assert.ok(relaxed.issues.some((issue) => issue.title === "Push setup is not verified" && issue.severity === "warning"));

  const strict = computeStatus({
    facts: httpsFacts,
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(strict.level, "not_safe");
  assert.ok(strict.issues.some((issue) => issue.title === "Push setup is not verified" && issue.severity === "blocking"));
});

test("working directly on a protected branch is NOT SAFE", () => {
  const summary = run(safeFacts({ currentBranch: "main" }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Working directly on main"));
});

test("detached HEAD is NOT SAFE", () => {
  const summary = run(safeFacts({ currentBranch: undefined, isDetachedHead: true }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Working in detached HEAD"));
});

test("Agent Guard reports not safe for AI whenever anything else is blocking", () => {
  const summary = run(safeFacts({ currentBranch: "main" }));
  assert.ok(summary.issues.some((issue) => issue.title === "Not safe for AI agent"));
});

test("strict local identity mode flags identity that is only safe via global config", () => {
  const summary = run(
    safeFacts({ localGitName: undefined, localGitEmail: undefined }),
    { requireLocalIdentity: true, agentGuardEnabled: true },
  );
  assert.equal(summary.level, "safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Repo is not locked to Work identity"));
});

test("missing pinned memory produces an info-level (non-blocking) issue", () => {
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "safe");
  assert.ok(summary.issues.some((issue) => issue.title === "No pinned repo memory" && issue.severity === "info"));
});
