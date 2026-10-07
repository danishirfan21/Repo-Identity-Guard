import { pushEnforcementFor } from "../identity/identityConfig";
import { EnforcementState, Identity, PushEnforcement, RepoIdentityState } from "../identity/types";

/**
 * The data posted to the (placeholder) webview, and the pure function that
 * derives it. No `vscode` import, so it is unit-testable directly.
 *
 * Multi-root: every repository is listed with its OWN enforcement state.
 * There is deliberately no workspace-wide aggregate of any kind — one
 * unassigned or misconfigured repository says nothing about another.
 */

export interface RepoEntryModel {
  /** Canonical checkout root — unique per worktree. */
  id: string;
  folderName?: string;
  state: RepoIdentityState;
}

export interface SidebarModel {
  repos: RepoEntryModel[];
  selectedId?: string;
  identities: Identity[];
  /** Human-readable problems with configured identities (rejected entries) — shown, never silently dropped. */
  identityProblems: string[];
  isWorkspaceTrusted: boolean;
}

export interface WireRepo {
  id: string;
  name: string;
  enforcementState: EnforcementState;
  assignedLabel?: string;
  selected: boolean;
}

export interface WireIdentity {
  id: string;
  label: string;
  gitName?: string;
  gitEmail: string;
  expectedGitHubLogin?: string;
  push: PushEnforcement;
}

export interface WireState {
  repos: WireRepo[];
  /** Full state of the selected repository (repoRoot omitted — the webview never needs a local path). */
  selected?: Omit<RepoIdentityState, "repoRoot"> & { id: string };
  identities: WireIdentity[];
  identityProblems: string[];
  isWorkspaceTrusted: boolean;
}

export function toWireState(model: SidebarModel): WireState {
  const selectedEntry = model.repos.find((repo) => repo.id === model.selectedId) ?? model.repos[0];
  let selected: WireState["selected"];
  if (selectedEntry) {
    // Destructure repoRoot out rather than copying the whole object: the
    // webview has no use for a local filesystem path.
    const { repoRoot: _omit, ...rest } = selectedEntry.state;
    void _omit;
    selected = { ...rest, id: selectedEntry.id };
  }
  return {
    repos: model.repos.map((repo) => ({
      id: repo.id,
      name: repo.state.repoName ?? repo.folderName ?? "(unnamed repository)",
      enforcementState: repo.state.enforcement.state,
      assignedLabel: repo.state.assignment?.identityLabel,
      selected: repo === selectedEntry,
    })),
    selected,
    identities: model.identities.map((identity) => ({
      id: identity.id,
      label: identity.label,
      gitName: identity.gitName,
      gitEmail: identity.gitEmail,
      expectedGitHubLogin: identity.expectedGitHubLogin,
      push: pushEnforcementFor(identity),
    })),
    identityProblems: model.identityProblems,
    isWorkspaceTrusted: model.isWorkspaceTrusted,
  };
}
