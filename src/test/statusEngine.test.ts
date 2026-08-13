import assert from "node:assert/strict";
import test from "node:test";
import { computeStatus } from "../core/statusEngine";
import { Capability, Profile, RepoFacts, SafetyPreferences } from "../types";

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

const ALL_CAPABILITIES: Capability[] = [
  "commit_identity",
  "push_destination",
  "push_account",
  "branch_policy",
  "repo_operation_state",
  "workspace_trust",
];

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

test("non-Git folders are NOT CHECKED, never SAFE or NOT SAFE, with no capability results", () => {
  const summary = computeStatus({
    facts: { isGitRepo: false },
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_checked");
  assert.equal(summary.capabilityResults.length, 0);
  assert.equal(summary.infoNotes.length, 0);
});

test("a Git repo always produces exactly one result per capability, every scan", () => {
  const summary = run(safeFacts());
  assert.equal(summary.capabilityResults.length, ALL_CAPABILITIES.length);
  const capabilities = summary.capabilityResults.map((r) => r.capability).sort();
  assert.deepEqual(capabilities, [...ALL_CAPABILITIES].sort());
});

test("a fully matching repo is SAFE, with every capability confirmed", () => {
  const summary = run(safeFacts());
  assert.equal(summary.level, "safe");
  assert.equal(summary.matchedProfile?.id, "work");
  for (const result of summary.capabilityResults) {
    assert.equal(result.state, "confirmed", `expected ${result.capability} to be confirmed, got ${result.state}`);
    assert.equal(result.blocksOverallSafety, false);
  }
});

test("wrong config (local identity itself is wrong) is NOT SAFE with the ordinary fixable result", () => {
  // Both configured (local) and effective identity are wrong — an ordinary
  // config problem, fixable by writing config.
  const summary = run(
    safeFacts({ effectiveGitEmail: "personal@example.com", localGitEmail: "personal@example.com" }),
  );
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Wrong commit identity");
  assert.equal(result?.state, "contradicted");
  assert.equal(result?.blocksOverallSafety, true);
  assert.equal(result?.suggestedActionCommand, "fixCommitIdentity");
  assert.match(result?.whatWeFound ?? "", /Author:/);
});

test("wrong config (committer) is NOT SAFE with the ordinary fixable result", () => {
  const summary = run(
    safeFacts({
      effectiveCommitterName: "Someone Else",
      effectiveCommitterEmail: "someone@example.com",
      localGitName: "Someone Else",
      localGitEmail: "someone@example.com",
    }),
  );
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Wrong commit identity");
  assert.match(result?.whatWeFound ?? "", /Committer:/);
  assert.doesNotMatch(result?.whatWeFound ?? "", /Author:/);
});

test("effective author mismatch with config already correct is an environment-override result, not the ordinary fixable one", () => {
  // Local config matches the profile; only the *effective* identity
  // (which includes GIT_AUTHOR_EMAIL-style env overrides) differs. Fix
  // Commit Identity writing config again would not change this, so it
  // must not be offered as a config-writing fix.
  const summary = run(safeFacts({ effectiveGitEmail: "personal@example.com" }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Commit identity overridden by the environment");
  assert.equal(result?.state, "contradicted");
  assert.equal(result?.blocksOverallSafety, true);
  assert.equal(result?.suggestedActionCommand, undefined);
  assert.match(result?.whatWeFound ?? "", /Author:/);
});

test("effective committer mismatch with config already correct is also an environment-override result", () => {
  const summary = run(
    safeFacts({ effectiveCommitterName: "Someone Else", effectiveCommitterEmail: "someone@example.com" }),
  );
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Commit identity overridden by the environment");
  assert.match(result?.whatWeFound ?? "", /Committer:/);
  assert.doesNotMatch(result?.whatWeFound ?? "", /Author:/);
});

test("an unmatched/unknown profile is NOT SAFE and unverified", () => {
  const summary = run(safeFacts({ remoteOwner: "someone-else" }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Repo profile is unknown");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.blocksOverallSafety, true);
});

test("dependent capabilities are not_applicable when no profile is resolved", () => {
  const summary = run(safeFacts({ remoteOwner: "someone-else" }));
  const pushDestination = summary.capabilityResults.find((r) => r.capability === "push_destination");
  const pushAccount = summary.capabilityResults.find((r) => r.capability === "push_account");
  const branchPolicy = summary.capabilityResults.find((r) => r.capability === "branch_policy");
  assert.equal(pushDestination?.state, "not_applicable");
  assert.equal(pushAccount?.state, "not_applicable");
  assert.equal(branchPolicy?.state, "not_applicable");
  // not_applicable never blocks, even though overall status is still NOT SAFE via commit_identity.
  assert.equal(pushDestination?.blocksOverallSafety, false);
  assert.equal(pushAccount?.blocksOverallSafety, false);
  assert.equal(branchPolicy?.blocksOverallSafety, false);
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
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Origin and upstream imply different profiles");
  assert.equal(result?.state, "contradicted");
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
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.notEqual(result?.title, "Origin and upstream imply different profiles");
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
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Multiple profiles match this repo");
  assert.equal(result?.state, "contradicted");
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
  const result = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(result?.title, "Push destination is not verified");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.blocksOverallSafety, true);
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
  const result = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(result?.title, "Push destination does not match Work");
  assert.equal(result?.state, "contradicted");
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
  const result = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(result?.state, "confirmed");
});

test("push account is unverified over HTTPS; blocksOverallSafety follows strict push setup, state does not", () => {
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
  const relaxedResult = relaxed.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(relaxedResult?.title, "Push account is unverified");
  assert.equal(relaxedResult?.state, "unverified");
  assert.equal(relaxedResult?.blocksOverallSafety, false);

  const strict = computeStatus({
    facts: httpsFacts,
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(strict.level, "not_safe");
  const strictResult = strict.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(strictResult?.title, "Push account is unverified");
  assert.equal(strictResult?.state, "unverified");
  assert.equal(strictResult?.blocksOverallSafety, true);
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
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.title, "Push account is unverified");
});

test("a dedicated SSH host alias produces a confirmed push account result", () => {
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true };
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "safe");
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.state, "confirmed");
});

test("working directly on a protected branch is NOT SAFE with agent restrictions", () => {
  const summary = run(safeFacts({ currentBranch: "main" }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "branch_policy");
  assert.equal(result?.title, "Working directly on main");
  assert.equal(result?.state, "contradicted");
  assert.ok(result?.agentRestrictions?.some((r) => r.id === "no-commit"));
});

test("detached HEAD is NOT SAFE regardless of profile resolution", () => {
  const summary = run(safeFacts({ currentBranch: undefined, isDetachedHead: true }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "branch_policy");
  assert.equal(result?.title, "Working in detached HEAD");
});

test("an in-progress rebase is NOT SAFE with no-commit/no-branch-switch restrictions", () => {
  const summary = run(safeFacts({ inProgressOperation: "rebase" }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "repo_operation_state");
  assert.equal(result?.title, "A rebase is in progress");
  assert.equal(result?.blocksOverallSafety, true);
  const restrictionIds = (result?.agentRestrictions ?? []).map((r) => r.id);
  assert.ok(restrictionIds.includes("no-commit"));
  assert.ok(restrictionIds.includes("no-branch-switch"));
});

test("unresolved merge conflicts are NOT SAFE", () => {
  const summary = run(safeFacts({ hasMergeConflicts: true, hasUncommittedChanges: true }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "repo_operation_state");
  assert.equal(result?.title, "Unresolved merge conflicts");
});

test("a failed Git inspection is NOT SAFE and unverified, not silently treated as clean", () => {
  const summary = run(safeFacts({ gitError: "fatal: unable to read some refs" }));
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "repo_operation_state");
  assert.equal(result?.title, "Could not fully inspect this repository");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.blocksOverallSafety, true);
});

test("ordinary uncommitted changes are only a warning with a preserve-changes restriction, not a blocker", () => {
  const summary = run(safeFacts({ hasUncommittedChanges: true, hasMergeConflicts: false }));
  assert.equal(summary.level, "safe");
  const result = summary.capabilityResults.find((r) => r.capability === "repo_operation_state");
  assert.equal(result?.title, "Uncommitted changes present");
  assert.equal(result?.state, "warning");
  assert.equal(result?.blocksOverallSafety, false);
  assert.ok(result?.agentRestrictions?.some((r) => r.id === "preserve-changes"));
});

test("an untrusted workspace is NOT SAFE and blocks agent operation", () => {
  const summary = run(safeFacts(), defaultPreferences, false);
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "workspace_trust");
  assert.equal(result?.title, "Workspace is not trusted");
  assert.equal(result?.state, "contradicted");
  assert.equal(result?.blocksOverallSafety, true);
});

test("a trusted workspace (default) produces a confirmed workspace-trust result", () => {
  const summary = run(safeFacts());
  const result = summary.capabilityResults.find((r) => r.capability === "workspace_trust");
  assert.equal(result?.state, "confirmed");
});

test("Shield Mode is always shown as an info note, never a capability result", () => {
  const summary = run(safeFacts());
  const note = summary.infoNotes.find((n) => n.title === "Shield Mode is not built yet");
  assert.ok(note);
  assert.equal(note?.category, "agent_guard_meta");
  assert.ok(!summary.capabilityResults.some((r) => r.title === "Shield Mode is not built yet"));
});

test("strict local identity mode flags identity that is only safe via global config, as a non-blocking warning", () => {
  const summary = run(
    safeFacts({ localGitName: undefined, localGitEmail: undefined }),
    { requireLocalIdentity: true, includeMemoryInAiContext: false },
  );
  assert.equal(summary.level, "safe");
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Repo is not locked to Work identity");
  assert.equal(result?.state, "warning");
  assert.equal(result?.blocksOverallSafety, false);
});

test("strict local identity mode recognizes a worktree-scoped override, not just --local", () => {
  // Fix Commit Identity may have written --worktree instead of --local
  // (see resolveIdentityConfigScope) — the strict check must not keep
  // reporting "not locked" after that succeeds.
  const summary = run(
    safeFacts({ localGitName: undefined, localGitEmail: undefined, worktreeGitName: "Danish Irfan", worktreeGitEmail: "work@example.com" }),
    { requireLocalIdentity: true, includeMemoryInAiContext: false },
  );
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.state, "confirmed");
});

test("strict local identity mode still flags a mismatched worktree-scoped override", () => {
  const summary = run(
    safeFacts({ localGitName: undefined, localGitEmail: undefined, worktreeGitName: "Someone Else", worktreeGitEmail: "someone@example.com" }),
    { requireLocalIdentity: true, includeMemoryInAiContext: false },
  );
  const result = summary.capabilityResults.find((r) => r.capability === "commit_identity");
  assert.equal(result?.title, "Repo is not locked to Work identity");
  assert.equal(result?.state, "warning");
});

test("missing pinned memory produces an info note, not a capability result", () => {
  const summary = computeStatus({
    facts: safeFacts(),
    profiles: [workProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "safe");
  const note = summary.infoNotes.find((n) => n.title === "No pinned repo memory");
  assert.ok(note);
  assert.equal(note?.category, "repo_memory");
});

test("issueCount excludes confirmed and not_applicable results", () => {
  const summary = run(safeFacts());
  assert.equal(summary.issueCount, 0);

  const withProblems = run(safeFacts({ currentBranch: "main", hasUncommittedChanges: true }));
  // branch_policy (contradicted) + repo_operation_state (warning) = 2
  assert.equal(withProblems.issueCount, 2);
});

test("nextFix prefers a blocking result over a warning", () => {
  const summary = run(
    safeFacts({ currentBranch: "main", hasUncommittedChanges: true }),
  );
  assert.equal(summary.nextFix?.blocksOverallSafety, true);
});
