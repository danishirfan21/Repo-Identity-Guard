import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { SHIELD_ARTIFACT_MARKER } from "../shield/artifacts";
import { ShieldManager, SshResolver } from "../shield/manager";
import { Profile, RepoFacts } from "../types";

/**
 * Integration tests for Shield Mode Phase 6: hook coexistence (chaining a
 * pre-existing foreign hook rather than refusing to install alongside
 * it), worktree correctness, integrity detection, and install/uninstall
 * lifecycle robustness. Real temporary Git repositories throughout —
 * nothing here mocks the filesystem or Git itself.
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

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(repo: Repo, args: string[], envOverride?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo.dir, encoding: "utf8", env: envOverride ?? repo.env }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") {
        reject(error);
        return;
      }
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

async function touchFile(repo: Repo, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo.dir, name), content);
  await git(repo, ["add", name]);
}

// Same Windows finding as shieldGitTopology.test.ts's toPosix: Git always
// reports paths with forward slashes, even on Windows, so comparing one
// against a native-separator Node path spuriously fails there alone.
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// Same Windows PATH-casing fix as shieldPrePush.test.ts — see that file's
// comment on `normalizePathKey` for why this is necessary: `process.env`
// on Windows may key the search path as `Path`, not `PATH`, and reading
// `repo.env.PATH` off a plain spread object silently returns undefined,
// producing a broken PATH once a fake ssh dir is prepended.
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
  // realpath: on macOS, os.tmpdir() resolves through the /var ->
  // /private/var symlink, while `git rev-parse --path-format=absolute`
  // returns the canonical /private/var/... form -- without this, every
  // assertion comparing a computed path against git's own absolute-path
  // output would spuriously fail on macOS alone (confirmed via CI).
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-")));
  const env: NodeJS.ProcessEnv = {
    ...normalizePathKey(process.env),
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

function baseFacts(repo: Repo, overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    isGitRepo: true,
    repoRoot: repo.dir,
    repoName: path.basename(repo.dir),
    remoteHost: "github.com",
    remoteOwner: "AcmeSoftware",
    remoteRepo: "acme-frontend",
    // Phase 8: `approvedPushDestination` is built from the pushRemote*
    // facts (the destination a plain `git push` actually reaches), never
    // from origin's fetch facts. These fixtures describe the ordinary
    // "origin is also the push destination" arrangement, so both sets
    // agree; tests that deliberately separate them override pushRemote*.
    pushRemoteName: "origin",
    pushRemoteUrl: "git@github.com:AcmeSoftware/acme-frontend.git",
    pushRemoteProtocol: "ssh" as const,
    pushRemoteHost: "github.com",
    pushRemoteOwner: "AcmeSoftware",
    pushRemoteRepo: "acme-frontend",
    ...overrides,
  };
}

async function hooksDirFor(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

async function enableShield(
  manager: ShieldManager,
  repo: Repo,
  overrides: {
    profiles?: Profile[];
    facts?: Partial<RepoFacts>;
    chainForeignHooks?: boolean;
    fakeSshBin?: string;
    sshResolver?: SshResolver;
  } = {},
) {
  // Round-2 release-blocker fix: enable() now resolves and persists the
  // approved destination's REAL canonical SSH endpoint via a live
  // `ssh -G` call. Threading the fake ssh's PATH-shadowing directory
  // through here (via ShieldEnableInput.env, never this test process's
  // real global environment) is what makes that resolution see the fake
  // "github-work -> github.com" route.
  const env = overrides.fakeSshBin
    ? { ...repo.env, PATH: `${overrides.fakeSshBin}${path.delimiter}${repo.env.PATH}` }
    : undefined;
  return manager.enable(repo.dir, EVALUATOR_SOURCE, {
    facts: baseFacts(repo, overrides.facts),
    profiles: overrides.profiles ?? [workProfile],
    protectedBranches: ["main", "master"],
    chainForeignHooks: overrides.chainForeignHooks,
    env,
    sshResolver: overrides.sshResolver,
  });
}

/**
 * A deterministic, in-process stand-in for a real `ssh -G` resolution —
 * always resolves to `hostname` on port "22", regardless of platform.
 * Injected via `ShieldEnableInput.sshResolver`/
 * `ShieldInspectOptions.sshResolver` instead of shadowing a fake `ssh`
 * binary onto PATH, which is NOT deterministic across platforms: real
 * Windows process spawning does not resolve a PATH-shadowed fake `ssh`
 * the same way a POSIX shell does (see docs/SHIELD_MODE.md's Windows
 * evaluator-testing section). This makes the underlying Shield behavior
 * — not just the shell evaluator's own parsing — verifiable identically
 * on all three platforms.
 */
