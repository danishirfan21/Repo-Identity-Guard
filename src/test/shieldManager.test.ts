import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldManager } from "../shield/manager";
import { Profile, RepoFacts } from "../types";

/**
 * Integration tests for Shield's installation lifecycle (ShieldManager)
 * AND its actual pre-commit enforcement, exercised end-to-end: real
 * temporary Git repositories, the real `git commit` binary, and the real
 * shipped hook (built by `ShieldManager.enable`, which in turn installs a
 * copy of the real `resources/shield/shield-evaluate.sh`) — nothing here
 * calls into VS Code, and nothing here runs the evaluator directly the
 * way shieldEvaluatorScript.test.ts does. This is the "does Shield
 * actually block/allow a real `git commit`" test suite.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  expectedBranchPatterns: ["feature/*"],
  strictPushSetup: true,
  trustedSshHostAliases: ["github-work"],
};

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

async function git(repo: Repo, args: string[], envOverride?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: envOverride ?? repo.env });
  return stdout.trim();
}

interface CommitResult {
  code: number;
  stderr: string;
}

/**
 * Runs `git commit`, tolerating a non-zero exit (that's the whole point of
 * testing Shield) instead of treating it as a Node error. `configOverrides`
 * become top-level `git -c key=value ... commit ...` options — these MUST
 * come before the `commit` subcommand on the command line (git rejects a
 * joined `-ckey=value` form; it needs `-c key=value` as two argv entries),
 * which is exactly why this is a separate parameter rather than something
 * folded into `extraArgs`.
 */
function commit(
  repo: Repo,
  message: string,
  extraArgs: string[] = [],
  options: { env?: NodeJS.ProcessEnv; configOverrides?: string[] } = {},
): Promise<CommitResult> {
  const configArgs = (options.configOverrides ?? []).flatMap((kv) => ["-c", kv]);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...configArgs, "commit", "-q", "-m", message, ...extraArgs],
      { cwd: repo.dir, encoding: "utf8", env: options.env ?? repo.env },
      (error, _stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr });
      },
    );
  });
}

async function touchFile(repo: Repo, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo.dir, name), content);
  await git(repo, ["add", name]);
}

/**
 * A fresh temp repo with its OWN isolated global git config (via
 * `GIT_CONFIG_GLOBAL`, git >=2.32) so these tests can freely set/unset a
 * "global" identity without ever touching the real machine's
 * `~/.gitconfig`, and `GIT_CONFIG_NOSYSTEM=1` so a machine's `/etc/gitconfig`
 * can't leak in either. Local identity starts correct (matching
 * `workProfile`) and on the default branch renamed to a non-protected
 * name — callers adjust from there per test.
 */
async function makeTempRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-mgr-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const repo: Repo = { dir, env };

  await git(repo, ["init", "-q"]);
  await git(repo, ["config", "user.name", workProfile.gitName!]);
  await git(repo, ["config", "user.email", workProfile.gitEmail]);
  await touchFile(repo, "f.txt", "hello\n");
  await git(repo, ["commit", "-q", "-m", "init"]);
  await git(repo, ["checkout", "-q", "-b", "feature/shield-tests"]);

  return repo;
}

async function cleanup(repo: Repo): Promise<void> {
  await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
}

function baseFacts(repo: Repo): RepoFacts {
  return {
    isGitRepo: true,
    repoRoot: repo.dir,
    repoName: path.basename(repo.dir),
    remoteHost: "github.com",
    remoteOwner: "AcmeSoftware",
    remoteRepo: "acme-frontend",
  };
}

async function enableShield(
  manager: ShieldManager,
  repo: Repo,
  overrides: { profiles?: Profile[]; protectedBranches?: string[]; facts?: Partial<RepoFacts> } = {},
) {
  return manager.enable(repo.dir, EVALUATOR_SOURCE, {
    facts: { ...baseFacts(repo), ...overrides.facts },
    profiles: overrides.profiles ?? [workProfile],
    protectedBranches: overrides.protectedBranches ?? ["main", "master"],
  });
}

async function hooksDirFor(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

// ==================== lifecycle: inspect / enable / disable / repair ====================

test("inspect() on a repo Shield has never touched reports off, with nothing written", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "off");
    assert.equal(inspection.policyPresent, false);
    assert.equal(inspection.evaluatorPresent, false);
    assert.ok(inspection.hooks.every((h) => h.ownership === "absent"));
  } finally {
    await cleanup(repo);
  }
});

