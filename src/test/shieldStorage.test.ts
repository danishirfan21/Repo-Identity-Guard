import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";

test("shieldStorageDir places Shield's metadata in its own namespaced subdirectory of the git-common-dir", () => {
  const dir = shieldStorageDir("/repo/.git");
  assert.equal(dir, path.join("/repo/.git", "repo-identity-guard"));
});

test("shieldPolicyFilePath sits inside shieldStorageDir", () => {
  const file = shieldPolicyFilePath("/repo/.git");
  assert.equal(file, path.join("/repo/.git", "repo-identity-guard", "shield-policy.json"));
});

test("shieldStorageDir resolves identically for a main worktree and a linked worktree of the same repository", () => {
  // Both worktrees' git-common-dir empirically resolves to the SAME
  // absolute path (see shieldGitTopology.test.ts) — this is exactly what
  // makes Shield's storage location worktree-portable without any
  // per-worktree bookkeeping.
  const mainWorktreeCommonDir = "/home/user/project/.git";
  const linkedWorktreeCommonDir = "/home/user/project/.git"; // git-common-dir is shared, not the linked worktree's own git-dir
  assert.equal(shieldStorageDir(mainWorktreeCommonDir), shieldStorageDir(linkedWorktreeCommonDir));
});

test("shieldStorageDir rejects a relative path — callers must resolve an absolute git-common-dir first", () => {
  assert.throws(() => shieldStorageDir(".git"), /absolute/);
  assert.throws(() => shieldStorageDir("relative/path/.git"), /absolute/);
});

test("shieldStorageDir never collides with Git's own hooks/ or config paths", () => {
  const dir = shieldStorageDir("/repo/.git");
  assert.notEqual(dir, path.join("/repo/.git", "hooks"));
  assert.notEqual(dir, path.join("/repo/.git", "config"));
});