function fakeResolverFor(hostname: string): SshResolver {
  return async () => ({ host: hostname, port: "22" });
}

// ==================== hook coexistence: chaining ====================

test("chainForeignHooks: false (default) never touches a foreign hook — Phase 3/4/5 behavior unchanged", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const foreignContent = "#!/bin/sh\necho foreign\nexit 0\n";
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, foreignContent, { mode: 0o755 });

    const manager = new ShieldManager();
    const result = await enableShield(manager, repo);

    assert.equal(result.ok, false);
    assert.equal(result.inspection.state, "degraded");
    assert.equal(await fs.readFile(hookPath, "utf8"), foreignContent);
  } finally {
    await cleanup(repo.dir);
  }
});

test("chainForeignHooks: true moves the foreign hook to a sidecar and installs Shield's own hook in its place", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const foreignContent = "#!/bin/sh\necho husky-ran >> husky.log\nexit 0\n";
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, foreignContent, { mode: 0o755 });

    const manager = new ShieldManager();
    const result = await enableShield(manager, repo, { chainForeignHooks: true });

    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
    assert.equal(result.inspection.state, "active");

    const sidecarPath = `${hookPath}.repo-identity-guard-original`;
    assert.equal(await fs.readFile(sidecarPath, "utf8"), foreignContent);
    if (process.platform !== "win32") {
      // NTFS has no POSIX executable bit -- see shieldManager.test.ts's
      // identical guard for why this is skipped there.
      assert.equal(((await fs.stat(sidecarPath)).mode & 0o100) as number, 0o100, "chained original should keep its executable bit");
    }

    const installedHook = await fs.readFile(hookPath, "utf8");
    assert.match(installedHook, new RegExp(SHIELD_ARTIFACT_MARKER));

    const preCommitInspection = result.inspection.hooks.find((h) => h.fileName === "pre-commit")!;
    assert.equal(preCommitInspection.hasChainedOriginal, true);
    assert.equal(preCommitInspection.ownership, "shield");
  } finally {
    await cleanup(repo.dir);
  }
});

test("a chained foreign pre-commit hook actually runs, after Shield's own check passes, and its failure blocks the commit", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    // A lint-staged-style hook that always fails.
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, `#!/bin/sh\necho "lint failed" >&2\nexit 3\n`, { mode: 0o755 });

    const manager = new ShieldManager();
    await enableShield(manager, repo, { chainForeignHooks: true });

    // "main" is a protected branch under this profile -- move off it first
    // so the only thing exercised here is the chained hook's own failure.
    await git(repo, ["checkout", "-q", "-b", "feature/chained-failure"]);
    await touchFile(repo, "a.txt", "content\n");
    const result = await run(repo, ["commit", "-q", "-m", "should be blocked by the chained hook"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /lint failed/);
    // Shield itself allowed this commit (correct identity) -- the block is
    // entirely the chained hook's, and must not be silently swallowed.
    assert.doesNotMatch(result.stderr, /COMMIT BLOCKED/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("execution order: Shield's own check runs FIRST — a chained hook never runs when Shield itself blocks", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const markerFile = path.join(repo.dir, "chained-hook-ran");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, `#!/bin/sh\ntouch "${markerFile}"\nexit 0\n`, { mode: 0o755 });

    const manager = new ShieldManager();
    await enableShield(manager, repo, { chainForeignHooks: true });

    // Wrong identity -> Shield itself should block before the chained hook
    // ever gets a chance to create the marker file.
    await git(repo, ["config", "user.email", "personal@example.com"]);
    await touchFile(repo, "a.txt", "content\n");
    const result = await run(repo, ["commit", "-q", "-m", "should be blocked by Shield, not reach the chained hook"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /COMMIT BLOCKED/);
    await assert.rejects(fs.access(markerFile), "the chained hook must never have run");
  } finally {
    await cleanup(repo.dir);
  }
});