test("enable() installs a policy, an evaluator copy, and owned pre-commit AND pre-push hooks, and reports active", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    const result = await enableShield(manager, repo);

    assert.equal(result.ok, true);
    assert.equal(result.inspection.state, "active");
    assert.deepEqual(result.inspection.reasons, []);
    assert.equal(result.inspection.policyProfileLabel, "Work");

    const hooksDir = await hooksDirFor(repo);
    for (const [fileName, marker] of [
      ["pre-commit", "pre-commit"],
      ["pre-push", "pre-push"],
    ] as const) {
      const hookPath = path.join(hooksDir, fileName);
      const hookContent = await fs.readFile(hookPath, "utf8");
      assert.match(hookContent, new RegExp(`repo-identity-guard-shield-artifact v3 \\(${marker}\\)`));
      const mode = (await fs.stat(hookPath)).mode;
      assert.equal(mode & 0o100, 0o100, `${fileName} hook file should be executable`);
    }

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evaluatorContent = await fs.readFile(path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh"), "utf8");
    assert.match(evaluatorContent, /repo-identity-guard-shield-artifact v3 \(evaluator\)/);
    const policyContent = await fs.readFile(path.join(commonDir, "repo-identity-guard", "shield-policy.json"), "utf8");
    assert.match(policyContent, /"profileLabel": "Work"/);
    assert.match(policyContent, /"push"/); // enabledActions now includes push as of Phase 4
  } finally {
    await cleanup(repo);
  }
});

test("enable() refuses to enable without a resolved profile, and writes nothing", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    const result = await enableShield(manager, repo, { profiles: [] });

    assert.equal(result.ok, false);
    assert.equal(result.inspection.state, "off");
    assert.match(result.inspection.reasons[0], /No profile matches/);
  } finally {
    await cleanup(repo);
  }
});

test("a foreign pre-commit hook is never overwritten: enable() refuses full activation and reports degraded", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    const foreignContent = "#!/bin/sh\necho not-shield\nexit 1\n";
    await fs.writeFile(hookPath, foreignContent, { mode: 0o755 });

    const manager = new ShieldManager();
    const result = await enableShield(manager, repo);

    assert.equal(result.ok, false);
    assert.equal(result.inspection.state, "degraded");
    assert.match(result.inspection.reasons.join(" "), /did not create/);

    // Never touched.
    assert.equal(await fs.readFile(hookPath, "utf8"), foreignContent);

    // Policy/evaluator are still written (harmless without a wired hook).
    assert.equal(result.inspection.policyPresent, true);
    assert.equal(result.inspection.evaluatorPresent, true);
  } finally {
    await cleanup(repo);
  }
});

test("disable() never removes a foreign hook even if Shield's own artifacts sit alongside it", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    const foreignContent = "#!/bin/sh\necho not-shield\nexit 1\n";
    await fs.writeFile(hookPath, foreignContent, { mode: 0o755 });

    const manager = new ShieldManager();
    await enableShield(manager, repo); // degraded: policy/evaluator written, hook left alone
    const inspection = await manager.disable(repo.dir);

    assert.equal(await fs.readFile(hookPath, "utf8"), foreignContent);
    assert.equal(inspection.state, "off");
    assert.equal(inspection.policyPresent, false);
    assert.equal(inspection.evaluatorPresent, false);
  } finally {
    await cleanup(repo);
  }
});

test("repair() completes activation once a previously-blocking foreign hook is cleared", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "pre-commit");
    await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const manager = new ShieldManager();
    const first = await enableShield(manager, repo);
    assert.equal(first.inspection.state, "degraded");

    await fs.unlink(hookPath); // user moved the foreign hook aside

    const repaired = await manager.repair(repo.dir, EVALUATOR_SOURCE, {
      facts: baseFacts(repo),
      profiles: [workProfile],
      protectedBranches: ["main", "master"],
    });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.inspection.state, "active");
  } finally {
    await cleanup(repo);
  }
});

test("disable() removes exactly Shield's own artifacts and inspect() reports off afterward", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const inspection = await manager.disable(repo.dir);
    assert.equal(inspection.state, "off");

    const hooksDir = await hooksDirFor(repo);
    await assert.rejects(fs.access(path.join(hooksDir, "pre-commit")));
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await assert.rejects(fs.access(path.join(commonDir, "repo-identity-guard")));
  } finally {
    await cleanup(repo);
  }
});

test("a partial install (hook file missing after enable) is reported degraded, never active", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const hooksDir = await hooksDirFor(repo);
    await fs.unlink(path.join(hooksDir, "pre-commit")); // simulate an interrupted/partially-undone install

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    assert.match(inspection.reasons.join(" "), /pre-commit hook is missing/);
  } finally {
    await cleanup(repo);
  }
});

