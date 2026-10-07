import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldManager } from "../shield/manager";
import type { Identity } from "../identity/types";
import { WORK_IDENTITY_WITH_LOGIN } from "./testUtil/lockFixtures";

/**
 * Hardening/abuse matrix for the identity lock.
 *
 * This file does NOT re-test what shieldManager.test.ts, shieldPrePush.test.ts,
 * shieldGitTopology.test.ts, shieldGitHubAccountBinding.test.ts, and
 * shieldCoexistenceAndIntegrity.test.ts already cover (see their test
 * titles). It fills the specific gaps in Phase 7's requested commit/push
 * abuse matrix — real temporary Git repositories throughout, no mocked
 * hook invocations — plus:
 *
 *   - explicit KNOWN BYPASS demonstrations (--no-verify, core.hooksPath
 *     override) that are documented limitations of the local-hook
 *     enforcement boundary, not bugs to "fix";
 *   - the internal-evaluator-failure-vs-policy-block distinction added in
 *     Phase 7 (see buildPreCommitHookScript/buildPrePushHookScript);
 *   - rough added-latency measurements for commit and account-verifying
 *     push (informational — printed via
 *     console.log rather than tight assertions, since absolute timing is
 *     not portable across CI runners; a very generous upper bound is
 *     still asserted so a genuine regression — e.g. an accidental network
 *     call — fails loudly).
 *
 * The lock's promise, restated because several tests below exist purely to
 * demonstrate its boundary: it blocks ACCIDENTAL commits/pushes with the
 * wrong identity. It does not, and cannot, contain a process willing to
 * pass --no-verify, edit core.hooksPath, or otherwise act with intent to
 * bypass a client-side hook — no local-hook-based tool can.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

// Enforces both commit identity and the pushing GitHub account, so all
// three hooks are installed and every push below runs the account check
// (answered by the mocked ssh, never real GitHub).
const workProfile: Identity = WORK_IDENTITY_WITH_LOGIN;

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

async function git(repo: Repo, args: string[], envOverride?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: envOverride ?? repo.env });
  return stdout.trim();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(repo: Repo, args: string[], options: { env?: NodeJS.ProcessEnv; configOverrides?: string[] } = {}): Promise<RunResult> {
  const configArgs = (options.configOverrides ?? []).flatMap((kv) => ["-c", kv]);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...configArgs, ...args],
      { cwd: repo.dir, encoding: "utf8", env: options.env ?? repo.env },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function commit(repo: Repo, message: string, extraArgs: string[] = [], options: { env?: NodeJS.ProcessEnv; configOverrides?: string[] } = {}): Promise<RunResult> {
  return run(repo, ["commit", "-q", "-m", message, ...extraArgs], options);
}

function push(repo: Repo, args: string[], envOverride?: NodeJS.ProcessEnv): Promise<RunResult> {
  return run(repo, ["push", ...args], { env: envOverride });
}

async function touchFile(repo: Repo, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo.dir, name), content);
  await git(repo, ["add", name]);
}

function stripAmbientGitConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete cleaned[key];
  }
  return normalizePathKey(cleaned);
}

// Same Windows PATH-casing fix as shieldPrePush.test.ts — see that file's
// comment on `normalizePathKey` for why this is necessary.
function normalizePathKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  const pathKeys = Object.keys(result).filter((key) => key.toUpperCase() === "PATH");
  const value = pathKeys.map((key) => result[key]).find((v) => v !== undefined);
  for (const key of pathKeys) {
    if (key !== "PATH") delete result[key];
  }
  if (value !== undefined) result.PATH = value;
  return result;
}

async function makeTempRepo(prefix = "shield-harden-"): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: NodeJS.ProcessEnv = {
    ...stripAmbientGitConfigEnv(process.env),
    GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const repo: Repo = { dir, env };

  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", workProfile.gitName!]);
  await git(repo, ["config", "user.email", workProfile.gitEmail]);
  await touchFile(repo, "f.txt", "hello\n");
  await git(repo, ["commit", "-q", "-m", "init"]);
  await git(repo, ["checkout", "-q", "-b", "feature/shield-tests"]);

  return repo;
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
}

async function enableShield(
  manager: ShieldManager,
  repo: Repo,
  overrides: { identity?: Identity } = {},
) {
  const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
    identity: overrides.identity ?? workProfile,
    lockId: "hardening",
    assignedAt: 1,
  });
  assert.equal(result.ok, true, `enable() should succeed: ${result.inspection.reasons.join("; ")}`);
  return result;
}

// Phase 7 Windows findings: (1) a PATH lookup for a bare, extension-less
// `ssh` file is POSIX-only -- Windows tries PATHEXT extensions and falls
// through to the real ssh.exe further down PATH, which then genuinely
// tries to resolve the fake alias as DNS and fails. An `ssh.cmd` shim,
// delegating to a plain Node script rather than assuming a shell is on
// PATH, makes the shadow visible on Windows too. (2) a fake-ssh path
// embedded in GIT_SSH_COMMAND / core.sshCommand goes through git-bash's
// own `sh -c "<command> ..."`, which treats backslash as a shell escape --
// an un-converted Windows path arrives with every backslash silently
// eaten ("command not found"). See toShellPath below.
function toShellPath(p: string): string {
  return p.split(path.sep).join("/");
}

// Phase 7 Windows finding (see shieldPrePush.test.ts for the fuller
// writeup): Git for Windows does not resolve its ssh transport through
// the caller's PATH -- it falls through to its own bundled ssh.exe
// regardless of what this suite prepends, so a real DNS/auth failure
// surfaces before Shield's pre-push hook ever runs. A gap in this repo's
// PATH-shadowing test technique on Windows, not in Shield: covered on
// ubuntu-latest/macos-latest.
const SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS =
  process.platform === "win32"
    ? "Git for Windows does not resolve ssh via PATH search -- this suite's PATH-shadow fake-ssh technique cannot intercept it here. Covered on ubuntu-latest/macos-latest."
    : false;

async function makeBareRemote(parentDir: string, owner: string, repoName: string): Promise<string> {
  const ownerDir = path.join(parentDir, owner);
  await fs.mkdir(ownerDir, { recursive: true });
  const bareDir = path.join(ownerDir, `${repoName}.git`);
  await execFileAsync("git", ["init", "-q", "--bare", bareDir]);
  // Phase 7 Windows finding (see shieldPrePush.test.ts): this path gets
  // embedded into a scp-like SSH URL below for Shield's evaluator to parse
  // the owner/repo out of -- a raw Windows backslash path breaks that
  // parsing. Forward slashes are equally valid as a real fs path there.
  return toShellPath(bareDir);
}

async function remoteRefSha(bareDir: string, ref = "refs/heads/main"): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["--git-dir", bareDir, "rev-parse", "--verify", ref], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function hooksDirFor(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

// ==================== COMMIT MATRIX GAPS ====================

test("wrong user.name only (email correct) -> blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.name", "Someone Else"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "wrong name");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-mismatch/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("wrong author only (committer correct via env) -> blocked, reason names the author specifically", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "author only", [], {
      env: { ...repo.env, GIT_AUTHOR_NAME: "Someone Else", GIT_AUTHOR_EMAIL: "someone@example.com" },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /author:\s+Someone Else/);
    assert.match(result.stderr, /FOUND_ROLE: author$/m);
    assert.doesNotMatch(result.stderr, /committer:\s+Someone Else/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("wrong committer only (author correct via env) -> blocked, reason names the committer specifically", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "committer only", [], {
      env: { ...repo.env, GIT_COMMITTER_NAME: "Someone Else", GIT_COMMITTER_EMAIL: "someone@example.com" },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /committer:\s+Someone Else/);
    assert.match(result.stderr, /FOUND_ROLE: committer$/m);
    assert.doesNotMatch(result.stderr, /author:\s+Someone Else/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("GIT_AUTHOR_NAME environment override alone is visible at hook time and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "name env override", [], {
      env: { ...repo.env, GIT_AUTHOR_NAME: "Someone Else" },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("GIT_COMMITTER_NAME environment override alone is visible at hook time and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "committer name env override", [], {
      env: { ...repo.env, GIT_COMMITTER_NAME: "Someone Else" },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("`git -c user.name=... commit` is visible at hook time and blocked", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "cli name override", [], {
      configOverrides: ["user.name=Someone Else"],
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("amend: re-committing with a bad identity is blocked exactly like a fresh commit (hook fires again)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await touchFile(repo, "a.txt", "x\n");
    const ok = await commit(repo, "good commit");
    assert.equal(ok.code, 0, ok.stderr);

    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "b.txt", "y\n");
    const amend = await commit(repo, "good commit", ["--amend", "--no-edit"]);
    assert.notEqual(amend.code, 0);
    assert.match(amend.stderr, /commit-identity-mismatch/);
    // The prior good commit must still be intact (amend never partially applies).
    assert.equal(await git(repo, ["log", "-1", "--format=%s"]), "good commit");
  } finally {
    await cleanup(repo.dir);
  }
});

test("merge commit: a real (non-fast-forward) merge with bad identity is blocked -- Phase 7 finding: this requires the pre-merge-commit hook, NOT pre-commit (Git invokes a different hook for merge commits; empirically confirmed a mismatched identity previously sailed straight through git merge)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["checkout", "-q", "-b", "feature/other", "main"]);
    await touchFile(repo, "other.txt", "other\n");
    await git(repo, ["commit", "-q", "-m", "other work"]);
    await git(repo, ["checkout", "-q", "feature/shield-tests"]);
    await touchFile(repo, "mine.txt", "mine\n");
    await git(repo, ["commit", "-q", "-m", "my work"]);

    await git(repo, ["config", "user.email", "personal@example.com"]);
    const result = await run(repo, ["merge", "--no-ff", "-m", "merge other", "feature/other"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-mismatch/);
    // Git must not have completed the merge (no MERGE_HEAD survives a
    // hook-rejected merge commit; the working tree is left mid-merge for
    // the user to resolve, but no new commit was created).
    assert.doesNotMatch(await git(repo, ["log", "-1", "--format=%s"]), /merge other/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("cherry-pick: a CONFLICTING cherry-pick finalized via --continue IS blocked (it internally runs a plain `git commit`, which runs pre-commit)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["checkout", "-q", "-b", "feature/source", "main"]);
    await touchFile(repo, "f.txt", "line1\nCHANGED\nline3\n");
    await git(repo, ["commit", "-q", "-m", "to be picked"]);
    const pickedSha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "feature/shield-tests"]);
    await touchFile(repo, "f.txt", "line1\nOTHER\nline3\n");
    await git(repo, ["commit", "-q", "-m", "conflicting local change"]);

    const conflicted = await run(repo, ["cherry-pick", pickedSha]);
    assert.notEqual(conflicted.code, 0); // Git's own conflict, not Shield

    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "f.txt", "line1\nCHANGED\nline3\n");
    const continued = await run(repo, ["cherry-pick", "--continue"]);
    assert.notEqual(continued.code, 0);
    assert.match(continued.stderr, /commit-identity-mismatch/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("KNOWN GAP (unfixable by any local hook): a CLEAN (non-conflicting) cherry-pick or revert bypasses pre-commit entirely -- Git commits it via a fast internal path with no hook invocation at all, confirmed empirically", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["checkout", "-q", "-b", "feature/source", "main"]);
    await touchFile(repo, "picked.txt", "picked\n");
    await git(repo, ["commit", "-q", "-m", "to be picked"]);
    const pickedSha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "feature/shield-tests"]);

    await git(repo, ["config", "user.email", "personal@example.com"]);
    const result = await run(repo, ["cherry-pick", pickedSha]);
    // This is Git's own documented behavior (not a Shield bug this phase
    // introduced, and not something a pre-commit/pre-merge-commit hook
    // can intercept): a clean cherry-pick applies and commits via an
    // internal fast path that never invokes ANY commit hook. The same is
    // true of `git revert` on a clean revert. There is no hook name Git
    // offers for this path -- see docs/SHIELD_MODE.md's Phase 7 section
    // for why this sits alongside --no-verify as an acknowledged boundary
    // of local-hook-based enforcement, not a defect to chase.
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo.dir);
  }
});

test("malformed policy (real hand-corrupted policy.json on disk) blocks a real commit, not just the standalone script", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const policyPath = path.join(commonDir, "repo-identity-guard", "shield-policy.json");
    await fs.writeFile(policyPath, "{ not json at all");

    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "should be blocked by corrupt policy");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-corrupt/);
    assert.doesNotMatch(result.stderr, /internal error/i);
  } finally {
    await cleanup(repo.dir);
  }
});

/**
 * Phase 8 reversal — this test previously asserted the OPPOSITE ("fails
 * OPEN"), and that documented behavior was the bug.
 *
 * With Shield reported ACTIVE, deleting one file
 * (`<gitCommonDir>/repo-identity-guard/shield-evaluate.sh`) left the hook
 * installed and made every commit — including one with a deliberately
 * mismatched identity — sail straight through, silently and with no
 * output at all. That is a one-command, no-privileges bypass of the entire
 * feature. "Hook installed but evaluator missing" is a BROKEN
 * INSTALLATION, not a disabled Shield, and the only safe reading of a
 * broken enforcement mechanism is to stop and say so.
 *
 * The safety of failing closed here rests entirely on `disable()` being
 * complete — see the disable/orphan tests below, which prove a legitimate
 * Disable Shield never leaves a hook behind to block against a
 * deliberately-removed evaluator.
 */
