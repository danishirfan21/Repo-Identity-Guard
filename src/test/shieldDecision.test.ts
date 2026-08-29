import assert from "node:assert/strict";
import test from "node:test";
import { SHIELD_REASON_CATALOG } from "../shield/reasonCatalog";
import {
  SHIELD_ACTIONS,
  SHIELD_LIFECYCLE_STATES,
  SHIELD_REASON_IDS,
  allowDecision,
  decisionFromReasons,
  denyDecision,
  isShieldReasonId,
} from "../shield/types";

test("allowDecision produces an allowed decision with no reasons", () => {
  const decision = allowDecision("commit", 1000);
  assert.equal(decision.action, "commit");
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.evaluatedAt, 1000);
});

test("denyDecision requires at least one reason — a denial must always be explainable", () => {
  assert.throws(() => denyDecision("push", []), /at least one reason/);
});

test("denyDecision carries every reason given, not just the first", () => {
  const decision = denyDecision(
    "commit",
    [
      { id: "protected-branch", message: "on main" },
      { id: "commit-identity-mismatch", message: "wrong identity" },
    ],
    2000,
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasons.length, 2);
  assert.equal(decision.evaluatedAt, 2000);
});

test("decisionFromReasons allows when there are no reasons and denies otherwise", () => {
  const allowed = decisionFromReasons("push", [], 1);
  assert.equal(allowed.allowed, true);

  const denied = decisionFromReasons("push", [{ id: "push-route-unverified", message: "x" }], 2);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasons[0]?.id, "push-route-unverified");
});

test("every ShieldReasonId has a catalog entry with a non-empty description (compile-time-enforced, verified here too)", () => {
  for (const id of SHIELD_REASON_IDS) {
    const entry = SHIELD_REASON_CATALOG[id];
    assert.ok(entry, `missing catalog entry for ${id}`);
    assert.ok(entry.description.length > 0, `empty description for ${id}`);
  }
  // And no stray, unrecognized keys sneaked into the catalog.
  assert.deepEqual(Object.keys(SHIELD_REASON_CATALOG).sort(), [...SHIELD_REASON_IDS].sort());
});

test("isShieldReasonId accepts only known reason ids", () => {
  assert.equal(isShieldReasonId("protected-branch"), true);
  assert.equal(isShieldReasonId("policy-corrupt"), true);
  assert.equal(isShieldReasonId("not-a-real-reason"), false);
  assert.equal(isShieldReasonId(42), false);
  assert.equal(isShieldReasonId(undefined), false);
});

test("SHIELD_ACTIONS is exactly commit and push", () => {
  assert.deepEqual([...SHIELD_ACTIONS].sort(), ["commit", "push"]);
});

test("SHIELD_LIFECYCLE_STATES is exactly off/active/degraded/broken", () => {
  assert.deepEqual([...SHIELD_LIFECYCLE_STATES].sort(), ["active", "broken", "degraded", "off"]);
});
