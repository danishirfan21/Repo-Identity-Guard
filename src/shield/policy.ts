import type { Identity } from "../identity/types";
import { SHIELD_ACTIONS, ShieldAction } from "./types";

/**
 * Lock policy schema version.
 *
 * - v1/v2 were the retired "Shield Mode" policy: a profile matched by
 *   remote owner, plus branch protection, an approved push destination,
 *   and a user-facing `strictPushSetup` switch. They are never enforced by
 *   this build — the shell evaluator rejects them as `policy-corrupt`
 *   (fail closed), and `IdentityLockService.migrateLegacy` either converts
 *   a provable explicit binding into an identity lock or removes the
 *   legacy installation (see `src/identity/legacyMigration.ts`).
 * - v3 was the first identity-lock policy. It carried an `enforcedActions`
 *   list that dropped `"push"` whenever the identity had no GitHub login,
 *   which let every push through unchecked from an ASSIGNED repository.
 *   This build never enforces a v3 policy (the evaluator fails closed on
 *   it); `IdentityLockService.upgradePreviousLock` rewrites it as v4,
 *   preserving the assignment (identity snapshot, `lockId`, `assignedAt`) —
 *   see {@link upgradePreviousLockPolicy}.
 * - v4 is the identity lock: one explicitly assigned identity, and BOTH
 *   commit and push are always governed. There is no per-action switch: a
 *   missing `expectedGitHubLogin` no longer takes push out of the policy,
 *   it makes the push requirement incomplete, and every push is blocked
 *   (`push-identity-not-configured`). It is also the durable assignment
 *   record itself (see `src/identity/assignment.ts`).
 */
export const SHIELD_POLICY_VERSION = 4 as const;

/** Policy versions written by earlier releases — recognized only so they can be migrated, never enforced. */
export const LEGACY_SHIELD_POLICY_VERSIONS: readonly number[] = [1, 2];

/** Earlier identity-lock policy versions — a real assignment, recognized only so it can be upgraded in place (assignment preserved), never enforced. */
export const PREVIOUS_LOCK_POLICY_VERSIONS: readonly number[] = [3];

/** Every action a lock governs — always both, for every assigned repository. */
export const GOVERNED_ACTIONS: readonly ShieldAction[] = SHIELD_ACTIONS;

/**
 * Non-secret description of the identity one repository is locked to.
 * Represents explicit user intent (the assignment), never a cached
 * verdict. Every field is either already visible in settings.json (the
 * identity fields) or random bookkeeping (`lockId`).
 *
 * Never include: access tokens, passwords, private SSH key material or
 * paths, credential-helper output, or `.env` contents.
 */
export interface ShieldPolicy {
  policyVersion: typeof SHIELD_POLICY_VERSION;
  /**
   * Random id minted when the identity was assigned (kept stable across
   * repairs and identity re-syncs of the same assignment, replaced when a
   * different identity is assigned). Lets a UI/test tell "this exact
   * assignment" apart from a later one; never a security boundary.
   */
  lockId: string;
  /** Epoch milliseconds the assignment was made. */
  assignedAt: number;
  /** Epoch milliseconds this policy file was (re)generated. */
  generatedAt: number;

  identityId: string;
  identityLabel: string;

  expectedGitName?: string;
  expectedGitEmail: string;

  /**
   * github.com login every push must authenticate as. ABSENT (or empty)
   * means the push requirement is incomplete: every push is BLOCKED with
   * `push-identity-not-configured` — never allowed unchecked. Push is
   * governed by every policy regardless (see {@link GOVERNED_ACTIONS});
   * there is no field that can take it out of the lock.
   */
  expectedGitHubLogin?: string;
  /**
   * SSH aliases accepted as push routes for `expectedGitHubLogin` (see
   * `Identity.trustedSshHostAliases`). Empty means no route can be
   * verified: every push is blocked with `push-route-unverified`.
   */
  trustedSshHostAliases: string[];
}

export interface ShieldPolicyInput {
  identity: Identity;
  lockId: string;
  assignedAt: number;
  now?: number;
}