test("a partial install (policy file missing after enable) is reported degraded, never active", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.unlink(path.join(commonDir, "repo-identity-guard", "shield-policy.json"));

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    assert.match(inspection.reasons.join(" "), /no policy file was found/);
  } finally {
    await cleanup(repo);
  }
});

test("healthCheck() summarizes state without requiring the caller to interpret ShieldInspection", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    const before = await manager.healthCheck(repo.dir);
    assert.equal(before.healthy, false);
    assert.equal(before.state, "off");

    await enableShield(manager, repo);
    const after = await manager.healthCheck(repo.dir);
    assert.equal(after.healthy, true);
    assert.equal(after.state, "active");
    assert.match(after.summary, /Shield is active \(Work\)/);
  } finally {
    await cleanup(repo);
  }
});

// ==================== real `git commit` enforcement, end-to-end ====================

test("correct identity on a feature branch -> commit succeeds", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await touchFile(repo, "a.txt", "content\n");
    const result = await commit(repo, "good commit");
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("wrong local identity -> blocked with a concise reason", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "personal@example.com"]);

    await touchFile(repo, "a.txt", "content\n");
    const result = await commit(repo, "should be blocked");

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Repo Identity Guard Shield/);
    assert.match(result.stderr, /COMMIT BLOCKED/);
    assert.match(result.stderr, /commit-identity-mismatch/);
    assert.match(result.stderr, /Profile: Work/);
    assert.match(result.stderr, /Expected:.*work@example\.com/);
    assert.match(result.stderr, /Found:.*personal@example\.com/);
  } finally {
    await cleanup(repo);
  }
});

test("wrong GLOBAL identity is blocked once local identity is unset and the effective identity actually differs", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["config", "--unset", "user.name"]);
    await git(repo, ["config", "--unset", "user.email"]);
    await git(repo, ["config", "--global", "user.name", "Danish Irfan"]);
    await git(repo, ["config", "--global", "user.email", "personal@example.com"]);

    await touchFile(repo, "a.txt", "content\n");
    const result = await commit(repo, "should be blocked via global fallback");

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-mismatch/);
  } finally {
    await cleanup(repo);
  }
});

test("GIT_AUTHOR_EMAIL environment override is visible at hook time and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "content\n");

    const result = await commit(repo, "author env override", [], {
      env: { ...repo.env, GIT_AUTHOR_EMAIL: "personal@example.com" },
    });

    assert.notEqual(result.code, 0);
    // Local config still matches the profile, so this is an override, not a mismatch.
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo);
  }
});

test("GIT_COMMITTER_EMAIL environment override is visible at hook time and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "content\n");

    const result = await commit(repo, "committer env override", [], {
      env: { ...repo.env, GIT_COMMITTER_EMAIL: "personal@example.com" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo);
  }
});

test("`git -c user.email=... commit` is visible at hook time (via GIT_CONFIG_PARAMETERS) and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "content\n");

    const result = await commit(repo, "cli config override", [], {
      configOverrides: ["user.email=personal@example.com"],
    });

    assert.notEqual(result.code, 0);
    // `git config --local` (what the hook reads as "configured") is unaffected
    // by a -c override — only the *effective* identity (git var) sees it — so
    // this is an override, exactly like an environment-variable override.
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo);
  }
});

test("protected branch -> blocked even with correct identity", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["checkout", "-q", "main"]).catch(() => git(repo, ["checkout", "-q", "master"]));

    await touchFile(repo, "a.txt", "content\n");
    const result = await commit(repo, "direct commit on protected branch");

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /protected-branch/);
  } finally {
    await cleanup(repo);
  }
});

test("detached HEAD -> blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const sha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", sha]);

    await touchFile(repo, "a.txt", "content\n");
    const result = await commit(repo, "detached commit");

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /detached-head/);
  } finally {
    await cleanup(repo);
  }
});

async function makeConflictedRebase(repo: Repo): Promise<void> {
  await touchFile(repo, "conflict.txt", "base\n");
  await git(repo, ["commit", "-q", "-m", "base"]);

  await git(repo, ["checkout", "-q", "-b", "feature/other"]);
  await touchFile(repo, "conflict.txt", "from-other-branch\n");
  await git(repo, ["commit", "-q", "-m", "other change"]);

  await git(repo, ["checkout", "-q", "feature/shield-tests"]);
  await touchFile(repo, "conflict.txt", "from-shield-tests-branch\n");
  await git(repo, ["commit", "-q", "-m", "conflicting change"]);

  await git(repo, ["rebase", "feature/other"]).catch(() => undefined); // expected to stop on conflict
}