/**
 * A fake `ssh`, shadowed onto PATH, that lets a real `git push` over a
 * scp-like SSH URL (`git@<alias>:<path>`) land in a local bare repo
 * instead of attempting a real network connection — the same technique
 * `shieldPrePush.test.ts` (Phase 4) established; see that file's
 * `makeFakeSshBin` for the full rationale.
 */
// Phase 7 Windows finding: a bare, extension-less `ssh` file is invisible
// to Windows' PATH lookup (it tries PATHEXT extensions, not raw
// filenames), so the real ssh.exe further down PATH gets found instead.
// An `ssh.cmd` shim delegating to a plain Node script -- rather than
// assuming a POSIX shell is reachable -- makes the shadow visible there
// too. See shieldPrePush.test.ts for the fuller writeup.
async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-fakessh-"));
  const implPath = path.join(binDir, "fake-ssh-impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
// Round-2 release-blocker fix: enable()/repair() now resolve the approved
// destination's canonical endpoint via a real "ssh -G" call. This fake
// ssh answers it the same way the alias is expected to behave throughout
// this file ("github-work" -> "github.com") so that resolution succeeds
// under the fake instead of failing to parse a bare "-G" invocation as a
// push transport command.
if (joined.includes(" -G ")) {
  process.stdout.write(
    "user " + (process.env.FAKE_SSH_USER || "git") + "\\n" +
    "hostname " + (process.env.FAKE_SSH_HOSTNAME || "github.com") + "\\n" +
    "port " + (process.env.FAKE_SSH_PORT || "22") + "\\n"
  );
  process.exit(0);
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
`,
  );
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
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

test("a chained pre-push hook receives the same argv AND the same stdin ref lines Shield's own evaluator saw", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    // Forward-slashed (Phase 7 Windows finding, see shieldPrePush.test.ts's
    // makeBareRemote): this path is embedded into a scp-like SSH URL below.
    const bareDir = toPosix(path.join(remoteParent, "AcmeSoftware", "acme-frontend.git"));
    await fs.mkdir(path.dirname(bareDir), { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareDir]);

    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-push");
    const capturedArgs = path.join(repo.dir, "captured-args.txt");
    const capturedStdin = path.join(repo.dir, "captured-stdin.txt");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/sh\nprintf '%s %s\\n' "$1" "$2" > "${capturedArgs}"\ncat > "${capturedStdin}"\nexit 0\n`,
      { mode: 0o755 },
    );

    const manager = new ShieldManager();
    // Trusted alias route, matching this profile's trustedSshHostAliases,
    // so Shield's own strict route check allows the push through to the
    // chained hook (the point of this test is the chaining plumbing, not
    // route/destination enforcement, already covered elsewhere).
    await enableShield(manager, repo, {
      chainForeignHooks: true,
      fakeSshBin,
      facts: {
        remoteHost: "github-work",
        remoteOwner: "AcmeSoftware",
        remoteRepo: "acme-frontend",
        pushRemoteHost: "github-work",
        pushRemoteOwner: "AcmeSoftware",
        pushRemoteRepo: "acme-frontend",
      },
    });

    await git(repo, ["remote", "add", "origin", `git@github-work:${bareDir}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}${path.delimiter}${repo.env.PATH}` };
    const pushResult = await run(repo, ["push", "origin", "main"], env);
    assert.equal(pushResult.code, 0, pushResult.stderr);

    const args = await fs.readFile(capturedArgs, "utf8");
    assert.match(args, /^origin .*acme-frontend\.git/);

    const stdin = await fs.readFile(capturedStdin, "utf8");
    assert.match(stdin, /refs\/heads\/main/);
  } finally {
    await cleanup(repo.dir, remoteParent, fakeSshBin);
  }
});

