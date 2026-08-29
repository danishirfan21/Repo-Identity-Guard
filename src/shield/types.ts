import { Capability } from "../types";

/**
 * Git operations Shield Mode can guard. Deliberately a closed, explicit set
 * — never inferred from an arbitrary command line or hook name string, so a
 * new hook type can never silently start being "guarded" just because Git
 * happens to invoke a same-named script.
 */
export type ShieldAction = "commit" | "push";

export const SHIELD_ACTIONS: readonly ShieldAction[] = ["commit", "push"];

/**
 * Shield's own lifecycle, distinct from the SAFE/NOT SAFE/NOT CHECKED
 * safety verdict — a repo can be perfectly SAFE while Shield itself is
 * "off", and a repo can be NOT SAFE while Shield is "active" and correctly
 * blocking the operation that caused it. See docs/SHIELD_MODE.md
 * "Lifecycle states" for the full definition of each state and how a hook
 * (once one exists, in a later phase) should behave in each.
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
 * carry. These are a public contract: once shipped, an id's *meaning* must
 * never change, and ids are additive-only (never renumbered or repurposed).
 * A future hook script, log line, or telemetry event keys off these ids —
 * never off the human-readable `message`, which can be reworded freely.
 */
export type ShieldReasonId =
  | "profile-unresolved"
  | "profile-conflict"
  | "commit-identity-mismatch"
  | "commit-identity-override"
  | "protected-branch"
  | "detached-head"
  | "repo-operation-in-progress"
  | "merge-conflicts"
  | "push-destination-mismatch"
  | "push-route-unverified"
  | "push-route-mismatch"
  | "policy-missing"
  | "policy-corrupt"
  | "inspection-failed";

export const SHIELD_REASON_IDS: readonly ShieldReasonId[] = [
  "profile-unresolved",
  "profile-conflict",
  "commit-identity-mismatch",
  "commit-identity-override",
  "protected-branch",
  "detached-head",
  "repo-operation-in-progress",
  "merge-conflicts",
  "push-destination-mismatch",
  "push-route-unverified",
  "push-route-mismatch",
  "policy-missing",
  "policy-corrupt",
  "inspection-failed",
];

export function isShieldReasonId(value: unknown): value is ShieldReasonId {
  return typeof value === "string" && (SHIELD_REASON_IDS as readonly string[]).includes(value);
}

/**
 * One reason a {@link ShieldDecision} denied (or would have denied) an
 * action. `capability` links back to the existing six-capability vocabulary
 * (see `../types`'s `Capability`) when this reason corresponds directly to
 * one of those checks, so the same underlying fact is never worded two
 * different ways between the sidebar and a Shield hook's terminal output.
 * Not every reason maps to a capability (e.g. `policy-missing` is a Shield
 * concept with no sidebar equivalent).
 */
export interface ShieldReason {
  id: ShieldReasonId;
  message: string;
  capability?: Capability;
}

/**
 * The result of evaluating one Git action against the current policy and
 * current Git state, at the moment it's about to happen.
 *
 * A ShieldDecision is a **point-in-time snapshot, never a cache**: it must
 * be recomputed by re-reading Git state at the moment of the action (inside
 * the hook, once hooks exist), never reused from an earlier sidebar scan.
 * The sidebar's `StatusSummary` can be minutes old by the time a commit
 * actually happens (an agent can act long after the last scan); a
 * ShieldDecision that guards a real Git operation cannot afford that same
 * staleness. See docs/SHIELD_MODE.md "Decisions are never cached".
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

/**
 * Builds a decision from whatever reasons were collected during
 * evaluation: allowed when there are none, denied (with all of them
 * surfaced, not just the first) otherwise. This is the shape an evaluator
 * should use — collect every applicable reason, then call this once, so a
 * denial always explains everything wrong at once rather than one problem
 * per attempt.
 */
export function decisionFromReasons(
  action: ShieldAction,
  reasons: ShieldReason[],
  evaluatedAt: number = Date.now(),
): ShieldDecision {
  return reasons.length === 0 ? allowDecision(action, evaluatedAt) : denyDecision(action, reasons, evaluatedAt);
}
