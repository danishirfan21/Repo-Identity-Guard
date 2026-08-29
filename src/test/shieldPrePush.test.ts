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
 * Integration tests for Shield's pre-push enforcement (Phase 4): real
 * temporary Git repositories, real bare remotes, and — for SSH-protocol
 * scenarios — a real `git push` over a genuinely faked SSH transport (see
 * `makeFakeSshBin` below), never a simulated/mocked hook invocation. Every
 * "blocked" assertion checks BOTH the exit code AND that the remote ref
 * was NOT updated; every "allowed" assertion checks the ref WAS updated to
 * the pushed commit.
 *
 * `origin`/`facts.remoteHost` etc. never determine anything by themselves —
 * `ShieldManager.enable()` is given `facts` describing the *approved*
 * destination (as if that's what `origin` looked like when Shield was last
 * enabled/repaired), and each test then configures the repo's REAL `origin`
 * remote independently and pushes for real, exactly like an actual git
 * client would after the URL changed underneath Shield's policy.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
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

interface PushResult {
  code: number;
  stderr: string;
}

function push(repo: Repo, args: string[], envOverride?: NodeJS.ProcessEnv): Promise<PushResult> {
  return new Promise((resolve, reject) => {
    execFile("git", ["push", ...args], { cwd: repo.dir, encoding: "utf8", env: envOverride ?? repo.env }, (error, _stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") {
        reject(error);
        return;
      }
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, stderr });
    });
  });
}

/**
 * A fake `ssh` executable, shadowed onto PATH ahead of the real one, that
 * lets a real `git push` over a genuine scp-like SSH URL
 * (`git@<alias>:<path>`) actually land in a local bare repo instead of
 * attempting a real network connection — no real SSH daemon involved.
 * Git invokes its configured SSH command as `ssh [options] <host>
 * <remote-command>`; this script drops the host argument and runs the
 * remote command (`git-receive-pack '<path>'` etc.) locally via `sh -c`,
 * which works because the URL's "path" portion is deliberately a real
 * local filesystem path to a bare repo this test created.
 *
 * Crucially, this is invoked purely via PATH resolution — no `GIT_SSH`,
 * `GIT_SSH_COMMAND`, or `core.sshCommand` is set for these "should
 * succeed" tests, so it is indistinguishable to Shield's own
 * override-detection from a real, unmodified `ssh`. (A real attacker
 * shadowing PATH this way would be equally invisible to Shield — a
 * documented limitation, not a gap introduced by this test harness: see
 * docs/SHIELD_MODE.md "Phase 4.")
 */
async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakessh-"));
  const sshPath = path.join(binDir, "ssh");
  await fs.writeFile(
    sshPath,
    `#!/bin/sh\nshift $(($#-1))\nexec sh -c "$1"\n`,
    { mode: 0o755 },
  );
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

async function touchFile(repo: Repo, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo.dir, name), content);
  await git(repo, ["add", name]);
}

/**
 * Some sandboxes/CI environments inject `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` into the ambient process environment to transparently
 * rewrite `git@github.com:`/`ssh://git@github.com/` to `https://github.com/`
 * (routing real GitHub SSH-shaped URLs through an HTTP(S) proxy). Env-based
 * git config outranks `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`, so it isn't
 * neutralized by either — it must be stripped explicitly, or a test that
 * deliberately targets the literal generic host "github.com" would
 * silently get rewritten into a real network call instead of exercising
 * Shield's own route-trust logic at all.
 */
function stripAmbientGitConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete cleaned[key];
  }
  return cleaned;
}

async function makeTempRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-push-"));
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

  return repo;
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
}

function approvedFacts(repo: Repo, overrides: Partial<RepoFacts> = {}): RepoFacts {
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
  facts: RepoFacts,
  profiles: Profile[] = [workProfile],
): Promise<void> {
  const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, { facts, profiles, protectedBranches: [] });
  assert.equal(result.ok, true, `enable() should succeed: ${result.inspection.reasons.join("; ")}`);
}

// ==================== approved-route baseline (real SSH-shaped transport) ====================

