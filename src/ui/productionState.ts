import { EffectiveIdentityCheck } from "../identity/effectiveIdentityCheck";
import { pushEnforcementFor } from "../identity/identityConfig";
import { LockStatus } from "../identity/identityLockService";
import { Identity } from "../identity/types";
import type { MemoryNote } from "../types";

/**
 * The production-facing state contract for the real UI — see "PRODUCTION
 * UI DTO" in the task spec. This was originally a SEPARATE module from the
 * placeholder webview's own wire format (`src/ui/wireState.ts`, now
 * removed along with the placeholder it served); `RepoIdentityUiState` is
 * the contract the production webview (`src/webview/client/productionView.ts`)
 * is actually wired onto.
 *
 * The webview must NEVER see: `ShieldLifecycleState` ("off"/"active"/
 * "degraded"/"broken" — an enforcement-engine concept), raw
 * `ShieldInspection` fields, policy versions, hook paths, raw SSH probe
 * data, or the old repos[]/selectedId repository-list architecture. This
 * module is the one place that translates the real backend's richer,
 * engine-level state into small, stable PRODUCT concepts.
 */

// ==================== reason taxonomy ====================

/**
 * A small, stable product-level reason taxonomy — never the raw internal
 * Shield reason strings (`ShieldInspection.reasons`), which are free text,
 * versioned independently of the UI, and not meant for programmatic
 * branching. See "PRODUCT REASON CODES" in the task spec.
 */
export type NeedsAttentionCause =
  | "git_identity_mismatch"
  | "push_identity_incomplete"
  | "push_identity_unverifiable"
  | "identity_missing"
  | "repair_required"
  | "other";

// ==================== identities ====================

export interface IdentitySummary {
  id: string;
  label: string;
  gitName?: string;
  gitEmail: string;
  /** UI-facing name for `expectedGitHubLogin`. */
  githubUsername?: string;
  /** UI-facing name for `trustedSshHostAliases` — ALWAYS the complete array (see "MULTIPLE SSH ALIASES" in the task spec: this is never truncated to one value). */
  sshAliases: string[];
  /** True when this identity can enforce a lock in FULL (commit and push) — see `isEnforcementReadyIdentity`. Structurally valid but incomplete identities are still listed, never hidden or rejected. */
  complete: boolean;
  missingGithubUsername: boolean;
  missingSshProfile: boolean;
}

export function buildIdentitySummary(identity: Pick<Identity, "id" | "label" | "gitName" | "gitEmail" | "expectedGitHubLogin" | "trustedSshHostAliases">): IdentitySummary {
  const sshAliases = [...(identity.trustedSshHostAliases ?? [])];
  const missingGithubUsername = !identity.expectedGitHubLogin;
  const missingSshProfile = sshAliases.length === 0;
  return {
    id: identity.id,
    label: identity.label,
    gitName: identity.gitName,
    gitEmail: identity.gitEmail,
    githubUsername: identity.expectedGitHubLogin,
    sshAliases,
    complete: pushEnforcementFor(identity) === "enforced",
    missingGithubUsername,
    missingSshProfile,
  };
}

// ==================== notes ====================

/**
 * Identical in shape to `MemoryNote` today — re-declared here (rather than
 * re-exported) so the UI contract does not implicitly change if the
 * internal storage type grows a field the UI should not see. Full note
 * text, never pre-truncated: truncation is frontend presentation only.
 */
export interface NoteUiModel {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: number;
  updatedAt?: number;
}

export function buildNoteUiModel(note: MemoryNote): NoteUiModel {
  return { id: note.id, text: note.text, pinned: note.pinned, createdAt: note.createdAt, updatedAt: note.updatedAt };
}

// ==================== lock state ====================

export interface NeedsAttentionDetail {
  /** Safe minimum detail the backend can actually prove — see "DETAILS MUST BE TRUTHFUL": no invented config provenance (global/local/worktree). */
  expectedGitEmail?: string;
  expectedGitName?: string;
  effectiveGitEmail?: string;
  effectiveGitName?: string;
  /** Which role(s) of the live Git identity violate the assigned one — set only for `git_identity_mismatch`. */
  violatingRole?: "author" | "committer" | "both";
  missingGitHubUsername?: boolean;
  missingSshProfile?: boolean;
}

export interface RepairDetail {
  /** True when "Repair Identity Lock" can be expected to fix this on its own (`RepoIdentityEnforcement.repairAvailable`). */
  repairAvailable: boolean;
  /** Human-readable lines straight from the engine's own inspection (`ShieldInspection.reasons`) — truthful, never invented, never parsed for branching (see REPAIR AS A REAL UI STATE). */
  reasons: string[];
}

