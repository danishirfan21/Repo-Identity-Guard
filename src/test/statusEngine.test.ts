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
  // safeFacts() below defaults to a "github-work" push remote host; this is
  // the profile explicitly trusting it as a push route (see the
  // trustedSshHostAliases tests further down for the untrusted-alias case).
  trustedSshHostAliases: ["github-work"],
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

// Release-blocker regression: owner/org trust must be host-aware. A push
// destination on an arbitrary, untrusted host must never inherit trust from
// a profile's expectedRemoteOwners pattern just because the owner/repo TEXT
// happens to match — that would let `git@evil.example:AcmeSoftware/backend.git`
// read as a confirmed destination for a profile expecting owner
// "AcmeSoftware", with only the (non-blocking under a relaxed profile)
// push_account check standing between it and an overall SAFE verdict.
test("push destination on an arbitrary host is NOT SAFE even when the owner/repo text matches an expectedRemoteOwners pattern (relaxed strictPushSetup)", () => {
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const summary = computeStatus({
    facts: safeFacts({
      pushRemoteName: "origin",
      pushRemoteUrl: "git@evil.example:AcmeSoftware/backend.git",
      pushRemoteProtocol: "ssh",
      pushRemoteHost: "evil.example",
      pushRemoteOwner: "AcmeSoftware",
      pushRemoteRepo: "backend",
    }),
    profiles: [relaxedProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_safe");
  const destination = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(destination?.state, "contradicted");
  assert.equal(destination?.blocksOverallSafety, true);
  assert.equal(destination?.title, "Push destination does not match Work");
});

test("push destination on a profile's own trusted SSH alias still confirms via owner pattern (legitimate alias unaffected by the host-aware fix)", () => {
  // github-work is listed in workProfile.trustedSshHostAliases — this must
  // keep working exactly as before: a trusted alias host is eligible for
  // owner-pattern matching, only an arbitrary/untrusted host is not.
  const summary = run(safeFacts());
  const destination = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(destination?.state, "confirmed");
});

test("push destination on a well-known generic host (github.com) still confirms via owner pattern", () => {
  const summary = run(
    safeFacts({
      pushRemoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git",
      pushRemoteHost: "github.com",
    }),
  );
  const destination = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(destination?.state, "confirmed");
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

test("a dedicated SSH host alias explicitly listed in the matched profile is a trusted route, not a verified account", () => {
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true, trustedSshHostAliases: ["github-work"] };
  const summary = computeStatus({
    facts: safeFacts({ pushRemoteHost: "github-work" }),
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "safe");
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.state, "confirmed");
  assert.equal(result?.title, "Push route trusted");
  assert.equal(result?.blocksOverallSafety, false);
  assert.match(result?.summary ?? "", /"github-work" is explicitly trusted by the Work profile/);
  assert.doesNotMatch(result?.summary ?? "", /account verified|verified account|verified key|cryptographically verif/i);
});

test("a dedicated-looking SSH alias is NOT auto-trusted just for being non-generic — it must be explicitly listed on the matched profile", () => {
  const profileWithNoAliases: Profile = { ...workProfile, trustedSshHostAliases: [] };
  const summary = computeStatus({
    facts: safeFacts({ pushRemoteHost: "github-work" }),
    profiles: [profileWithNoAliases],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.title, "Push account is unverified");
});

test("an alias trusted only under a different profile (github-personal under Personal) is unverified when evaluated against Work", () => {
  const personalProfile: Profile = {
    id: "personal",
    label: "Personal",
    gitEmail: "personal@example.com",
    expectedRemoteOwners: ["jane-doe"],
    trustedSshHostAliases: ["github-personal"],
  };
  const workProfileNoOverlap: Profile = { ...workProfile, trustedSshHostAliases: ["github-work"] };

  const summary = computeStatus({
    facts: safeFacts({ pushRemoteHost: "github-personal" }),
    profiles: [workProfileNoOverlap, personalProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  // Matched profile here is still Work (owner AcmeSoftware) — github-personal
  // is only trusted under Personal, so it must not be trusted here.
  assert.equal(summary.matchedProfile?.id, "work");
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.title, "Push account is unverified");
  assert.match(result?.whatWeFound ?? "", /github-personal/);
});

test("an untrusted push route blocks overall safety under a strict profile", () => {
  const strictProfile: Profile = { ...workProfile, strictPushSetup: true, trustedSshHostAliases: [] };
  const summary = computeStatus({
    facts: safeFacts({ pushRemoteHost: "github-work" }),
    profiles: [strictProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  assert.equal(summary.level, "not_safe");
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.blocksOverallSafety, true);
});

test("an untrusted push route stays non-blocking under a relaxed (non-strict) profile", () => {
  // A well-known GENERIC host (github.com), not a bespoke SSH alias: this
  // is the case where destination and account are genuinely independent —
  // the owner-pattern destination match is host-eligible (github.com is a
  // recognized generic host), while the *account* authenticating a generic
  // host is still unverifiable regardless. (A bespoke, undeclared alias
  // like "github-work" is deliberately NOT host-eligible for owner-pattern
  // destination matching post-fix — see the host-aware destination tests
  // above — so it no longer doubles as a stand-in for "untrusted but still
  // a confirmed destination" the way it did before that fix.)
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false, trustedSshHostAliases: [] };
  const summary = computeStatus({
    facts: safeFacts({ pushRemoteHost: "github.com", pushRemoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git" }),
    profiles: [relaxedProfile],
    protectedBranches: ["main"],
    preferences: defaultPreferences,
  });
  const destination = summary.capabilityResults.find((r) => r.capability === "push_destination");
  assert.equal(destination?.state, "confirmed");
  const result = summary.capabilityResults.find((r) => r.capability === "push_account");
  assert.equal(result?.state, "unverified");
  assert.equal(result?.blocksOverallSafety, false);
  assert.equal(summary.level, "safe");
});

test("no push_account result, trusted or unverified, ever claims cryptographic account verification", () => {
  const scenarios: RepoFacts[] = [
    safeFacts({ pushRemoteProtocol: "https", pushRemoteHost: "github.com", pushRemoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git" }),
    safeFacts({ pushRemoteProtocol: "unknown", pushRemoteHost: undefined }),
    safeFacts({ pushRemoteHost: "github.com" }),
    safeFacts({ pushRemoteHost: "github-work" }),
  ];
  const profiles = [
    { ...workProfile, trustedSshHostAliases: [] },
    { ...workProfile, trustedSshHostAliases: ["github-work"] },
  ];
  for (const profile of profiles) {
    for (const facts of scenarios) {
      const summary = computeStatus({
        facts,
        profiles: [profile],
        protectedBranches: ["main"],
        preferences: defaultPreferences,
      });
      const result = summary.capabilityResults.find((r) => r.capability === "push_account");
      const text = [result?.title, result?.summary, result?.whyItMatters, result?.whatWeExpected, result?.whatWeFound].join(" ");
      assert.doesNotMatch(text, /account (is |has been )?verified\b/i);
      assert.doesNotMatch(text, /verified account/i);
      assert.doesNotMatch(text, /verified key/i);
      assert.doesNotMatch(text, /cryptographically verif/i);
      assert.doesNotMatch(text, /GitHub account verified/i);
    }
  }
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

test("the safety engine never claims Shield Mode does not exist (Phase 9 — it does, and it enforces)", () => {
  // This used to assert the OPPOSITE: that a static
  // "Shield Mode is not built yet / nothing is enforcing this
  // automatically" note was always present. It was shown unconditionally,
  // including in repositories where Shield was installed and actively
  // blocking commits and pushes — telling the user nothing protected them
  // while something did. The note is gone; this test now guards against it
  // (or anything like it) coming back.
  const summary = run(safeFacts());
  const claims = [
    ...summary.infoNotes.map((n) => `${n.title} ${n.message}`),
    ...summary.capabilityResults.map((r) => `${r.title} ${r.summary} ${r.whyItMatters ?? ""}`),
  ];
  for (const claim of claims) {
    assert.doesNotMatch(claim, /not built yet|coming soon|don't exist yet|do not exist yet|nothing is enforcing/i, claim);
  }
  // The safety engine deliberately makes NO claim about Shield at all —
  // Shield's real state is per-repository and comes from
  // ShieldManager.inspect(), which this pure engine cannot see.
  assert.ok(!summary.infoNotes.some((n) => /shield/i.test(n.title)));
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

// ====================================================================
// Phase 8 — FINDING 4 (second half): one coherent push-destination rule.
//
// Confirmed defect: the rule read
//
//   matchesExactRepo || expectedOwners.length === 0 || ownerPatternMatches
//
// whose middle term is an unconditional `true` for any profile that lists
// `exactRepos` but no `expectedRemoteOwners`. Such a profile reported
// "destination confirmed" for LITERALLY ANY destination -- a repository
// it does not list, under an owner it has never heard of -- and likewise
// confirmed a destination whose owner could not be parsed at all.
//
// The rule now: a profile that declares NO destination constraint
// confirms any resolvable destination; otherwise the destination must
// POSITIVELY match an exactRepos pattern or an owner pattern, and missing
// evidence never counts as a match. Owner-level matching is retained on
// purpose so forks/mirrors under a trusted owner keep working.
// ====================================================================

function pushDestinationState(facts: RepoFacts, profile: Profile) {
  const summary = computeStatus({
    facts,
    profiles: [profile],
    protectedBranches: [],
    preferences: defaultPreferences,
  });
  return summary.capabilityResults.find((r) => r.capability === "push_destination")?.state;
}

test("push destination: a profile listing exactRepos but NO owner patterns must NOT confirm a stranger's repository", () => {
  const exactOnlyProfile: Profile = {
    ...workProfile,
    expectedRemoteOwners: [],
    exactRepos: ["github-work/acmesoftware/acme-frontend"],
  };

  // The listed repo is confirmed...
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "AcmeSoftware", pushRemoteRepo: "acme-frontend" }),
      exactOnlyProfile,
    ),
    "confirmed",
  );

  // ...and an entirely unrelated destination is NOT. This is the case
  // that used to read as "confirmed".
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "TotalStranger", pushRemoteRepo: "some-other-repo" }),
      exactOnlyProfile,
    ),
    "contradicted",
  );

  // Nor is a DIFFERENT repository under the same owner, since this
  // profile constrained itself to exact repositories only.
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "AcmeSoftware", pushRemoteRepo: "not-listed" }),
      exactOnlyProfile,
    ),
    "contradicted",
  );
});

test("push destination: a constrained profile never confirms a destination whose owner could not be parsed", () => {
  const constrained: Profile = { ...workProfile, expectedRemoteOwners: ["AcmeSoftware"] };
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteUrl: "/srv/git/bare.git", pushRemoteHost: undefined, pushRemoteOwner: undefined, pushRemoteRepo: undefined }),
      constrained,
    ),
    "contradicted",
    "missing evidence is never a match",
  );
});

test("push destination: owner-pattern matching still confirms forks and mirrors under a trusted owner (deliberately NOT narrowed)", () => {
  const ownerProfile: Profile = { ...workProfile, expectedRemoteOwners: ["AcmeSoftware"], exactRepos: [] };
  for (const repo of ["acme-frontend", "acme-frontend-fork", "a-brand-new-repo"]) {
    assert.equal(
      pushDestinationState(
        safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "AcmeSoftware", pushRemoteRepo: repo }),
        ownerProfile,
      ),
      "confirmed",
      `${repo} under a trusted owner should stay confirmed`,
    );
  }
});

