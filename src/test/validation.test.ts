import assert from "node:assert/strict";
import test from "node:test";
import { isNonEmptyString, sanitizeStringArray } from "../validation";

/**
 * Webview messages are a trust boundary: a cast can't enforce a shape.
 * These generic validators are what `dispatchSidebarMessage` uses; identity
 * validation has its own suite (identityConfig.test.ts).
 */

test("isNonEmptyString rejects non-strings, empty strings, and whitespace-only strings", () => {
  assert.equal(isNonEmptyString("work"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString("   "), false);
  assert.equal(isNonEmptyString(undefined), false);
  assert.equal(isNonEmptyString(null), false);
  assert.equal(isNonEmptyString(42), false);
  assert.equal(isNonEmptyString({}), false);
  assert.equal(isNonEmptyString(["a"]), false);
});

test("sanitizeStringArray drops non-array input entirely rather than throwing", () => {
  assert.deepEqual(sanitizeStringArray("AcmeSoftware"), []);
  assert.deepEqual(sanitizeStringArray(undefined), []);
  assert.deepEqual(sanitizeStringArray(null), []);
  assert.deepEqual(sanitizeStringArray(42), []);
  assert.deepEqual(sanitizeStringArray({ 0: "a", length: 1 }), []);
});

test("sanitizeStringArray drops individual non-string elements without coercing them", () => {
  assert.deepEqual(sanitizeStringArray(["github.com", 42, null, { evil: true }, "gitlab.com"]), ["github.com", "gitlab.com"]);
});
