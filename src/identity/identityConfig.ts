import { EnforcementReadyIdentity, Identity, PushEnforcement } from "./types";

/**
 * Runtime validation for identities crossing a trust boundary: the
 * `repoIdentityGuard.identities` user setting (hand-edited, synced, or
 * written by another extension), webview messages, and legacy profile
 * data. TypeScript types vouch for nothing at runtime, so every field is
 * checked here and nothing downstream (policy building, the shell
 * evaluator's one-line block prelude) ever sees an unvalidated value.
 *
 * Pure: no `vscode` import, directly unit-testable.
 */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** github.com username rules: alphanumerics and single hyphens, 1–39 chars, no leading/trailing hyphen. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** An SSH host alias (or literal host, including a bracketed IPv6 literal) — no whitespace, `@`, `/` or `\`, and never a leading `-` (ssh would parse it as an option). */
const SSH_ALIAS = /^[^\s@/\\-][^\s@/\\]*$/;

export type IdentityValidationResult = { ok: true; identity: Identity } | { ok: false; errors: string[] };

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validates one identity STRUCTURALLY. Returns every problem at once (so
 * a UI can show them together) rather than silently dropping a malformed
 * field: an identity whose `expectedGitHubLogin` is invalid must NOT
 * quietly become an identity with no GitHub login.
 *
 * A MISSING `expectedGitHubLogin` (or trusted alias) is not a structural
 * error: such an identity is valid, storable and editable, just not
 * enforcement-ready (see {@link isEnforcementReadyIdentity}) — a
 * repository locked to it blocks every push until it is completed.
 */
export function validateIdentity(raw: unknown): IdentityValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["An identity must be an object."] };
  }
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  const id = cleanString(r.id);
  const label = cleanString(r.label);
  const gitEmail = cleanString(r.gitEmail);
  const gitName = cleanString(r.gitName);
  const expectedGitHubLogin = cleanString(r.expectedGitHubLogin);

  if (!id) errors.push("id is required.");
  if (!label) errors.push("label is required.");
  if (!gitEmail) errors.push("gitEmail is required.");

  for (const [field, value] of [
    ["id", id],
    ["label", label],
    ["gitName", gitName],
    ["gitEmail", gitEmail],
    ["expectedGitHubLogin", expectedGitHubLogin],
  ] as const) {
    if (value !== undefined && CONTROL_CHARS.test(value)) errors.push(`${field} must not contain control characters (such as line breaks).`);
  }
  if (gitEmail && /[<>]/.test(gitEmail)) errors.push("gitEmail must not contain '<' or '>'.");
  if (gitName && /[<>]/.test(gitName)) errors.push("gitName must not contain '<' or '>'.");
  if (r.gitName !== undefined && typeof r.gitName !== "string") errors.push("gitName must be a string.");
  if (r.expectedGitHubLogin !== undefined && typeof r.expectedGitHubLogin !== "string") errors.push("expectedGitHubLogin must be a string.");
  if (expectedGitHubLogin && !GITHUB_LOGIN.test(expectedGitHubLogin)) {
    errors.push(`expectedGitHubLogin "${expectedGitHubLogin}" is not a valid GitHub username.`);
  }

  let trustedSshHostAliases: string[] | undefined;
  if (r.trustedSshHostAliases !== undefined) {
    if (!Array.isArray(r.trustedSshHostAliases)) {
      errors.push("trustedSshHostAliases must be an array of strings.");
    } else {
      const seen = new Set<string>();
      trustedSshHostAliases = [];
      for (const entry of r.trustedSshHostAliases) {
        const alias = cleanString(entry);
        if (!alias || CONTROL_CHARS.test(alias) || !SSH_ALIAS.test(alias)) {
          errors.push(`trustedSshHostAliases contains an invalid alias: ${JSON.stringify(entry)}.`);
          continue;
        }
        if (seen.has(alias.toLowerCase())) continue;
        seen.add(alias.toLowerCase());
        trustedSshHostAliases.push(alias);
      }
    }
  }

  if (errors.length > 0 || !id || !label || !gitEmail) {
    return { ok: false, errors };
  }

  const identity: Identity = { id, label, gitEmail };
  if (gitName) identity.gitName = gitName;
  if (expectedGitHubLogin) identity.expectedGitHubLogin = expectedGitHubLogin;
  if (trustedSshHostAliases && trustedSshHostAliases.length > 0) identity.trustedSshHostAliases = trustedSshHostAliases;
  return { ok: true, identity };
}

export function sanitizeIdentity(raw: unknown): Identity | undefined {
  const result = validateIdentity(raw);
  return result.ok ? result.identity : undefined;
}

export interface IdentityListResult {
  identities: Identity[];
  /** One entry per rejected element, for display — never silently swallowed. */
  rejected: Array<{ index: number; errors: string[] }>;
}

/** Validates a whole identity list: invalid entries and duplicate ids (first wins) are rejected individually, never all-or-nothing. */
export function validateIdentityList(raw: unknown): IdentityListResult {
  if (!Array.isArray(raw)) return { identities: [], rejected: [] };
  const identities: Identity[] = [];
  const rejected: IdentityListResult["rejected"] = [];
  const ids = new Set<string>();
  raw.forEach((entry, index) => {
    const result = validateIdentity(entry);
    if (!result.ok) {
      rejected.push({ index, errors: result.errors });
      return;
    }
    if (ids.has(result.identity.id)) {
      rejected.push({ index, errors: [`Duplicate identity id "${result.identity.id}" — only the first one is used.`] });
      return;
    }
    ids.add(result.identity.id);
    identities.push(result.identity);
  });
  return { identities, rejected };
}

export function sanitizeIdentityList(raw: unknown): Identity[] {
  return validateIdentityList(raw).identities;
}

/**
 * The push requirement a lock for this identity has — see
 * `PushEnforcement` in `./types`. Anything other than `enforced` means
 * every push from a repository locked to it is BLOCKED; there is no value
 * for "push unconfigured, therefore allowed".
 */
export function pushEnforcementFor(identity: Pick<Identity, "expectedGitHubLogin" | "trustedSshHostAliases">): PushEnforcement {
  if (!identity.expectedGitHubLogin) return "needs_configuration";
  return (identity.trustedSshHostAliases ?? []).length > 0 ? "enforced" : "unverifiable";
}

/**
 * True when `identity` can enforce a lock in full (commit AND push) — see
 * {@link EnforcementReadyIdentity}. A structurally valid identity that is
 * not enforcement-ready is still a legitimate, storable, assignable
 * identity; a repository locked to it simply blocks every push until it is
 * completed.
 */
export function isEnforcementReadyIdentity(identity: Identity): identity is EnforcementReadyIdentity {
  return pushEnforcementFor(identity) === "enforced";
}

/**
 * What an identity still needs before it is enforcement-ready, as
 * user-facing sentences (empty when it is ready). Never suggests a value:
 * the GitHub login is never guessed from the email, remote, owner, alias
 * or Git config.
 */
export function identityReadinessProblems(identity: Pick<Identity, "label" | "expectedGitHubLogin" | "trustedSshHostAliases">): string[] {
  const problems: string[] = [];
  if (!identity.expectedGitHubLogin) {
    problems.push(`"${identity.label}" has no GitHub account (expectedGitHubLogin) configured for push verification.`);
  }
  if ((identity.trustedSshHostAliases ?? []).length === 0) {
    problems.push(`"${identity.label}" lists no trusted SSH host alias (trustedSshHostAliases) to push through.`);
  }
  return problems;
}

// ==================== legacy profile → identity ====================

/**
 * Deterministically converts the retired `repoIdentityGuard.profiles`
 * setting into identities. Only the fields that describe WHO the user is
 * survive: `id`, `label`, `gitName`, `gitEmail`, `expectedGitHubLogin`,
 * `trustedSshHostAliases`. Everything that described repository MATCHING
 * or policy — `expectedRemoteOwners`, `exactRepos`,
 * `expectedBranchPatterns`, `strictPushSetup` — is dropped here; it never
 * becomes an assignment (see `legacyMigration.ts` for the one narrow,
 * provable exception involving `exactRepos`).
 *
 * A legacy profile that fails identity validation (e.g. an invalid
 * login) is skipped and reported, never half-converted.
 */
export function identitiesFromLegacyProfiles(rawProfiles: unknown): IdentityListResult {
  if (!Array.isArray(rawProfiles)) return { identities: [], rejected: [] };
  return validateIdentityList(
    rawProfiles.map((profile) => {
      if (!profile || typeof profile !== "object") return profile;
      const p = profile as Record<string, unknown>;
      return {
        id: p.id,
        label: p.label,
        gitName: p.gitName,
        gitEmail: p.gitEmail,
        expectedGitHubLogin: p.expectedGitHubLogin,
        trustedSshHostAliases: p.trustedSshHostAliases,
      };
    }),
  );
}
