import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldManager } from "../shield/manager";
import { Profile, RepoFacts } from "../types";

/**
 * Phase 7 hardening/abuse matrix.
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
 *   - rough added-latency measurements for commit, route-only push, and
 *     strict SSH account-verification push (informational — printed via
 *     console.log rather than tight assertions, since absolute timing is
 *     not portable across CI runners; a very generous upper bound is
 *     still asserted so a genuine regression — e.g. an accidental network
 *     call — fails loudly).
 *
 * Shield's promise, restated because several tests below exist purely to
 * demonstrate its boundary: Shield blocks ORDINARY ACCIDENTAL unsafe Git
 * operations. It does not, and cannot, contain a malicious process willing
 * to pass --no-verify, edit core.hooksPath, or otherwise act with intent
 * to bypass a client-side hook — no local-hook-based tool can.
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
  expectedGitHubLogin: "danish-work",
};

/**
 * Route-only variant of `workProfile` (no `expectedGitHubLogin`) — for
 * tests about push DESTINATION resolution (pushRemote/pushDefault/pushurl/
 * force/deletion) that use the plain `makeFakeSshBin` transport shim,
 * which doesn't answer `ssh -G`/`ssh -T` the way GitHub account
 * verification needs. Using `workProfile` as-is here would spuriously
 * block on push-account-unverified and test the wrong thing.
 */
const routeOnlyProfile: Profile = { ...workProfile, expectedGitHubLogin: undefined };

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

function baseFacts(repo: Repo, overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    isGitRepo: true,
    repoRoot: repo.dir,
    repoName: path.basename(repo.dir),
    remoteHost: "github-work",
    remoteOwner: "AcmeSoftware",
    remoteRepo: "acme-frontend",
    ...overrides,
  };
}

async function enableShield(
  manager: ShieldManager,
  repo: Repo,
  overrides: { profiles?: Profile[]; protectedBranches?: string[]; facts?: Partial<RepoFacts> } = {},
) {
  const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
    facts: baseFacts(repo, overrides.facts),
    profiles: overrides.profiles ?? [workProfile],
    protectedBranches: overrides.protectedBranches ?? ["main", "master"],
  });
  assert.equal(result.ok, true, `enable() should succeed: ${result.inspection.reasons.join("; ")}`);
  return result;
}

async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakessh-"));
  const sshPath = path.join(binDir, "ssh");
  await fs.writeFile(sshPath, `#!/bin/sh\nshift $(($#-1))\nexec sh -c "$1"\n`, { mode: 0o755 });
  return binDir;
}

async function makeBareRemote(parentDir: string, owner: string, repoName: string): Promise<string> {
  const ownerDir = path.join(parentDir, owner);
  await fs.mkdir(ownerDir, { recursive: true });
  const bareDir = path.join(ownerDir, `${repoName}.git`);
  await execFileAsync("git", ["init", "-q", "--bare", bareDir]);
  return bareDir;
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
    assert.match(result.stderr, /author Someone Else/);
    assert.doesNotMatch(result.stderr, /committer Someone Else/);
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
    assert.match(result.stderr, /committer Someone Else/);
    assert.doesNotMatch(result.stderr, /author Someone Else/);
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

test("deleted evaluator: removing the evaluator copy after enable fails OPEN for commit (documented: half-removed Shield must never block an ordinary commit)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.rm(path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh"));

    await git(repo, ["config", "user.email", "personal@example.com"]); // would otherwise be blocked
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "evaluator missing, fails open");
    assert.equal(result.code, 0, result.stderr);
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