test("deleted evaluator: removing the evaluator copy after enable FAILS CLOSED for commit, framed as a broken Shield installation", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.rm(path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh"));

    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "evaluator missing, must fail closed");
    assert.notEqual(result.code, 0, "a missing evaluator must never let a commit through");
    assert.match(result.stderr, /broken installation/i);
    // Framed as Shield's own problem, never as a verdict about the commit.
    assert.match(result.stderr, /Repair Identity Lock/);
    assert.match(result.stderr, /Unlock Current Repository/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("deleted evaluator: a push FAILS CLOSED the same way, framed as a broken Shield installation", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", bare]);

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.rm(path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh"));

    const result = await push(repo, ["origin", "HEAD:refs/heads/main"]);
    assert.notEqual(result.code, 0, "a missing evaluator must never let a push through");
    assert.match(result.stderr, /broken installation/i);
    assert.equal(await remoteRefSha(bare), null, "the remote ref must NOT have been updated");
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("corrupted evaluator (truncated to garbage, marker gone) blocks a commit as a Shield INTERNAL error, never as a policy verdict", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evaluatorPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");
    // Present and readable, so the "missing evaluator" branch is NOT what
    // fires -- this exercises the evaluator actually running and dying.
    await fs.writeFile(evaluatorPath, "#!/bin/sh\nexit 42\n", { mode: 0o755 });

    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "corrupt evaluator");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /internal error/i);
    // A crash is never dressed up as a policy decision.
    assert.match(result.stderr, /^REASON: internal_error$/m);
    assert.doesNotMatch(result.stderr, /REASON: wrong_identity/);
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== disable safety under fail-closed hooks ====================

test("DISABLE SAFETY: after a completed unlock, ordinary commits and pushes work again (no hook is left to fail closed)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await manager.disable(repo.dir);

    const bare = await makeBareRemote(remoteParent, "SomewhereElse", "anything");
    await git(repo, ["remote", "add", "origin", bare]);
    // A deliberately wrong identity AND a non-GitHub (local path) push
    // route: both would be blocked if any lock hook survived.
    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");

    const committed = await commit(repo, "after disable");
    assert.equal(committed.code, 0, committed.stderr);
    const pushed = await push(repo, ["origin", "HEAD:refs/heads/main"]);
    assert.equal(pushed.code, 0, pushed.stderr);
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("DISABLE SAFETY: hooks are removed BEFORE the evaluator, so an interrupted disable can only ever over-enforce, never permanently block", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const hooksDir = await hooksDirFor(repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evaluatorPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");

    // Simulate the exact state a disable interrupted between its two
    // phases leaves behind: hooks already gone, evaluator still present.
    // That state must be harmless -- Git simply has no hook to run.
    for (const name of ["pre-commit", "pre-merge-commit", "pre-push"]) {
      await fs.rm(path.join(hooksDir, name), { force: true });
    }
    assert.ok(await fs.stat(evaluatorPath).then(() => true).catch(() => false), "evaluator still present, as in a half-finished disable");

    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "hooks gone, evaluator left");
    assert.equal(result.code, 0, result.stderr);

    // And finishing the disable afterwards is still clean and idempotent.
    const inspection = await manager.disable(repo.dir);
    assert.equal(inspection.state, "off");
  } finally {
    await cleanup(repo.dir);
  }
});

test("REPAIR restores enforcement after the evaluator was deleted (broken -> active, and a mismatched commit is blocked by policy again)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.rm(path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh"));

    const repaired = await enableShield(manager, repo);
    assert.equal(repaired.inspection.state, "active", repaired.inspection.reasons.join("; "));

    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "blocked by policy again");
    assert.notEqual(result.code, 0);
    // A real policy verdict, NOT the internal-error framing.
    assert.match(result.stderr, /commit-identity-mismatch/);
    assert.doesNotMatch(result.stderr, /broken installation/i);
  } finally {
    await cleanup(repo.dir);
  }
});

