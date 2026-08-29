import assert from "node:assert/strict";
import test from "node:test";
import {
  SHIELD_POLICY_VERSION,
  ShieldPolicy,
  buildShieldPolicy,
  parseShieldPolicy,
  serializeShieldPolicy,
  validateShieldPolicy,
} from "../shield/policy";
import { Profile } from "../types";

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  exactRepos: [],
  expectedBranchPatterns: ["feature/*"],
  strictPushSetup: true,
  trustedSshHostAliases: ["github-work"],
};

function buildValidPolicy(): ShieldPolicy {
  return buildShieldPolicy({
    profile: workProfile,
    approvedRepositoryKey: "github.com/acmesoftware/acme-frontend",
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
    protectedBranches: ["main", "master"],
    enabledActions: ["commit", "push"],
    now: 12345,
  });
}

test("buildShieldPolicy shapes a policy purely from a profile and non-secret facts, with no I/O", () => {
  const policy = buildValidPolicy();
  assert.equal(policy.policyVersion, SHIELD_POLICY_VERSION);
  assert.equal(policy.generatedAt, 12345);
  assert.equal(policy.matchedProfileId, "work");
  assert.equal(policy.profileLabel, "Work");
  assert.equal(policy.expectedGitName, "Danish Irfan");
  assert.equal(policy.expectedGitEmail, "work@example.com");
  assert.equal(policy.approvedRepositoryKey, "github.com/acmesoftware/acme-frontend");
  assert.deepEqual(policy.approvedPushDestination, { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" });
  assert.deepEqual(policy.trustedSshHostAliases, ["github-work"]);
  assert.equal(policy.strictPushSetup, true);
  assert.deepEqual(policy.protectedBranches, ["main", "master"]);
  assert.deepEqual(policy.expectedBranchPatterns, ["feature/*"]);
  assert.deepEqual(policy.enabledActions, ["commit", "push"]);
});

test("buildShieldPolicy defaults absent profile arrays to empty arrays, never undefined", () => {
  const bareProfile: Profile = { id: "p", label: "P", gitEmail: "p@example.com" };
  const policy = buildShieldPolicy({
    profile: bareProfile,
    protectedBranches: [],
    enabledActions: [],
    now: 1,
  });
  assert.deepEqual(policy.trustedSshHostAliases, []);
  assert.deepEqual(policy.expectedBranchPatterns, []);
  assert.equal(policy.strictPushSetup, false);
  assert.equal(policy.approvedRepositoryKey, undefined);
  assert.equal(policy.approvedPushDestination, undefined);
});

test("a policy built by buildShieldPolicy round-trips through validateShieldPolicy", () => {
  const policy = buildValidPolicy();
  const result = validateShieldPolicy(policy);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.policy, policy);
  }
});

test("serializeShieldPolicy + parseShieldPolicy round-trips exactly", () => {
  const policy = buildValidPolicy();
  const json = serializeShieldPolicy(policy);
  const result = parseShieldPolicy(json);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.policy, policy);
  }
});

test("parseShieldPolicy reports malformed JSON as a validation failure, not a thrown exception", () => {
  const result = parseShieldPolicy("{ this is not json");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0].message, /not valid JSON/);
  }
});

test("validateShieldPolicy rejects a wrong/future policyVersion instead of guessing", () => {
  const policy = buildValidPolicy();
  const tampered = { ...policy, policyVersion: 999 };
  const result = validateShieldPolicy(tampered);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.path === "policyVersion"));
  }
});

test("validateShieldPolicy rejects non-object input", () => {
  for (const bad of [null, undefined, 42, "a string", ["array", "not", "object"]]) {
    const result = validateShieldPolicy(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to fail validation`);
  }
});

test("validateShieldPolicy reports every structural problem at once, not just the first", () => {
  const result = validateShieldPolicy({
    policyVersion: SHIELD_POLICY_VERSION,
    // missing generatedAt, matchedProfileId, profileLabel, expectedGitEmail, etc.
    trustedSshHostAliases: "not-an-array",
    protectedBranches: [1, 2, 3],
    enabledActions: ["commit", "rebase"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const paths = result.errors.map((e) => e.path);
    assert.ok(paths.includes("generatedAt"));
    assert.ok(paths.includes("matchedProfileId"));
    assert.ok(paths.includes("profileLabel"));
    assert.ok(paths.includes("expectedGitEmail"));
    assert.ok(paths.includes("trustedSshHostAliases"));
    assert.ok(paths.includes("protectedBranches"));
    assert.ok(paths.includes("enabledActions"));
    assert.ok(result.errors.length >= 7);
  }
});

test("validateShieldPolicy rejects a policy carrying a secret-shaped field, even if otherwise well-formed", () => {
  const policy = buildValidPolicy();
  for (const secretKey of ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"]) {
    const tampered = { ...policy, [secretKey]: "should never be here" };
    const result = validateShieldPolicy(tampered);
    assert.equal(result.ok, false, `expected a policy carrying "${secretKey}" to fail validation`);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.path === secretKey));
    }
  }
});

test("validateShieldPolicy accepts a policy with no push-related facts (no remote configured yet)", () => {
  const policy = buildShieldPolicy({
    profile: workProfile,
    protectedBranches: ["main"],
    enabledActions: ["commit"],
    now: 1,
  });
  const result = validateShieldPolicy(policy);
  assert.equal(result.ok, true);
});

test("serialized policy JSON never contains any of the disallowed secret field names as keys", () => {
  const policy = buildValidPolicy();
  const json = serializeShieldPolicy(policy);
  const parsedKeys = Object.keys(JSON.parse(json));
  for (const secretKey of ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"]) {
    assert.ok(!parsedKeys.includes(secretKey), `serialized policy must never contain "${secretKey}"`);
  }
});
