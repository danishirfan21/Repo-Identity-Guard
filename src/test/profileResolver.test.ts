import assert from "node:assert/strict";
import test from "node:test";
import {
  branchMatchesAnyPattern,
  findMatchingProfiles,
  findOverlappingProfiles,
  ownerPatternsOverlap,
  wildcardMatch,
} from "../core/profileResolver";
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

const freelanceClientA: Profile = {
  id: "freelance-a",
  label: "Freelance Client A",
  gitEmail: "danish@client-a.com",
  expectedRemoteOwners: ["client-a-org"],
};

const freelanceClientB: Profile = {
  id: "freelance-b",
  label: "Freelance Client B",
  gitEmail: "danish@client-b.com",
  expectedRemoteOwners: ["client-a-org", "client-b-org"],
};

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return { isGitRepo: true, ...overrides };
}

test("wildcardMatch supports case-insensitive glob patterns", () => {
  assert.equal(wildcardMatch("AcmeSoftware", "acmesoftware"), true);
  assert.equal(wildcardMatch("danish-irfan", "danish-*"), true);
  assert.equal(wildcardMatch("someone-else", "danish-*"), false);
});

test("findMatchingProfiles matches by remote owner", () => {
  const matches = findMatchingProfiles(facts({ remoteOwner: "AcmeSoftware" }), [workProfile, personalProfile]);
  assert.deepEqual(matches, [workProfile]);
});

test("findMatchingProfiles matches wildcard owner patterns", () => {
  const matches = findMatchingProfiles(facts({ remoteOwner: "danish-irfan" }), [workProfile, personalProfile]);
  assert.deepEqual(matches, [personalProfile]);
});

test("findMatchingProfiles returns nothing when no remote owner is known", () => {
  assert.deepEqual(findMatchingProfiles(facts(), [workProfile]), []);
});

test("findMatchingProfiles returns nothing when no profile matches", () => {
  assert.deepEqual(findMatchingProfiles(facts({ remoteOwner: "someone-else" }), [workProfile]), []);
});

test("findMatchingProfiles returns every match when two profiles claim the same owner (ambiguous)", () => {
  const matches = findMatchingProfiles(facts({ remoteOwner: "client-a-org" }), [freelanceClientA, freelanceClientB]);
  assert.equal(matches.length, 2);
  assert.ok(matches.includes(freelanceClientA));
  assert.ok(matches.includes(freelanceClientB));
});

test("findMatchingProfiles supports one profile covering many owners (one-to-many)", () => {
  const matchesA = findMatchingProfiles(facts({ remoteOwner: "client-a-org" }), [freelanceClientB]);
  const matchesB = findMatchingProfiles(facts({ remoteOwner: "client-b-org" }), [freelanceClientB]);
  assert.deepEqual(matchesA, [freelanceClientB]);
  assert.deepEqual(matchesB, [freelanceClientB]);
});

test("ownerPatternsOverlap detects exact duplicates and wildcard subsumption", () => {
  assert.equal(ownerPatternsOverlap("AcmeSoftware", "acmesoftware"), true);
  assert.equal(ownerPatternsOverlap("Acme*", "AcmeSoftware"), true);
  assert.equal(ownerPatternsOverlap("AcmeSoftware", "Acme*"), true);
  assert.equal(ownerPatternsOverlap("AcmeSoftware", "OtherOrg"), false);
});

test("findOverlappingProfiles flags profiles that share an owner pattern", () => {
  const overlaps = findOverlappingProfiles(freelanceClientA, [freelanceClientA, freelanceClientB, workProfile]);
  assert.deepEqual(overlaps, [freelanceClientB]);
});

test("findOverlappingProfiles returns nothing when owners are disjoint", () => {
  assert.deepEqual(findOverlappingProfiles(workProfile, [workProfile, personalProfile]), []);
});

test("branchMatchesAnyPattern treats an empty pattern list as always matching", () => {
  assert.equal(branchMatchesAnyPattern("anything", []), true);
});

test("branchMatchesAnyPattern matches wildcard branch patterns", () => {
  assert.equal(branchMatchesAnyPattern("feature/login", ["feature/*", "fix/*"]), true);
  assert.equal(branchMatchesAnyPattern("chore/cleanup", ["feature/*", "fix/*"]), false);
});
