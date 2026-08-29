import { Profile } from "../types";
import { SHIELD_ACTIONS, ShieldAction } from "./types";

/**
 * Bumped whenever ShieldPolicy's shape changes in a way that isn't purely
 * additive-optional. A hook (once one exists) reading a policy with an
 * unrecognized/newer version, or an older version it doesn't know how to
 * interpret, should treat that as `policy-corrupt` rather than guess.
 */
export const SHIELD_POLICY_VERSION = 1 as const;

/**
 * Non-secret, non-cached intent for enforcing Git safety on one underlying
 * repository. This is deliberately a description of *what the user asked
 * for* — never a snapshot of the last computed SAFE/NOT SAFE result. See
 * docs/SHIELD_MODE.md "Policy represents intent, not cached status."
 *
 * Never include: access tokens, passwords, private SSH key material,
 * credential-helper output, or `.env` contents. Every field here is either
 * already visible in `settings.json` (profile fields) or is itself
 * non-secret Git-facts-derived data (a canonical repo key, a push
 * destination's host/owner/repo, a branch name) — nothing that couldn't be
 * read by anyone with read access to the repository and its remote.
 */
export interface ShieldPolicy {
  policyVersion: typeof SHIELD_POLICY_VERSION;
  /** Epoch milliseconds this policy was generated — lets a hook or the sidebar notice a policy that predates a later profile edit. */
  generatedAt: number;

  matchedProfileId: string;
  profileLabel: string;

  expectedGitName?: string;
  expectedGitEmail: string;

  /** Canonical `host/owner/repo` (lowercased) this policy is scoped to, when the repo has a resolvable remote. Never a disk path. */
  approvedRepositoryKey?: string;

  /** Where a plain push is expected to land, as non-secret facts only — never credentials for reaching it. */
  approvedPushDestination?: {
    host?: string;
    owner?: string;
    repo?: string;
  };

  /** SSH host aliases this profile explicitly trusts as push routes (see Profile.trustedSshHostAliases). Never a private key or its fingerprint. */
  trustedSshHostAliases: string[];

  /**
   * The GitHub authenticated username a trusted SSH route is expected to
   * prove itself as (Shield Mode Phase 5) — copied verbatim from
   * `Profile.expectedGitHubLogin`. Distinct from `expectedGitEmail` (a
   * local Git commit identity) and from `approvedPushDestination.owner`
   * (the repository's owner/org) — see `Profile.expectedGitHubLogin`'s doc
   * comment for why these three must never be conflated. Undefined means
   * this profile doesn't request account-level verification; route trust
   * alone (see `trustedSshHostAliases`) is all Shield checks in that case.
   */
  expectedGitHubLogin?: string;

  strictPushSetup: boolean;

  /** Local branch-protection list in effect when this policy was generated (global config, not profile-specific). */
  protectedBranches: string[];
  /** This profile's expected branch name patterns. */
  expectedBranchPatterns: string[];

  /** Which Shield actions this policy governs. An action not listed here is never blocked by this policy. */
  enabledActions: ShieldAction[];
}

export interface ShieldPolicyInput {
  profile: Profile;
  approvedRepositoryKey?: string;
  approvedPushDestination?: { host?: string; owner?: string; repo?: string };
  protectedBranches: string[];
  enabledActions: ShieldAction[];
  now?: number;
}

/**
 * Builds a policy purely from already-known, already-non-secret inputs —
 * no I/O, no Git invocation. The caller (a future phase) is responsible for
 * gathering `approvedRepositoryKey`/`approvedPushDestination` from
 * `RepoFacts` and for persisting the result; this function only shapes the
 * data.
 */
export function buildShieldPolicy(input: ShieldPolicyInput): ShieldPolicy {
  const { profile } = input;
  return {
    policyVersion: SHIELD_POLICY_VERSION,
    generatedAt: input.now ?? Date.now(),
    matchedProfileId: profile.id,
    profileLabel: profile.label,
    expectedGitName: profile.gitName,
    expectedGitEmail: profile.gitEmail,
    approvedRepositoryKey: input.approvedRepositoryKey,
    approvedPushDestination: input.approvedPushDestination,
    trustedSshHostAliases: [...(profile.trustedSshHostAliases ?? [])],
    expectedGitHubLogin: profile.expectedGitHubLogin,
    strictPushSetup: !!profile.strictPushSetup,
    protectedBranches: [...input.protectedBranches],
    expectedBranchPatterns: [...(profile.expectedBranchPatterns ?? [])],
    enabledActions: [...input.enabledActions],
  };
}

export interface ShieldPolicyValidationError {
  path: string;
  message: string;
}

