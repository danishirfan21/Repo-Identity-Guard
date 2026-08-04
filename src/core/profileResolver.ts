import { Profile, RepoFacts } from "../types";

/** Case-insensitive glob match where `*` matches any run of characters. */
export function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value.trim());
}

function ownerMatches(owner: string, profiles: Profile[]): Profile[] {
  return profiles.filter((profile) =>
    (profile.expectedRemoteOwners ?? []).some((pattern) => wildcardMatch(owner, pattern)),
  );
}

/**
 * Finds every profile whose `expectedRemoteOwners` matches this repo's
 * remote owner (e.g. a GitHub org or username). A person with several
 * clients/employers is expected to have several profiles, so this
 * intentionally returns *all* matches rather than just the first — callers
 * decide what 0, 1, or 2+ matches mean (unknown vs. safe vs. ambiguous).
 *
 * This is the owner-pattern tier only. Prefer {@link resolveProfiles} for
 * full precedence (exact-repo overrides, fork/upstream conflict detection).
 */
export function findMatchingProfiles(
  facts: RepoFacts,
  profiles: Profile[],
): Profile[] {
  if (!facts.remoteOwner) {
    return [];
  }
  return ownerMatches(facts.remoteOwner, profiles);
}

/** Canonical `host/owner/repo` key used for exact-repository matching — never a disk path. */
export function canonicalRepoKey(
  host: string | undefined,
  owner: string | undefined,
  repo: string | undefined,
): string | undefined {
  if (!host || !owner || !repo) {
    return undefined;
  }
  return `${host}/${owner}/${repo}`.toLowerCase();
}

function exactRepoMatches(key: string, profiles: Profile[]): Profile[] {
  return profiles.filter((profile) =>
    (profile.exactRepos ?? []).some((pattern) => wildcardMatch(key, pattern)),
  );
}

export type ProfileMatchTier = "exact_repo" | "owner_pattern" | "none";

export interface ForkConflict {
  /** Profile implied by `origin`'s owner. */
  originProfile: Profile;
  /** Profile implied by `upstream`'s owner — evidence of a possible fork, never an automatic winner. */
  upstreamProfile: Profile;
}

export interface ProfileResolution {
  /** Profiles matching at the winning tier. 0 = unresolved, 1 = resolved, 2+ = ambiguous. */
  matches: Profile[];
  tier: ProfileMatchTier;
  /** Set when origin and upstream unambiguously imply two *different* profiles and no exact-repo override resolved it. */
  forkConflict?: ForkConflict;
}

/**
 * Resolves which profile(s) apply to this repo, in order:
 *
 * 1. Exact-repository override (`Profile.exactRepos`, canonicalized as
 *    `host/owner/repo`) — always wins outright when present.
 * 2. Owner/org pattern (`Profile.expectedRemoteOwners`) matched against
 *    `origin` — but first cross-checked against `upstream`: if origin and
 *    upstream each unambiguously imply a different single profile, that's
 *    a fork/upstream conflict, reported as unresolved rather than silently
 *    picking `origin`'s profile. Upstream is only ever used as evidence for
 *    this conflict check, never as a tiebreaker or automatic winner.
 * 3. Unresolved.
 */
export function resolveProfiles(facts: RepoFacts, profiles: Profile[]): ProfileResolution {
  const originKey = canonicalRepoKey(facts.remoteHost, facts.remoteOwner, facts.remoteRepo);
  if (originKey) {
    const exact = exactRepoMatches(originKey, profiles);
    if (exact.length > 0) {
      return { matches: exact, tier: "exact_repo" };
    }
  }

  const originOwnerMatches = facts.remoteOwner ? ownerMatches(facts.remoteOwner, profiles) : [];
  const upstreamOwnerMatches = facts.upstreamOwner ? ownerMatches(facts.upstreamOwner, profiles) : [];

  if (
    originOwnerMatches.length === 1 &&
    upstreamOwnerMatches.length === 1 &&
    originOwnerMatches[0].id !== upstreamOwnerMatches[0].id
  ) {
    return {
      matches: [],
      tier: "owner_pattern",
      forkConflict: { originProfile: originOwnerMatches[0], upstreamProfile: upstreamOwnerMatches[0] },
    };
  }

  if (originOwnerMatches.length > 0) {
    return { matches: originOwnerMatches, tier: "owner_pattern" };
  }

  return { matches: [], tier: "none" };
}

/**
 * Two patterns "overlap" if either could match the same value — covers
 * exact duplicates (`AcmeSoftware` / `AcmeSoftware`) and a wildcard
 * subsuming a literal (`Acme*` / `AcmeSoftware`) in either direction.
 */
export function ownerPatternsOverlap(a: string, b: string): boolean {
  return wildcardMatch(a, b) || wildcardMatch(b, a);
}

/**
 * Finds profiles among `others` whose expected owners or exact-repo
 * overrides overlap with `candidate`'s — i.e. a repo could plausibly match
 * both. Used to warn at profile-save time, before the ambiguity ever shows
 * up as a NOT SAFE repo.
 */
export function findOverlappingProfiles(
  candidate: Profile,
  others: Profile[],
): Profile[] {
  const candidateOwners = candidate.expectedRemoteOwners ?? [];
  const candidateRepos = candidate.exactRepos ?? [];
  if (candidateOwners.length === 0 && candidateRepos.length === 0) {
    return [];
  }

  return others.filter((other) => {
    if (other.id === candidate.id) {
      return false;
    }
    const otherOwners = other.expectedRemoteOwners ?? [];
    const otherRepos = other.exactRepos ?? [];
    const ownersOverlap = candidateOwners.some((a) => otherOwners.some((b) => ownerPatternsOverlap(a, b)));
    const reposOverlap = candidateRepos.some((a) => otherRepos.some((b) => ownerPatternsOverlap(a, b)));
    return ownersOverlap || reposOverlap;
  });
}

export function branchMatchesAnyPattern(
  branch: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => wildcardMatch(branch, pattern));
}