test("push to the approved destination through a trusted SSH alias -> allowed, and the remote ref IS updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("pushing multiple refs in one invocation still allows/enforces correctly (multi-ref stdin input)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    await git(repo, ["branch", "second"]);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main", "second"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare, "refs/heads/main"), await git(repo, ["rev-parse", "main"]));
    assert.equal(await remoteRefSha(bare, "refs/heads/second"), await git(repo, ["rev-parse", "second"]));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("--no-verify bypasses Shield's pre-push hook entirely (documented, expected, not a bug — outside the accidental-misuse threat model)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    // A destination that would otherwise be blocked.
    const bare = await makeBareRemote(remoteParent, "SomeoneElse", "other-repo");
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));
    await git(repo, ["remote", "add", "origin", bare]);

    const result = await push(repo, ["origin", "main", "--no-verify"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

// ==================== destination checks (route held constant: trusted alias) ====================

test("a pushurl changed to a different owner after Shield approval -> blocked, ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    // Shield was enabled while the approved destination was AcmeSoftware/acme-frontend...
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    // ...but the push URL now points somewhere else entirely (e.g.
    // `github-personal` in the task's own example) — still a trusted-
    // shaped alias host so ONLY the destination check is exercised.
    const bare = await makeBareRemote(remoteParent, "someone", "backend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    await git(repo, ["config", "remote.origin.pushurl", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /Repo Identity Guard Shield/);
    assert.match(result.stderr, /PUSH BLOCKED/);
    assert.match(result.stderr, /push-destination-mismatch/);
    assert.match(result.stderr, /Profile: Work/);
    assert.match(result.stderr, /Expected approved destination/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("a different remote entirely (not 'origin') is still checked against the same policy -> blocked", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "SomeoneElse", "unrelated");
    await git(repo, ["remote", "add", "upstream", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["upstream", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-destination-mismatch/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("a direct URL push (git push <url>, no configured remote) to an unexpected destination -> blocked", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "RandomOrg", "random-repo");
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, [`git@github-work:${bare}`, "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-destination-mismatch/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("no approved destination on file (policy predates a resolvable remote) -> fails closed, blocked", async () => {
  // ShieldManager's own profile resolution requires *some* remote fact to
  // match a profile against, so "Shield enabled with literally no remote"
  // and "profile resolved" can't co-occur through enable() itself. The
  // realistic way a live policy ends up with no approved destination is a
  // stale/older policy that predates one being resolved -- simulated here
  // by enabling normally, then stripping the field from the persisted
  // policy file directly, exactly as an old-format policy would read back.
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const policyPath = path.join(commonDir, "repo-identity-guard", "shield-policy.json");
    const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
    delete policy.approvedPushDestination;
    await fs.writeFile(policyPath, JSON.stringify(policy, null, 2));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-destination-mismatch/);
    assert.match(result.stderr, /no approved push destination/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

// ==================== route / account checks (destination held constant) ====================

test("a generic SSH host (github.com) under a strict profile -> blocked, ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github.com:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-unverified/);
    assert.doesNotMatch(result.stderr, /verified account|verified key|cryptographically verif/i);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an untrusted SSH alias under a strict profile -> blocked, ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    // "github-personal" LOOKS like a dedicated alias but was never listed
    // in trustedSshHostAliases -- must not be trusted just for not being
    // one of the well-known generic hosts.
    await git(repo, ["remote", "add", "origin", `git@github-personal:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-unverified/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an unknown-protocol route (file://) under a strict profile is unverified and blocked, even with a real, working, non-SSH transport", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `file://${bare}`]);

    // No fake SSH needed here -- file:// is a real transport Git supports
    // natively, so this exercises route-unverified against a genuinely
    // working (non-SSH) connection, not merely a URL string.
    const result = await push(repo, ["origin", "main"]);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-unverified/);
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

// ==================== action-time SSH overrides ====================

// Empirically, an override that actually breaks the SSH transport (e.g.
// `/bin/false`) makes Git fail during connection setup/ref advertisement
// BEFORE it ever invokes the pre-push hook at all — a real, but different
// and less interesting, kind of "blocked" (Git's own transport failure,
// not Shield). To prove Shield's own hook is what's blocking these — and
// that it blocks a push that would otherwise have gone through — every
// override below points at `makeFakeSshBin`'s WORKING fake transport
// (targeting the exact approved destination), so the connection would
// succeed if Shield allowed it.

test("GIT_SSH_COMMAND set at push time -> route unverifiable, strict mode blocks a push that would otherwise succeed", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);

    const result = await push(repo, ["origin", "main"], { ...repo.env, GIT_SSH_COMMAND: path.join(fakeSshBin, "ssh") });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-override/);
    assert.match(result.stderr, /GIT_SSH_COMMAND/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("GIT_SSH set at push time -> route unverifiable, strict mode blocks a push that would otherwise succeed", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);

    const result = await push(repo, ["origin", "main"], { ...repo.env, GIT_SSH: path.join(fakeSshBin, "ssh") });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-override/);
    assert.match(result.stderr, /GIT_SSH\b/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("core.sshCommand set (persisted repo config) -> route unverifiable, strict mode blocks a push that would otherwise succeed", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    await git(repo, ["config", "core.sshCommand", path.join(fakeSshBin, "ssh")]);

    const result = await push(repo, ["origin", "main"]);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-override/);
    assert.match(result.stderr, /core\.sshCommand/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("a command-scoped `git -c core.sshCommand=...` override is visible at hook time too (not only persisted config) -> blocks a push that would otherwise succeed", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);

    const result = await new Promise<PushResult>((resolve, reject) => {
      execFile(
        "git",
        ["-c", `core.sshCommand=${path.join(fakeSshBin, "ssh")}`, "push", "origin", "main"],
        { cwd: repo.dir, encoding: "utf8", env: repo.env },
        (error, _stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== "number") {
            reject(error);
            return;
          }
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
        },
      );
    });

    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-override/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an SSH override does NOT block a non-strict profile (route trust is only ever gated by strictPushSetup)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo), [relaxedProfile]);

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}`, GIT_SSH_COMMAND: `${fakeSshBin}/ssh` };

    const result = await push(repo, ["origin", "main"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

// ==================== policy / evaluator failure modes ====================

test("missing Shield policy at push time -> blocked, ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.unlink(path.join(commonDir, "repo-identity-guard", "shield-policy.json"));

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /policy-missing/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("malformed (corrupted) Shield policy at push time -> blocked, ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.writeFile(path.join(commonDir, "repo-identity-guard", "shield-policy.json"), "{ not valid json ][");

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an evaluator that fails unexpectedly (corrupted copy) still blocks the push -- fail-closed, not fail-open", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, approvedFacts(repo));

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evaluatorPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");
    // Simulate an internal evaluator bug/corruption unrelated to any real
    // Shield reason code -- the hook must still treat any non-zero exit
    // from the evaluator as a block, never inspect *why* to decide.
    await fs.writeFile(evaluatorPath, `#!/bin/sh\necho "unexpected internal error" >&2\nexit 99\n`, { mode: 0o755 });

    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };

    const result = await push(repo, ["origin", "main"], env);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /unexpected internal error/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});
