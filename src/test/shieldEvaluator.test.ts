import assert from "node:assert/strict";
import test from "node:test";
import {
  CommitEvalFacts,
  PushEvalFacts,
  evaluateCommit,
  evaluateFromPolicyLoad,
  evaluatePush,
} from "../shield/evaluator";
import { ShieldPolicy, buildShieldPolicy, validateShieldPolicy } from "../shield/policy";
import { Profile } from "../types";

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  expectedBranchPatterns: ["feature/*"],
  strictPushSetup: true,
  trustedSshHostAliases: ["github-work"],
};

function policy(overrides: Partial<Parameters<typeof buildShieldPolicy>[0]> = {}): ShieldPolicy {
  return buildShieldPolicy({
    profile: workProfile,
    approvedRepositoryKey: "github.com/acmesoftware/acme-frontend",
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
    protectedBranches: ["main", "master"],
    enabledActions: ["commit", "push"],
    now: 1,
    ...overrides,
  });
}

function commitFacts(overrides: Partial<CommitEvalFacts> = {}): CommitEvalFacts {
  return {
    effectiveAuthorName: "Danish Irfan",
    effectiveAuthorEmail: "work@example.com",
    effectiveCommitterName: "Danish Irfan",
    effectiveCommitterEmail: "work@example.com",
    configuredName: "Danish Irfan",
    configuredEmail: "work@example.com",
    isDetachedHead: false,
    currentBranch: "feature/login",
    hasMergeConflicts: false,
    ...overrides,
  };
}

// ---------------- commit: allow path ----------------

test("evaluateCommit allows a fully matching commit with no reasons", () => {
  const decision = evaluateCommit(policy(), commitFacts());
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
});

test("evaluateCommit allows when the 'commit' action is not in enabledActions, regardless of Git state", () => {
  const decision = evaluateCommit(
    policy({ enabledActions: ["push"] }),
    commitFacts({ isDetachedHead: true, currentBranch: undefined }),
  );
  assert.equal(decision.allowed, true);
});

test("ordinary dirty working tree state alone (no conflicts, no in-progress op) does not block", () => {
  // hasMergeConflicts: false and no inProgressOperation already models an
  // ordinary dirty tree — there is deliberately no "hasUncommittedChanges"
  // input to this evaluator at all, since it must never be a block reason.
  const decision = evaluateCommit(policy(), commitFacts());
  assert.equal(decision.allowed, true);
});

test("branch-pattern mismatch alone does not block — it stays a non-blocking warning in the main engine and Shield must not silently upgrade it", () => {
  // "chore/x" does not match the profile's expectedBranchPatterns
  // ("feature/*"), but is not itself a protected branch.
  const decision = evaluateCommit(policy(), commitFacts({ currentBranch: "chore/x" }));
  assert.equal(decision.allowed, true);
});

// ---------------- commit: blocking reasons ----------------