export type ShieldPolicyValidationResult =
  | { ok: true; policy: ShieldPolicy }
  | { ok: false; errors: ShieldPolicyValidationError[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Structurally validates an arbitrary value as a {@link ShieldPolicy}.
 * Deliberately hand-rolled (no schema library dependency) and deliberately
 * strict about `policyVersion`: a policy written by a future, newer version
 * of Repo Identity Guard must not be silently accepted and misinterpreted
 * by an older one — that's exactly the kind of silent-drift failure Shield
 * exists to prevent elsewhere, so it must not tolerate it in itself.
 */
export function validateShieldPolicy(value: unknown): ShieldPolicyValidationResult {
  const errors: ShieldPolicyValidationError[] = [];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "$", message: "Policy must be a JSON object." }] };
  }
  const v = value as Record<string, unknown>;

  if (v.policyVersion !== SHIELD_POLICY_VERSION) {
    errors.push({
      path: "policyVersion",
      message: `Expected policyVersion ${SHIELD_POLICY_VERSION}, got ${JSON.stringify(v.policyVersion)}.`,
    });
  }
  if (typeof v.generatedAt !== "number" || !Number.isFinite(v.generatedAt)) {
    errors.push({ path: "generatedAt", message: "generatedAt must be a finite number (epoch milliseconds)." });
  }
  if (typeof v.matchedProfileId !== "string" || v.matchedProfileId.length === 0) {
    errors.push({ path: "matchedProfileId", message: "matchedProfileId must be a non-empty string." });
  }
  if (typeof v.profileLabel !== "string" || v.profileLabel.length === 0) {
    errors.push({ path: "profileLabel", message: "profileLabel must be a non-empty string." });
  }
  if (v.expectedGitName !== undefined && typeof v.expectedGitName !== "string") {
    errors.push({ path: "expectedGitName", message: "expectedGitName must be a string when present." });
  }
  if (typeof v.expectedGitEmail !== "string" || v.expectedGitEmail.length === 0) {
    errors.push({ path: "expectedGitEmail", message: "expectedGitEmail must be a non-empty string." });
  }
  if (v.approvedRepositoryKey !== undefined && typeof v.approvedRepositoryKey !== "string") {
    errors.push({ path: "approvedRepositoryKey", message: "approvedRepositoryKey must be a string when present." });
  }
  if (v.approvedPushDestination !== undefined) {
    const dest = v.approvedPushDestination;
    if (typeof dest !== "object" || dest === null || Array.isArray(dest)) {
      errors.push({ path: "approvedPushDestination", message: "approvedPushDestination must be an object when present." });
    } else {
      const d = dest as Record<string, unknown>;
      for (const key of ["host", "owner", "repo"] as const) {
        if (d[key] !== undefined && typeof d[key] !== "string") {
          errors.push({ path: `approvedPushDestination.${key}`, message: `${key} must be a string when present.` });
        }
      }
    }
  }
  if (!isStringArray(v.trustedSshHostAliases)) {
    errors.push({ path: "trustedSshHostAliases", message: "trustedSshHostAliases must be an array of strings." });
  }
  if (v.expectedGitHubLogin !== undefined && typeof v.expectedGitHubLogin !== "string") {
    errors.push({ path: "expectedGitHubLogin", message: "expectedGitHubLogin must be a string when present." });
  }
  if (typeof v.strictPushSetup !== "boolean") {
    errors.push({ path: "strictPushSetup", message: "strictPushSetup must be a boolean." });
  }
  if (!isStringArray(v.protectedBranches)) {
    errors.push({ path: "protectedBranches", message: "protectedBranches must be an array of strings." });
  }
  if (!isStringArray(v.expectedBranchPatterns)) {
    errors.push({ path: "expectedBranchPatterns", message: "expectedBranchPatterns must be an array of strings." });
  }
  if (!Array.isArray(v.enabledActions) || v.enabledActions.some((a) => !SHIELD_ACTIONS.includes(a as ShieldAction))) {
    errors.push({
      path: "enabledActions",
      message: `enabledActions must be an array containing only ${SHIELD_ACTIONS.join(", ")}.`,
    });
  }

  // Secret-shaped-field guard: reject known secret-ish keys outright, so a
  // policy accidentally built from the wrong source object (e.g. one that
  // still carries a token/password field) fails validation instead of
  // silently persisting to disk.
  const forbiddenKeys = ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"];
  for (const key of forbiddenKeys) {
    if (key in v) {
      errors.push({ path: key, message: `Policy must not contain a "${key}" field — Shield policy is non-secret by design.` });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    policy: {
      policyVersion: SHIELD_POLICY_VERSION,
      generatedAt: v.generatedAt as number,
      matchedProfileId: v.matchedProfileId as string,
      profileLabel: v.profileLabel as string,
      expectedGitName: v.expectedGitName as string | undefined,
      expectedGitEmail: v.expectedGitEmail as string,
      approvedRepositoryKey: v.approvedRepositoryKey as string | undefined,
      approvedPushDestination: v.approvedPushDestination as ShieldPolicy["approvedPushDestination"],
      trustedSshHostAliases: v.trustedSshHostAliases as string[],
      expectedGitHubLogin: v.expectedGitHubLogin as string | undefined,
      strictPushSetup: v.strictPushSetup as boolean,
      protectedBranches: v.protectedBranches as string[],
      expectedBranchPatterns: v.expectedBranchPatterns as string[],
      enabledActions: v.enabledActions as ShieldAction[],
    },
  };
}

export function serializeShieldPolicy(policy: ShieldPolicy): string {
  return JSON.stringify(policy, null, 2);
}

/**
 * Parses and validates a policy from raw JSON text (as it would be read
 * from disk). Malformed JSON is reported the same shape as a structural
 * validation failure — both collapse to "policy-corrupt" for a caller,
 * without needing to distinguish JSON.parse failures from schema failures.
 */
export function parseShieldPolicy(json: string): ShieldPolicyValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: "$", message: `Policy is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  return validateShieldPolicy(parsed);
}