test("chaining twice is safe: repairing an already-chained hook doesn't touch or duplicate the sidecar", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const foreignContent = "#!/bin/sh\nexit 0\n";
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, foreignContent, { mode: 0o755 });

    const manager = new ShieldManager();
    await enableShield(manager, repo, { chainForeignHooks: true });
    const sidecarPath = `${hookPath}.repo-identity-guard-original`;
    const sidecarAfterFirst = await fs.readFile(sidecarPath, "utf8");

    // Repairing again (e.g. after a profile edit) must not re-chain
    // Shield's own hook on top of itself, and must not disturb the
    // preserved original.
    const second = await enableShield(manager, repo, { chainForeignHooks: true });
    assert.equal(second.ok, true);
    assert.equal(await fs.readFile(sidecarPath, "utf8"), sidecarAfterFirst);
    assert.equal(await fs.readFile(sidecarPath, "utf8"), foreignContent);
  } finally {
    await cleanup(repo.dir);
  }
});

test("chaining refuses (fails closed) when a sidecar from a PRIOR chain already occupies that path — never silently overwrites it", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const sidecarPath = `${hookPath}.repo-identity-guard-original`;
    const staleOriginal = "#!/bin/sh\necho stale-original\nexit 0\n";
    const newForeign = "#!/bin/sh\necho new-foreign\nexit 0\n";
    await fs.mkdir(hooksDir, { recursive: true });
    // Simulate a leftover sidecar from an earlier, never-cleanly-disabled chain.
    await fs.writeFile(sidecarPath, staleOriginal, { mode: 0o755 });
    await fs.writeFile(hookPath, newForeign, { mode: 0o755 });

    const manager = new ShieldManager();
    const result = await enableShield(manager, repo, { chainForeignHooks: true });

    assert.equal(result.ok, false);
    assert.equal(result.inspection.state, "degraded");
    // Neither file was touched -- Shield never guesses which one to keep.
    assert.equal(await fs.readFile(sidecarPath, "utf8"), staleOriginal);
    assert.equal(await fs.readFile(hookPath, "utf8"), newForeign);
  } finally {
    await cleanup(repo.dir);
  }
});

test("disable() restores a chained original exactly (bytes and executable bit) and removes the sidecar", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const foreignContent = "#!/bin/sh\necho original-restored\nexit 0\n";
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, foreignContent, { mode: 0o755 });

    const manager = new ShieldManager();
    await enableShield(manager, repo, { chainForeignHooks: true });
    await manager.disable(repo.dir);

    assert.equal(await fs.readFile(hookPath, "utf8"), foreignContent);
    if (process.platform !== "win32") {
      assert.equal(((await fs.stat(hookPath)).mode & 0o100) as number, 0o100, "restored original should keep its executable bit");
    }
    await assert.rejects(fs.access(`${hookPath}.repo-identity-guard-original`), "sidecar must be gone after restore");
  } finally {
    await cleanup(repo.dir);
  }
});

test("disable() never restores a chained sidecar over content that isn't Shield's own anymore, and reports it instead", async () => {
  const repo = await makeTempRepo();
  try {
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const sidecarPath = `${hookPath}.repo-identity-guard-original`;
    const originalContent = "#!/bin/sh\necho original\nexit 0\n";
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(hookPath, originalContent, { mode: 0o755 });

    const manager = new ShieldManager();
    await enableShield(manager, repo, { chainForeignHooks: true });

    // Something else clobbers the hook slot after Shield installed into it.
    const somethingElse = "#!/bin/sh\necho somebody-else-wrote-this\nexit 0\n";
    await fs.writeFile(hookPath, somethingElse, { mode: 0o755 });

    const inspection = await manager.disable(repo.dir);

    assert.equal(await fs.readFile(hookPath, "utf8"), somethingElse, "unrelated content must never be overwritten");
    assert.equal(await fs.readFile(sidecarPath, "utf8"), originalContent, "the preserved original must not be deleted either");
    assert.match(inspection.reasons.join(" "), /could not be restored automatically/);
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== worktree correctness ====================

test("worktrees: enabling Shield from the main worktree makes a LINKED worktree report the same active state (shared common dir)", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = `${repo.dir}-wt`;
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["worktree", "add", "-q", worktreeDir, "-b", "feature/from-worktree"]);
    const worktreeRepo: Repo = { dir: worktreeDir, env: repo.env };

    const mainInspection = await manager.inspect(repo.dir);
    const linkedInspection = await manager.inspect(worktreeRepo.dir);
    assert.equal(mainInspection.state, "active");
    assert.equal(linkedInspection.state, "active");
    assert.equal(mainInspection.policyPath, linkedInspection.policyPath, "policy path must be identical from both worktrees");
    assert.equal(mainInspection.evaluatorPath, linkedInspection.evaluatorPath);
  } finally {
    await cleanup(repo.dir, worktreeDir);
  }
});

