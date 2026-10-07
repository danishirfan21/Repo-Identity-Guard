/**
 * Git operations the identity lock's enforcement engine can guard.
 * Deliberately a closed, explicit set — never inferred from an arbitrary
 * command line or hook name string, so a new hook type can never silently
 * start being "guarded" just because Git happens to invoke a same-named
 * script.
 *
 * (Historical note: this engine was previously exposed to users as
 * "Shield Mode". It is now an internal implementation detail of the
 * identity lock — see `src/identity/identityLockService.ts` — and the
 * `Shield*` names below are kept only because renaming hardened internals
 * buys nothing functionally.)
 */
export type ShieldAction = "commit" | "push";

export const SHIELD_ACTIONS: readonly ShieldAction[] = ["commit", "push"];

/**
 * The enforcement engine's own on-disk lifecycle. Internal only: the
 * product-facing state is `RepoIdentityState.enforcement.state`
 * (`unassigned` / `active` / `needs_attention` / `unavailable`), which
 * `IdentityLockService` derives from this plus the lock policy.
 */
export type ShieldLifecycleState = "off" | "active" | "degraded" | "broken";

export const SHIELD_LIFECYCLE_STATES: readonly ShieldLifecycleState[] = [
  "off",
  "active",
  "degraded",
  "broken",
];

/**
 * Stable, machine-readable reason identifiers a {@link ShieldDecision} can
 * carry. These are a public contract — they appear verbatim in the
 * `REASON_ID:` line of every block message a hook prints, which AI agents
 * and scripts may key off — so an id's *meaning* must never change.
 *
 * The taxonomy is deliberately narrow: the identity lock answers exactly
 * one question ("is this commit/push using the assigned identity?"), so
 * the only reasons are about commit identity, push identity (and the
 * transport facts needed to establish it), and the lock's own integrity.
 * Branch policy, repository-operation state and push-destination ownership
 * reasons were removed together with those product features.
 */
export type ShieldReasonId =
  | "commit-identity-mismatch"
  | "commit-identity-override"
  | "push-route-unverified"
  | "push-route-override"
  | "push-account-mismatch"
  | "push-account-unverified"
  | "policy-missing"
  | "policy-corrupt"
  | "inspection-failed";

export const SHIELD_REASON_IDS: readonly ShieldReasonId[] = [
  "commit-identity-mismatch",
  "commit-identity-override",
  "push-route-unverified",
  "push-route-override",
  "push-account-mismatch",
  "push-account-unverified",
  "policy-missing",
  "policy-corrupt",
  "inspection-failed",
];

export function isShieldReasonId(value: unknown): value is ShieldReasonId {
  return typeof value === "string" && (SHIELD_REASON_IDS as readonly string[]).includes(value);
}

/** One reason a {@link ShieldDecision} denied an action. */
export interface ShieldReason {
  id: ShieldReasonId;
  message: string;
}

/**
 * The result of evaluating one Git action against the current lock policy
 * and current Git state, at the moment it's about to happen.
 *
 * A ShieldDecision is a **point-in-time snapshot, never a cache**: it must
 * be recomputed by re-reading Git state at the moment of the action (inside
 * the hook), never reused from an earlier extension scan.
 */
export interface ShieldDecision {
  action: ShieldAction;
  allowed: boolean;
  reasons: ShieldReason[];
  /** Epoch milliseconds this decision was computed — never persisted or reused for a later action. */
  evaluatedAt: number;
}

/** Constructs an allowed decision with no reasons. */
export function allowDecision(action: ShieldAction, evaluatedAt: number = Date.now()): ShieldDecision {
  return { action, allowed: true, reasons: [], evaluatedAt };
}

/** Constructs a denied decision. Throws if called with zero reasons — a denial must always be explainable. */
export function denyDecision(
  action: ShieldAction,
  reasons: ShieldReason[],
  evaluatedAt: number = Date.now(),
): ShieldDecision {
  if (reasons.length === 0) {
    throw new Error("denyDecision requires at least one reason — a denial must always be explainable.");
  }
  return { action, allowed: false, reasons, evaluatedAt };
}

/** Builds a decision from whatever reasons were collected during evaluation: allowed when there are none, denied otherwise. */
export function decisionFromReasons(
  action: ShieldAction,
  reasons: ShieldReason[],
  evaluatedAt: number = Date.now(),
): ShieldDecision {
  return reasons.length === 0 ? allowDecision(action, evaluatedAt) : denyDecision(action, reasons, evaluatedAt);
}
