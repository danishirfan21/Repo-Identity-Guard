import assert from "node:assert/strict";
import test from "node:test";
import {
  branchMatchesAnyPattern,
  canonicalRepoKey,
  findMatchingProfiles,
  findOverlappingProfiles,
  ownerPatternsOverlap,
  resolveProfiles,
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

test("canonicalRepoKey lowercases and joins host/owner/repo", () => {
  assert.equal(canonicalRepoKey("GitHub.com", "AcmeSoftware", "Widgets"), "github.com/acmesoftware/widgets");
});

test("canonicalRepoKey returns undefined when any part is missing", () => {
  assert.equal(canonicalRepoKey(undefined, "AcmeSoftware", "widgets"), undefined);
  assert.equal(canonicalRepoKey("github.com", undefined, "widgets"), undefined);
  assert.equal(canonicalRepoKey("github.com", "AcmeSoftware", undefined), undefined);
});

test("resolveProfiles: exact-repo override wins over owner pattern entirely", () => {
  const personalWithOverride: Profile = {
    ...personalProfile,
    exactRepos: ["github.com/AcmeSoftware/open-source-thing"],
  };
  const resolution = resolveProfiles(
    facts({ remoteHost: "github.com", remoteOwner: "AcmeSoftware", remoteRepo: "open-source-thing" }),
    [workProfile, personalWithOverride],
  );
  assert.equal(resolution.tier, "exact_repo");
  assert.deepEqual(resolution.matches, [personalWithOverride]);
});

test("resolveProfiles: two profiles with the same exact-repo override are ambiguous", () => {
  const a: Profile = { ...workProfile, id: "a", exactRepos: ["github.com/org/repo"] };
  const b: Profile = { ...personalProfile, id: "b", exactRepos: ["github.com/org/repo"] };
  const resolution = resolveProfiles(
    facts({ remoteHost: "github.com", remoteOwner: "org", remoteRepo: "repo" }),
    [a, b],
  );
  assert.equal(resolution.tier, "exact_repo");
  assert.equal(resolution.matches.length, 2);
});

test("resolveProfiles: falls back to owner pattern when no exact-repo override matches", () => {
  const resolution = resolveProfiles(facts({ remoteOwner: "AcmeSoftware" }), [workProfile, personalProfile]);
  assert.equal(resolution.tier, "owner_pattern");
  assert.deepEqual(resolution.matches, [workProfile]);
});

test("resolveProfiles: unresolved when nothing matches", () => {
  const resolution = resolveProfiles(facts({ remoteOwner: "someone-else" }), [workProfile]);
  assert.equal(resolution.tier, "none");
  assert.deepEqual(resolution.matches, []);
});

test("resolveProfiles: fork conflict when origin and upstream imply different single profiles", () => {
  // origin is the user's personal fork; upstream is the company's original repo.
  const resolution = resolveProfiles(
    facts({ remoteOwner: "danish-irfan", upstreamOwner: "AcmeSoftware" }),
    [workProfile, personalProfile],
  );
  assert.equal(resolution.matches.length, 0);
  assert.ok(resolution.forkConflict);
  assert.equal(resolution.forkConflict!.originProfile.id, "personal");
  assert.equal(resolution.forkConflict!.upstreamProfile.id, "work");
});

test("resolveProfiles: an exact-repo override resolves what would otherwise be a fork conflict", () => {
  const personalWithOverride: Profile = {
    ...personalProfile,
    exactRepos: ["github.com/danish-irfan/forked-repo"],
  };
  const resolution = resolveProfiles(
    facts({
      remoteHost: "github.com",
      remoteOwner: "danish-irfan",
      remoteRepo: "forked-repo",
      upstreamOwner: "AcmeSoftware",
    }),
    [workProfile, personalWithOverride],
  );
  assert.equal(resolution.tier, "exact_repo");
  assert.equal(resolution.forkConflict, undefined);
  assert.deepEqual(resolution.matches, [personalWithOverride]);
});

test("resolveProfiles: upstream matching nothing is not treated as a conflict", () => {
  const resolution = resolveProfiles(
    facts({ remoteOwner: "AcmeSoftware", upstreamOwner: "some-unrelated-org" }),
    [workProfile, personalProfile],
  );
  assert.equal(resolution.tier, "owner_pattern");
  assert.deepEqual(resolution.matches, [workProfile]);
  assert.equal(resolution.forkConflict, undefined);
});

test("resolveProfiles: upstream implying the same profile as origin is not a conflict", () => {
  const resolution = resolveProfiles(
    facts({ remoteOwner: "AcmeSoftware", upstreamOwner: "AcmeSoftware" }),
    [workProfile, personalProfile],
  );
  assert.equal(resolution.tier, "owner_pattern");
  assert.deepEqual(resolution.matches, [workProfile]);
  assert.equal(resolution.forkConflict, undefined);
});

test("findOverlappingProfiles also flags overlapping exact-repo overrides", () => {
  const a: Profile = { ...workProfile, id: "a", expectedRemoteOwners: [], exactRepos: ["github.com/org/repo"] };
  const b: Profile = { ...personalProfile, id: "b", expectedRemoteOwners: [], exactRepos: ["github.com/org/repo"] };
  const overlaps = findOverlappingProfiles(a, [a, b]);
  assert.deepEqual(overlaps, [b]);
});

test("branchMatchesAnyPattern treats an empty pattern list as always matching", () => {
  assert.equal(branchMatchesAnyPattern("anything", []), true);
});

test("branchMatchesAnyPattern matches wildcard branch patterns", () => {
  assert.equal(branchMatchesAnyPattern("feature/login", ["feature/*", "fix/*"]), true);
  assert.equal(branchMatchesAnyPattern("chore/cleanup", ["feature/*", "fix/*"]), false);
});