test("worktrees: multiple linked worktrees are all protected by a single enable() from the main one", async () => {
  const repo = await makeTempRepo();
  const wt1 = `${repo.dir}-wt1`;
  const wt2 = `${repo.dir}-wt2`;
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["worktree", "add", "-q", wt1, "-b", "feature/one"]);
    await git(repo, ["worktree", "add", "-q", wt2, "-b", "feature/two"]);

    for (const dir of [repo.dir, wt1, wt2]) {
      const inspection = await manager.inspect(dir);
      assert.equal(inspection.state, "active", `${dir} should be active`);
    }
  } finally {
    await cleanup(repo.dir, wt1, wt2);
  }
});

test("worktrees: a worktree-scoped core.hooksPath makes ONE linked worktree resolve a different, unprotected hooks dir — surfaced there, not silently assumed active", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = `${repo.dir}-wt`;
  const altHooksDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-althooks-")));
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    await git(repo, ["worktree", "add", "-q", worktreeDir, "-b", "feature/scoped-hooks"]);
    const worktreeRepo: Repo = { dir: worktreeDir, env: repo.env };

    // extensions.worktreeConfig=on, set in the shared repo config (any
    // worktree can enable it), then a core.hooksPath override written to
    // THIS worktree's own config.worktree file only.
    await git(repo, ["config", "extensions.worktreeConfig", "true"]);
    await git(worktreeRepo, ["config", "--worktree", "core.hooksPath", altHooksDir]);

    const mainInspection = await manager.inspect(repo.dir);
    const linkedInspection = await manager.inspect(worktreeRepo.dir);

    assert.equal(mainInspection.state, "active", "the main worktree, unaffected by a worktree-scoped override elsewhere, stays active");
    assert.notEqual(linkedInspection.state, "active");
    assert.equal(linkedInspection.gitContext?.hooksDir, toPosix(altHooksDir));
    assert.notEqual(linkedInspection.gitContext?.hooksDir, mainInspection.gitContext?.hooksDir);
  } finally {
    await cleanup(repo.dir, worktreeDir, altHooksDir);
  }
});

// ==================== integrity ====================

