import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { SHIELD_ARTIFACT_MARKER } from "../shield/artifacts";
import { ShieldManager } from "../shield/manager";
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

async function makeTempRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
    ...overrides,
  };
}

async function hooksDirFor(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

async function enableShield(
  manager: ShieldManager,
  repo: Repo,
  overrides: { profiles?: Profile[]; facts?: Partial<RepoFacts>; chainForeignHooks?: boolean } = {},
) {
  return manager.enable(repo.dir, EVALUATOR_SOURCE, {
    facts: baseFacts(repo, overrides.facts),
    profiles: overrides.profiles ?? [workProfile],
    protectedBranches: ["main", "master"],
    chainForeignHooks: overrides.chainForeignHooks,
  });
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
    assert.equal(((await fs.stat(sidecarPath)).mode & 0o100) as number, 0o100, "chained original should keep its executable bit");

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
async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-fakessh-"));
  const sshPath = path.join(binDir, "ssh");
  await fs.writeFile(sshPath, `#!/bin/sh\nshift $(($#-1))\nexec sh -c "$1"\n`, { mode: 0o755 });
  return binDir;
}

test("a chained pre-push hook receives the same argv AND the same stdin ref lines Shield's own evaluator saw", async () => {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  try {
    const bareDir = path.join(remoteParent, "AcmeSoftware", "acme-frontend.git");
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
      facts: { remoteHost: "github-work", remoteOwner: "AcmeSoftware", remoteRepo: "acme-frontend" },
    });

    await git(repo, ["remote", "add", "origin", `git@github-work:${bareDir}`]);
    const env = { ...repo.env, PATH: `${fakeSshBin}:${repo.env.PATH}` };
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
    assert.equal(((await fs.stat(hookPath)).mode & 0o100) as number, 0o100, "restored original should keep its executable bit");
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
  const altHooksDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-althooks-"));
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
    assert.equal(linkedInspection.gitContext?.hooksDir, altHooksDir);
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
  const altHooksDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p6-althooks2-"));
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
        policyVersion: 1,
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