/** Builds a policy purely from already-validated, non-secret inputs — no I/O. */
export function buildShieldPolicy(input: ShieldPolicyInput): ShieldPolicy {
  const { identity } = input;
  const policy: ShieldPolicy = {
    policyVersion: SHIELD_POLICY_VERSION,
    lockId: input.lockId,
    assignedAt: input.assignedAt,
    generatedAt: input.now ?? Date.now(),
    identityId: identity.id,
    identityLabel: identity.label,
    expectedGitEmail: identity.gitEmail,
    trustedSshHostAliases: [...(identity.trustedSshHostAliases ?? [])],
  };
  if (identity.gitName) policy.expectedGitName = identity.gitName;
  if (identity.expectedGitHubLogin) policy.expectedGitHubLogin = identity.expectedGitHubLogin;
  return policy;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Structurally validates an arbitrary value as a {@link ShieldPolicy}.
 * Deliberately hand-rolled and strict about `policyVersion`: a policy from
 * an older (legacy Shield) or newer release must never be silently
 * reinterpreted. Mirrored 1:1 by the schema checks in
 * `resources/shield/shield-evaluate.sh`; the parser fuzz suite keeps them
 * in agreement.
 */
export function validateShieldPolicy(value: unknown): ShieldPolicyValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "$", message: "Policy must be a JSON object." }] };
  }
  const v = value as Record<string, unknown>;
  const errors: ShieldPolicyValidationError[] = [];

  if (v.policyVersion !== SHIELD_POLICY_VERSION) {
    errors.push({
      path: "policyVersion",
      message:
        typeof v.policyVersion === "number" && LEGACY_SHIELD_POLICY_VERSIONS.includes(v.policyVersion)
          ? `This is a legacy Shield policy (version ${v.policyVersion}); it must be migrated, not enforced.`
          : typeof v.policyVersion === "number" && PREVIOUS_LOCK_POLICY_VERSIONS.includes(v.policyVersion)
            ? `This is an identity-lock policy from an earlier version (version ${v.policyVersion}); it must be upgraded, not enforced.`
            : `Expected policyVersion ${SHIELD_POLICY_VERSION}, got ${JSON.stringify(v.policyVersion)}.`,
    });
  }
  // v4 governs commit AND push unconditionally. A per-action list is not
  // part of the schema, and its presence is refused rather than ignored so
  // nobody can believe that editing it takes push out of the lock.
  if ("enforcedActions" in v) {
    errors.push({
      path: "enforcedActions",
      message: "enforcedActions is not part of the identity-lock policy (version 4): commit and push are always both governed.",
    });
  }
  errors.push(...lockFieldErrors(v));

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, policy: policyFromValidatedFields(v) };
}

/**
 * Field checks shared by every identity-lock policy version (v3 and v4):
 * everything except `policyVersion` and v3's `enforcedActions`.
 */
function lockFieldErrors(v: Record<string, unknown>): ShieldPolicyValidationError[] {
  const errors: ShieldPolicyValidationError[] = [];
  if (!isNonEmptyString(v.lockId)) {
    errors.push({ path: "lockId", message: "lockId must be a non-empty string." });
  }
  for (const key of ["assignedAt", "generatedAt"] as const) {
    if (typeof v[key] !== "number" || !Number.isFinite(v[key])) {
      errors.push({ path: key, message: `${key} must be a finite number (epoch milliseconds).` });
    }
  }
  for (const key of ["identityId", "identityLabel", "expectedGitEmail"] as const) {
    if (!isNonEmptyString(v[key])) {
      errors.push({ path: key, message: `${key} must be a non-empty string.` });
    }
  }
  for (const key of ["expectedGitName", "expectedGitHubLogin"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push({ path: key, message: `${key} must be a string when present.` });
    }
  }
  if (!isStringArray(v.trustedSshHostAliases)) {
    errors.push({ path: "trustedSshHostAliases", message: "trustedSshHostAliases must be an array of strings." });
  }

  // Secret-shaped-field guard: a policy accidentally built from the wrong
  // source object must fail validation instead of silently persisting.
  for (const key of FORBIDDEN_POLICY_KEYS) {
    if (key in v) {
      errors.push({ path: key, message: `Policy must not contain a "${key}" field — the lock policy is non-secret by design.` });
    }
  }
  return errors;
}