test("unresolved conflicts during a rebase -> Git itself refuses the commit before Shield's hook ever runs (documented defense-in-depth: shield-evaluate.sh's own merge-conflicts reason is exercised directly in shieldEvaluatorScript.test.ts, since a real `git commit` can't reach it with unmerged files present)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await makeConflictedRebase(repo);

    const result = await commit(repo, "commit while conflicted", ["--no-edit"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unmerged files/);
    // Never even reached Shield's hook.
    assert.doesNotMatch(result.stderr, /Repo Identity Guard Shield/);
  } finally {
    await cleanup(repo);
  }
});

test("resolving a rebase conflict and committing manually (not via --continue) -> blocked on repo-operation-in-progress alone", async () => {
  // Empirically, `git rebase --continue` itself does NOT invoke the
  // pre-commit hook for the commit it creates internally (confirmed by
  // hand against real Git 2.43: a pre-commit hook that unconditionally
  // exits 1 does not stop `rebase --continue` from succeeding) — a
  // documented gap, not an oversight; see docs/SHIELD_MODE.md "What's
  // next." The hook DOES run for a plain `git commit` made while a
  // rebase is merely in progress (conflict already resolved and staged,
  // `--continue` not yet run), which is the scenario this test exercises.
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await makeConflictedRebase(repo);

    // Resolve the conflict and stage it — status is clean of unmerged
    // entries now, but the rebase itself is still in progress.
    await fs.writeFile(path.join(repo.dir, "conflict.txt"), "resolved\n");
    await git(repo, ["add", "conflict.txt"]);

    const result = await commit(repo, "manual commit mid-rebase");

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Repo Identity Guard Shield/);
    assert.match(result.stderr, /repo-operation-in-progress/);
    assert.doesNotMatch(result.stderr, /merge-conflicts/);
  } finally {
    await cleanup(repo);
  }
});

test("--author override is visible at hook time and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "content\n");

    const result = await commit(repo, "author flag override", ["--author=Other Person <other@example.com>"]);

    assert.notEqual(result.code, 0);
    // Local config is untouched by --author either, so this is an override —
    // documented empirically: `git var GIT_AUTHOR_IDENT` DOES reflect
    // `--author` at pre-commit hook time (confirmed by this test actually
    // blocking); if a future Git version stopped exposing it, this test
    // would start failing loudly instead of Shield silently losing coverage.
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo);
  }
});

test("--no-verify bypasses Shield's pre-commit hook entirely (documented, expected, not a bug)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "personal@example.com"]); // would otherwise block

    await touchFile(repo, "a.txt", "content\n");
    const result = await commit(repo, "bypassed", ["--no-verify"]);

    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("Shield enforcement works with no VS Code process involved at all (this whole suite proves it, this test says so explicitly)", async () => {
  const repo = await makeTempRepo();
  try {
    assert.equal(
      Object.keys(require.cache).some((k) => k.includes(`${path.sep}vscode${path.sep}`)),
      false,
      "this test (and every other test in this file) must never load the vscode module",
    );

    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "content\n");

    // The hook is invoked by the real `git` binary as its own child
    // process tree (git -> sh pre-commit -> sh shield-evaluate.sh) — this
    // Node test process never runs the hook itself, and nothing here
    // requires (or even imports) `vscode`.
    const result = await commit(repo, "should still be blocked");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-mismatch/);
  } finally {
    await cleanup(repo);
  }
});

test("a linked worktree is protected by the same hook installed once from the main worktree", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = `${repo.dir}-wt`;
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["worktree", "add", "-q", worktreeDir, "-b", "feature/from-worktree"]);
    const worktreeRepo: Repo = { dir: worktreeDir, env: repo.env };

    await touchFile(worktreeRepo, "b.txt", "content\n");
    const goodResult = await commit(worktreeRepo, "good commit from worktree");
    assert.equal(goodResult.code, 0, goodResult.stderr);

    await git(worktreeRepo, ["config", "user.email", "personal@example.com"]);
    await touchFile(worktreeRepo, "b.txt", "more content\n");
    const badResult = await commit(worktreeRepo, "bad commit from worktree");
    assert.notEqual(badResult.code, 0);
    assert.match(badResult.stderr, /commit-identity-mismatch/);
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await cleanup(repo);
  }
});