test("integrity: a Shield-owned hook whose body was hand-edited (marker kept) is detected as modified, not silently treated as healthy", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const original = await fs.readFile(hookPath, "utf8");
    await fs.writeFile(hookPath, `${original}\n# hand-edited\n`, { mode: 0o755 });

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    const preCommit = inspection.hooks.find((h) => h.fileName === "pre-commit")!;
    assert.equal(preCommit.ownership, "shield");
    assert.equal(preCommit.contentModified, true);
    assert.match(inspection.reasons.join(" "), /pre-commit hook has been modified/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: the evaluator copy's content is only checked against the source when the caller supplies evaluatorScriptSource — opt-in, never assumed", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const evaluatorPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");
    const original = await fs.readFile(evaluatorPath, "utf8");
    await fs.writeFile(evaluatorPath, `${original}\n# tampered\n`, { mode: 0o755 });

    const withoutCheck = await manager.inspect(repo.dir);
    assert.equal(withoutCheck.evaluatorModified, false);
    assert.equal(withoutCheck.state, "active", "no evaluatorScriptSource supplied -- tampering isn't even checked for");

    const withCheck = await manager.inspect(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.equal(withCheck.evaluatorModified, true);
    assert.equal(withCheck.state, "degraded");
    assert.match(withCheck.reasons.join(" "), /evaluator copy has been modified/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: an outdated Shield hook version is degraded (repair recommended), not silently reported active", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    await fs.writeFile(
      hookPath,
      `#!/bin/sh\n# ${SHIELD_ARTIFACT_MARKER} v1 (pre-commit)\nexit 0\n`,
      { mode: 0o755 },
    );

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    assert.match(inspection.reasons.join(" "), /newer Shield pre-commit hook is available/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: a hook version NEWER than this build recognizes is reported as incompatible, not silently trusted", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    await fs.writeFile(
      hookPath,
      `#!/bin/sh\n# ${SHIELD_ARTIFACT_MARKER} v999 (pre-commit)\nexit 0\n`,
      { mode: 0o755 },
    );

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    assert.match(inspection.reasons.join(" "), /newer version \(v999\).*update the extension/i);
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: core.hooksPath changed after activation surfaces a specific reason, not just a generic 'hook missing'", async () => {
  const repo = await makeTempRepo();
  const altHooksDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-althooks2-")));
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    assert.equal((await manager.inspect(repo.dir)).state, "active");

    await git(repo, ["config", "core.hooksPath", altHooksDir]);

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    assert.equal(inspection.hooksPathCustomized, true);
    assert.match(inspection.reasons.join(" "), /core\.hooksPath/);
  } finally {
    await cleanup(repo.dir, altHooksDir);
  }
});

test("integrity: a foreign hook that appears AFTER activation is detected on the next inspect(), same as at enable() time", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    assert.equal((await manager.inspect(repo.dir)).state, "active");

    const hooksDir = await hooksDirFor(repo);
    await fs.writeFile(path.join(hooksDir, "pre-push"), "#!/bin/sh\necho takeover\nexit 0\n", { mode: 0o755 });

    const inspection = await manager.inspect(repo.dir);
    assert.equal(inspection.state, "degraded");
    assert.match(inspection.reasons.join(" "), /pre-push.*did not create/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: approved push destination drift is detected only when the caller supplies the current destination, and never auto-repaired", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, { facts: { remoteOwner: "AcmeSoftware", remoteRepo: "acme-frontend" } });

    const withoutCheck = await manager.inspect(repo.dir);
    assert.equal(withoutCheck.pushDestinationDrift, false);
    assert.equal(withoutCheck.state, "active");

    const withDrift = await manager.inspect(repo.dir, { currentPushDestination: { owner: "SomeoneElse", repo: "other-repo" } });
    assert.equal(withDrift.pushDestinationDrift, true);
    assert.equal(withDrift.state, "degraded");

    // inspect() never writes anything -- checking again changes nothing.
    const stillDrifted = await manager.inspect(repo.dir, { currentPushDestination: { owner: "SomeoneElse", repo: "other-repo" } });
    assert.equal(stillDrifted.state, "degraded");
  } finally {
    await cleanup(repo.dir);
  }
});

// Review finding: `pushDestinationDrift` used to compare owner/repo ONLY,
// ignoring host entirely -- so a push destination that moved to a different
// HOST while keeping the same owner/repo text read as unchanged, and Shield
// stayed "active" rather than "degraded". Health status and hook
// enforcement (which DOES require host identity, independent of
// strictPushSetup -- see the release-blocker fix in evaluator.ts) must
// agree about whether the approved destination changed.
test("integrity: a host-only change in the push destination IS drift, even with the same owner/repo (health must agree with hook enforcement)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    // approvedPushDestination is built from pushRemoteHost/Owner/Repo — see
    // baseFacts(), host "github.com".
    await enableShield(manager, repo);
    assert.equal((await manager.inspect(repo.dir)).state, "active");

    const withHostDrift = await manager.inspect(repo.dir, {
      currentPushDestination: { host: "evil.example", owner: "AcmeSoftware", repo: "acme-frontend" },
    });
    assert.equal(withHostDrift.pushDestinationDrift, true, "same owner/repo, different host, must still be drift");
    assert.equal(withHostDrift.state, "degraded");
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: missing repo evidence in the current push destination is drift, never silently treated as unchanged", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);
    assert.equal((await manager.inspect(repo.dir)).state, "active");

    // approved.repo is set ("acme-frontend") but current.repo is missing —
    // the old `!!current.repo &&` guard treated this as "can't compare, so
    // not changed"; missing evidence must never be silently equal.
    const withMissingRepo = await manager.inspect(repo.dir, {
      currentPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: undefined },
    });
    assert.equal(withMissingRepo.pushDestinationDrift, true);
    assert.equal(withMissingRepo.state, "degraded");
  } finally {
    await cleanup(repo.dir);
  }
});

