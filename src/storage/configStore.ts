import * as vscode from "vscode";
import { Profile, SafetyPreferences } from "../types";

const SECTION = "repoIdentityGuard";
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function getProfiles(): Profile[] {
  const configured = config().get<Profile[]>("profiles", []);
  return configured.filter(
    (profile) =>
      typeof profile?.id === "string" &&
      typeof profile?.label === "string" &&
      typeof profile?.gitEmail === "string",
  );
}

export async function saveProfiles(profiles: Profile[]): Promise<void> {
  await config().update("profiles", profiles, vscode.ConfigurationTarget.Global);
}

export function getProtectedBranches(): string[] {
  const configured = config().get<string[]>("protectedBranches", DEFAULT_PROTECTED_BRANCHES);
  return configured.length > 0 ? configured : DEFAULT_PROTECTED_BRANCHES;
}

export async function saveProtectedBranches(branches: string[]): Promise<void> {
  await config().update("protectedBranches", branches, vscode.ConfigurationTarget.Global);
}

export function getSafetyPreferences(): SafetyPreferences {
  return {
    requireLocalIdentity: config().get<boolean>("requireLocalIdentity", false),
    includeMemoryInAiContext: config().get<boolean>("includeMemoryInAiContext", false),
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