test("branch.pushRemote redirects a push and Shield evaluates the ACTUAL destination it resolves to, not origin's URL", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const wrongBare = await makeBareRemote(remoteParent, "AcmeSoftware", "wrong-repo");
    const rightBare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, { profiles: [routeOnlyProfile] });

    await git(repo, ["remote", "add", "origin", `git@github-work:${wrongBare}`]);
    await git(repo, ["remote", "add", "upstream", `git@github-work:${rightBare}`]);
    await git(repo, ["config", "branch.feature/shield-tests.pushRemote", "upstream"]);
    await git(repo, ["config", "push.default", "current"]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    // Bare `git push` (no remote argument) -- only then does Git consult
    // branch.<name>.pushRemote to resolve which remote to use.
    const result = await push(repo, [], env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await remoteRefSha(rightBare, "refs/heads/feature/shield-tests"));
    assert.equal(await remoteRefSha(wrongBare, "refs/heads/feature/shield-tests"), null);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("remote.pushDefault redirects a bare `git push` and is evaluated against the resolved destination", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const wrongBare = await makeBareRemote(remoteParent, "AcmeSoftware", "wrong-repo");
    const rightBare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, { profiles: [routeOnlyProfile] });

    await git(repo, ["remote", "add", "origin", `git@github-work:${wrongBare}`]);
    await git(repo, ["remote", "add", "upstream", `git@github-work:${rightBare}`]);
    await git(repo, ["config", "remote.pushDefault", "upstream"]);
    await git(repo, ["config", `push.default`, "current"]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, [], env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await remoteRefSha(rightBare, "refs/heads/feature/shield-tests"));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("remote.pushurl (asymmetric fetch/push URL) is what's actually evaluated at push time, not the fetch URL", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const rightBare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, { profiles: [routeOnlyProfile] });

    // Fetch URL points somewhere Shield never approved; only the pushurl matters for `git push`.
    await git(repo, ["remote", "add", "origin", "https://example.com/nonexistent/repo.git"]);
    await git(repo, ["remote", "set-url", "--push", "origin", `git@github-work:${rightBare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await remoteRefSha(rightBare, "refs/heads/feature/shield-tests"));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("force push to the approved destination is still subject to the same destination/route checks (force alone changes nothing)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, { profiles: [routeOnlyProfile] });
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

test("ref deletion (`git push origin :branch`) is evaluated the same as any other push to the same destination", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, { profiles: [routeOnlyProfile] });
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const first = await push(repo, ["origin", "feature/shield-tests"], env);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(await remoteRefSha(bare, "refs/heads/feature/shield-tests"));

    const deletion = await push(repo, ["origin", "--delete", "feature/shield-tests"], env);
    assert.equal(deletion.code, 0, deletion.stderr);
    assert.equal(await remoteRefSha(bare, "refs/heads/feature/shield-tests"), null);

    // The destination check still applies to a deletion against an untrusted alias.
    await git(repo, ["branch", "feature/other-branch"]);
    await git(repo, ["remote", "set-url", "origin", `git@totally-untrusted:${bare}`]);
    const blockedDeletion = await push(repo, ["origin", "--delete", "feature/other-branch"], env);
    assert.notEqual(blockedDeletion.code, 0);
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

test("expected GitHub login match under strict verification -> allowed (network mocked via fake ssh, never real GitHub)", async () => {
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
    await cleanup(repo.dir, remoteParent);
  }
});

/**
 * A fake `ssh` that both (a) satisfies `ssh -G <alias>` with
 * "identitiesonly yes" and (b) satisfies `ssh -T user@alias` with a
 * GitHub-shaped "Hi <login>! ... successfully authenticated ..." response,
 * AND (c) for anything else (the actual git-receive-pack transport call)
 * falls through to locally executing the remote command exactly like
 * makeFakeSshBin — so one fake binary serves both the account-verification
 * probe and the real push transport, without ever touching the network.
 */
async function mockGithubSsh(login: string): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakegh-"));
  const sshPath = path.join(binDir, "ssh");
  await fs.writeFile(
    sshPath,
    `#!/bin/sh
case " $* " in
  *" -G "*)
    echo "identitiesonly yes"
    exit 0
    ;;
  *" -T "*)
    echo "Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access."
    exit 1
    ;;
esac
shift $(($#-1))
exec sh -c "$1"
`,
    { mode: 0o755 },
  );
  return binDir;
}

// ==================== KNOWN BYPASSES (documented limitations, not bugs) ====================

test("KNOWN BYPASS: `git commit --no-verify` skips Shield entirely, even with a maximally wrong identity", async () => {
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
    // pre-commit hook, from any tool, can prevent it. Shield's promise is
    // "blocks ordinary accidental unsafe operations," never "contains a
    // user or process willing to pass --no-verify."
  } finally {
    await cleanup(repo.dir);
  }
});

test("KNOWN BYPASS: `git push --no-verify` skips Shield entirely, even to a destination Shield never approved", async () => {
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

test("KNOWN BYPASS: pointing core.hooksPath at an empty directory after Shield is active disables enforcement entirely", async () => {
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
    // Shield's own inspect() DOES detect this after the fact (Phase 6:
    // hooksPathCustomized / a missing governed hook at the resolved
    // path) -- but it cannot retroactively stop a commit that already
    // happened, and nothing forces the user to re-run inspect() before
    // their next commit. Any tool relying on a client-side Git hook has
    // this same limitation: `core.hooksPath` (or deleting the hook file
    // directly) is a fully supported, first-class Git feature, not a
    // vulnerability in Shield.
    const inspection = await manager.inspect(repo.dir);
    assert.notEqual(inspection.state, "active");
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== INTERNAL FAILURE vs POLICY BLOCK ====================

test("a real internal evaluator crash (unbound variable, no structured reason) is reported as a Shield internal error, distinct from a policy block, and still fails closed", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evalPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");
    // Replace the evaluator with something that crashes before ever
    // calling add_reason/fail_immediately -- no "Shield: [" line at all,
    // just a raw shell failure. This simulates a genuine Shield bug
    // (e.g. a typo'd command), not a deliberate policy decision.
    await fs.writeFile(evalPath, `#!/bin/sh\nset -eu\n: "$THIS_VARIABLE_IS_NEVER_SET"\n`, { mode: 0o755 });

    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "should fail closed with a distinct message");
    assert.notEqual(result.code, 0); // still fails CLOSED
    assert.match(result.stderr, /Shield internal error/);
    assert.doesNotMatch(result.stderr, /COMMIT BLOCKED\n/); // not framed as an ordinary policy block
    assert.match(result.stderr, /Next step:/);
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
    assert.match(result.stderr, /COMMIT BLOCKED\n/);
    assert.doesNotMatch(result.stderr, /Shield internal error/);
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== FAILURE MESSAGE SHAPE ====================

test("every commit block states action, profile, expected, found, and a next corrective step -- no stack trace", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "x\n");
    const result = await commit(repo, "ordinary block");
    assert.match(result.stderr, /COMMIT BLOCKED/); // action blocked
    assert.match(result.stderr, /Profile: Work/); // profile
    assert.match(result.stderr, /Expected:.*work@example\.com/); // expected
    assert.match(result.stderr, /Found:.*personal@example\.com/); // found
    assert.match(result.stderr, /commit-identity-mismatch/); // concise machine reason
    assert.match(result.stderr, /Fix the repository identity or disable Shield/); // next corrective step
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
function platformBoundMs(posixBoundMs: number): number {
  return process.platform === "win32" ? posixBoundMs * 5 : posixBoundMs;
}

test("PERFORMANCE: added commit latency stays well under one second on a local repo", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const withoutShieldRepo = await makeTempRepo("shield-harden-baseline-");
    try {
      await touchFile(withoutShieldRepo, "a.txt", "x\n");
      const baseline = await timeIt(() => commit(withoutShieldRepo, "baseline"));

      await touchFile(repo, "a.txt", "x\n");
      const withShield = await timeIt(() => commit(repo, "shielded"));

      // eslint-disable-next-line no-console
      console.log(`[perf] commit: baseline=${baseline.toFixed(1)}ms shielded=${withShield.toFixed(1)}ms delta=${(withShield - baseline).toFixed(1)}ms`);
      const bound = platformBoundMs(1000);
      assert.ok(withShield < bound, `commit with Shield took ${withShield}ms, expected well under ${bound}ms`);
    } finally {
      await cleanup(withoutShieldRepo.dir);
    }
  } finally {
    await cleanup(repo.dir);
  }
});

