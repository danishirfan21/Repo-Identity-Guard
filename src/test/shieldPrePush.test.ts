import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldManager } from "../shield/manager";
import { WORK_IDENTITY, WORK_IDENTITY_WITH_LOGIN, enableLock, parseBlockPrelude } from "./testUtil/lockFixtures";

/**
 * Integration tests for the identity lock's pre-push enforcement: real
 * temporary Git repositories, real bare remotes, and — for SSH-protocol
 * scenarios — a real `git push` over a genuinely faked SSH transport (see
 * `makeFakeSshBin` below) that ALSO answers the hook's `ssh -G` / `ssh -T`
 * account probe. Every "blocked" assertion checks BOTH the exit code AND
 * that the remote ref was NOT updated; every "allowed" assertion checks
 * the ref WAS updated.
 *
 * The lock answers "does this push authenticate as the assigned GitHub
 * account?" — never "is this the approved repository?" (the destination
 * policy was removed).
 */

const execFileAsync = promisify(execFile);
const workProfile = WORK_IDENTITY;

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
 * <remote-command>`; this drops the host/option arguments and runs the
 * remote command (`git-receive-pack '<path>'` etc.) locally, which works
 * because the URL's "path" portion is deliberately a real local filesystem
 * path to a bare repo this test created.
 *
 * Crucially, this is invoked purely via PATH resolution — no `GIT_SSH`,
 * `GIT_SSH_COMMAND`, or `core.sshCommand` is set for these "should
 * succeed" tests, so it is indistinguishable to Shield's own
 * override-detection from a real, unmodified `ssh`. (A real attacker
 * shadowing PATH this way would be equally invisible to Shield — a
 * documented limitation, not a gap introduced by this test harness: see
 * docs/SHIELD_MODE.md "Phase 4.")
 *
 * Phase 7 Windows finding: a PATH lookup for a bare, extension-less `ssh`
 * file is a POSIX-only mechanism — Windows resolves an unqualified command
 * by trying `PATHEXT` extensions (.EXE/.CMD/.BAT/...) against each PATH
 * directory in turn, so a shebang script named plain `ssh` is invisible to
 * it and the *real* `ssh.exe` further down PATH gets found instead (a real
 * `git push` then genuinely tries to resolve "github-work" as a DNS name
 * and fails). Writing an `ssh.cmd` shim alongside it -- delegating to a
 * plain Node script rather than assuming any particular shell is on PATH
 * -- makes the shadow visible on Windows too, and the shared regex-based
 * parser (rather than `sh -c`) sidesteps depending on a POSIX shell being
 * reachable at all.
 */
async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakessh-"));
  await writeFakeSshPassthrough(binDir);
  return binDir;
}

/**
 * Shared passthrough implementation: git's ssh transport always invokes the
 * remote command as a single already-quoted argument shaped like
 * `git-upload-pack '/abs/path'` -- parsing that out with a regex and
 * running it directly (no intermediate shell) works identically on every
 * platform this suite runs on.
 */
function fakeSshPassthroughImplSource(): string {
  return `"use strict";
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
// The pre-push hook's account probe: "ssh -G <alias>" (effective route)
// then "ssh -T ... <alias>" (who does GitHub say this is?). The alias
// resolves to github.com with IdentitiesOnly unless a test overrides it.
if (joined.includes(" -G ")) {
  process.stdout.write(
    "user " + (process.env.FAKE_SSH_USER || "git") + "\\n" +
    "hostname " + (process.env.FAKE_SSH_HOSTNAME || "github.com") + "\\n" +
    "port " + (process.env.FAKE_SSH_PORT || "22") + "\\n" +
    "identitiesonly " + (process.env.FAKE_SSH_IDENTITIES_ONLY || "yes") + "\\n"
  );
  process.exit(0);
}
if (joined.includes(" -T ")) {
  process.stderr.write(process.env.FAKE_SSH_AUTH_OUTPUT || "");
  process.exit(1);
}
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
`;
}

async function writeFakeSshPassthrough(binDir: string): Promise<void> {
  const implPath = path.join(binDir, "fake-ssh-impl.js");
  await fs.writeFile(implPath, fakeSshPassthroughImplSource());
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
}

// MSYS/git-bash (which resolves GIT_SSH_COMMAND / core.sshCommand via its
// own `sh -c "<command> ..."`) treats a backslash as a POSIX shell escape
// character -- an unconverted Windows path like `C:\Users\x\ssh` arrives
// at sh with every backslash silently eaten (`C:Usersxssh`, "command not
// found"). Any fake-ssh path handed to Git through a config value or env
// var that Git re-invokes via a shell must be forward-slashed first.
function toShellPath(p: string): string {
  return p.split(path.sep).join("/");
}

async function makeBareRemote(parentDir: string, owner: string, repoName: string): Promise<string> {
  const ownerDir = path.join(parentDir, owner);
  await fs.mkdir(ownerDir, { recursive: true });
  const bareDir = path.join(ownerDir, `${repoName}.git`);
  await execFileAsync("git", ["init", "-q", "--bare", bareDir]);
  // Phase 7 Windows finding: this path gets embedded directly into a
  // scp-like SSH URL below (`git@host:<path>`) for Shield's evaluator to
  // parse the owner/repo out of. A raw Windows backslash path there breaks
  // that parsing (the whole thing reads as one opaque segment, not
  // "AcmeSoftware/acme-frontend"), producing a spurious destination
  // mismatch. Forward slashes work equally well as a real filesystem path
  // on Windows, so normalizing once here keeps every downstream URL and
  // fs operation consistent.
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
  return normalizePathKey(cleaned);
}

/**
 * Phase 7 Windows finding: `process.env` on Windows carries the search-path
 * variable as `Path` (or `PATH`/`path`, inconsistently, depending on how the
 * runner set it up) -- Node's `process.env` is case-insensitive for reads,
 * but a plain object produced by spreading it is NOT, so it keeps whatever
 * casing the OS happened to use as its only real key. Every test in this
 * file reads `repo.env.PATH` (uppercase) to prepend a fake ssh directory;
 * on a box where the real key is `Path`, that read silently returns
 * `undefined`, and the resulting env ends up with BOTH a correct `Path` and
 * a broken `PATH: "<dir>;undefined"` -- and once both casings of the same
 * Windows environment variable exist on one object, spawn's env block
 * becomes ambiguous and `git` itself failed to resolve at all (`spawn git
 * ENOENT`), not just the fake ssh shim. Collapsing every case variant down
 * to a single canonical `PATH` key up front removes the ambiguity.
 */
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

const LOGIN_IDENTITY = WORK_IDENTITY_WITH_LOGIN;
const AUTH_AS = (login: string) => `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.`;

async function enableShield(manager: ShieldManager, repo: Repo, identity = LOGIN_IDENTITY): Promise<void> {
  const result = await enableLock(manager, repo.dir, identity, { requireComplete: true });
  assert.equal(result.ok, true, `enable() should succeed: ${result.inspection.reasons.join("; ")}`);
}

function fakeSshEnv(repo: Repo, fakeSshBin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}`, FAKE_SSH_AUTH_OUTPUT: AUTH_AS("danish-work"), ...extra };
}

