import * as vscode from "vscode";
import { Profile, SafetyPreferences } from "../types";
import { sanitizeBranchList, sanitizeProfileList } from "../validation";

const SECTION = "repoIdentityGuard";
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

/**
 * Persisted settings are a trust boundary, not just a typed getter: nothing
 * stops `settings.json` (hand-edited, synced from another machine, written
 * by another extension) from holding a value that doesn't match the
 * `configuration` schema at all — a string instead of an array, an object
 * instead of a string, a missing required field. `.get<Profile[]>` only
 * asserts the TypeScript type; it performs no runtime check. Every array
 * field on every profile is sanitized here so a single malformed entry
 * can't make a downstream `.map`/`.some`/`.filter` throw and take scanning
 * down with it — see `../validation`.
 */
export function getProfiles(): Profile[] {
  const configured = config().get("profiles", []);
  return sanitizeProfileList(configured);
}

export async function saveProfiles(profiles: Profile[]): Promise<void> {
  await config().update("profiles", profiles, vscode.ConfigurationTarget.Global);
}

export function getProtectedBranches(): string[] {
  const configured = config().get("protectedBranches", DEFAULT_PROTECTED_BRANCHES);
  return sanitizeBranchList(configured, DEFAULT_PROTECTED_BRANCHES);
}

export async function saveProtectedBranches(branches: string[]): Promise<void> {
  await config().update("protectedBranches", branches, vscode.ConfigurationTarget.Global);
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function getSafetyPreferences(): SafetyPreferences {
  return {
    requireLocalIdentity: sanitizeBoolean(config().get("requireLocalIdentity", false), false),
    includeMemoryInAiContext: sanitizeBoolean(config().get("includeMemoryInAiContext", false), false),
  };
}

export async function saveRequireLocalIdentity(value: boolean): Promise<void> {
  await config().update("requireLocalIdentity", value, vscode.ConfigurationTarget.Global);
}

export async function saveIncludeMemoryInAiContext(value: boolean): Promise<void> {
  await config().update("includeMemoryInAiContext", value, vscode.ConfigurationTarget.Global);
}

export function affectsRepoIdentityGuardConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return (
    event.affectsConfiguration(`${SECTION}.profiles`) ||
    event.affectsConfiguration(`${SECTION}.protectedBranches`) ||
    event.affectsConfiguration(`${SECTION}.requireLocalIdentity`) ||
    event.affectsConfiguration(`${SECTION}.includeMemoryInAiContext`)
  );
}
