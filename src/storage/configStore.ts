import * as vscode from "vscode";
import { IdentityListResult, identitiesFromLegacyProfiles, validateIdentityList } from "../identity/identityConfig";
import { Identity } from "../identity/types";

const SECTION = "repoIdentityGuard";

/**
 * Settings this version still reads or writes:
 *
 *  - `repoIdentityGuard.identities` — the reusable identity definitions.
 *    Contributed with `"scope": "application"`, and read ONLY from the
 *    user (global) value: a repository's own `.vscode/settings.json` can
 *    never define or override an identity, so opening an untrusted
 *    repository can never change what a lock enforces.
 *
 *  - `repoIdentityGuard.profiles` (RETIRED, read-only) — the old profile
 *    list. Read only from the user (global) value, only for the one-time
 *    identity migration and for the narrow legacy-Shield binding proof in
 *    `src/identity/legacyMigration.ts`. Never written, never matched
 *    against remotes.
 *
 * Obsolete and deterministically IGNORED (never read, never written, no
 * longer contributed; any value left in settings.json has no effect):
 * `repoIdentityGuard.protectedBranches`, `repoIdentityGuard.requireLocalIdentity`
 * (a locked repository is always checked against the EFFECTIVE identity,
 * wherever Git took it from, so "require local config" has no meaning),
 * and `repoIdentityGuard.includeMemoryInAiContext` (the AI-context feature
 * was removed).
 */

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

function globalValue(key: string): unknown {
  return config().inspect<unknown>(key)?.globalValue;
}

/** The validated identity list, plus any entries that were rejected (for display — never silently dropped). */
export function getIdentityList(): IdentityListResult {
  return validateIdentityList(globalValue("identities"));
}

export function getIdentities(): Identity[] {
  return getIdentityList().identities;
}

export async function saveIdentities(identities: Identity[]): Promise<void> {
  await config().update("identities", identities, vscode.ConfigurationTarget.Global);
}

/** The retired profile list, raw (user scope only). Only legacy migration reads it. */
export function getLegacyProfilesRaw(): unknown {
  return globalValue("profiles");
}

/**
 * One-time, deterministic identity migration: when no identities have been
 * configured yet but legacy profiles exist, derive identities from them
 * (see `identitiesFromLegacyProfiles`) and save them. A no-op once
 * `identities` has any user value (even an empty list the user chose), so
 * running it on every activation is safe. Never creates an assignment.
 */
export async function migrateLegacyProfilesToIdentities(): Promise<{ migrated: number; rejected: number }> {
  if (globalValue("identities") !== undefined) return { migrated: 0, rejected: 0 };
  const legacy = getLegacyProfilesRaw();
  if (!Array.isArray(legacy) || legacy.length === 0) return { migrated: 0, rejected: 0 };
  const result = identitiesFromLegacyProfiles(legacy);
  if (result.identities.length > 0) {
    await saveIdentities(result.identities);
  }
  return { migrated: result.identities.length, rejected: result.rejected.length };
}

export function affectsRepoIdentityGuardConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(`${SECTION}.identities`) || event.affectsConfiguration(`${SECTION}.profiles`);
}
