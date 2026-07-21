import assert from "node:assert/strict";
import test from "node:test";
import { branchMatchesAnyPattern, resolveProfile, wildcardMatch } from "../core/profileResolver";
import { Profile, RepoFacts } from "../types";

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  expectedBranchPatterns: ["feature/*", "fix/*"],
  strictPushSetup: true,
};

const personalProfile: Profile = {
  id: "personal",
  label: "Personal",
  gitEmail: "personal@example.com",
  expectedRemoteOwners: ["danish-*"],
};

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return { isGitRepo: true, ...overrides };
}

test("wildcardMatch supports case-insensitive glob patterns", () => {
  assert.equal(wildcardMatch("AcmeSoftware", "acmesoftware"), true);
  assert.equal(wildcardMatch("danish-irfan", "danish-*"), true);
  assert.equal(wildcardMatch("someone-else", "danish-*"), false);
});

test("resolveProfile matches by remote owner", () => {
  const profile = resolveProfile(facts({ remoteOwner: "AcmeSoftware" }), [workProfile, personalProfile]);
  assert.equal(profile, workProfile);
});

test("resolveProfile matches wildcard owner patterns", () => {
  const profile = resolveProfile(facts({ remoteOwner: "danish-irfan" }), [workProfile, personalProfile]);
  assert.equal(profile, personalProfile);
});

test("resolveProfile returns undefined when no remote owner is known", () => {
  assert.equal(resolveProfile(facts(), [workProfile]), undefined);
});

test("resolveProfile returns undefined when no profile matches", () => {
  assert.equal(resolveProfile(facts({ remoteOwner: "someone-else" }), [workProfile]), undefined);
});

test("branchMatchesAnyPattern treats an empty pattern list as always matching", () => {
  assert.equal(branchMatchesAnyPattern("anything", []), true);
});

test("branchMatchesAnyPattern matches wildcard branch patterns", () => {
  assert.equal(branchMatchesAnyPattern("feature/login", ["feature/*", "fix/*"]), true);
  assert.equal(branchMatchesAnyPattern("chore/cleanup", ["feature/*", "fix/*"]), false);
});