// Phase 7 Windows finding: Git for Windows does not resolve its ssh
// transport through the caller's PATH the way POSIX git does -- it falls
// through to its own bundled ssh.exe regardless of what this suite
// prepends to PATH, so a real DNS/auth failure surfaces (git connects for
// real ref advertisement BEFORE the pre-push hook ever runs) instead of
// reaching our fake-ssh transport at all. This is a gap in this repo's
// PATH-shadowing test *technique* on Windows, not in the lock: the
// identical push behavior is exercised on ubuntu-latest/macos-latest, the
// evaluator's account verification runs for real on Windows in
// shieldAccountVerificationCrossPlatform.test.ts, and the
// override-DETECTION half (GIT_SSH_COMMAND/GIT_SSH/core.sshCommand) is
// verified on all three platforms since Git executes those values directly.
const SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS =
  process.platform === "win32"
    ? "Git for Windows does not resolve ssh via PATH search -- this suite's PATH-shadow fake-ssh technique cannot intercept it here (see comment above). Covered on ubuntu-latest/macos-latest."
    : false;

// ==================== commit-only lock: pushes are never account-checked ====================

test("a commit-only lock (identity without a GitHub login) never blocks a push", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    const bare = await makeBareRemote(remoteParent, "AnyOwner", "any-repo");
    await enableShield(new ShieldManager(), repo, WORK_IDENTITY);
    await git(repo, ["remote", "add", "origin", bare]);
    const result = await push(repo, ["origin", "main"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

// ==================== account verification over a real SSH-shaped transport ====================

test("push through a trusted SSH alias that authenticates as the expected GitHub account -> allowed, and the remote ref IS updated", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const result = await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("there is no push-destination policy: a different owner/repo, another remote name, and a direct URL push are all ALLOWED when the account is the assigned one", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    await enableShield(new ShieldManager(), repo);
    const env = fakeSshEnv(repo, fakeSshBin);

    const other = await makeBareRemote(remoteParent, "SomeoneElse", "other-repo");
    await git(repo, ["remote", "add", "origin", `git@github-work:${other}`]);
    assert.equal((await push(repo, ["origin", "main"], env)).code, 0);

    const fork = await makeBareRemote(remoteParent, "Fork", "fork-repo");
    await git(repo, ["remote", "add", "fork", `git@github-work:${fork}`]);
    assert.equal((await push(repo, ["fork", "main"], env)).code, 0);

    const direct = await makeBareRemote(remoteParent, "Direct", "direct-repo");
    assert.equal((await push(repo, [`git@github-work:${direct}`, "main"], env)).code, 0);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("a DIFFERENT authenticated GitHub account -> blocked with wrong_push_account naming both accounts, ref NOT updated", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const result = await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin, { FAKE_SSH_AUTH_OUTPUT: AUTH_AS("danish-personal") }));
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    const prelude = parseBlockPrelude(result.stderr);
    assert.equal(prelude.ACTION, "push");
    assert.equal(prelude.REASON, "wrong_push_account");
    assert.equal(prelude.REASON_ID, "push-account-mismatch");
    assert.equal(prelude.IDENTITY, "Work");
    assert.equal(prelude.EXPECTED_GITHUB_LOGIN, "danish-work");
    assert.equal(prelude.FOUND_GITHUB_LOGIN, "danish-personal");
    assert.equal(prelude.REMOTE, "origin");
    assert.equal(prelude.ROUTE_HOST, "github-work");
    assert.match(result.stderr, /Repo Identity Guard blocked this push/);
    assert.match(result.stderr, /--no-verify/);
    // The raw remote location is never echoed by the hook (an HTTPS URL can
    // embed credentials). Git's OWN trailing "failed to push some refs to
    // '<url>'" / "To <url>" lines are not ours and are excluded.
    const ourLines = result.stderr.split(/\r?\n/).filter((line) => !/^error: failed to push some refs to /.test(line) && !/^To /.test(line));
    assert.deepEqual(ourLines.filter((line) => line.includes(bare)), [], "the hook must not print the remote URL/path");
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an SSH alias repointed away from GitHub blocks a real git push through the SAME unchanged remote URL (the live probe re-resolves it every push)", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    assert.equal((await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin))).code, 0);

    await git(repo, ["commit", "-q", "--allow-empty", "-m", "second"]);
    // ~/.ssh/config edited so "github-work" now resolves elsewhere -- even a
    // perfectly GitHub-shaped greeting from there must not count.
    const second = await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin, { FAKE_SSH_HOSTNAME: "evil.example" }));
    assert.notEqual(second.code, 0);
    const prelude = parseBlockPrelude(second.stderr);
    assert.equal(prelude.REASON_ID, "push-account-unverified");
    assert.equal(prelude.DETAIL, "route_not_github");
    assert.equal(prelude.FOUND_GITHUB_LOGIN, "unverified");
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD~1"]));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an unverifiable account (permission denied) blocks the push — never treated as 'probably fine'", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const result = await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin, { FAKE_SSH_AUTH_OUTPUT: "git@github.com: Permission denied (publickey)." }));
    assert.notEqual(result.code, 0);
    assert.equal(parseBlockPrelude(result.stderr).DETAIL, "permission_denied");
    assert.equal(await remoteRefSha(bare), null);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("pushing multiple refs in one invocation still allows correctly (multi-ref stdin input)", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["branch", "second"]);
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const result = await push(repo, ["origin", "main", "second"], fakeSshEnv(repo, fakeSshBin));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare, "refs/heads/main"), await git(repo, ["rev-parse", "main"]));
    assert.equal(await remoteRefSha(bare, "refs/heads/second"), await git(repo, ["rev-parse", "second"]));
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("--no-verify bypasses the pre-push hook entirely (documented, deliberate, outside the accidental-misuse threat model)", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    // file:// is never verifiable for a login lock — it would be blocked without --no-verify.
    const bare = await makeBareRemote(remoteParent, "SomeoneElse", "other-repo");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `file://${bare}`]);
    assert.notEqual((await push(repo, ["origin", "main"])).code, 0);
    const result = await push(repo, ["origin", "main", "--no-verify"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(bare), await git(repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

// ==================== routes that cannot carry account evidence ====================

test("a generic SSH host (github.com) -> push-route-unverified, ref NOT updated", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `git@github.com:${bare}`]);
    const result = await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin));
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /REASON_ID: push-route-unverified/);
    assert.match(result.stderr, /DETAIL: generic_ssh_host/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an SSH alias the identity does not trust -> push-route-unverified, ref NOT updated", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await enableShield(new ShieldManager(), repo);
    await git(repo, ["remote", "add", "origin", `git@github-personal:${bare}`]);
    const result = await push(repo, ["origin", "main"], fakeSshEnv(repo, fakeSshBin));
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /DETAIL: untrusted_alias/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("an unknown-protocol route (file://) is unverifiable and blocked, even with a real, working, non-SSH transport", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    await enableShield(new ShieldManager(), repo);
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `file://${bare}`]);
    const result = await push(repo, ["origin", "main"]);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /push-route-unverified/);
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

