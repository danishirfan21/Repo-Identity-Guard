import assert from "node:assert/strict";
import test from "node:test";
import { resolveCurrentRepoId } from "../identity/currentRepo";

/**
 * The current-repository resolver — the ONE rule deciding which repository
 * the sidebar and every Command Palette command act on. No repository
 * picker, no workspace dashboard: see FROZEN PRODUCT RULES in the task
 * spec and `src/identity/currentRepo.ts`'s own doc comment for the rule
 * itself (A–D).
 */

const A = { id: "a", repoRoot: "/work/a" };
const B = { id: "b", repoRoot: "/work/b" };
const C = { id: "c", repoRoot: "/work/c" };

test("no repository known -> no current repository (rule D)", () => {
  assert.equal(resolveCurrentRepoId({ repos: [] }), undefined);
});

test("exactly one repository known -> it is current, even with no active editor (rule B)", () => {
  assert.equal(resolveCurrentRepoId({ repos: [A] }), "a");
});

test("active editor inside a known repository determines the current repository (rule A)", () => {
  assert.equal(
    resolveCurrentRepoId({ repos: [A, B], activeFilePath: "/work/b/src/file.ts" }),
    "b",
  );
});

test("active editor at the repository root itself still matches", () => {
  assert.equal(resolveCurrentRepoId({ repos: [A, B], activeFilePath: "/work/a" }), "a");
});

test("active editor switches between roots: each call re-resolves independently", () => {
  const repos = [A, B];
  assert.equal(resolveCurrentRepoId({ repos, activeFilePath: "/work/a/x.ts" }), "a");
  assert.equal(resolveCurrentRepoId({ repos, activeFilePath: "/work/b/y.ts" }), "b");
  assert.equal(resolveCurrentRepoId({ repos, activeFilePath: "/work/a/z.ts" }), "a");
});

test("active editor outside every known repository does not match a wrong one (falls through to rule C)", () => {
  assert.equal(
    resolveCurrentRepoId({ repos: [A, B], activeFilePath: "/elsewhere/unrelated.ts", previousId: "b" }),
    "b",
  );
});

test("a file path that merely starts with a repo root as a string prefix (not a real subpath) does not match", () => {
  // "/work/ab" is NOT inside "/work/a" even though the string "/work/ab"
  // starts with "/work/a" — this guards against a naive startsWith check.
  // Two repos, so a wrong match here could not be masked by rule B.
  const repos = [{ id: "a", repoRoot: "/work/a" }, { id: "b", repoRoot: "/work/b" }];
  assert.equal(resolveCurrentRepoId({ repos, activeFilePath: "/work/ab/file.ts", previousId: "b" }), "b");
});

test("no active editor, multiple repos: prefers the previously-resolved repository (rule C, less jumpy)", () => {
  assert.equal(resolveCurrentRepoId({ repos: [A, B, C], previousId: "b" }), "b");
});

test("no active editor, multiple repos, previous repo no longer known: deterministic fallback to the first (rule C)", () => {
  assert.equal(resolveCurrentRepoId({ repos: [A, B, C], previousId: "gone" }), "a");
  assert.equal(resolveCurrentRepoId({ repos: [A, B, C] }), "a");
});

test("deterministic fallback follows the caller's own repo order, not insertion order of some other structure", () => {
  assert.equal(resolveCurrentRepoId({ repos: [C, B, A] }), "c");
});

test("active editor match always wins over a stale previousId", () => {
  assert.equal(
    resolveCurrentRepoId({ repos: [A, B, C], activeFilePath: "/work/c/file.ts", previousId: "a" }),
    "c",
  );
});