// Review case F: health inspection after an SSH alias's endpoint changes
// must report DEGRADED — but only via the EXPLICIT, on-demand canonical
// check (resolveCanonicalDestinationDrift), since that is what actually
// re-resolves the current route through a real "ssh -G" call rather than
// comparing literal host text (see the class-level doc comment on
// ShieldInspectOptions.resolveCanonicalDestinationDrift for why routine
// background scans intentionally do NOT pay that cost automatically).
//
// Windows finding, now fixed rather than skipped: a PATH-shadowed fake
// `ssh` binary is not reached identically across platforms by the
// manager's own direct `execFile("ssh", ...)` call (Windows process
// spawning does not resolve it the same way a POSIX shell does). Rather
// than skip this test on Windows, it now drives the SAME manager code
// through `ShieldEnableInput.sshResolver`/`ShieldInspectOptions.sshResolver`
// dependency injection (`fakeResolverFor`, above) — no PATH shadowing, no
// real subprocess, deterministic on all three platforms, and it still
// exercises Shield's actual `canonicalizeDestination`/drift-comparison
// logic, not a re-implementation of it.
test("integrity: an SSH alias's endpoint changing since enable() is caught by the explicit canonical health check (case F), never by the cheap literal check alone", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo, { sshResolver: fakeResolverFor("github.com") });
    assert.equal((await manager.inspect(repo.dir)).state, "active");

    // Literal host/owner/repo text is UNCHANGED (still "github.com" per
    // baseFacts) -- only what the alias ACTUALLY resolves to right now
    // has changed, simulating a ~/.ssh/config edit since enable().
    const cheapCheck = await manager.inspect(repo.dir, {
      currentPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend", protocol: "ssh" },
    });
    assert.equal(cheapCheck.pushDestinationDrift, false, "the cheap literal check cannot see an alias repoint by design");
    assert.equal(cheapCheck.state, "active");

    const canonicalCheck = await manager.inspect(repo.dir, {
      currentPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend", protocol: "ssh" },
      resolveCanonicalDestinationDrift: true,
      sshResolver: fakeResolverFor("evil.example"),
    });
    assert.equal(canonicalCheck.pushDestinationDrift, true, "the explicit canonical check must catch the repoint");
    assert.equal(canonicalCheck.state, "degraded");

    // Sanity: the SAME explicit canonical check, with NO repoint, must not
    // false-positive.
    const canonicalCheckUnchanged = await manager.inspect(repo.dir, {
      currentPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend", protocol: "ssh" },
      resolveCanonicalDestinationDrift: true,
      sshResolver: fakeResolverFor("github.com"),
    });
    assert.equal(canonicalCheckUnchanged.pushDestinationDrift, false);
    assert.equal(canonicalCheckUnchanged.state, "active");
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: account verification configuration drift (expectedGitHubLogin changed) is detected via currentProfiles, and repair() re-syncs it", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo); // workProfile has no expectedGitHubLogin

    const updatedProfile: Profile = { ...workProfile, expectedGitHubLogin: "danish-work" };

    const withoutCheck = await manager.inspect(repo.dir);
    assert.equal(withoutCheck.policyProfileDrift, false);

    const withDrift = await manager.inspect(repo.dir, { currentProfiles: [updatedProfile] });
    assert.equal(withDrift.policyProfileDrift, true);
    assert.equal(withDrift.state, "degraded");
    assert.match(withDrift.reasons.join(" "), /expectedGitHubLogin/);

    // Explicit repair (never automatic) re-syncs the policy to the live profile.
    await manager.repair(repo.dir, EVALUATOR_SOURCE, {
      facts: baseFacts(repo),
      profiles: [updatedProfile],
      protectedBranches: ["main", "master"],
    });
    const afterRepair = await manager.inspect(repo.dir, { currentProfiles: [updatedProfile] });
    assert.equal(afterRepair.policyProfileDrift, false);
    assert.equal(afterRepair.state, "active");
  } finally {
    await cleanup(repo.dir);
  }
});