test("push destination: a wildcard owner pattern still works, and a profile with an exactRepos match under an untrusted owner is still confirmed by that exact listing", () => {
  const wildcard: Profile = { ...workProfile, expectedRemoteOwners: ["Acme*"], exactRepos: [] };
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "AcmeLabs", pushRemoteRepo: "x" }),
      wildcard,
    ),
    "confirmed",
  );

  const both: Profile = {
    ...workProfile,
    expectedRemoteOwners: ["AcmeSoftware"],
    exactRepos: ["github-work/vendorco/shared-lib"],
  };
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "VendorCo", pushRemoteRepo: "shared-lib" }),
      both,
    ),
    "confirmed",
    "an explicitly listed exact repo is confirmed even though its owner is not an owner pattern",
  );
});

test("push destination: a profile that declares NO destination constraint at all can never be MATCHED to a repository in the first place, so the permissive branch is unreachable in practice", () => {
  // Documented consequence of the new rule, worth pinning down: profile
  // resolution itself (resolveProfiles) matches a repository by owner
  // pattern or exact-repo listing, so a profile that declares neither can
  // never become the matched profile -- push destination then reports
  // not_applicable rather than confirming anything. The permissive branch
  // in checkPushDestination therefore exists only so the rule stays total
  // and honest, never as a way for an under-specified profile to wave a
  // destination through.
  const unconstrained: Profile = { ...workProfile, expectedRemoteOwners: [], exactRepos: [] };
  assert.equal(
    pushDestinationState(
      safeFacts({ pushRemoteHost: "github-work", pushRemoteOwner: "AnyoneAtAll", pushRemoteRepo: "anything" }),
      unconstrained,
    ),
    "not_applicable",
  );
});
