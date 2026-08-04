import { Profile, RepoFacts } from "../types";

/** Case-insensitive glob match where `*` matches any run of characters. */
export function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value.trim());
}

/**
 * Finds every profile whose `expectedRemoteOwners` matches this repo's
 * remote owner (e.g. a GitHub org or username). A person with several
 * clients/employers is expected to have several profiles, so this
 * intentionally returns *all* matches rather than just the first — callers
 * decide what 0, 1, or 2+ matches mean (unknown vs. safe vs. ambiguous).
 */
export function findMatchingProfiles(
  facts: RepoFacts,
  profiles: Profile[],
): Profile[] {
  if (!facts.remoteOwner) {
    return [];
  }

  return profiles.filter((profile) =>
    (profile.expectedRemoteOwners ?? []).some((pattern) =>
      wildcardMatch(facts.remoteOwner as string, pattern),
    ),
  );
}

/**
 * Two owner patterns "overlap" if either could match the same repo owner —
 * covers exact duplicates (`AcmeSoftware` / `AcmeSoftware`) and a wildcard
 * subsuming a literal (`Acme*` / `AcmeSoftware`) in either direction.
 */
export function ownerPatternsOverlap(a: string, b: string): boolean {
  return wildcardMatch(a, b) || wildcardMatch(b, a);
}

/**
 * Finds profiles among `others` whose expected remote owners overlap with
 * `candidate`'s — i.e. a repo could plausibly match both. Used to warn at
 * profile-save time, before the ambiguity ever shows up as a NOT SAFE repo.
 */
export function findOverlappingProfiles(
  candidate: Profile,
  others: Profile[],
): Profile[] {
  const candidateOwners = candidate.expectedRemoteOwners ?? [];
  if (candidateOwners.length === 0) {
    return [];
  }

  return others.filter((other) => {
    if (other.id === candidate.id) {
      return false;
    }
    const otherOwners = other.expectedRemoteOwners ?? [];
    return candidateOwners.some((ownerA) =>
      otherOwners.some((ownerB) => ownerPatternsOverlap(ownerA, ownerB)),
    );
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