const FORBIDDEN_POLICY_KEYS = ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"];

/** The v4 policy carried by fields that already passed {@link lockFieldErrors}. */
function policyFromValidatedFields(v: Record<string, unknown>): ShieldPolicy {
  const policy: ShieldPolicy = {
    policyVersion: SHIELD_POLICY_VERSION,
    lockId: v.lockId as string,
    assignedAt: v.assignedAt as number,
    generatedAt: v.generatedAt as number,
    identityId: v.identityId as string,
    identityLabel: v.identityLabel as string,
    expectedGitEmail: v.expectedGitEmail as string,
    trustedSshHostAliases: [...(v.trustedSshHostAliases as string[])],
  };
  if (typeof v.expectedGitName === "string") policy.expectedGitName = v.expectedGitName;
  if (typeof v.expectedGitHubLogin === "string") policy.expectedGitHubLogin = v.expectedGitHubLogin;
  return policy;
}

/**
 * Reads a PREVIOUS-version (v3) identity-lock policy — a real, explicit
 * assignment written by an earlier release — and returns the v4 policy
 * that carries the same assignment forward: identical identity snapshot,
 * `lockId` and `assignedAt`. Returns `undefined` when the text is not a
 * well-formed v3 lock policy (anything else is corruption, not an
 * assignment, and is never "upgraded" into one).
 *
 * The upgrade deliberately DROPS v3's `enforcedActions`: a v3 policy whose
 * list omitted `"push"` (an identity with no GitHub login) becomes a v4
 * policy with no `expectedGitHubLogin` — i.e. commits stay enforced
 * exactly as before, and every push is now BLOCKED as
 * `push-identity-not-configured` until the user configures a login. A v3
 * lock is never silently unlocked, and never silently given a login.
 */
export function upgradePreviousLockPolicy(json: string): ShieldPolicy | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const v = parsed as Record<string, unknown>;
  if (typeof v.policyVersion !== "number" || !PREVIOUS_LOCK_POLICY_VERSIONS.includes(v.policyVersion)) return undefined;
  if (lockFieldErrors(v).length > 0) return undefined;
  // v3's own consistency rule for its action list: well-formed, and always
  // containing "commit". Anything else was already corrupt under v3.
  if (!Array.isArray(v.enforcedActions) || v.enforcedActions.some((a) => !SHIELD_ACTIONS.includes(a as ShieldAction))) return undefined;
  if (!(v.enforcedActions as ShieldAction[]).includes("commit")) return undefined;
  return policyFromValidatedFields(v);
}

export function serializeShieldPolicy(policy: ShieldPolicy): string {
  return JSON.stringify(policy, null, 2);
}

/** Parses and validates a policy from raw JSON text. Malformed JSON and schema failures collapse to the same shape. */
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

/**
 * The only two facts a legacy (v1/v2) Shield policy contributes to
 * migration: which legacy profile it was enabled for, and which canonical
 * `host/owner/repo` key it approved. Read leniently (anything missing is
 * simply undefined) because a legacy policy is never enforced from here —
 * it only ever serves as evidence that MIGHT prove an explicit binding.
 * Returns `undefined` when the text is not a legacy policy at all.
 */
export interface LegacyPolicyInfo {
  policyVersion: number;
  matchedProfileId?: string;
  approvedRepositoryKey?: string;
}

export function readLegacyPolicyInfo(json: string): LegacyPolicyInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const v = parsed as Record<string, unknown>;
  if (typeof v.policyVersion !== "number" || !LEGACY_SHIELD_POLICY_VERSIONS.includes(v.policyVersion)) return undefined;
  return {
    policyVersion: v.policyVersion,
    matchedProfileId: isNonEmptyString(v.matchedProfileId) ? v.matchedProfileId : undefined,
    approvedRepositoryKey: isNonEmptyString(v.approvedRepositoryKey) ? v.approvedRepositoryKey : undefined,
  };
}
