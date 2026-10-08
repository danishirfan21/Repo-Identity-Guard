import assert from "node:assert/strict";
import test from "node:test";
import type { Identity } from "../identity/types";
import {
  GOVERNED_ACTIONS,
  SHIELD_POLICY_VERSION,
  ShieldPolicy,
  buildShieldPolicy,
  parseShieldPolicy,
  readLegacyPolicyInfo,
  serializeShieldPolicy,
  upgradePreviousLockPolicy,
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

test("buildShieldPolicy (v4) records exactly the assigned identity — no per-action switch, nothing about branches, destinations or strictness", () => {
  const policy = buildValidPolicy();
  assert.deepEqual(policy, {
    policyVersion: 4,
    lockId: "lock-1",
    assignedAt: 100,
    generatedAt: 12345,
    identityId: "work",
    identityLabel: "Work",
    expectedGitName: "Danish Irfan",
    expectedGitEmail: "work@example.com",
    expectedGitHubLogin: "danish-work",
    trustedSshHostAliases: ["github-work"],
  });
  for (const retired of [
    "enforcedActions",
    "approvedRepositoryKey",
    "approvedPushDestination",
    "protectedBranches",
    "expectedBranchPatterns",
    "strictPushSetup",
    "matchedProfileId",
    "enabledActions",
  ]) {
    assert.ok(!(retired in policy), `${retired} must not exist in a v4 policy`);
  }
  assert.deepEqual([...GOVERNED_ACTIONS], ["commit", "push"], "every lock governs both actions");
});

test("an identity without an expected GitHub login still produces a lock that governs push — its push requirement is simply incomplete", () => {
  const policy = buildValidPolicy({ id: "p", label: "P", gitEmail: "p@example.com" });
  assert.equal(policy.expectedGitHubLogin, undefined);
  assert.equal(policy.expectedGitName, undefined);
  assert.deepEqual(policy.trustedSshHostAliases, []);
  assert.ok(!("enforcedActions" in policy), "absence of a login never takes push out of the policy");
  assert.equal(validateShieldPolicy(policy).ok, true);
});

test("v4 refuses an enforcedActions field outright — nothing can take push out of an assigned repository's lock", () => {
  for (const enforcedActions of [["commit"], ["commit", "push"], [], "commit"]) {
    const result = validateShieldPolicy({ ...buildValidPolicy(), enforcedActions });
    assert.equal(result.ok, false, JSON.stringify(enforcedActions));
    if (!result.ok) assert.ok(result.errors.some((e) => e.path === "enforcedActions"));
  }
});

// ==================== v3 → v4 upgrade ====================

/** A v3 lock policy exactly as release 0.3.0 wrote it. */
function v3Policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyVersion: 3,
    lockId: "lock-v3",
    assignedAt: 111,
    generatedAt: 222,
    identityId: "work",
    identityLabel: "Work",
    expectedGitName: "Danish Irfan",
    expectedGitEmail: "work@example.com",
    trustedSshHostAliases: ["github-work"],
    enforcedActions: ["commit"],
    ...overrides,
  };
}

test("a v3 policy is never enforced as-is: it is recognized as an earlier lock that must be upgraded", () => {
  const result = validateShieldPolicy(v3Policy());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.find((e) => e.path === "policyVersion")?.message ?? "", /earlier version.*upgraded/);
  assert.equal(readLegacyPolicyInfo(JSON.stringify(v3Policy())), undefined, "a v3 lock is not a legacy Shield policy");
});

test("upgradePreviousLockPolicy: a v3 COMMIT-ONLY lock keeps its assignment and becomes a v4 lock with an incomplete push requirement", () => {
  const upgraded = upgradePreviousLockPolicy(JSON.stringify(v3Policy()));
  assert.deepEqual(upgraded, {
    policyVersion: 4,
    lockId: "lock-v3",
    assignedAt: 111,
    generatedAt: 222,
    identityId: "work",
    identityLabel: "Work",
    expectedGitName: "Danish Irfan",
    expectedGitEmail: "work@example.com",
    trustedSshHostAliases: ["github-work"],
  });
  assert.equal(upgraded?.expectedGitHubLogin, undefined, "a login is never invented during the upgrade");
  assert.equal(validateShieldPolicy(upgraded).ok, true);
});

test("upgradePreviousLockPolicy: a v3 lock WITH a login carries it over unchanged", () => {
  const upgraded = upgradePreviousLockPolicy(JSON.stringify(v3Policy({ expectedGitHubLogin: "danish-work", enforcedActions: ["commit", "push"] })));
  assert.equal(upgraded?.expectedGitHubLogin, "danish-work");
  assert.equal(upgraded?.policyVersion, 4);
});

test("upgradePreviousLockPolicy refuses anything that is not a well-formed v3 lock (corruption is never upgraded into an assignment)", () => {
  for (const raw of [
    "{ not json",
    JSON.stringify([1]),
    JSON.stringify(buildValidPolicy()), // already v4
    JSON.stringify({ policyVersion: 2, matchedProfileId: "work" }),
    JSON.stringify(v3Policy({ enforcedActions: ["push"] })), // v3 required commit
    JSON.stringify(v3Policy({ enforcedActions: ["commit", "rebase"] })),
    JSON.stringify(v3Policy({ enforcedActions: undefined })),
    JSON.stringify(v3Policy({ expectedGitEmail: "" })),
    JSON.stringify(v3Policy({ lockId: 7 })),
    JSON.stringify(v3Policy({ token: "x" })),
  ]) {
    assert.equal(upgradePreviousLockPolicy(raw), undefined, raw);
  }
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
  assert.equal(readLegacyPolicyInfo(serializeShieldPolicy(buildValidPolicy())), undefined, "a v4 policy is not legacy");
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

test("expectedGitHubLogin is optional in the schema (an incomplete push requirement, not corruption) but must be a string when present", () => {
  const base: Partial<ShieldPolicy> & Record<string, unknown> = { ...buildValidPolicy() };
  delete base.expectedGitHubLogin;
  assert.equal(validateShieldPolicy(base).ok, true);
  assert.equal(validateShieldPolicy({ ...base, expectedGitHubLogin: 42 }).ok, false);
  assert.equal(validateShieldPolicy({ ...base, expectedGitHubLogin: ["a"] }).ok, false);
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
