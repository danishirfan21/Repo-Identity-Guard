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
 * Finds the profile whose `expectedRemoteOwners` matches this repo's remote
 * owner (e.g. a GitHub org or username). Returns undefined when the repo has
 * no remote owner to match, or when no configured profile claims it —
 * callers must treat an unmatched repo as NOT SAFE, not as "safe by default".
 */
export function resolveProfile(
  facts: RepoFacts,
  profiles: Profile[],
): Profile | undefined {
  if (!facts.remoteOwner) {
    return undefined;
  }

  return profiles.find((profile) =>
    (profile.expectedRemoteOwners ?? []).some((pattern) =>
      wildcardMatch(facts.remoteOwner as string, pattern),
    ),
  );
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