test("PERFORMANCE: added push latency in route-only (non-account-verifying) strict mode stays well under one second", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    // No expectedGitHubLogin -- route trust only, Phase 0-4 behavior.
    const profile: Profile = { ...workProfile, expectedGitHubLogin: undefined };
    await enableShield(manager, repo, { profiles: [profile] });
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const elapsed = await timeIt(() => push(repo, ["origin", "feature/shield-tests"], env));
    // eslint-disable-next-line no-console
    console.log(`[perf] push (route-only): ${elapsed.toFixed(1)}ms`);
    const bound = platformBoundMs(1000);
    assert.ok(elapsed < bound, `route-only push took ${elapsed}ms, expected well under ${bound}ms`);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("PERFORMANCE: added push latency in strict GitHub SSH account-verification mode stays bounded (mocked ssh -- an extra ssh -G + ssh -T round trip)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeGithubSshBin = await mockGithubSsh("danish-work");
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo); // workProfile already sets expectedGitHubLogin
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeGithubSshBin}${path.delimiter}${repo.env.PATH}` };

    const elapsed = await timeIt(() => push(repo, ["origin", "feature/shield-tests"], env));
    // eslint-disable-next-line no-console
    console.log(`[perf] push (strict GitHub SSH account verification, mocked ssh): ${elapsed.toFixed(1)}ms`);
    // Generous bound: this path adds a real subprocess-spawned `ssh -G`
    // and `ssh -T` (mocked here, but the process-spawn overhead is real)
    // on top of the route-only path. Against a REAL GitHub endpoint this
    // number is dominated by network RTT (see docs/SHIELD_MODE.md's
    // measured-latency note) -- the mocked figure here only bounds
    // Shield's own local overhead, never network time.
    const bound = platformBoundMs(3000);
    assert.ok(elapsed < bound, `strict account-verifying push took ${elapsed}ms, expected well under ${bound}ms locally`);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeGithubSshBin);
  }
});

test("PERFORMANCE: strict account verification always passes a bounded, configurable ConnectTimeout -- never an unbounded network wait", async () => {
  // A live "unreachable host" test would need a real network probe, is
  // slow, flaky across CI runners/network policies, and (per Phase 5's
  // own rule) automated tests must never contact a real remote SSH
  // endpoint. Instead this asserts, against the actual shipped script
  // text, that the one real `ssh -T` call Shield ever makes always
  // carries an explicit, short, user-configurable ConnectTimeout -- the
  // structural guarantee that bounds wall-clock time regardless of what
  // network conditions a real run hits. The parser's behavior once a
  // "timed out" response comes back is covered live (mocked) in
  // shieldGitHubAccountBinding.test.ts.
  const script = await fs.readFile(EVALUATOR_SOURCE, "utf8");
  assert.match(script, /ConnectTimeout="\$TIMEOUT"/);
  assert.match(script, /TIMEOUT="\$\{REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT:-5\}"/);
});