// ==================== action-time SSH transport overrides ====================

// Every override below points at the WORKING fake transport targeting the
// trusted alias, so the connection would succeed if the lock allowed it —
// proving it is the hook that blocks, not a broken transport.

async function overrideScenario(apply: (repo: Repo, sshPath: string) => Promise<{ env?: NodeJS.ProcessEnv; configArgs?: string[] }>, expected: RegExp): Promise<void> {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    await enableShield(new ShieldManager(), repo);
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
    const { env, configArgs } = await apply(repo, toShellPath(path.join(fakeSshBin, "ssh")));
    const result = await new Promise<PushResult>((resolve, reject) => {
      execFile("git", [...(configArgs ?? []), "push", "origin", "main"], { cwd: repo.dir, encoding: "utf8", env: { ...(env ?? repo.env), FAKE_SSH_AUTH_OUTPUT: AUTH_AS("danish-work") } }, (error, _stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      });
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /REASON_ID: push-route-override/);
    assert.match(result.stderr, expected);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
}

test("GIT_SSH_COMMAND set at push time -> push-route-override blocks a push that would otherwise succeed", async () => {
  await overrideScenario(async (repo, ssh) => ({ env: { ...repo.env, GIT_SSH_COMMAND: ssh } }), /GIT_SSH_COMMAND/);
});

test("GIT_SSH set at push time -> push-route-override blocks a push that would otherwise succeed", async () => {
  await overrideScenario(async (repo, ssh) => ({ env: { ...repo.env, GIT_SSH: ssh } }), /GIT_SSH\b/);
});

test("core.sshCommand set (persisted repo config) -> push-route-override", async () => {
  await overrideScenario(async (repo, ssh) => {
    await git(repo, ["config", "core.sshCommand", ssh]);
    return {};
  }, /core\.sshCommand/);
});

test("a command-scoped `git -c core.sshCommand=...` override is visible at hook time too -> push-route-override", async () => {
  await overrideScenario(async (_repo, ssh) => ({ configArgs: ["-c", `core.sshCommand=${ssh}`] }), /core\.sshCommand/);
});

// ==================== policy / evaluator failure modes ====================

test("missing lock policy at push time -> blocked (fail closed), ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    await enableShield(new ShieldManager(), repo, WORK_IDENTITY);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.unlink(path.join(commonDir, "repo-identity-guard", "shield-policy.json"));
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", bare]);
    const result = await push(repo, ["origin", "main"]);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /policy-missing/);
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("malformed (corrupted) lock policy at push time -> blocked, ref NOT updated", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    await enableShield(new ShieldManager(), repo, WORK_IDENTITY);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.writeFile(path.join(commonDir, "repo-identity-guard", "shield-policy.json"), "{ not valid json ][");
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", bare]);
    const result = await push(repo, ["origin", "main"]);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});

test("an evaluator that fails unexpectedly (corrupted copy) still blocks the push -- fail-closed, framed as an internal error", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  try {
    await enableShield(new ShieldManager(), repo, WORK_IDENTITY);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.writeFile(path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh"), `#!/bin/sh\necho "unexpected internal error" >&2\nexit 99\n`, { mode: 0o755 });
    const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
    await git(repo, ["remote", "add", "origin", bare]);
    const result = await push(repo, ["origin", "main"]);
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(bare), null);
    assert.match(result.stderr, /unexpected internal error/);
    assert.equal(parseBlockPrelude(result.stderr).REASON, "internal_error");
  } finally {
    await cleanup(repo.dir, remoteParent);
  }
});
