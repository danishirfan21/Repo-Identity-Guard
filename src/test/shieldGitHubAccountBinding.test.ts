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
 * Integration tests for Shield Mode Phase 5's verified GitHub SSH account
 * binding — the real `resources/shield/shield-evaluate.sh`, a real
 * temporary Git repo, and a real bare remote, exactly like
 * `shieldPrePush.test.ts` (Phase 4). What's different here is the fake
 * `ssh` shadowed onto PATH also answers `ssh -G <alias>` and
 * `ssh -T ... <user>@<alias>` — the two commands `verify_github_account`
 * actually runs — with a scripted response set per test via environment
 * variables, so these tests never contact a real SSH daemon or real
 * GitHub, per the task's explicit "mock network SSH responses, do not
 * contact real GitHub during automated CI tests" requirement.
 *
 * Every "blocked" assertion checks both the exit code AND that the remote
 * ref was NOT updated; the one "allowed" test checks the ref WAS updated.
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
  expectedGitHubLogin: "danish-work",
};

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
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
 * A fake `ssh`, shadowed onto PATH, that answers all three shapes Shield's
 * evaluator can invoke for account verification:
 *
 *  - `ssh -G <alias>` — prints an effective-config response controlled by
 *    `FAKE_SSH_IDENTITIES_ONLY` (default: "yes", i.e. strongly bound).
 *  - `ssh -T ... <user>@<alias>` — prints `FAKE_SSH_AUTH_OUTPUT` verbatim
 *    (to stdout+stderr, matching a real `ssh -T`'s combined output) and
 *    exits with `FAKE_SSH_AUTH_EXIT` (default 1, mirroring GitHub's own
 *    "exit 1 even on full success" behavior) — never consulted by
 *    Shield's parsing, only present here for realism.
 *  - anything else — the ordinary git-transport passthrough from Phase 4
 *    (`shift` to the last arg, run it locally via `sh -c`), so the
 *    baseline push after a passing account check still actually lands in
 *    the local bare repo.
 */
// Phase 7 Windows finding: a bare, extension-less `ssh` file is invisible
// to Windows' PATH lookup (it tries PATHEXT extensions, not raw
// filenames), so the real ssh.exe further down PATH would get found
// instead and genuinely try to reach GitHub. Reimplemented in Node (rather
// than POSIX `sh`) with a matching `ssh.cmd` shim so the shadow works on
// every platform without assuming a shell is on PATH. See
// shieldPrePush.test.ts for the fuller writeup of the Windows PATH-lookup
// gap this fixes.
async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakessh-gh-"));
  const implPath = path.join(binDir, "fake-ssh-impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  // Phase 8: the effective ROUTE, not just IdentitiesOnly. Shield now
  // resolves the alias with \`ssh -G\` and refuses to treat a
  // non-GitHub endpoint's self-report as a GitHub account, so this
  // stub must produce a realistic hostname/port. FAKE_SSH_HOSTNAME
  // lets a test point the "trusted" alias somewhere else entirely --
  // which is the whole attack this check exists to stop.
  // FAKE_SSH_G_FAIL simulates \`ssh -G\` producing no hostname at all.
  if (process.env.FAKE_SSH_G_FAIL === "1") {
    process.stdout.write("user git\\n");
    process.exit(0);
  }
  const identitiesOnly = (process.env.FAKE_SSH_IDENTITIES_ONLY || "yes") === "yes";
  const user = process.env.FAKE_SSH_USER || "git";
  const hostname = process.env.FAKE_SSH_HOSTNAME || "github.com";
  const port = process.env.FAKE_SSH_PORT || "22";
  process.stdout.write(
    \`user \${user}\\nhostname \${hostname}\\nport \${port}\\n\` +
    (identitiesOnly ? "identitiesonly yes\\n" : "identitiesonly no\\n")
  );
  process.exit(0);
} else if (joined.includes(" -T ")) {
  // Record the exact probe argv so a test can assert the probe travels
  // the same route (alias, and -p when the URL carried a port) that the
  // push itself would.
  if (process.env.FAKE_SSH_PROBE_LOG) {
    require("node:fs").appendFileSync(process.env.FAKE_SSH_PROBE_LOG, args.join(" ") + "\\n");
  }
  process.stderr.write(process.env.FAKE_SSH_AUTH_OUTPUT || "");
  process.exit(parseInt(process.env.FAKE_SSH_AUTH_EXIT || "1", 10));
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

async function makeBareRemote(parentDir: string, owner: string, repoName: string): Promise<string> {
  const ownerDir = path.join(parentDir, owner);
  await fs.mkdir(ownerDir, { recursive: true });
  const bareDir = path.join(ownerDir, `${repoName}.git`);
  await execFileAsync("git", ["init", "-q", "--bare", bareDir]);
  // Phase 7 Windows finding (see shieldPrePush.test.ts): this path gets
  // embedded into a scp-like SSH URL below for Shield's evaluator to parse
  // the owner/repo out of -- a raw Windows backslash path breaks that
  // parsing. Forward slashes are equally valid as a real fs path there.
  return bareDir.split(path.sep).join("/");
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

// Same sandbox-specific fix as shieldPrePush.test.ts — see that file's
// comment on `stripAmbientGitConfigEnv` for why this is necessary here.
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

async function makeTempRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-ghaccount-"));
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
    // Phase 8: `approvedPushDestination` is built from the pushRemote*
    // facts (the destination a plain `git push` actually reaches), never
    // from origin's fetch facts. These fixtures describe the ordinary
    // "origin is also the push destination" arrangement, so both sets
    // agree; tests that deliberately separate them override pushRemote*.
    pushRemoteName: "origin",
    pushRemoteUrl: "git@github-work:AcmeSoftware/acme-frontend.git",
    pushRemoteProtocol: "ssh" as const,
    pushRemoteHost: "github-work",
    pushRemoteOwner: "AcmeSoftware",
    pushRemoteRepo: "acme-frontend",
    ...overrides,
  };
}

async function enableShield(manager: ShieldManager, repo: Repo, facts: RepoFacts, profiles: Profile[] = [workProfile]): Promise<void> {
  const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, { facts, profiles, protectedBranches: [] });
  assert.equal(result.ok, true, `enable() should succeed: ${result.inspection.reasons.join("; ")}`);
}

interface Scenario {
  repo: Repo;
  remoteParent: string;
  bare: string;
  fakeSshBin: string;
}

async function setUpScenario(profiles: Profile[] = [workProfile]): Promise<Scenario> {
  const repo = await makeTempRepo();
  const remoteParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-remote-"));
  const fakeSshBin = await makeFakeSshBin();
  const bare = await makeBareRemote(remoteParent, "AcmeSoftware", "acme-frontend");
  const manager = new ShieldManager();
  await enableShield(manager, repo, approvedFacts(repo), profiles);
  await git(repo, ["remote", "add", "origin", `git@github-work:${bare}`]);
  return { repo, remoteParent, bare, fakeSshBin };
}

async function pushWithFakeSsh(scenario: Scenario, extraEnv: NodeJS.ProcessEnv): Promise<PushResult> {
  const env = { ...scenario.repo.env, PATH: `${scenario.fakeSshBin}${path.delimiter}${scenario.repo.env.PATH}`, ...extraEnv };
  return push(scenario.repo, ["origin", "main"], env);
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

// ==================== verified account matches ====================

test("authenticated login matches expectedGitHubLogin -> allowed, ref IS updated", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "Hi danish-work! You've successfully authenticated, but GitHub does not provide shell access.\n",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(scenario.bare), await git(scenario.repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== wrong account ====================

test("authenticated as a different GitHub account -> push-account-mismatch, blocked, ref NOT updated", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "Hi danish-personal! You've successfully authenticated, but GitHub does not provide shell access.\n",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /PUSH BLOCKED/);
    assert.match(result.stderr, /push-account-mismatch/);
    assert.match(result.stderr, /danish-work/);
    assert.match(result.stderr, /danish-personal/);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== deploy-key identity ====================

test("a deploy-key-style identity (owner/repo) can never be confirmed against a personal login -> unverified, blocked", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "Hi AcmeSoftware/acme-frontend! You've successfully authenticated, but GitHub does not provide shell access.\n",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /push-account-unverified/);
    assert.match(result.stderr, /deploy-key/);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== permission denied ====================

test("SSH permission denied while verifying the account -> unverified, blocked", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "git@github-work: Permission denied (publickey).\n",
      FAKE_SSH_AUTH_EXIT: "255",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /push-account-unverified/);
    assert.match(result.stderr, /permission/i);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== timeout ====================

test("SSH connection timeout while verifying the account -> unverified, blocked", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "ssh: connect to host github-work port 22: Connection timed out\n",
      FAKE_SSH_AUTH_EXIT: "255",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /push-account-unverified/);
    assert.match(result.stderr, /timed out/i);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== unknown host key ====================

test("an untrusted/unknown SSH host key -> Shield refuses to connect automatically, unverified, blocked, tells the user to verify manually", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "No ED25519 host key is known for github-work and you have requested strict checking.\nHost key verification failed.\n",
      FAKE_SSH_AUTH_EXIT: "255",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /push-account-unverified/);
    assert.match(result.stderr, /not already trusted|host key/i);
    assert.match(result.stderr, /verify.*fingerprint|fingerprint.*verify/is);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== malformed output ====================

test("malformed/unrecognized SSH response while verifying the account -> unverified, blocked, never guessed at", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "garbage that matches nothing GitHub would ever say\n",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /push-account-unverified/);
    assert.match(result.stderr, /could not be parsed/);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== IdentitiesOnly not set ====================

test("route not strongly bound (IdentitiesOnly not set) -> unverified without even attempting the network ssh -T probe", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const scenario = await setUpScenario();
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_IDENTITIES_ONLY: "no",
      // If the evaluator incorrectly proceeded to the network probe
      // anyway, this would report success and the test would fail by
      // seeing the push allowed instead of blocked.
      FAKE_SSH_AUTH_OUTPUT: "Hi danish-work! You've successfully authenticated, but GitHub does not provide shell access.\n",
    });
    assert.notEqual(result.code, 0);
    assert.equal(await remoteRefSha(scenario.bare), null);
    assert.match(result.stderr, /push-account-unverified/);
    assert.match(result.stderr, /IdentitiesOnly/);
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== non-strict profile ====================

test("a non-strict profile never runs account verification even with a mismatched account set up to respond", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
  const scenario = await setUpScenario([relaxedProfile]);
  try {
    const result = await pushWithFakeSsh(scenario, {
      FAKE_SSH_AUTH_OUTPUT: "Hi danish-personal! You've successfully authenticated, but GitHub does not provide shell access.\n",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(scenario.bare), await git(scenario.repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});

// ==================== no expectedGitHubLogin ====================

test("a profile without expectedGitHubLogin never runs account verification (route trust alone is sufficient, unchanged from Phase 4)", { skip: SKIP_FAKE_SSH_PATH_SHADOW_ON_WINDOWS }, async () => {
  const noLoginProfile: Profile = { ...workProfile, expectedGitHubLogin: undefined };
  const scenario = await setUpScenario([noLoginProfile]);
  try {
    // No FAKE_SSH_AUTH_OUTPUT set at all -- if the evaluator incorrectly
    // attempted verification anyway, the fake ssh's default empty output
    // would be parsed as malformed and this push would be blocked.
    const result = await pushWithFakeSsh(scenario, {});
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await remoteRefSha(scenario.bare), await git(scenario.repo, ["rev-parse", "HEAD"]));
  } finally {
    await cleanup(scenario.repo.dir, scenario.remoteParent, scenario.fakeSshBin);
  }
});