test("integrity: inspect() never rewrites anything to turn BROKEN/DEGRADED back into ACTIVE on its own", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const policyPath = path.join(commonDir, "repo-identity-guard", "shield-policy.json");
    await fs.writeFile(policyPath, "{ not valid json", "utf8");

    await manager.inspect(repo.dir);
    await manager.inspect(repo.dir);
    await manager.inspect(repo.dir);

    // Still exactly the corrupted content Shield never touched itself.
    assert.equal(await fs.readFile(policyPath, "utf8"), "{ not valid json");
    assert.equal((await manager.inspect(repo.dir)).state, "broken");
  } finally {
    await cleanup(repo.dir);
  }
});

// ==================== install/uninstall lifecycle ====================

test("lifecycle: an interrupted enable (policy written, hooks/evaluator not yet) reports degraded, and repair() completes it", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    const gitContext = await manager.resolveGitContext(repo.dir);
    const commonDir = gitContext.gitCommonDir;
    await fs.mkdir(path.join(commonDir, "repo-identity-guard"), { recursive: true });
    await fs.writeFile(
      path.join(commonDir, "repo-identity-guard", "shield-policy.json"),
      JSON.stringify({
        policyVersion: 2,
        generatedAt: Date.now(),
        matchedProfileId: "work",
        profileLabel: "Work",
        expectedGitEmail: "work@example.com",
        trustedSshHostAliases: [],
        strictPushSetup: true,
        protectedBranches: [],
        expectedBranchPatterns: [],
        enabledActions: ["commit", "push"],
      }),
    );

    const midway = await manager.inspect(repo.dir);
    assert.equal(midway.state, "degraded");
    assert.equal(midway.policyPresent, true);
    assert.equal(midway.evaluatorPresent, false);

    const repaired = await enableShield(manager, repo);
    assert.equal(repaired.ok, true);
    assert.equal(repaired.inspection.state, "active");
  } finally {
    await cleanup(repo.dir);
  }
});

test("lifecycle: enable() never leaves a stray temp file behind (atomic replacement)", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const hooksDir = await hooksDirFor(repo);
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const storageDir = path.join(commonDir, "repo-identity-guard");

    for (const dir of [hooksDir, storageDir]) {
      const entries = await fs.readdir(dir);
      const strays = entries.filter((name) => name.includes(".tmp-"));
      assert.deepEqual(strays, [], `no stray temp files expected in ${dir}, found: ${strays.join(", ")}`);
    }
  } finally {
    await cleanup(repo.dir);
  }
});

test("lifecycle: disable() never deletes a file it doesn't own, even inside its own storage directory", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    await enableShield(manager, repo);

    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const storageDir = path.join(commonDir, "repo-identity-guard");
    const unrelatedFile = path.join(storageDir, "unrelated-notes.txt");
    await fs.writeFile(unrelatedFile, "do not touch me\n");

    await manager.disable(repo.dir);

    assert.equal(await fs.readFile(unrelatedFile, "utf8"), "do not touch me\n");
    // The storage dir itself must survive too, since it isn't empty.
    await fs.access(storageDir);
  } finally {
    await cleanup(repo.dir);
  }
});

test("lifecycle: disable() is a safe no-op when Shield was never enabled, and idempotent when called twice", async () => {
  const repo = await makeTempRepo();
  try {
    const manager = new ShieldManager();
    const first = await manager.disable(repo.dir);
    assert.equal(first.state, "off");

    await enableShield(manager, repo);
    const afterFirstDisable = await manager.disable(repo.dir);
    assert.equal(afterFirstDisable.state, "off");
    const afterSecondDisable = await manager.disable(repo.dir);
    assert.equal(afterSecondDisable.state, "off");
  } finally {
    await cleanup(repo.dir);
  }
});
