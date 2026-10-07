import assert from "node:assert/strict";
import test from "node:test";
import { identitiesFromLegacyProfiles } from "../identity/identityConfig";
import { canonicalRepoKey, decideLegacyMigration } from "../identity/legacyMigration";

/**
 * The conservative legacy-migration rule (pure decision logic): a legacy
 * Shield installation becomes an identity lock ONLY for a provable,
 * literal `exactRepos` binding. Owner patterns never assign.
 */

const KEY = "github.com/acmesoftware/acme-frontend";
const ORIGIN = "git@github.com:AcmeSoftware/acme-frontend.git";

const workProfile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  exactRepos: ["github.com/AcmeSoftware/acme-frontend"],
};
const personalProfile = { id: "personal", label: "Personal", gitEmail: "me@example.com", expectedRemoteOwners: ["AcmeSoftware"] };

function decide(overrides: Partial<Parameters<typeof decideLegacyMigration>[0]> = {}) {
  const legacyProfiles = overrides.legacyProfiles ?? [workProfile, personalProfile];
  return decideLegacyMigration({
    legacyPolicy: { policyVersion: 2, matchedProfileId: "work", approvedRepositoryKey: KEY },
    originRemoteUrl: ORIGIN,
    legacyProfiles,
    identities: identitiesFromLegacyProfiles(legacyProfiles).identities,
    ...overrides,
  });
}

test("canonicalRepoKey is host/owner/repo, lower-cased, and undefined when any part is missing", () => {
  assert.equal(canonicalRepoKey("GitHub.com", "AcmeSoftware", "Acme-Frontend"), KEY);
  assert.equal(canonicalRepoKey(undefined, "a", "b"), undefined);
  assert.equal(canonicalRepoKey("h", "", "b"), undefined);
});

test("A — a literal exactRepos binding for the profile Shield was enabled for migrates to an identity lock", () => {
  const decision = decide();
  assert.equal(decision.kind, "assign");
  assert.equal(decision.kind === "assign" && decision.identity.id, "work");
  assert.match(decision.reason, /exactRepos/);
});

test("A — the match is case-insensitive and survives https / ssh:// spellings of the same origin", () => {
  for (const origin of ["https://github.com/acmesoftware/ACME-FRONTEND.git", "ssh://git@github.com/AcmeSoftware/acme-frontend", ORIGIN]) {
    assert.equal(decide({ originRemoteUrl: origin }).kind, "assign", origin);
  }
});

test("B — an owner-pattern (expectedRemoteOwners) match alone NEVER assigns", () => {
  const ownerOnly = { ...workProfile, exactRepos: undefined, expectedRemoteOwners: ["AcmeSoftware"] };
  const decision = decide({ legacyProfiles: [ownerOnly] });
  assert.equal(decision.kind, "remove");
  assert.match(decision.reason, /owner-pattern matches are never migrated/);
});

test("B — a wildcard exactRepos entry is not a literal binding and never assigns", () => {
  for (const pattern of ["github.com/acmesoftware/*", "github.com/*/acme-frontend", "*"]) {
    assert.equal(decide({ legacyProfiles: [{ ...workProfile, exactRepos: [pattern] }] }).kind, "remove", pattern);
  }
});

test("B — the binding must be unambiguous and belong to the profile the legacy policy names", () => {
  const twoBinders = [workProfile, { ...personalProfile, exactRepos: [KEY] }];
  assert.match(decide({ legacyProfiles: twoBinders }).reason, /ambiguous/);

  const otherBinder = [{ ...workProfile, exactRepos: [] }, { ...personalProfile, exactRepos: [KEY] }];
  assert.match(decide({ legacyProfiles: otherBinder }).reason, /not the one Shield was enabled for/);
});

test("B — a missing/unreadable legacy policy, or one without profile+repository, removes", () => {
  assert.equal(decide({ legacyPolicy: undefined }).kind, "remove");
  assert.equal(decide({ legacyPolicy: { policyVersion: 2, matchedProfileId: "work" } }).kind, "remove");
  assert.equal(decide({ legacyPolicy: { policyVersion: 1, approvedRepositoryKey: KEY } }).kind, "remove");
});

test("B — the repository must still be the one Shield approved (origin changed, or no origin → remove)", () => {
  assert.match(decide({ originRemoteUrl: "git@github.com:AcmeSoftware/other-repo.git" }).reason, /no longer matches/);
  assert.match(decide({ originRemoteUrl: "git@github.com:SomeoneElse/acme-frontend.git" }).reason, /no longer matches/);
  assert.match(decide({ originRemoteUrl: undefined }).reason, /no parseable origin/);
});

test("B — a bound profile that does not convert into a valid identity removes rather than half-migrating", () => {
  const invalid = [{ ...workProfile, expectedGitHubLogin: "not valid!" }];
  const decision = decide({ legacyProfiles: invalid });
  assert.equal(decision.kind, "remove");
  assert.match(decision.reason, /could not be converted/);
});

test("the decision is deterministic for the same inputs", () => {
  assert.deepEqual(decide(), decide());
  assert.deepEqual(decide({ legacyProfiles: [personalProfile] }), decide({ legacyProfiles: [personalProfile] }));
});
