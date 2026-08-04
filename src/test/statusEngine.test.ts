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

function run(
  facts: RepoFacts,
  preferences: SafetyPreferences = defaultPreferences,
  isWorkspaceTrusted = true,
) {
  return computeStatus({
    facts,
    profiles: [workProfile],
    protectedBranches: ["main", "master"],
    preferences,
    pinnedMemoryNote: "Do not push directly to main.",
    isWorkspaceTrusted,
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

test("wrong effective author identity is NOT SAFE", () => {
  const summary = run(safeFacts({ effectiveGitEmail: "personal@example.com" }));
  assert.equal(summary.level, "not_safe");
  const issue = summary.issues.find((i) => i.title === "Wrong commit identity");
  assert.ok(issue);
  assert.match(issue!.whatWeFound ?? "", /Author:/);
});

test("wrong effective committer identity (author matches) is NOT SAFE", () => {
  const summary = run(
    safeFacts({ effectiveCommitterName: "Someone Else", effectiveCommitterEmail: "someone@example.com" }),
  );
  assert.equal(summary.level, "not_safe");
  const issue = summary.issues.find((i) => i.title === "Wrong commit identity");
  assert.ok(issue);
  assert.match(issue!.whatWeFound ?? "", /Committer:/);
  assert.doesNotMatch(issue!.whatWeFound ?? "", /Author:/);
});

test("an unmatched/unknown profile is NOT SAFE", () => {
  const summary = run(safeFacts({ remoteOwner: "someone-else" }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Repo profile is unknown"));
});

test("a fork where origin and upstream imply different profiles is NOT SAFE and matchedProfile is unresolved", () => {
  const personalProfile: Profile = {
    id: "personal",
    label: "Personal",
    gitEmail: "danish@example.com",
    expectedRemoteOwners: ["danish-irfan"],
  };
  const summary = computeStatus({
    facts: safeFacts({ remoteOwner: "danish-irfan", upstreamOwner: "AcmeSoftware" }),
    profiles: [workProfile, personalProfile],
    protectedBranches: ["main", "master"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_safe");
  assert.equal(summary.matchedProfile, undefined);
  assert.ok(summary.issues.some((issue) => issue.title === "Origin and upstream imply different profiles"));
});

test("assigning an exact-repo override resolves what would otherwise be a fork conflict", () => {
  const personalWithOverride: Profile = {
    id: "personal",
    label: "Personal",
    gitEmail: "danish@example.com",
    expectedRemoteOwners: ["danish-irfan"],
    exactRepos: ["github-work/danish-irfan/acme-frontend"],
  };
  const summary = computeStatus({
    facts: safeFacts({
      remoteOwner: "danish-irfan",
      remoteHost: "github-work",
      upstreamOwner: "AcmeSoftware",
      effectiveGitEmail: "danish@example.com",
      effectiveCommitterEmail: "danish@example.com",
      localGitEmail: "danish@example.com",
      pushRemoteHost: "github-work",
      pushRemoteOwner: "danish-irfan",
    }),
    profiles: [workProfile, personalWithOverride],
    protectedBranches: ["main", "master"],
    preferences: defaultPreferences,
    pinnedMemoryNote: "note",
  });
  assert.equal(summary.matchedProfile?.id, "personal");
  assert.ok(!summary.issues.some((issue) => issue.title === "Origin and upstream imply different profiles"));
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

test("push destination that cannot be resolved at all is always NOT SAFE, even for a relaxed profile", () => {
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const summary = computeStatus({
    facts: safeFacts({ pushRemoteName: undefined, pushRemoteUrl: undefined, pushRemoteProtocol: undefined }),
    profiles: [relaxedProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Push destination is not verified" && issue.severity === "blocking"));
});

test("push destination resolving to a different owner is NOT SAFE (destination mismatch, not just account)", () => {
  const summary = run(
    safeFacts({
      pushRemoteName: "upstream",
      pushRemoteUrl: "git@github.com:SomeoneElse/acme-frontend.git",
      pushRemoteOwner: "SomeoneElse",
    }),
  );
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Push destination does not match Work"));
});

test("push destination matching a profile's exact-repo override is confirmed even outside its owner pattern", () => {
  const profileWithOverride: Profile = {
    ...workProfile,
    expectedRemoteOwners: [],
    exactRepos: ["github-work/acmesoftware/acme-frontend"],
  };
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [profileWithOverride],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.ok(!summary.issues.some((issue) => issue.category === "push_setup"));
});

test("push account is unverified over HTTPS, blocking only when the profile requires strict push setup", () => {
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true };

  const httpsFacts = safeFacts({
    pushRemoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git",
    pushRemoteProtocol: "https",
    pushRemoteHost: "github.com",
  });

  const relaxed = computeStatus({
    facts: httpsFacts,
    profiles: [relaxedProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(relaxed.level, "safe");
  assert.ok(relaxed.issues.some((issue) => issue.title === "Push account is unverified" && issue.severity === "warning"));

  const strict = computeStatus({
    facts: httpsFacts,
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(strict.level, "not_safe");
  assert.ok(strict.issues.some((issue) => issue.title === "Push account is unverified" && issue.severity === "blocking"));
});

test("push account is unverified over a generic SSH host (no dedicated alias)", () => {
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true };
  const summary = computeStatus({
    facts: safeFacts({
      pushRemoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git",
      pushRemoteHost: "github.com",
    }),
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Push account is unverified"));
});

test("a dedicated SSH host alias produces no push account issue", () => {
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true };
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "safe");
  assert.ok(!summary.issues.some((issue) => issue.category === "push_setup"));
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

test("an in-progress rebase is NOT SAFE, regardless of profile match", () => {
  const summary = run(safeFacts({ inProgressOperation: "rebase" }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "A rebase is in progress" && issue.severity === "blocking"));
});

test("unresolved merge conflicts are NOT SAFE", () => {
  const summary = run(safeFacts({ hasMergeConflicts: true, hasUncommittedChanges: true }));
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Unresolved merge conflicts"));
});

test("ordinary uncommitted changes are only a warning, not a blocker", () => {
  const summary = run(safeFacts({ hasUncommittedChanges: true, hasMergeConflicts: false }));
  assert.equal(summary.level, "safe");
  assert.ok(
    summary.issues.some((issue) => issue.title === "Uncommitted changes present" && issue.severity === "warning"),
  );
});

test("an untrusted workspace is NOT SAFE and blocks agent operation", () => {
  const summary = run(safeFacts(), defaultPreferences, false);
  assert.equal(summary.level, "not_safe");
  assert.ok(summary.issues.some((issue) => issue.title === "Workspace is not trusted"));
});

test("a trusted workspace (default) produces no workspace-trust issue", () => {
  const summary = run(safeFacts());
  assert.ok(!summary.issues.some((issue) => issue.title === "Workspace is not trusted"));
});

test("Agent Guard reports not safe for AI whenever anything else is blocking", () => {
  const summary = run(safeFacts({ currentBranch: "main" }));
  assert.ok(summary.issues.some((issue) => issue.title === "Not safe for AI agent"));
});

test("Shield Mode is always shown as not-yet-built info, with no toggle behind it", () => {
  const summary = run(safeFacts());
  const issue = summary.issues.find((i) => i.title === "Shield Mode is not built yet");
  assert.ok(issue);
  assert.equal(issue!.severity, "info");
});

test("strict local identity mode flags identity that is only safe via global config", () => {
  const summary = run(
    safeFacts({ localGitName: undefined, localGitEmail: undefined }),
    { requireLocalIdentity: true, includeMemoryInAiContext: false },
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
