import assert from "node:assert/strict";
import test from "node:test";
import { CommitEvalFacts, PushEvalFacts, evaluateCommit, evaluateFromPolicyLoad, evaluatePush } from "../shield/evaluator";
import { validateShieldPolicy } from "../shield/policy";
import { WORK_IDENTITY, WORK_IDENTITY_WITH_LOGIN, identityWith, testPolicy } from "./testUtil/lockFixtures";

/**
 * The pure TypeScript reference for the identity lock's decisions. The
 * shipped shell evaluator is held to these same semantics by the
 * differential suites.
 */

function commitFacts(overrides: Partial<CommitEvalFacts> = {}): CommitEvalFacts {
  return {
    effectiveAuthorName: "Danish Irfan",
    effectiveAuthorEmail: "work@example.com",
    effectiveCommitterName: "Danish Irfan",
    effectiveCommitterEmail: "work@example.com",
    configuredName: "Danish Irfan",
    configuredEmail: "work@example.com",
    ...overrides,
  };
}

// ==================== commit ====================

test("evaluateCommit allows a commit whose effective author AND committer are the assigned identity", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts());
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
});

test("evaluateCommit has no branch, detached-HEAD, merge/rebase or conflict inputs at all — the lock only answers 'is this the assigned identity?'", () => {
  // Structural guarantee: CommitEvalFacts carries identity facts only. A
  // stray legacy field is simply ignored, never consulted.
  const legacyShaped = { ...commitFacts(), isDetachedHead: true, currentBranch: "main", inProgressOperation: "rebase", hasMergeConflicts: true } as CommitEvalFacts;
  assert.equal(evaluateCommit(testPolicy(), legacyShaped).allowed, true);
});

test("evaluateCommit blocks on inspection failure and reports ONLY that reason", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts({ inspectionError: "git var failed", effectiveAuthorEmail: "x@y" }));
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons.map((r) => r.id), ["inspection-failed"]);
});

test("a wrong configured email -> commit-identity-mismatch naming the identity and expected email", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts({ effectiveAuthorEmail: "personal@example.com", effectiveCommitterEmail: "personal@example.com", configuredEmail: "personal@example.com" }));
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons.map((r) => r.id), ["commit-identity-mismatch"]);
  assert.match(decision.reasons[0].message, /Work/);
  assert.match(decision.reasons[0].message, /work@example\.com/);
  assert.match(decision.reasons[0].message, /personal@example\.com/);
});

test("a wrong configured name (when the identity sets gitName) -> commit-identity-mismatch", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts({ effectiveAuthorName: "Someone Else", effectiveCommitterName: "Someone Else", configuredName: "Someone Else" }));
  assert.deepEqual(decision.reasons.map((r) => r.id), ["commit-identity-mismatch"]);
});

test("config correct but effective identity overridden (env / -c / --author) -> commit-identity-override, not -mismatch", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts({ effectiveAuthorEmail: "personal@example.com" }));
  assert.deepEqual(decision.reasons.map((r) => r.id), ["commit-identity-override"]);
});

test("committer identity is checked independently of author identity", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts({ effectiveCommitterEmail: "someone-else@example.com", configuredEmail: "someone-else@example.com" }));
  assert.deepEqual(decision.reasons.map((r) => r.id), ["commit-identity-mismatch"]);
  assert.match(decision.reasons[0].message, /committer/);
});

test("an identity without gitName enforces only the email", () => {
  const decision = evaluateCommit(testPolicy(identityWith({ gitName: undefined })), commitFacts({ effectiveAuthorName: "Some Other Name" }));
  assert.equal(decision.allowed, true);
});

test("identity comparison ignores case and surrounding whitespace (Git strips ident whitespace)", () => {
  const decision = evaluateCommit(testPolicy(), commitFacts({ effectiveAuthorEmail: "WORK@Example.com", effectiveAuthorName: "  danish irfan " }));
  assert.equal(decision.allowed, true);
});

// ==================== push ====================

function pushFacts(overrides: Partial<PushEvalFacts> = {}): PushEvalFacts {
  return { remoteName: "origin", remoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git", sshCommandOverrides: [], ...overrides };
}

test("a commit-only lock (identity without expectedGitHubLogin) never blocks a push — whatever the route", () => {
  for (const remoteUrl of ["https://github.com/x/y.git", "git@github.com:x/y.git", "git@unknown-alias:x/y.git", "not a url"]) {
    assert.equal(evaluatePush(testPolicy(WORK_IDENTITY), pushFacts({ remoteUrl })).allowed, true, remoteUrl);
  }
});

test("there is no push-destination policy: pushing to ANY repository is allowed when the account is the assigned one", () => {
  const verified = { githubAccountCheck: { kind: "authenticated-user" as const, login: "danish-work" } };
  for (const remoteUrl of ["git@github-work:AcmeSoftware/acme-frontend.git", "git@github-work:SomeoneElse/other-repo.git", "ssh://git@github-work/fork/x.git"]) {
    const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ remoteUrl, ...verified }));
    assert.equal(decision.allowed, true, remoteUrl);
  }
});

test("expected account authenticated -> allowed (case-insensitive)", () => {
  for (const login of ["danish-work", "Danish-Work"]) {
    assert.equal(evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ githubAccountCheck: { kind: "authenticated-user", login } })).allowed, true);
  }
});

