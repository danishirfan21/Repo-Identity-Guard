import * as crypto from "node:crypto";
import { validateIdentity } from "./identityConfig";
import { Identity } from "./types";

/**
 * Product-level identity CRUD. `repoIdentityGuard.identities` is a plain
 * array setting, and until now the only write available was "replace the
 * whole array" (`configStore.saveIdentities`) — fine for migration, but not
 * a safe primitive for a UI that creates/edits/deletes ONE identity at a
 * time out from under whatever else is in the list. These functions are
 * pure (no `vscode` import): given the CURRENT list, they return either the
 * NEXT list or a structured failure, and the caller (configStore) is the
 * only place that actually persists it.
 *
 * Structural validation is never duplicated here: `validateIdentity` (the
 * same function settings-load validation uses) is the only place that
 * decides whether an identity is well-formed. These functions add only
 * PRODUCT-level policy on top: unique id, unique (case-insensitive) label,
 * and (for delete) never silently orphaning a currently-open assignment.
 *
 * Incomplete identities (no `expectedGitHubLogin`, no
 * `trustedSshHostAliases`) are deliberately NOT rejected here — see
 * `src/identity/types.ts`. A missing push field is a push-enforcement
 * problem, never a reason to refuse storing, editing or keeping an
 * identity.
 */

export interface IdentityDraft {
  /** Present (and must name an existing identity) for an update; absent for a create. */
  id?: string;
  label: string;
  gitEmail: string;
  gitName?: string;
  /** UI-facing name for `Identity.expectedGitHubLogin` — see `src/ui/productionState.ts`. */
  githubUsername?: string;
  /**
   * UI-facing name for `Identity.trustedSshHostAliases` — ALWAYS the
   * complete array, never truncated to one value. See the "multiple SSH
   * aliases" invariant in `src/ui/productionState.ts`.
   */
  sshAliases: string[];
}

export type IdentityCrudResult = { ok: true; identities: Identity[]; identity: Identity } | { ok: false; code: "invalid"; errors: string[] } | { ok: false; code: "duplicate_id"; errors: string[] } | { ok: false; code: "duplicate_label"; errors: string[] } | { ok: false; code: "not_found"; errors: string[] };

export interface IdentityInUseRepo {
  /** Display name only — never a filesystem path (see "IDENTITY DELETE UI RESULT DATA" in the task spec). */
  repoName: string;
}

export type IdentityDeleteResult =
  | { ok: true; identities: Identity[] }
  | { ok: false; code: "not_found"; errors: string[] }
  | { ok: false; code: "identity_in_use"; errors: string[]; repoNames: string[] };

function draftToRaw(draft: IdentityDraft, id: string): unknown {
  return {
    id,
    label: draft.label,
    gitEmail: draft.gitEmail,
    gitName: draft.gitName,
    expectedGitHubLogin: draft.githubUsername,
    trustedSshHostAliases: draft.sshAliases,
  };
}

function findDuplicateLabel(identities: readonly Identity[], label: string, excludeId?: string): boolean {
  const normalized = label.trim().toLowerCase();
  return identities.some((identity) => identity.id !== excludeId && identity.label.trim().toLowerCase() === normalized);
}

/**
 * Creates a new identity. `newId` is injectable for deterministic tests;
 * production callers can leave it out (a CSPRNG-derived id, matching how
 * lock ids are already generated in `IdentityLockService`).
 */
export function createIdentity(identities: readonly Identity[], draft: IdentityDraft, newId: () => string = () => crypto.randomBytes(12).toString("hex")): IdentityCrudResult {
  const id = newId();
  const validated = validateIdentity(draftToRaw(draft, id));
  if (!validated.ok) return { ok: false, code: "invalid", errors: validated.errors };
  if (identities.some((identity) => identity.id === validated.identity.id)) {
    return { ok: false, code: "duplicate_id", errors: [`Identity id "${validated.identity.id}" already exists.`] };
  }
  if (findDuplicateLabel(identities, validated.identity.label)) {
    return { ok: false, code: "duplicate_label", errors: [`An identity named "${validated.identity.label}" already exists. Choose a different name.`] };
  }
  return { ok: true, identities: [...identities, validated.identity], identity: validated.identity };
}

/** Updates the identity named by `draft.id`. The id itself never changes (an update is never a rename-by-id). */
export function updateIdentity(identities: readonly Identity[], draft: IdentityDraft): IdentityCrudResult {
  if (!draft.id) return { ok: false, code: "not_found", errors: ["No identity id was given to update."] };
  const index = identities.findIndex((identity) => identity.id === draft.id);
  if (index === -1) return { ok: false, code: "not_found", errors: [`Identity "${draft.id}" does not exist.`] };

  const validated = validateIdentity(draftToRaw(draft, draft.id));
  if (!validated.ok) return { ok: false, code: "invalid", errors: validated.errors };
  if (findDuplicateLabel(identities, validated.identity.label, draft.id)) {
    return { ok: false, code: "duplicate_label", errors: [`An identity named "${validated.identity.label}" already exists. Choose a different name.`] };
  }
  const next = [...identities];
  next[index] = validated.identity;
  return { ok: true, identities: next, identity: validated.identity };
}

/**
 * Deletes `id`, but never while a CURRENTLY OPEN/known repository is
 * assigned to it (`openAssignments`) — there is deliberately no
 * filesystem-wide repository registry (see "IDENTITY DELETE SAFETY" in the
 * task spec), so this can only ever know about repositories already open
 * in this VS Code session. A repository that is not currently open is
 * truthfully unknown here: if it later opens still assigned to a deleted
 * identity, its persisted lock snapshot remains enforcement-safe (the lock
 * policy, not this settings list, is what enforcement reads) and the UI
 * reports Needs Attention / "identity missing" — see
 * `src/ui/productionState.ts`.
 */
export function deleteIdentity(identities: readonly Identity[], id: string, openAssignments: readonly IdentityInUseRepo[]): IdentityDeleteResult {
  if (!identities.some((identity) => identity.id === id)) {
    return { ok: false, code: "not_found", errors: [`Identity "${id}" does not exist.`] };
  }
  if (openAssignments.length > 0) {
    const repoNames = openAssignments.map((a) => a.repoName);
    return {
      ok: false,
      code: "identity_in_use",
      errors: [`"${id}" is assigned to ${repoNames.length} currently open repositor${repoNames.length === 1 ? "y" : "ies"}: ${repoNames.join(", ")}. Unassign or change it there first.`],
      repoNames,
    };
  }
  return { ok: true, identities: identities.filter((identity) => identity.id !== id) };
}
