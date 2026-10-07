import assert from "node:assert/strict";
import test from "node:test";
import {
  identitiesFromLegacyProfiles,
  pushEnforcementFor,
  sanitizeIdentityList,
  validateIdentity,
  validateIdentityList,
} from "../identity/identityConfig";

/**
 * Identity validation is a trust boundary: the `repoIdentityGuard.identities`
 * setting can be hand-edited or synced, and every value ends up in the lock
 * policy and, from there, in the shell evaluator's one-line block prelude.
 */

const VALID = { id: "work", label: "Work", gitName: "Danish Irfan", gitEmail: "work@example.com" };

test("a minimal identity (id, label, email) is valid; optional fields are omitted, not emptied", () => {
  const result = validateIdentity({ id: " work ", label: " Work ", gitEmail: " work@example.com " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.identity, { id: "work", label: "Work", gitEmail: "work@example.com" });
});

test("a full identity keeps every identity field and nothing else", () => {
  const result = validateIdentity({
    ...VALID,
    expectedGitHubLogin: "danish-work",
    trustedSshHostAliases: ["github-work", " github-work ", "GITHUB-WORK", "[2001:db8::1]"],
    // Retired profile/policy fields are not part of an identity.
    expectedRemoteOwners: ["AcmeSoftware"],
    exactRepos: ["github.com/acmesoftware/acme"],
    strictPushSetup: true,
    expectedBranchPatterns: ["feature/*"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.identity, {
    ...VALID,
    expectedGitHubLogin: "danish-work",
    trustedSshHostAliases: ["github-work", "[2001:db8::1]"],
  });
});

test("missing required fields are each reported", () => {
  const result = validateIdentity({ gitName: "x" });
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.errors, ["id is required.", "label is required.", "gitEmail is required."]);
  for (const bad of [null, undefined, 42, "work", [VALID]]) {
    assert.equal(validateIdentity(bad).ok, false);
  }
});

test("control characters (prelude/line injection) are rejected in every text field", () => {
  for (const field of ["id", "label", "gitName", "gitEmail", "expectedGitHubLogin"]) {
    const result = validateIdentity({ ...VALID, expectedGitHubLogin: "danish", [field]: "evil\nREASON: allowed" });
    assert.equal(result.ok, false, field);
    assert.ok(!result.ok && result.errors.some((e) => e.startsWith(field)), field);
  }
  assert.equal(validateIdentity({ ...VALID, label: "tab\there" }).ok, false);
  assert.equal(validateIdentity({ ...VALID, label: "nul\u0000" }).ok, false);
});

test("angle brackets in name/email are rejected (they would corrupt Git's ident format)", () => {
  assert.equal(validateIdentity({ ...VALID, gitEmail: "a<b@example.com" }).ok, false);
  assert.equal(validateIdentity({ ...VALID, gitName: "Name <x@y>" }).ok, false);
});

test("an invalid GitHub login is an ERROR — never silently dropped into a weaker (commit-only) lock", () => {
  for (const login of ["-leading", "trailing-", "double--hyphen", "has space", "a".repeat(40), "under_score", "dot.ted"]) {
    const result = validateIdentity({ ...VALID, expectedGitHubLogin: login });
    assert.equal(result.ok, false, login);
  }
  for (const login of ["a", "danish-work", "A1-b2-C3", "a".repeat(39)]) {
    assert.equal(validateIdentity({ ...VALID, expectedGitHubLogin: login }).ok, true, login);
  }
  assert.equal(validateIdentity({ ...VALID, expectedGitHubLogin: 42 }).ok, false);
});

test("trusted SSH aliases: invalid entries are errors; duplicates (case-insensitive) collapse", () => {
  for (const alias of ["git@github.com", "has space", "a/b", "a\\b", "", "line\nbreak", "-oProxyCommand=x", "-github-work"]) {
    assert.equal(validateIdentity({ ...VALID, trustedSshHostAliases: [alias] }).ok, false, JSON.stringify(alias));
  }
  assert.equal(validateIdentity({ ...VALID, trustedSshHostAliases: "github-work" }).ok, false);
  const ok = validateIdentity({ ...VALID, trustedSshHostAliases: [] });
  assert.equal(ok.ok && ok.identity.trustedSshHostAliases, undefined);
});

test("identity list: invalid entries and duplicate ids are rejected individually and reported, never all-or-nothing", () => {
  const result = validateIdentityList([VALID, { id: "bad" }, { ...VALID, label: "Work again" }, { id: "personal", label: "Personal", gitEmail: "me@example.com" }]);
  assert.deepEqual(result.identities.map((i) => i.id), ["work", "personal"]);
  assert.deepEqual(result.rejected.map((r) => r.index), [1, 2]);
  assert.match(result.rejected[1].errors[0], /Duplicate identity id "work"/);
  assert.deepEqual(sanitizeIdentityList("not a list"), []);
});

test("push enforcement: no login → not_configured; login without alias → unverifiable; login + alias → enforced", () => {
  assert.equal(pushEnforcementFor({}), "not_configured");
  assert.equal(pushEnforcementFor({ trustedSshHostAliases: ["github-work"] }), "not_configured");
  assert.equal(pushEnforcementFor({ expectedGitHubLogin: "danish" }), "unverifiable");
  assert.equal(pushEnforcementFor({ expectedGitHubLogin: "danish", trustedSshHostAliases: [] }), "unverifiable");
  assert.equal(pushEnforcementFor({ expectedGitHubLogin: "danish", trustedSshHostAliases: ["github-work"] }), "enforced");
});

test("legacy profiles → identities: only WHO fields survive; matching/policy fields are dropped; invalid profiles are reported", () => {
  const result = identitiesFromLegacyProfiles([
    {
      id: "work",
      label: "Work",
      gitName: "Danish Irfan",
      gitEmail: "work@example.com",
      expectedRemoteOwners: ["AcmeSoftware"],
      exactRepos: ["github.com/acmesoftware/acme-frontend"],
      expectedBranchPatterns: ["feature/*"],
      strictPushSetup: true,
      expectedGitHubLogin: "danish-work",
      trustedSshHostAliases: ["github-work"],
    },
    { id: "broken", label: "Broken", gitEmail: "b@example.com", expectedGitHubLogin: "not valid!" },
    "garbage",
  ]);
  assert.deepEqual(result.identities, [
    {
      id: "work",
      label: "Work",
      gitName: "Danish Irfan",
      gitEmail: "work@example.com",
      expectedGitHubLogin: "danish-work",
      trustedSshHostAliases: ["github-work"],
    },
  ]);
  assert.deepEqual(result.rejected.map((r) => r.index), [1, 2]);
  assert.deepEqual(identitiesFromLegacyProfiles(undefined), { identities: [], rejected: [] });
});
