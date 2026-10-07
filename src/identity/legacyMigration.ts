import { parseRemoteUrl } from "../services/gitService";
import type { LegacyPolicyInfo } from "../shield/policy";
import { Identity } from "./types";

/**
 * Conservative migration of a repository that still carries a legacy
 * "Shield Mode" installation (a v1/v2 policy and/or pre-v6 hooks) into the
 * identity-lock model. Pure decision logic only — `IdentityLockService`
 * performs the resulting install or removal.
 *
 * The rule, in one sentence: a legacy installation becomes an identity
 * lock ONLY when the repository can be proven to have been explicitly
 * bound to exactly one profile through a literal `exactRepos` entry;
 * everything else is removed (hooks restored to what was there before),
 * because an unassigned repository must not keep hooks that block Git.
 *
 * "Proven" means ALL of:
 *  1. the legacy policy is readable and names both the profile it was
 *     enabled for (`matchedProfileId`) and the canonical repository key it
 *     approved (`approvedRepositoryKey`);
 *  2. the repository's current `origin` remote canonicalizes to that same
 *     key (it is still the same repository);
 *  3. among ALL legacy profiles, exactly one has a LITERAL (no `*`)
 *     `exactRepos` entry equal to that key, and it is the profile the
 *     legacy policy was enabled for;
 *  4. that profile converted into a valid identity with the same id.
 *
 * Deliberately never a reason to assign: an `expectedRemoteOwners`
 * (owner/org pattern) match, a wildcard `exactRepos` pattern, an
 * `upstream` remote, another repository with the same owner being
 * assigned, or a legacy Shield installation alone. Prefer a false negative
 * (the user re-assigns with one click) over silently locking a repository
 * the user never explicitly bound.
 */

export type LegacyMigrationDecision =
  | { kind: "assign"; identity: Identity; reason: string }
  | { kind: "remove"; reason: string };

/** Canonical `host/owner/repo` key the retired profile model matched `exactRepos` against — never a disk path, never an assignment key. */
export function canonicalRepoKey(host: string | undefined, owner: string | undefined, repo: string | undefined): string | undefined {
  if (!host || !owner || !repo) return undefined;
  return `${host}/${owner}/${repo}`.toLowerCase();
}

function literalExactRepos(profile: unknown): string[] {
  if (!profile || typeof profile !== "object") return [];
  const exactRepos = (profile as Record<string, unknown>).exactRepos;
  if (!Array.isArray(exactRepos)) return [];
  return exactRepos
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && !entry.includes("*"));
}

function profileId(profile: unknown): string | undefined {
  if (!profile || typeof profile !== "object") return undefined;
  const id = (profile as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export function decideLegacyMigration(input: {
  legacyPolicy: LegacyPolicyInfo | undefined;
  originRemoteUrl: string | undefined;
  legacyProfiles: unknown;
  identities: Identity[];
}): LegacyMigrationDecision {
  const remove = (why: string): LegacyMigrationDecision => ({
    kind: "remove",
    reason: `No explicit identity assignment could be proven for this repository (${why}), so the legacy Shield hooks were removed and Git is no longer restricted here. Assign an identity to lock it again.`,
  });

  const policy = input.legacyPolicy;
  if (!policy) return remove("the legacy Shield policy is missing or unreadable");
  if (!policy.matchedProfileId || !policy.approvedRepositoryKey) {
    return remove("the legacy Shield policy does not record both a profile and an approved repository");
  }
  const approvedKey = policy.approvedRepositoryKey.trim().toLowerCase();

  const origin = input.originRemoteUrl ? parseRemoteUrl(input.originRemoteUrl) : undefined;
  const originKey = origin ? canonicalRepoKey(origin.host, origin.owner, origin.repo) : undefined;
  if (!originKey) return remove("this repository has no parseable origin remote to match against");
  if (originKey !== approvedKey) return remove("the origin remote no longer matches the repository Shield approved");

  const profiles = Array.isArray(input.legacyProfiles) ? input.legacyProfiles : [];
  const binders = profiles.filter((profile) => literalExactRepos(profile).includes(approvedKey));
  if (binders.length === 0) return remove("no legacy profile listed this repository in exactRepos (owner-pattern matches are never migrated)");
  if (binders.length > 1) return remove("more than one legacy profile listed this repository in exactRepos (ambiguous)");
  const binderId = profileId(binders[0]);
  if (binderId !== policy.matchedProfileId) {
    return remove("the profile that listed this repository in exactRepos is not the one Shield was enabled for");
  }

  const identity = input.identities.find((candidate) => candidate.id === binderId);
  if (!identity) return remove(`the bound profile "${binderId}" could not be converted into a valid identity`);

  return {
    kind: "assign",
    identity,
    reason: `This repository was explicitly bound to the legacy profile "${identity.label}" (exactRepos: ${approvedKey}) with Shield enabled, so it was migrated to an identity lock for "${identity.label}".`,
  };
}
