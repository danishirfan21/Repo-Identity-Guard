import assert from "node:assert/strict";
import test from "node:test";
import { isNonEmptyString, sanitizeBranchList, sanitizeProfile, sanitizeProfileList, sanitizeStringArray } from "../validation";

/**
 * Review finding: webview messages and persisted settings are a trust
 * boundary — `message.profile as Profile` and `message.branches as
 * string[]` (and the equivalent unguarded `.get<Profile[]>(...)` reads from
 * `settings.json`) assumed a shape a cast can't enforce. These tests drive
 * the validators directly against every malformed shape the review
 * described, so a regression here fails loudly instead of surfacing as a
 * downstream `.map`/`.some` crash deep in profile resolution.
 */

test("isNonEmptyString rejects non-strings, empty strings, and whitespace-only strings", () => {
  assert.equal(isNonEmptyString("work"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString("   "), false);
  assert.equal(isNonEmptyString(undefined), false);
  assert.equal(isNonEmptyString(null), false);
  assert.equal(isNonEmptyString(42), false);
  assert.equal(isNonEmptyString({}), false);
  assert.equal(isNonEmptyString(["a"]), false);
});

test("sanitizeStringArray drops non-array input entirely rather than throwing", () => {
  assert.deepEqual(sanitizeStringArray("AcmeSoftware"), []);
  assert.deepEqual(sanitizeStringArray(undefined), []);
  assert.deepEqual(sanitizeStringArray(null), []);
  assert.deepEqual(sanitizeStringArray(42), []);
  assert.deepEqual(sanitizeStringArray({ 0: "a", length: 1 }), []);
});

test("sanitizeStringArray drops individual non-string elements without coercing them", () => {
  assert.deepEqual(sanitizeStringArray(["github.com", 42, null, { evil: true }, "gitlab.com"]), ["github.com", "gitlab.com"]);
});

test("sanitizeProfile rejects a profile missing any of id/label/gitEmail", () => {
  assert.equal(sanitizeProfile({ label: "Work", gitEmail: "w@example.com" }), undefined);
  assert.equal(sanitizeProfile({ id: "work", gitEmail: "w@example.com" }), undefined);
  assert.equal(sanitizeProfile({ id: "work", label: "Work" }), undefined);
  assert.equal(sanitizeProfile({ id: "", label: "Work", gitEmail: "w@example.com" }), undefined);
  assert.equal(sanitizeProfile(null), undefined);
  assert.equal(sanitizeProfile("not an object"), undefined);
  assert.equal(sanitizeProfile(["array", "not", "object"]), undefined);
});

test("sanitizeProfile accepts a minimal valid profile and normalizes every array field", () => {
  const profile = sanitizeProfile({
    id: "work",
    label: "Work",
    gitEmail: "work@example.com",
    expectedRemoteOwners: "AcmeSoftware", // malformed: a string, not an array
    exactRepos: ["github.com/acme/secret", 42, null], // malformed elements mixed with a good one
    expectedBranchPatterns: undefined,
    trustedSshHostAliases: { 0: "github-work" }, // malformed: array-like object, not a real array
    strictPushSetup: "true", // malformed: a string, not a boolean
    expectedGitHubLogin: "  ", // malformed: whitespace-only
  });
  assert.ok(profile);
  assert.equal(profile!.id, "work");
  assert.equal(profile!.label, "Work");
  assert.equal(profile!.gitEmail, "work@example.com");
  assert.equal(profile!.expectedRemoteOwners, undefined, "a non-array value must be dropped, not coerced");
  assert.deepEqual(profile!.exactRepos, ["github.com/acme/secret"]);
  assert.equal(profile!.expectedBranchPatterns, undefined);
  assert.equal(profile!.trustedSshHostAliases, undefined);
  assert.equal(profile!.strictPushSetup, undefined, "a non-boolean must be dropped, not coerced to true/false");
  assert.equal(profile!.expectedGitHubLogin, undefined);
});

test("sanitizeProfile preserves every field's real value when everything is well-formed", () => {
  const profile = sanitizeProfile({
    id: "work",
    label: "Work",
    gitName: "Danish Irfan",
    gitEmail: "work@example.com",
    expectedRemoteOwners: ["AcmeSoftware", "acme-*"],
    exactRepos: ["github.com/acme/secret"],
    expectedBranchPatterns: ["feature/*"],
    trustedSshHostAliases: ["github-work"],
    strictPushSetup: true,
    expectedGitHubLogin: "danish-work",
  });
  assert.ok(profile);
  assert.deepEqual(profile, {
    id: "work",
    label: "Work",
    gitName: "Danish Irfan",
    gitEmail: "work@example.com",
    expectedRemoteOwners: ["AcmeSoftware", "acme-*"],
    exactRepos: ["github.com/acme/secret"],
    expectedBranchPatterns: ["feature/*"],
    trustedSshHostAliases: ["github-work"],
    strictPushSetup: true,
    expectedGitHubLogin: "danish-work",
  });
});

test("sanitizeProfileList drops one malformed entry without failing every other profile", () => {
  const result = sanitizeProfileList([
    { id: "work", label: "Work", gitEmail: "work@example.com" },
    { id: "broken", label: "Broken" }, // missing gitEmail
    "not even an object",
    { id: "personal", label: "Personal", gitEmail: "me@example.com" },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((p) => p.id).sort(), ["personal", "work"]);
});

test("sanitizeProfileList returns [] for non-array persisted settings, never throws", () => {
  assert.deepEqual(sanitizeProfileList("garbage"), []);
  assert.deepEqual(sanitizeProfileList(undefined), []);
  assert.deepEqual(sanitizeProfileList({ id: "not-an-array" }), []);
});

test("sanitizeBranchList falls back when the persisted value is malformed or empty after cleaning", () => {
  assert.deepEqual(sanitizeBranchList("main", ["main", "master"]), ["main", "master"]);
  assert.deepEqual(sanitizeBranchList([], ["main", "master"]), ["main", "master"]);
  assert.deepEqual(sanitizeBranchList(["  ", "", null, 42], ["main", "master"]), ["main", "master"]);
});

test("sanitizeBranchList trims and keeps well-formed entries, dropping only the malformed ones", () => {
  assert.deepEqual(sanitizeBranchList([" main ", "release/*", 42, "master"], ["main"]), ["main", "release/*", "master"]);
});