export type LockUiState =
  | { state: "unassigned" }
  | { state: "locked"; identity: IdentitySummary }
  | { state: "needs_attention"; identity?: IdentitySummary; cause: NeedsAttentionCause; detail?: NeedsAttentionDetail; repairAvailable: boolean }
  | { state: "repair"; identity?: IdentitySummary; detail?: RepairDetail };

export interface RepoIdentityUiState {
  repo?: { id: string; name: string };
  lock: LockUiState;
  identities: IdentitySummary[];
  notes: NoteUiModel[];
  isWorkspaceTrusted: boolean;
}

export interface BuildUiStateInput {
  repo?: { id: string; name: string };
  /** `undefined` only when `repo` is also undefined (no repository open at all). */
  status?: LockStatus;
  /** The live (settings) identity list — used for the identity picker and to build `IdentitySummary`s with their full `trustedSshHostAliases`. */
  liveIdentities: Identity[];
  /**
   * The passive effective-identity check (see
   * `src/identity/effectiveIdentityCheck.ts`) for the CURRENTLY ASSIGNED
   * identity, when one is assigned — omit when none is assigned, or when
   * the caller chose not to run it (e.g. a cheap refresh that only wants
   * artifact-level health). Only ever consulted when the engine itself
   * reports the lock fully installed (`inspection.state === "active"`):
   * commit enforcement is not live at all on a lock that is not even
   * structurally active, so a Git-config mismatch is not the actionable
   * cause in that case — the broken lock is.
   */
  passiveIdentityCheck?: EffectiveIdentityCheck;
  notes: MemoryNote[];
  isWorkspaceTrusted: boolean;
}

/**
 * Builds the identity summary for the CURRENTLY ASSIGNED/enforced
 * identity from the lock's own recorded snapshot (`policySnapshot`) when
 * one is present — never from the live settings list, which may have
 * drifted from what is actually enforced (see `identityDrift`). Falls
 * back to the live identity (by id) only when no snapshot is available at
 * all, and to `undefined` when neither can name it.
 */
function assignedIdentitySummary(status: LockStatus, liveIdentities: Identity[]): IdentitySummary | undefined {
  const snapshot = status.inspection.policySnapshot;
  if (snapshot) {
    return buildIdentitySummary({
      id: snapshot.identityId,
      label: snapshot.identityLabel,
      gitName: snapshot.expectedGitName,
      gitEmail: snapshot.expectedGitEmail,
      expectedGitHubLogin: snapshot.expectedGitHubLogin,
      trustedSshHostAliases: snapshot.trustedSshHostAliases,
    });
  }
  const view = status.assignmentView;
  if (view) {
    const live = liveIdentities.find((identity) => identity.id === view.identityId);
    if (live) return buildIdentitySummary(live);
    return buildIdentitySummary({ id: view.identityId, label: view.identityLabel, gitName: view.gitName, gitEmail: view.gitEmail, expectedGitHubLogin: view.expectedGitHubLogin });
  }
  return undefined;
}

/**
 * Pure mapping from the real backend's richer state onto the small
 * product contract — see this module's top-level doc comment.
 *
 * REPAIR vs NEEDS ATTENTION (see "REPAIR AS A REAL UI STATE"): decided
 * ENTIRELY from structured backend fields, never by parsing a
 * human-readable reason string.
 *
 *  - `!assignmentView.identityStillDefined` → always `needs_attention`
 *    with cause `identity_missing`, even if the engine also reports
 *    `degraded` (identity drift) for the same reason — the assigned
 *    identity no longer existing in settings is the actionable root
 *    cause, and it is never a "repair" (repair cannot know what to
 *    re-enforce without a live identity definition to repair FROM for a
 *    current-version lock — `IdentityLockService.repair` itself refuses
 *    for exactly this reason).
 *  - Otherwise, `inspection.state !== "active"` → `repair`. This is
 *    EXACTLY the engine's own "hooks/evaluator/policy artifacts are not
 *    fully, correctly installed" signal — legacy installs pending
 *    migration, a previous-version lock pending upgrade, missing/modified
 *    hooks, a missing/modified evaluator, a missing/damaged policy, a
 *    foreign hook occupying a slot, an orphaned hook location, or an
 *    edited-identity drift the lock has not caught up with yet. None of
 *    these are "wrong Git email", "missing GitHub username" or "missing
 *    SSH profile" — those never change `inspection.state`.
 *  - Otherwise (`inspection.state === "active"`, i.e. every artifact IS
 *    correctly installed) but the PRODUCT still reports `needs_attention`
 *    → that can only be an incomplete push requirement (no GitHub login,
 *    or no trusted SSH alias) — `push_identity_incomplete` /
 *    `push_identity_unverifiable`.
 *  - A fully `active` lock is then additionally checked against the
 *    PASSIVE effective-identity inspection (new in this phase — the
 *    engine's own `inspection.state` says nothing about the live Git
 *    config that would actually apply to the next commit): a mismatch
 *    there downgrades `locked` to `needs_attention` /
 *    `git_identity_mismatch`, and an inspection failure downgrades it to
 *    `needs_attention` / `other` (never guessed as healthy).
 */