test("evaluateCommit blocks on inspection failure and reports ONLY that reason", () => {
  const decision = evaluateCommit(
    policy(),
    commitFacts({ inspectionError: "git status failed: exit code 128", isDetachedHead: true }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasons.length, 1);
  assert.equal(decision.reasons[0].id, "inspection-failed");
});

test("evaluateCommit blocks on effective identity mismatch when configured identity ALSO doesn't match", () => {
  const decision = evaluateCommit(
    policy(),
    commitFacts({
      effectiveAuthorEmail: "personal@example.com",
      configuredEmail: "personal@example.com",
    }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "commit-identity-mismatch"));
  assert.ok(!decision.reasons.some((r) => r.id === "commit-identity-override"));
});

test("evaluateCommit reports commit-identity-override (not -mismatch) when configured identity is correct but effective identity is overridden", () => {
  const decision = evaluateCommit(
    policy(),
    commitFacts({
      effectiveAuthorEmail: "personal@example.com",
      configuredName: "Danish Irfan",
      configuredEmail: "work@example.com", // config matches the profile
    }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "commit-identity-override"));
  assert.ok(!decision.reasons.some((r) => r.id === "commit-identity-mismatch"));
});

test("evaluateCommit checks committer identity independently of author identity", () => {
  const decision = evaluateCommit(
    policy(),
    commitFacts({
      effectiveCommitterEmail: "someone-else@example.com",
      configuredEmail: "someone-else@example.com",
    }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "commit-identity-mismatch"));
});

test("evaluateCommit ignores expectedGitName when the profile leaves it unset", () => {
  const looseProfile: Profile = { ...workProfile, gitName: undefined };
  const decision = evaluateCommit(
    policy({ profile: looseProfile }),
    commitFacts({ effectiveAuthorName: "Some Other Name" }),
  );
  assert.equal(decision.allowed, true);
});

test("evaluateCommit blocks on detached HEAD", () => {
  const decision = evaluateCommit(policy(), commitFacts({ isDetachedHead: true, currentBranch: undefined }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "detached-head"));
});

test("evaluateCommit blocks on a protected branch (case-insensitive exact match)", () => {
  const decision = evaluateCommit(policy(), commitFacts({ currentBranch: "MAIN" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "protected-branch"));
});

test("evaluateCommit blocks on an in-progress operation", () => {
  const decision = evaluateCommit(policy(), commitFacts({ inProgressOperation: "rebase" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "repo-operation-in-progress"));
  assert.match(decision.reasons.find((r) => r.id === "repo-operation-in-progress")!.message, /rebase/);
});

test("evaluateCommit blocks on unresolved merge conflicts", () => {
  const decision = evaluateCommit(policy(), commitFacts({ hasMergeConflicts: true }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "merge-conflicts"));
});

test("evaluateCommit reports every applicable reason at once, not just the first", () => {
  const decision = evaluateCommit(
    policy(),
    commitFacts({
      effectiveAuthorEmail: "wrong@example.com",
      configuredEmail: "wrong@example.com",
      currentBranch: "main",
      inProgressOperation: "merge",
      hasMergeConflicts: true,
    }),
  );
  assert.equal(decision.allowed, false);
  const ids = decision.reasons.map((r) => r.id).sort();
  assert.deepEqual(ids, ["commit-identity-mismatch", "merge-conflicts", "protected-branch", "repo-operation-in-progress"].sort());
});

// ---------------- push ----------------

function pushFacts(overrides: Partial<PushEvalFacts> = {}): PushEvalFacts {
  return {
    remoteName: "origin",
    remoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git",
    sshCommandOverrides: [],
    ...overrides,
  };
}

test("evaluatePush allows a push through a trusted SSH alias to the approved destination", () => {
  const decision = evaluatePush(policy(), pushFacts());
  assert.equal(decision.allowed, true);
});

test("evaluatePush allows when 'push' is not in enabledActions", () => {
  const decision = evaluatePush(policy({ enabledActions: ["commit"] }), pushFacts({ remoteUrl: "https://github.com/x/y.git" }));
  assert.equal(decision.allowed, true);
});

test("evaluatePush uses the ACTUAL action-time remote URL, not a value predicted earlier — a different owner is caught as a destination mismatch", () => {
  const decision = evaluatePush(policy(), pushFacts({ remoteUrl: "git@github-work:SomeoneElse/other-repo.git" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-destination-mismatch"));
});

test("evaluatePush: HTTPS is always unverified; blocking follows strictPushSetup", () => {
  const strictDecision = evaluatePush(
    policy(),
    pushFacts({ remoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git" }),
  );
  assert.equal(strictDecision.allowed, false);
  assert.ok(strictDecision.reasons.some((r) => r.id === "push-route-unverified"));

  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const relaxedDecision = evaluatePush(
    policy({ profile: relaxedProfile }),
    pushFacts({ remoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git" }),
  );
  assert.equal(relaxedDecision.allowed, true);
});

test("evaluatePush: a generic SSH host is unverified even though it's SSH", () => {
  const decision = evaluatePush(policy(), pushFacts({ remoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-route-unverified"));
});

test("evaluatePush: a dedicated-looking SSH alias not listed in trustedSshHostAliases is still unverified — never auto-trusted", () => {
  const profileNoAliases: Profile = { ...workProfile, trustedSshHostAliases: [] };
  const decision = evaluatePush(policy({ profile: profileNoAliases }), pushFacts({ remoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git" }));
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-route-unverified"));
});

test("evaluatePush: a push-destination mismatch always blocks, regardless of strictPushSetup", () => {
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const decision = evaluatePush(
    policy({ profile: relaxedProfile }),
    pushFacts({ remoteUrl: "git@github-work:SomeoneElse/other-repo.git" }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-destination-mismatch"));
});

test("evaluatePush fails closed with push-destination-mismatch when the policy never recorded an approved destination (Phase 4: ambiguity blocks, never guesses safe)", () => {
  const decision = evaluatePush(policy({ approvedPushDestination: undefined }), pushFacts());
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-destination-mismatch"));
});

test("evaluatePush never claims cryptographic account verification in any reason message", () => {
  const scenarios: PushEvalFacts[] = [
    pushFacts({ remoteUrl: "https://github.com/AcmeSoftware/acme-frontend.git" }),
    pushFacts({ remoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git" }),
    pushFacts({ remoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git" }),
    pushFacts({ remoteUrl: "not a url at all" }),
  ];
  for (const facts of scenarios) {
    const decision = evaluatePush(policy(), facts);
    const text = decision.reasons.map((r) => r.message).join(" ");
    assert.doesNotMatch(text, /verified account|verified key|cryptographically verif/i);
  }
});

// ---------------- push: GitHub account verification (Phase 5) ----------------

function workProfileWithLogin(overrides: Partial<Profile> = {}): Profile {
  return { ...workProfile, expectedGitHubLogin: "danish-work", ...overrides };
}

test("evaluatePush: no expectedGitHubLogin means Shield never asserts anything about WHO authenticated (Phase 0-4 behavior unchanged)", () => {
  const decision = evaluatePush(policy(), pushFacts({ githubAccountCheck: { kind: "authenticated-user", login: "someone-else" } }));
  assert.equal(decision.allowed, true);
});

test("evaluatePush: expectedGitHubLogin set, authenticated login matches -> allowed", () => {
  const decision = evaluatePush(
    policy({ profile: workProfileWithLogin() }),
    pushFacts({ githubAccountCheck: { kind: "authenticated-user", login: "danish-work" } }),
  );
  assert.equal(decision.allowed, true);
});

test("evaluatePush: expectedGitHubLogin set, matches case-insensitively", () => {
  const decision = evaluatePush(
    policy({ profile: workProfileWithLogin() }),
    pushFacts({ githubAccountCheck: { kind: "authenticated-user", login: "Danish-Work" } }),
  );
  assert.equal(decision.allowed, true);
});

test("evaluatePush: expectedGitHubLogin set, authenticated as the wrong account -> push-account-mismatch, names both accounts", () => {
  const decision = evaluatePush(
    policy({ profile: workProfileWithLogin() }),
    pushFacts({ githubAccountCheck: { kind: "authenticated-user", login: "danish-personal" } }),
  );
  assert.equal(decision.allowed, false);
  const reason = decision.reasons.find((r) => r.id === "push-account-mismatch");
  assert.ok(reason);
  assert.match(reason!.message, /danish-work/);
  assert.match(reason!.message, /danish-personal/);
});

test("evaluatePush: verification never attempted (required but missing) -> push-account-unverified, never an implicit pass", () => {
  const decision = evaluatePush(policy({ profile: workProfileWithLogin() }), pushFacts());
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-account-unverified"));
});

test("evaluatePush: deploy-key-style identity can never be compared to a personal login -> unverified, never guessed", () => {
  const decision = evaluatePush(
    policy({ profile: workProfileWithLogin() }),
    pushFacts({ githubAccountCheck: { kind: "authenticated-deploy-key", identity: "AcmeSoftware/acme-frontend" } }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-account-unverified"));
});

test("evaluatePush: permission-denied/host-key-unverified/timeout/identities-not-isolated/malformed all block as push-account-unverified", () => {
  const outcomes: PushEvalFacts["githubAccountCheck"][] = [
    { kind: "permission-denied" },
    { kind: "host-key-unverified" },
    { kind: "timeout" },
    { kind: "identities-not-isolated" },
    { kind: "malformed", raw: "garbage" },
  ];
  for (const githubAccountCheck of outcomes) {
    const decision = evaluatePush(policy({ profile: workProfileWithLogin() }), pushFacts({ githubAccountCheck }));
    assert.equal(decision.allowed, false, `outcome ${JSON.stringify(githubAccountCheck)} should block`);
    assert.ok(decision.reasons.some((r) => r.id === "push-account-unverified"));
  }
});

test("evaluatePush: account verification is strict-only — a non-strict profile never checks expectedGitHubLogin", () => {
  const relaxedProfile = workProfileWithLogin({ strictPushSetup: false });
  const decision = evaluatePush(policy({ profile: relaxedProfile }), pushFacts());
  assert.equal(decision.allowed, true);
});

test("evaluatePush: account verification never runs (and never duplicates) when the route itself is already untrusted", () => {
  const decision = evaluatePush(
    policy({ profile: workProfileWithLogin() }),
    pushFacts({ remoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git" }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.id === "push-route-unverified"));
  assert.ok(!decision.reasons.some((r) => r.id === "push-account-mismatch" || r.id === "push-account-unverified"));
});

// ---------------- evaluateFromPolicyLoad ----------------

test("evaluateFromPolicyLoad denies with policy-missing when no policy file was found, without touching Git state", () => {
  const decision = evaluateFromPolicyLoad("commit", { found: false }, commitFacts({ isDetachedHead: true }));
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons.map((r) => r.id), ["policy-missing"]);
});

test("evaluateFromPolicyLoad denies with policy-corrupt when the policy fails validation", () => {
  const invalid = validateShieldPolicy({ policyVersion: 999 });
  assert.equal(invalid.ok, false);
  const decision = evaluateFromPolicyLoad("commit", { found: true, ...invalid }, commitFacts());
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons.map((r) => r.id), ["policy-corrupt"]);
});

test("evaluateFromPolicyLoad delegates to evaluateCommit/evaluatePush once the policy is valid", () => {
  const valid = validateShieldPolicy(policy());
  assert.equal(valid.ok, true);
  const allowed = evaluateFromPolicyLoad("commit", { found: true, ...valid }, commitFacts());
  assert.equal(allowed.allowed, true);

  const denied = evaluateFromPolicyLoad("commit", { found: true, ...valid }, commitFacts({ isDetachedHead: true, currentBranch: undefined }));
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasons[0].id, "detached-head");
});