test("a different authenticated account -> push-account-mismatch naming both accounts", () => {
  const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ githubAccountCheck: { kind: "authenticated-user", login: "danish-personal" } }));
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons.map((r) => r.id), ["push-account-mismatch"]);
  assert.match(decision.reasons[0].message, /danish-work/);
  assert.match(decision.reasons[0].message, /danish-personal/);
});

test("verification required but never run -> push-account-unverified, never an implicit pass", () => {
  const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts());
  assert.deepEqual(decision.reasons.map((r) => r.id), ["push-account-unverified"]);
});

test("every unverifiable probe outcome blocks as push-account-unverified (incl. an alias repointed away from GitHub)", () => {
  const outcomes: NonNullable<PushEvalFacts["githubAccountCheck"]>[] = [
    { kind: "authenticated-deploy-key", identity: "AcmeSoftware/acme-frontend" },
    { kind: "permission-denied" },
    { kind: "host-key-unverified" },
    { kind: "timeout" },
    { kind: "identities-not-isolated" },
    { kind: "route-not-github", hostname: "evil.example", port: "22" },
    { kind: "route-unresolvable" },
    { kind: "malformed", raw: "garbage" },
  ];
  for (const githubAccountCheck of outcomes) {
    const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ githubAccountCheck }));
    assert.deepEqual(decision.reasons.map((r) => r.id), ["push-account-unverified"], JSON.stringify(githubAccountCheck));
  }
});

test("routes that cannot carry account evidence are blocked BEFORE any account check: HTTPS, generic hosts, untrusted aliases, unknown protocols", () => {
  const cases: Array<[string, string]> = [
    ["https://github.com/AcmeSoftware/acme-frontend.git", "push-route-unverified"],
    ["git@github.com:AcmeSoftware/acme-frontend.git", "push-route-unverified"],
    ["git@gitlab.com:AcmeSoftware/acme-frontend.git", "push-route-unverified"],
    ["git@github-personal:AcmeSoftware/acme-frontend.git", "push-route-unverified"],
    ["not a url at all", "push-route-unverified"],
  ];
  for (const [remoteUrl, id] of cases) {
    // Even a (hypothetical) matching account result cannot rescue an untrusted route.
    const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ remoteUrl, githubAccountCheck: { kind: "authenticated-user", login: "danish-work" } }));
    assert.deepEqual(decision.reasons.map((r) => r.id), [id], remoteUrl);
  }
});

test("an identity with a GitHub login but no trusted alias can never verify a push — every SSH route is unverified", () => {
  const decision = evaluatePush(testPolicy(identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: [] })), pushFacts({ githubAccountCheck: { kind: "authenticated-user", login: "danish-work" } }));
  assert.deepEqual(decision.reasons.map((r) => r.id), ["push-route-unverified"]);
});

test("an SSH transport override makes the route unprovable -> push-route-override, even through a trusted alias with a matching account result", () => {
  for (const sshCommandOverrides of [["GIT_SSH"], ["GIT_SSH_COMMAND"], ["core.sshCommand"], ["ssh.variant=plink"]]) {
    const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ sshCommandOverrides, githubAccountCheck: { kind: "authenticated-user", login: "danish-work" } }));
    assert.deepEqual(decision.reasons.map((r) => r.id), ["push-route-override"], sshCommandOverrides.join());
  }
});

test("no reason message ever claims cryptographic verification", () => {
  for (const remoteUrl of ["https://github.com/a/b.git", "git@github.com:a/b.git", "git@github-work:a/b.git", "x"]) {
    const text = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), pushFacts({ remoteUrl })).reasons.map((r) => r.message).join(" ");
    assert.doesNotMatch(text, /verified account|verified key|cryptographically verif/i);
  }
});

// ==================== evaluateFromPolicyLoad ====================

test("evaluateFromPolicyLoad denies with policy-missing when no policy file was found, without touching Git state", () => {
  const decision = evaluateFromPolicyLoad("commit", { found: false }, commitFacts());
  assert.deepEqual(decision.reasons.map((r) => r.id), ["policy-missing"]);
});

test("evaluateFromPolicyLoad denies with policy-corrupt for an invalid or legacy policy", () => {
  for (const raw of [{ policyVersion: 999 }, { policyVersion: 2, matchedProfileId: "work" }]) {
    const invalid = validateShieldPolicy(raw);
    assert.equal(invalid.ok, false);
    const decision = evaluateFromPolicyLoad("push", { found: true, ...invalid }, pushFacts());
    assert.deepEqual(decision.reasons.map((r) => r.id), ["policy-corrupt"]);
  }
});

test("evaluateFromPolicyLoad delegates once the policy is valid", () => {
  const valid = validateShieldPolicy(testPolicy());
  assert.equal(valid.ok, true);
  assert.equal(evaluateFromPolicyLoad("commit", { found: true, ...valid }, commitFacts()).allowed, true);
  const denied = evaluateFromPolicyLoad("commit", { found: true, ...valid }, commitFacts({ effectiveAuthorEmail: "x@example.com", configuredEmail: "x@example.com" }));
  assert.deepEqual(denied.reasons.map((r) => r.id), ["commit-identity-mismatch"]);
});