export function buildRepoIdentityUiState(input: BuildUiStateInput): RepoIdentityUiState {
  const identities = input.liveIdentities.map(buildIdentitySummary);
  const notes = input.notes.map(buildNoteUiModel);
  const base = { identities, notes, isWorkspaceTrusted: input.isWorkspaceTrusted, repo: input.repo };

  if (!input.status) {
    return { ...base, lock: { state: "unassigned" } };
  }
  const { status } = input;
  const enforcement = status.enforcement;

  if (enforcement.state === "unassigned") {
    return { ...base, lock: { state: "unassigned" } };
  }

  if (enforcement.state === "unavailable") {
    // Not a Git repository, or Git itself cannot support enforcement —
    // there is no assigned identity to speak of and nothing provable to
    // repair; "other" is the truthful, non-invented cause.
    return { ...base, lock: { state: "needs_attention", cause: "other", repairAvailable: false } };
  }

  const assignmentView = status.assignmentView;
  const identity = assignedIdentitySummary(status, input.liveIdentities);

  // "identity missing" always wins — see the doc comment above.
  if (assignmentView && !assignmentView.identityStillDefined) {
    return { ...base, lock: { state: "needs_attention", identity, cause: "identity_missing", repairAvailable: enforcement.repairAvailable } };
  }

  // The engine itself says the artifacts are not fully/correctly
  // installed — a REPAIR-category problem, never "wrong git identity" or
  // "incomplete push setup".
  if (status.inspection.state !== "active") {
    return {
      ...base,
      lock: {
        state: "repair",
        identity,
        detail: { repairAvailable: enforcement.repairAvailable, reasons: [...status.inspection.reasons] },
      },
    };
  }

  // From here, `inspection.state === "active"`: every lock artifact is
  // correctly installed. `enforcement.state` is either "active" (push
  // enforced too) or "needs_attention" (push incomplete).
  if (enforcement.state === "needs_attention") {
    const push = identity ? pushEnforcementFor({ expectedGitHubLogin: identity.githubUsername, trustedSshHostAliases: identity.sshAliases }) : "needs_configuration";
    const cause: NeedsAttentionCause = push === "needs_configuration" ? "push_identity_incomplete" : push === "unverifiable" ? "push_identity_unverifiable" : "other";
    return {
      ...base,
      lock: {
        state: "needs_attention",
        identity,
        cause,
        repairAvailable: enforcement.repairAvailable,
        detail: identity
          ? { expectedGitEmail: identity.gitEmail, expectedGitName: identity.gitName, missingGitHubUsername: identity.missingGithubUsername, missingSshProfile: identity.missingSshProfile }
          : undefined,
      },
    };
  }

  // enforcement.state === "active": fully locked per the engine. Layer the
  // PASSIVE effective-identity check (never performed by the engine's own
  // inspection) on top before calling it genuinely "locked".
  const passive = input.passiveIdentityCheck;
  if (passive?.inspectionFailed) {
    return { ...base, lock: { state: "needs_attention", identity, cause: "other", repairAvailable: false } };
  }
  if (passive && !passive.matches && identity) {
    return {
      ...base,
      lock: {
        state: "needs_attention",
        identity,
        cause: "git_identity_mismatch",
        repairAvailable: false,
        detail: {
          expectedGitEmail: identity.gitEmail,
          expectedGitName: identity.gitName,
          effectiveGitEmail: passive.violatingRole === "committer" ? passive.effectiveCommitter.email : passive.effectiveAuthor.email,
          effectiveGitName: passive.violatingRole === "committer" ? passive.effectiveCommitter.name : passive.effectiveAuthor.name,
          violatingRole: passive.violatingRole,
        },
      },
    };
  }

  if (!identity) {
    // Should not happen for a genuinely active lock (it always has a
    // recorded snapshot) — fall back truthfully rather than claim "locked"
    // with nothing to show.
    return { ...base, lock: { state: "needs_attention", cause: "other", repairAvailable: false } };
  }
  return { ...base, lock: { state: "locked", identity } };
}
