import assert from "node:assert/strict";
import test from "node:test";
import type { Identity } from "../identity/types";
import {
  SHIELD_POLICY_VERSION,
  ShieldPolicy,
  buildShieldPolicy,
  enforcedActionsFor,
  parseShieldPolicy,
  readLegacyPolicyInfo,
  serializeShieldPolicy,
  validateShieldPolicy,
} from "../shield/policy";

const workIdentity: Identity = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedGitHubLogin: "danish-work",
  trustedSshHostAliases: ["github-work"],
};

function buildValidPolicy(identity: Identity = workIdentity): ShieldPolicy {
  return buildShieldPolicy({ identity, lockId: "lock-1", assignedAt: 100, now: 12345 });
}

test("buildShieldPolicy (v3) records exactly the assigned identity and the actions it enforces — nothing about branches, destinations or strictness", () => {
  const policy = buildValidPolicy();
  assert.deepEqual(policy, {
    policyVersion: 3,
    lockId: "lock-1",
    assignedAt: 100,
    generatedAt: 12345,
    identityId: "work",
    identityLabel: "Work",
    expectedGitName: "Danish Irfan",
    expectedGitEmail: "work@example.com",
    expectedGitHubLogin: "danish-work",
    trustedSshHostAliases: ["github-work"],
    enforcedActions: ["commit", "push"],
  });
  for (const retired of ["approvedRepositoryKey", "approvedPushDestination", "protectedBranches", "expectedBranchPatterns", "strictPushSetup", "matchedProfileId", "enabledActions"]) {
    assert.ok(!(retired in policy), `${retired} must not exist in a v3 policy`);
  }
});

test("an identity without an expected GitHub login produces a commit-only lock", () => {
  const policy = buildValidPolicy({ id: "p", label: "P", gitEmail: "p@example.com" });
  assert.deepEqual(policy.enforcedActions, ["commit"]);
  assert.deepEqual(policy.trustedSshHostAliases, []);
  assert.equal(policy.expectedGitHubLogin, undefined);
  assert.equal(policy.expectedGitName, undefined);
  assert.deepEqual(enforcedActionsFor({}), ["commit"]);
  assert.deepEqual(enforcedActionsFor({ expectedGitHubLogin: "x" }), ["commit", "push"]);
});

test("a built policy round-trips through validateShieldPolicy and through serialize/parse", () => {
  for (const policy of [buildValidPolicy(), buildValidPolicy({ id: "p", label: "P", gitEmail: "p@example.com" })]) {
    const validated = validateShieldPolicy(policy);
    assert.equal(validated.ok, true);
    if (validated.ok) assert.deepEqual(validated.policy, policy);
    const parsed = parseShieldPolicy(serializeShieldPolicy(policy));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.policy, policy);
  }
});

test("parseShieldPolicy reports malformed JSON as a validation failure, not a thrown exception", () => {
  const result = parseShieldPolicy("{ this is not json");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors[0].message, /not valid JSON/);
});

test("validateShieldPolicy rejects a wrong/future policyVersion instead of guessing", () => {
  const result = validateShieldPolicy({ ...buildValidPolicy(), policyVersion: 999 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.path === "policyVersion"));
});

test("a legacy (v1/v2) Shield policy is never accepted as a lock policy — it is identified as legacy, to be migrated", () => {
  const legacy = {
    policyVersion: 2,
    generatedAt: 1,
    matchedProfileId: "work",
    profileLabel: "Work",
    expectedGitEmail: "work@example.com",
    approvedRepositoryKey: "github.com/acme/repo",
    trustedSshHostAliases: [],
    strictPushSetup: false,
    protectedBranches: ["main"],
    expectedBranchPatterns: [],
    enabledActions: ["commit", "push"],
  };
  const result = validateShieldPolicy(legacy);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.find((e) => e.path === "policyVersion")?.message ?? "", /legacy Shield policy/);
  assert.deepEqual(readLegacyPolicyInfo(JSON.stringify(legacy)), {
    policyVersion: 2,
    matchedProfileId: "work",
    approvedRepositoryKey: "github.com/acme/repo",
  });
  assert.equal(readLegacyPolicyInfo(serializeShieldPolicy(buildValidPolicy())), undefined, "a v3 policy is not legacy");
  assert.equal(readLegacyPolicyInfo("{garbage"), undefined);
  assert.deepEqual(readLegacyPolicyInfo(JSON.stringify({ policyVersion: 1 })), { policyVersion: 1, matchedProfileId: undefined, approvedRepositoryKey: undefined });
});

test("validateShieldPolicy rejects non-object input", () => {
  for (const bad of [null, undefined, 42, "a string", ["array", "not", "object"]]) {
    assert.equal(validateShieldPolicy(bad).ok, false, `expected ${JSON.stringify(bad)} to fail validation`);
  }
});

test("validateShieldPolicy reports every structural problem at once, not just the first", () => {
  const result = validateShieldPolicy({
    policyVersion: SHIELD_POLICY_VERSION,
    trustedSshHostAliases: "not-an-array",
    enforcedActions: ["commit", "rebase"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const paths = result.errors.map((e) => e.path);
    for (const expected of ["lockId", "assignedAt", "generatedAt", "identityId", "identityLabel", "expectedGitEmail", "trustedSshHostAliases", "enforcedActions"]) {
      assert.ok(paths.includes(expected), `missing error for ${expected}: ${paths.join(", ")}`);
    }
  }
});

test("enforcedActions must always include commit, and include push exactly when an expected GitHub login is set", () => {
  const base = buildValidPolicy();
  const cases: Array<[Partial<ShieldPolicy> & Record<string, unknown>, boolean]> = [
    [{ enforcedActions: ["push"] }, false],
    [{ enforcedActions: [] }, false],
    [{ enforcedActions: ["commit"] }, false], // login set, push missing
    [{ enforcedActions: ["commit", "push"], expectedGitHubLogin: undefined }, false], // push claimed, no login
    [{ enforcedActions: ["commit"], expectedGitHubLogin: undefined }, true],
    [{ enforcedActions: ["commit", "push"] }, true],
  ];
  for (const [overrides, ok] of cases) {
    const candidate: Record<string, unknown> = { ...base, ...overrides };
    if ("expectedGitHubLogin" in overrides && overrides.expectedGitHubLogin === undefined) delete candidate.expectedGitHubLogin;
    assert.equal(validateShieldPolicy(candidate).ok, ok, JSON.stringify(overrides));
  }
});

test("validateShieldPolicy rejects a policy carrying a secret-shaped field, even if otherwise well-formed", () => {
  const policy = buildValidPolicy();
  for (const secretKey of ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"]) {
    const result = validateShieldPolicy({ ...policy, [secretKey]: "should never be here" });
    assert.equal(result.ok, false, `expected a policy carrying "${secretKey}" to fail validation`);
    if (!result.ok) assert.ok(result.errors.some((e) => e.path === secretKey));
  }
});

test("serialized policy JSON never contains any of the disallowed secret field names as keys", () => {
  const parsedKeys = Object.keys(JSON.parse(serializeShieldPolicy(buildValidPolicy())));
  for (const secretKey of ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"]) {
    assert.ok(!parsedKeys.includes(secretKey), `serialized policy must never contain "${secretKey}"`);
  }
});
