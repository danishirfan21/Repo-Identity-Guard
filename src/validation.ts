import { Profile } from "./types";

/**
 * Runtime validation/normalization for data crossing a trust boundary:
 * persisted VS Code settings (a user, another extension, or a syncing
 * service can write anything into `settings.json`) and webview messages
 * (the webview content is this extension's own code today, but the whole
 * point of a trust boundary is that a cast can't enforce it stays that way).
 *
 * Every function here is total — it never throws on a malformed input, and
 * a value that fails validation is either dropped (an array element, an
 * optional field) or the caller-supplied fallback is used, never left as
 * `undefined`/some other shape a caller's `.map`/`.some`/`.filter` would
 * choke on. Nothing here uses a schema-validation dependency: the shapes
 * involved are small and stable enough that hand-written checks are both
 * sufficient and easier to audit than a general-purpose validator would be.
 */

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Every array item that isn't a string is dropped rather than coerced — a coerced `String(obj)` silently produces `"[object Object]"`, which is worse than dropping it. */
export function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * A single `Profile`, validated field-by-field. Returns `undefined` when the
 * three fields every capability check depends on (`id`, `label`,
 * `gitEmail`) aren't present as non-empty strings — there is no safe
 * partial profile to fall back to in that case. Every other field is
 * individually optional and simply omitted when malformed, rather than
 * failing the whole profile.
 */
export function sanitizeProfile(raw: unknown): Profile | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.id) || !isNonEmptyString(r.label) || !isNonEmptyString(r.gitEmail)) {
    return undefined;
  }

  const profile: Profile = {
    id: r.id,
    label: r.label,
    gitEmail: r.gitEmail,
  };

  if (isNonEmptyString(r.gitName)) {
    profile.gitName = r.gitName;
  }
  const expectedRemoteOwners = sanitizeStringArray(r.expectedRemoteOwners);
  if (expectedRemoteOwners.length > 0) {
    profile.expectedRemoteOwners = expectedRemoteOwners;
  }
  const exactRepos = sanitizeStringArray(r.exactRepos);
  if (exactRepos.length > 0) {
    profile.exactRepos = exactRepos;
  }
  const expectedBranchPatterns = sanitizeStringArray(r.expectedBranchPatterns);
  if (expectedBranchPatterns.length > 0) {
    profile.expectedBranchPatterns = expectedBranchPatterns;
  }
  const trustedSshHostAliases = sanitizeStringArray(r.trustedSshHostAliases);
  if (trustedSshHostAliases.length > 0) {
    profile.trustedSshHostAliases = trustedSshHostAliases;
  }
  if (typeof r.strictPushSetup === "boolean") {
    profile.strictPushSetup = r.strictPushSetup;
  }
  if (isNonEmptyString(r.expectedGitHubLogin)) {
    profile.expectedGitHubLogin = r.expectedGitHubLogin;
  }

  return profile;
}

/** Every element that fails {@link sanitizeProfile} is dropped, not treated as an all-or-nothing failure of the whole list — one corrupt profile in settings.json must not take every other profile down with it. */
export function sanitizeProfileList(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: Profile[] = [];
  for (const item of raw) {
    const profile = sanitizeProfile(item);
    if (profile) {
      result.push(profile);
    }
  }
  return result;
}

/** Blank/whitespace-only entries are dropped; an empty or entirely-invalid result falls back to `fallback` rather than leaving branch-policy checks with nothing to compare against. */
export function sanitizeBranchList(raw: unknown, fallback: string[]): string[] {
  const cleaned = sanitizeStringArray(raw)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return cleaned.length > 0 ? cleaned : fallback;
}
