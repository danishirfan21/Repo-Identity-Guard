import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * Empirical regression tests backing the Shield Mode architecture decision
 * in docs/SHIELD_MODE.md — every fact this test asserts was verified by
 * hand against a real `git` binary before being written down as the basis
 * for "enablement is per-underlying-repository, not per-worktree" and "the
 * common git dir is Shield's storage anchor." If a future Git version
 * changes any of this, these tests fail loudly instead of silently
 * invalidating the architecture doc.
 *
 * Uses real temporary repositories (no mocking of Git) since this is
 * exactly the kind of Git-version/behavior-sensitive fact a parsing unit
 * test can't verify.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function makeTempRepo(): Promise<string> {
  // realpath: on macOS, os.tmpdir() returns a path through the /var ->
  // /private/var symlink, but `git rev-parse --path-format=absolute`
  // resolves symlinks and returns the canonical /private/var/... form.
  // Comparing a raw mkdtemp() path against git's own absolute-path output
  // would spuriously fail on macOS alone (confirmed via CI) without this
  // -- resolving once up front keeps every path this file computes
  // consistent with what git itself reports.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shield-topology-")));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
  await git(dir, ["add", "f.txt"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("a normal (non-worktree) repo: --git-dir and --git-common-dir are the same path", async () => {
  const repo = await makeTempRepo();
  try {
    const gitDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    assert.equal(gitDir, commonDir);
    assert.equal(gitDir, path.join(repo, ".git"));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("a linked worktree has its own --git-dir but SHARES --git-common-dir with the main worktree", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), path.basename(repo) + "-wt");
  try {
    await git(repo, ["branch", "feature-a"]);
    await git(repo, ["worktree", "add", worktreeDir, "feature-a"]);

    const mainGitDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const mainCommonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const wtGitDir = await git(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const wtCommonDir = await git(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

    // git-dir differs per worktree (each has its own worktrees/<name> dir)...
    assert.notEqual(wtGitDir, mainGitDir);
    assert.ok(wtGitDir.includes(path.join(".git", "worktrees")));

    // ...but git-common-dir is identical from both — the one stable,
    // worktree-portable anchor. This is the empirical basis for storing
    // Shield's policy under the common dir, not the per-worktree git-dir.
    assert.equal(wtCommonDir, mainCommonDir);
    assert.equal(mainCommonDir, path.join(repo, ".git"));
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("hooks resolve to ONE shared directory (derived from git-common-dir) for both the main worktree and a linked worktree, by default", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), path.basename(repo) + "-wt-hooks");
  try {
    await git(repo, ["branch", "feature-b"]);
    await git(repo, ["worktree", "add", worktreeDir, "feature-b"]);

    const mainHooksPath = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
    const wtHooksPath = await git(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);

    // This is the crux of the "enablement is per-repository, not
    // per-worktree" decision: Git itself has exactly one hooks directory
    // per repository by default, shared by every worktree. There is no
    // way to install a hook that runs for only one worktree without
    // opting into the (separately tested, separately documented as a
    // bypass) worktree-scoped core.hooksPath override.
    assert.equal(mainHooksPath, wtHooksPath);
    assert.equal(mainHooksPath, path.join(repo, ".git", "hooks"));
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a repo-level (--local) core.hooksPath override redirects hook resolution for ALL worktrees", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), path.basename(repo) + "-wt-hookspath");
  try {
    await git(repo, ["branch", "feature-c"]);
    await git(repo, ["worktree", "add", worktreeDir, "feature-c"]);
    await fs.mkdir(path.join(repo, "custom-hooks"), { recursive: true });
    await git(repo, ["config", "core.hooksPath", "custom-hooks"]);

    const mainHooksPath = await git(repo, ["rev-parse", "--git-path", "hooks"]);
    const wtHooksPath = await git(worktreeDir, ["rev-parse", "--git-path", "hooks"]);

    assert.equal(mainHooksPath, "custom-hooks");
    assert.equal(wtHooksPath, "custom-hooks");
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a WORKTREE-SCOPED core.hooksPath (extensions.worktreeConfig on) redirects hooks for that one worktree only — a documented bypass, not a feature to build enablement on", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), path.basename(repo) + "-wt-scoped");
  try {
    await git(repo, ["branch", "feature-d"]);
    await git(repo, ["worktree", "add", worktreeDir, "feature-d"]);
    await git(repo, ["config", "extensions.worktreeConfig", "true"]);
    await git(worktreeDir, ["config", "--worktree", "core.hooksPath", "/nonexistent-hooks-dir"]);

    const mainHooksPath = await git(repo, ["rev-parse", "--git-path", "hooks"]);
    const wtHooksPath = await git(worktreeDir, ["rev-parse", "--git-path", "hooks"]);

    // The main worktree is unaffected...
    assert.equal(mainHooksPath, path.join(".git", "hooks"));
    // ...but the linked worktree's hook resolution was silently redirected,
    // entirely independent of the main worktree. Shield cannot prevent
    // this — it can only be documented as a known, deliberate bypass
    // vector (same category as --no-verify).
    assert.equal(wtHooksPath, "/nonexistent-hooks-dir");
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("--no-verify bypasses a pre-commit hook entirely, even one that exits non-zero", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
    const preCommitPath = path.join(hooksDir, "pre-commit");
    await fs.writeFile(preCommitPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await fs.appendFile(path.join(repo, "f.txt"), "blocked attempt\n");
    await git(repo, ["add", "f.txt"]);
    await assert.rejects(git(repo, ["commit", "-m", "should be blocked"]));

    await git(repo, ["commit", "--no-verify", "-m", "bypassed"]);
    const log = await git(repo, ["log", "--oneline", "-1"]);
    assert.match(log, /bypassed/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});