test("modified hook (hand-edited pre-commit, marker kept, made to always allow) actually runs the tampered logic -- and inspect() still catches it as content-modified", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const original = await fs.readFile(hookPath, "utf8");
    assert.match(original, /repo-identity-guard-shield-artifact/);

    const tampered = original.replace(/^set -eu$/m, "set -eu\nexit 0 # tampered: always allow");
    await fs.writeFile(hookPath, tampered, { mode: 0o755 });

    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "tampered hook lets this through");
    assert.equal(result.code, 0, result.stderr); // proves the tamper is live, not that it's good

    const evaluatorSource = await fs.readFile(EVALUATOR_SOURCE, "utf8");
    const inspection = await manager.inspect(repo.dir, { evaluatorScriptSource: evaluatorSource });
    assert.equal(inspection.state, "degraded");
    const preCommit = inspection.hooks.find((h) => h.fileName === "pre-commit");
    assert.equal(preCommit?.contentModified, true);
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== PUSH MATRIX GAPS ====================

// Every push below runs with the lock's account check enabled and a mocked
// ssh that reports "danish-work" — so the only thing that can block is the
// ROUTE Git actually resolves for this push. "github-work" is the identity's
// trusted alias; "totally-untrusted" is not.

test("branch.pushRemote redirects a push and the lock verifies the route of the ACTUAL destination, not origin's URL", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-work");
  try {
    const originBare = await makeBareRemote(remoteParent, "AcmeSoftware", "origin-repo");
    const upstreamBare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    // origin goes through an UNTRUSTED alias (would be blocked); the
    // branch's pushRemote goes through the trusted one.
    await git(repo, ["remote", "add", "origin", `git@totally-untrusted:${originBare}`]);
    await git(repo, ["remote", "add", "upstream", `git@github-work:${upstreamBare}`]);
    await git(repo, ["config", "branch.feature/shield-tests.pushRemote", "upstream"]);
    await git(repo, ["config", "push.default", "current"]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    // Bare `git push` (no remote argument) -- only then does Git consult
    // branch.<name>.pushRemote to resolve which remote to use.
    const allowed = await push(repo, [], env);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.ok(await remoteRefSha(upstreamBare, "refs/heads/feature/shield-tests"));
    assert.equal(await remoteRefSha(originBare, "refs/heads/feature/shield-tests"), null);

    // The reverse arrangement: pushRemote now points at the untrusted route.
    await git(repo, ["config", "branch.feature/shield-tests.pushRemote", "origin"]);
    const blocked = await push(repo, [], env);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /push-route-unverified/);
    assert.match(blocked.stderr, /^ROUTE_HOST: totally-untrusted$/m);
    assert.equal(await remoteRefSha(originBare, "refs/heads/feature/shield-tests"), null);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("remote.pushDefault redirects a bare `git push` and the resolved destination's route is what gets verified", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-work");
  try {
    const originBare = await makeBareRemote(remoteParent, "AcmeSoftware", "origin-repo");
    const upstreamBare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["remote", "add", "origin", `git@github-work:${originBare}`]);
    await git(repo, ["remote", "add", "upstream", `git@totally-untrusted:${upstreamBare}`]);
    await git(repo, ["config", "push.default", "current"]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    await git(repo, ["config", "remote.pushDefault", "upstream"]);
    const blocked = await push(repo, [], env);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /push-route-unverified/);
    assert.equal(await remoteRefSha(upstreamBare, "refs/heads/feature/shield-tests"), null);

    await git(repo, ["config", "remote.pushDefault", "origin"]);
    const allowed = await push(repo, [], env);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.ok(await remoteRefSha(originBare, "refs/heads/feature/shield-tests"));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("remote.pushurl (asymmetric fetch/push URL) is what's actually verified at push time, not the fetch URL", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-work");
  try {
    const rightBare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    // The fetch URL is HTTPS (whose account cannot be verified, so it
    // would be blocked); only the pushurl matters for `git push`.
    await git(repo, ["remote", "add", "origin", "https://example.com/nonexistent/repo.git"]);
    await git(repo, ["remote", "set-url", "--push", "origin", `git@github-work:${rightBare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await remoteRefSha(rightBare, "refs/heads/feature/shield-tests"));

    // And the reverse: a trusted fetch URL does not launder an untrusted
    // pushurl. (An HTTPS pushurl cannot be used for this half: Git
    // contacts an HTTPS remote BEFORE running pre-push, so the test would
    // hit the network instead of the hook. HTTPS is covered at the
    // evaluator level in shieldEvaluatorScript.test.ts.)
    await git(repo, ["remote", "set-url", "origin", `git@github-work:${rightBare}`]);
    await git(repo, ["remote", "set-url", "--push", "origin", `git@totally-untrusted:${rightBare}`]);
    await git(repo, ["commit", "--allow-empty", "-q", "-m", "second"]);
    const blocked = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /push-route-unverified/);
    assert.match(blocked.stderr, /^DETAIL: untrusted_alias$/m);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("force push is still subject to the same route/account checks (force alone changes nothing)", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-work");
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const first = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(first.code, 0, first.stderr);

    await git(repo, ["commit", "--amend", "-q", "-m", "rewritten"]);
    const forced = await push(repo, ["--force", "origin", "feature/shield-tests"], env);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(await remoteRefSha(bare, "refs/heads/feature/shield-tests"), await git(repo, ["rev-parse", "HEAD"]));

    // Same force push against an untrusted alias is blocked exactly like a non-force push would be.
    await git(repo, ["remote", "set-url", "origin", `git@totally-untrusted:${bare}`]);
    const blockedForce = await push(repo, ["--force", "origin", "feature/shield-tests"], env);
    assert.notEqual(blockedForce.code, 0);
    assert.match(blockedForce.stderr, /push-route-unverified/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("ref deletion (`git push origin --delete branch`) is checked the same as any other push", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-work");
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const first = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(await remoteRefSha(bare, "refs/heads/feature/shield-tests"));

    const deletion = await push(repo, ["origin", "--delete", "feature/shield-tests"], env);
    assert.equal(deletion.code, 0, deletion.stderr);
    assert.equal(await remoteRefSha(bare, "refs/heads/feature/shield-tests"), null);

    // The route check still applies to a deletion against an untrusted alias.
    await git(repo, ["push", "-q", "origin", "HEAD:refs/heads/feature/other-branch"], env);
    await git(repo, ["remote", "set-url", "origin", `git@totally-untrusted:${bare}`]);
    const blockedDeletion = await push(repo, ["origin", "--delete", "feature/other-branch"], env);
    assert.notEqual(blockedDeletion.code, 0);
    assert.match(blockedDeletion.stderr, /push-route-unverified/);
    assert.ok(await remoteRefSha(bare, "refs/heads/feature/other-branch"), "the blocked deletion must not have happened");
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("pushing as the WRONG GitHub account over the trusted route is blocked with both logins in the prelude", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-personal");
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /^REASON: wrong_push_account$/m);
    assert.match(result.stderr, /^EXPECTED_GITHUB_LOGIN: danish-work$/m);
    assert.match(result.stderr, /^FOUND_GITHUB_LOGIN: danish-personal$/m);
    assert.equal(await remoteRefSha(bare, "refs/heads/feature/shield-tests"), null);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("missing policy at push time reports a concise, non-crash reason, not a raw shell/stack-trace-style error", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.rm(path.join(commonDir, "repo-identity-guard", "shield-policy.json"));

    await git(repo, ["remote", "add", "origin", bare]);
    const result = await push(repo, ["origin", "feature/shield-tests"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-missing/);
    assert.doesNotMatch(result.stderr, /Traceback|at Object\.|node:internal/);
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("expected GitHub login match under strict verification -> allowed (network mocked via fake ssh, never real GitHub)", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await mockGithubSsh("danish-work");
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

/**
 * A fake `ssh` that both (a) satisfies `ssh -G <alias>` with
 * "identitiesonly yes" and (b) satisfies `ssh -T user@alias` with a
 * GitHub-shaped "Hi <login>! ... successfully authenticated ..." response,
 * AND (c) for anything else (the actual git-receive-pack transport call)
 * falls through to locally executing the remote command — so one fake binary serves both the account-verification
 * probe and the real push transport, without ever touching the network.
 */
// Windows findings (see the comment above toShellPath): implemented in
// Node with an ssh.cmd shim so Windows' PATH lookup can find it too.
async function mockGithubSsh(login: string): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakegh-"));
  const implPath = path.join(binDir, "fake-ssh-impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  // The lock requires the alias's EFFECTIVE route (hostname, port, user)
  // to actually be a GitHub SSH endpoint before it will treat a
  // GitHub-shaped greeting as proof of a GitHub account.
  process.stdout.write("user git\\nhostname github.com\\nport 22\\nidentitiesonly yes\\n");
  process.exit(0);
} else if (joined.includes(" -T ")) {
  process.stdout.write("Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.\\n");
  process.exit(1);
} else {
  const remoteCommand = args[args.length - 1] || "";
  const match = /^(\\S+)\\s+'(.*)'$/.exec(remoteCommand);
  if (!match) {
    process.stderr.write("fake-ssh: could not parse remote command: " + remoteCommand + "\\n");
    process.exit(1);
  }
  try {
    execFileSync(match[1], [match[2]], { stdio: "inherit" });
  } catch (err) {
    process.exit(typeof err.status === "number" ? err.status : 1);
  }
}
`,
  );
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
}

// ==================== KNOWN BYPASSES (documented limitations, not bugs) ====================

test("KNOWN BYPASS: `git commit --no-verify` skips the lock entirely, even with a maximally wrong identity", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "attacker@evil.example"]);
    await git(repo, ["config", "user.name", "Not The Right Person"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "bypassed", ["--no-verify"]);
    assert.equal(result.code, 0, result.stderr);
    // This is Git's own documented hook-bypass mechanism -- no local
    // pre-commit hook, from any tool, can prevent it. The lock's promise
    // is "blocks accidental use of the wrong identity," never "contains a
    // user or process willing to pass --no-verify."
  } finally {
    await cleanup(repo.dir);
  }
});

test("KNOWN BYPASS: `git push --no-verify` skips the lock entirely, even over a route whose account cannot be verified", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const bare = await makeBareRemote(remoteParent, "SomeoneElse", "unrelated-repo");
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["remote", "add", "origin", bare]);
    const result = await push(repo, ["--no-verify", "origin", "feature/shield-tests"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await remoteRefSha(bare, "refs/heads/feature/shield-tests"));
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("KNOWN BYPASS: pointing core.hooksPath at an empty directory after the lock is active disables enforcement entirely", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const emptyHooksDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-empty-hooks-"));
    await git(repo, ["config", "core.hooksPath", emptyHooksDir]);

    await git(repo, ["config", "user.email", "attacker@evil.example"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "hooks redirected away");
    assert.equal(result.code, 0, result.stderr);
    // The lock's own inspect() DOES detect this after the fact (a missing
    // governed hook at the resolved hooks path) -- but it cannot
    // retroactively stop a commit that already happened. Any tool relying
    // on a client-side Git hook has this same limitation:
    // `core.hooksPath` (or deleting the hook file directly) is a fully
    // supported, first-class Git feature.
    const inspection = await manager.inspect(repo.dir);
    assert.notEqual(inspection.state, "active");
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== INTERNAL FAILURE vs POLICY BLOCK ====================

test("a real internal evaluator crash (unbound variable, no structured reason) is reported as an internal error, distinct from a policy block, and still fails closed", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evalPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");
    // Replace the evaluator with something that crashes before ever
    // calling block() -- no REPO_IDENTITY_GUARD_BLOCK prelude at all,
    // just a raw shell failure. This simulates a genuine evaluator bug
    // (e.g. a typo'd command), not a deliberate policy decision.
    await fs.writeFile(evalPath, `#!/bin/sh\nset -eu\n: "$THIS_VARIABLE_IS_NEVER_SET"\n`, { mode: 0o755 });

    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "should fail closed with a distinct message");
    assert.notEqual(result.code, 0); // still fails CLOSED
    assert.match(result.stderr, /blocked this commit \(internal error\)/);
    assert.match(result.stderr, /^REASON: internal_error$/m); // not framed as an ordinary policy block
    assert.doesNotMatch(result.stderr, /REASON: wrong_identity/);
    assert.match(result.stderr, /What to do:/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("an ordinary policy block is never mistaken for an internal error (control case for the test above)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "ordinary block");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /^REASON: wrong_identity$/m);
    assert.doesNotMatch(result.stderr, /internal error/i);
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== FAILURE MESSAGE SHAPE ====================

test("every commit block states action, identity, expected, found, and a next corrective step -- no stack trace", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "ordinary block");
    assert.match(result.stderr, /^REPO_IDENTITY_GUARD_BLOCK$/m);
    assert.match(result.stderr, /^ACTION: commit$/m); // action blocked
    assert.match(result.stderr, /^IDENTITY: Work$/m); // assigned identity
    assert.match(result.stderr, /^EXPECTED_EMAIL: work@example\.com$/m); // expected
    assert.match(result.stderr, /^FOUND_EMAIL: personal@example\.com$/m); // found
    assert.match(result.stderr, /^REASON_ID: commit-identity-mismatch$/m); // concise machine reason
    assert.match(result.stderr, /What to do:/); // next corrective step
    assert.doesNotMatch(result.stderr, /at Object\.|node:internal|Traceback/);
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== PERFORMANCE (informational, generous bounds) ====================

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function medianLatency(label: string, operation: () => Promise<unknown>): Promise<number> {
  await operation(); // warm-up: exclude first-use process and filesystem cost
  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) samples.push(await timeIt(operation));
  samples.sort((a, b) => a - b);
  const median = samples[1];
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: samples=${samples.map((sample) => sample.toFixed(1)).join(",")}ms median=${median.toFixed(1)}ms`);
  return median;
}

/**
 * Windows-aware latency bound. Confirmed on real windows-latest CI: a
 * single git-subprocess-heavy test here took ~1.5s there against ~80ms
 * on Linux -- not a Shield regression, just real, substantially higher
 * process-spawn overhead on Windows (spawning `git.exe`/`sh.exe` per
 * hook invocation costs much more than a POSIX fork+exec). These
 * assertions exist to catch a genuine regression (e.g. an accidental
 * network call), not to make a cross-platform latency claim -- so the
 * bound itself is platform-aware rather than pretending one number fits
 * every OS.
 */
function catastrophicLatencyCeilingMs(posixCeilingMs: number): number {
  return process.platform === "win32" ? posixCeilingMs * 5 : posixCeilingMs;
}

test("PERFORMANCE: commit median stays below the catastrophic-regression ceiling", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const withoutShieldRepo = await makeTempRepo("shield-harden-baseline-");
    try {
      await touchFile(withoutShieldRepo, "a.txt", "x\n");
      const baseline = await timeIt(() => commit(withoutShieldRepo, "baseline"));

      let commitNumber = 0;
      const withShield = await medianLatency("commit", async () => {
        commitNumber += 1;
        await touchFile(repo, `a-${commitNumber}.txt`, "x\n");
        await commit(repo, `shielded-${commitNumber}`);
      });

      // eslint-disable-next-line no-console
      console.log(`[perf] commit baseline=${baseline.toFixed(1)}ms median=${withShield.toFixed(1)}ms delta=${(withShield - baseline).toFixed(1)}ms`);
      const bound = catastrophicLatencyCeilingMs(5000);
      assert.ok(withShield < bound, `commit median took ${withShield}ms, catastrophic ceiling is ${bound}ms`);
    } finally {
      await cleanup(withoutShieldRepo.dir);
    }
  } finally {
    await cleanup(repo.dir);
  }
});

test("a commit-only lock (no GitHub login) never checks pushes: any route is allowed and ssh is never invoked", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const manager = new ShieldManager();
    const { expectedGitHubLogin: _omit, ...commitOnly } = workProfile;
    void _omit;
    const enabled = await enableShield(manager, repo, { identity: commitOnly });
    assert.deepEqual(enabled.inspection.policySnapshot?.enforcedActions, ["commit"]);
    // A plain local path: not GitHub, not SSH -- would be refused by an
    // account-verifying lock, and needs no ssh at all to push.
    const bare = await makeBareRemote(remoteParent, "Anyone", "anything");
    await git(repo, ["remote", "add", "origin", bare]);
    const env = { ...repo.env, GIT_SSH_COMMAND: "false-ssh-must-never-run" };
    const result = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await remoteRefSha(bare, "refs/heads/feature/shield-tests"));
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("PERFORMANCE: strict account-verifying push median stays below the catastrophic-regression ceiling", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeGithubSshBin = await mockGithubSsh("danish-work");
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo); // workProfile sets expectedGitHubLogin
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeGithubSshBin}${path.delimiter}${repo.env.PATH}` };

    const elapsed = await medianLatency("push (strict account verification, mocked ssh)", async () => {
      await push(repo, ["origin", "feature/shield-tests"], env);
    });
    // Generous bound: this path adds a real subprocess-spawned `ssh -G`
    // and `ssh -T` (mocked here, but the process-spawn overhead is real)
    // on top of the route-only path. Against a REAL GitHub endpoint this
    // number is dominated by network RTT -- the mocked figure here only
    // bounds the lock's own local overhead, never network time.
    const bound = catastrophicLatencyCeilingMs(10000);
    assert.ok(elapsed < bound, `strict account-verifying push median took ${elapsed}ms, catastrophic ceiling is ${bound}ms`);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeGithubSshBin);
  }
});

test("PERFORMANCE: strict account verification always passes a bounded, configurable ConnectTimeout -- never an unbounded network wait", async () => {
  // A live "unreachable host" test would need a real network probe, is
  // slow, flaky across CI runners/network policies, and (per Phase 5's
  // own rule) automated tests must never contact a real remote SSH
  // endpoint. Instead this asserts, against the actual shipped script
  // text, that the one real `ssh -T` call the lock ever makes always
  // carries an explicit, short, user-configurable ConnectTimeout -- the
  // structural guarantee that bounds wall-clock time regardless of what
  // network conditions a real run hits. The parser's behavior once a
  // "timed out" response comes back is covered live (mocked) in
  // shieldGitHubAccountBinding.test.ts.
  const script = await fs.readFile(EVALUATOR_SOURCE, "utf8");
  assert.match(script, /ConnectTimeout="\$TIMEOUT"/);
  assert.match(script, /TIMEOUT="\$\{REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT:-5\}"/);
});
