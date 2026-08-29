import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePush, resolveSshCommandOverrides } from "../shield/evaluator";
import { ShieldPolicy, buildShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { Profile } from "../types";

/**
 * PART 3 — does Shield verify the SAME SSH route `git push` will use?
 *
 * ## What was found
 *
 * Shield's strict GitHub account verification runs `ssh -G` and then
 * `ssh -T` directly from the evaluator, and treated three things as the
 * complete set of ways a push's SSH route can diverge from that probe:
 * `GIT_SSH`, `GIT_SSH_COMMAND`, and `core.sshCommand`. That set was
 * incomplete.
 *
 * `ssh.variant` (config, any scope) and `GIT_SSH_VARIANT` (environment)
 * change how Git *drives* the SSH program with NO command override set at
 * all. Captured from git 2.43.0 in this sandbox, with a fake `ssh` on PATH
 * and no GIT_SSH / GIT_SSH_COMMAND / core.sshCommand anywhere:
 *
 *   (default)                      ssh -o SendEnv=GIT_PROTOCOL git@host git-upload-pack '/o/r.git'
 *   -c ssh.variant=plink           ssh                          git@host git-upload-pack '/o/r.git'
 *   -c ssh.variant=simple          ssh                          git@host git-upload-pack '/o/r.git'
 *   GIT_SSH_VARIANT=tortoiseplink  ssh -batch                   git@host git-upload-pack '/o/r.git'
 *
 * Git is speaking PuTTY/plink or "simple" argument conventions there.
 * Shield's probe is unconditionally OpenSSH syntax (`-G`, `-o
 * BatchMode=yes`, `-o StrictHostKeyChecking=yes`, `-p <port>`); plink
 * spells the port `-P` and has no `-G` at all. So the probe cannot be
 * shown to reproduce the push's transport, and — per Shield's own rule
 * that an unprovable route stays UNVERIFIED — a strict profile must block.
 *
 * ## What these tests can and cannot prove
 *
 * This sandbox is **Linux**. What is proven here is the detection logic and
 * that the shell evaluator and the TypeScript reference agree on it, using
 * the real shipped `shield-evaluate.sh`. The variant mechanism itself is
 * cross-platform Git behavior, so the detection is not Windows-specific.
 *
 * What CANNOT be proven here, and needs a real Windows machine (see the
 * task report's Part 3 section): whether Git-for-Windows' bundled OpenSSH
 * and a system `C:\Windows\System32\OpenSSH\ssh.exe` resolve to the same
 * binary from a hook as from git's own transport spawn, and whether an
 * MSYS `$HOME` and a Windows `%USERPROFILE%` can make those two read
 * different `~/.ssh/config` files. Neither is reproducible on Linux and
 * neither is faithfully reproducible on a GitHub Actions windows-latest
 * runner, whose PATH and profile are not a real dev machine's.
 */

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

const strictProfile: Profile = {
  id: "work",
  label: "Work",
  gitEmail: "work@example.com",
  gitName: "Danish Irfan",
  expectedRemoteOwners: ["AcmeSoftware"],
  strictPushSetup: true,
  trustedSshHostAliases: ["github-work"],
};

function policy(): ShieldPolicy {
  return buildShieldPolicy({
    profile: strictProfile,
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
    protectedBranches: ["main"],
    enabledActions: ["commit", "push"],
    now: 1,
  });
}

const TRUSTED_URL = "git@github-work:AcmeSoftware/acme-frontend.git";

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-ssh-variant-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "work@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Danish Irfan"], { cwd: dir });
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
  const commonDir = stdout.trim();
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), serializeShieldPolicy(policy()));
  return dir;
}

function runPush(cwd: string, env: NodeJS.ProcessEnv, configArgs: string[] = []): Promise<{ code: number; stderr: string }> {
  // `git ... -c k=v` style overrides are applied by writing them into
  // GIT_CONFIG_PARAMETERS exactly the way git itself hands them to a hook —
  // empirically verified from inside a real pre-commit hook that
  // `git config --get ssh.variant` sees a command-scoped `-c` this way.
  const fullEnv = { ...env };
  if (configArgs.length > 0) {
    fullEnv.GIT_CONFIG_PARAMETERS = configArgs.map((kv) => {
      const at = kv.indexOf("=");
      return `'${kv.slice(0, at)}'='${kv.slice(at + 1)}'`;
    }).join(" ");
  }
  return new Promise((resolve, reject) => {
    execFile(
      "sh",
      [SCRIPT_PATH, "push", "origin", TRUSTED_URL],
      { cwd, encoding: "utf8", env: fullEnv },
      (error, _stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    ).stdin?.end("");
  });
}

const baseEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  return env;
};

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

// ==================== the newly-detected divergence ====================

for (const variant of ["plink", "tortoiseplink", "putty", "simple"]) {
  test(`PART 3 — ssh.variant=${variant} makes the route UNVERIFIABLE and blocks a strict push (previously undetected)`, async () => {
    const repo = await makeRepo();
    try {
      // Without the variant, this exact push is allowed: the alias is
      // trusted and there is no expectedGitHubLogin to verify.
      const allowed = await runPush(repo, baseEnv());
      assert.equal(allowed.code, 0, allowed.stderr);

      const blocked = await runPush(repo, baseEnv(), [`ssh.variant=${variant}`]);
      assert.notEqual(blocked.code, 0);
      assert.match(blocked.stderr, /push-route-override/);
      assert.match(blocked.stderr, new RegExp(`ssh\\.variant=${variant}`));

      // The TypeScript reference reaches the same decision from the same facts.
      const overrides = resolveSshCommandOverrides({ sshVariantConfig: variant });
      assert.deepEqual(overrides, [`ssh.variant=${variant}`]);
      const decision = evaluatePush(policy(), { remoteName: "origin", remoteUrl: TRUSTED_URL, sshCommandOverrides: overrides });
      assert.equal(decision.allowed, false);
      assert.equal(decision.reasons[0].id, "push-route-override");
    } finally {
      await cleanup(repo);
    }
  });
}

test("PART 3 — GIT_SSH_VARIANT (environment form) is detected too, and is what the hook actually inherits", async () => {
  const repo = await makeRepo();
  try {
    const env = { ...baseEnv(), GIT_SSH_VARIANT: "tortoiseplink" };
    const result = await runPush(repo, env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /push-route-override/);
    assert.match(result.stderr, /GIT_SSH_VARIANT=tortoiseplink/);

    const overrides = resolveSshCommandOverrides({ gitSshVariant: "tortoiseplink" });
    assert.deepEqual(overrides, ["GIT_SSH_VARIANT=tortoiseplink"]);
  } finally {
    await cleanup(repo);
  }
});

// ==================== not over-blocking ====================

for (const variant of ["auto", "ssh", "AUTO", "SSH"]) {
  test(`PART 3 — ssh.variant=${variant} asserts OpenSSH semantics and must NOT block (no over-blocking)`, async () => {
    const repo = await makeRepo();
    try {
      const result = await runPush(repo, baseEnv(), [`ssh.variant=${variant}`]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(resolveSshCommandOverrides({ sshVariantConfig: variant }), []);
    } finally {
      await cleanup(repo);
    }
  });
}

test("PART 3 — GIT_SSH_VARIANT takes precedence over ssh.variant, so an env value of 'ssh' cancels a plink config", async () => {
  const repo = await makeRepo();
  try {
    const env = { ...baseEnv(), GIT_SSH_VARIANT: "ssh" };
    const result = await runPush(repo, env, ["ssh.variant=plink"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(resolveSshCommandOverrides({ gitSshVariant: "ssh", sshVariantConfig: "plink" }), []);
  } finally {
    await cleanup(repo);
  }
});

test("PART 3 — the reverse also holds: GIT_SSH_VARIANT=plink is a divergence even when ssh.variant=ssh in config", async () => {
  const repo = await makeRepo();
  try {
    const env = { ...baseEnv(), GIT_SSH_VARIANT: "plink" };
    const result = await runPush(repo, env, ["ssh.variant=ssh"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /GIT_SSH_VARIANT=plink/);
    assert.deepEqual(resolveSshCommandOverrides({ gitSshVariant: "plink", sshVariantConfig: "ssh" }), [
      "GIT_SSH_VARIANT=plink",
    ]);
  } finally {
    await cleanup(repo);
  }
});

// ==================== the pre-existing three are unchanged ====================

test("PART 3 — the three command overrides still block, and the variant check never weakens or replaces them", async () => {
  const repo = await makeRepo();
  try {
    for (const [key, value] of [
      ["GIT_SSH", "/usr/bin/ssh"],
      ["GIT_SSH_COMMAND", "ssh -v"],
    ] as const) {
      const result = await runPush(repo, { ...baseEnv(), [key]: value });
      assert.notEqual(result.code, 0, `${key} did not block`);
      assert.match(result.stderr, new RegExp(key));
    }
    const viaConfig = await runPush(repo, baseEnv(), ["core.sshCommand=ssh -v"]);
    assert.notEqual(viaConfig.code, 0);
    assert.match(viaConfig.stderr, /core\.sshCommand/);
  } finally {
    await cleanup(repo);
  }
});

test("PART 3 — all four override families at once are reported together, in the same order as the TypeScript reference", async () => {
  const repo = await makeRepo();
  try {
    const env = { ...baseEnv(), GIT_SSH: "/usr/bin/ssh", GIT_SSH_COMMAND: "ssh -v", GIT_SSH_VARIANT: "plink" };
    const result = await runPush(repo, env, ["core.sshCommand=ssh -q"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /GIT_SSH, GIT_SSH_COMMAND, core\.sshCommand, GIT_SSH_VARIANT=plink/);

    assert.deepEqual(
      resolveSshCommandOverrides({
        gitSsh: "/usr/bin/ssh",
        gitSshCommand: "ssh -v",
        coreSshCommand: "ssh -q",
        gitSshVariant: "plink",
      }),
      ["GIT_SSH", "GIT_SSH_COMMAND", "core.sshCommand", "GIT_SSH_VARIANT=plink"],
    );
  } finally {
    await cleanup(repo);
  }
});

test("PART 3 — a non-strict profile is unaffected by any transport override (strictness gating is unchanged)", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "shield-ssh-variant-lax-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo });
    const commonDir = stdout.trim();
    await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
    await fs.writeFile(
      shieldPolicyFilePath(commonDir),
      serializeShieldPolicy(
        buildShieldPolicy({
          profile: { ...strictProfile, strictPushSetup: false },
          approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
          protectedBranches: ["main"],
          enabledActions: ["commit", "push"],
          now: 1,
        }),
      ),
    );
    const result = await runPush(repo, { ...baseEnv(), GIT_SSH_VARIANT: "plink" });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("PART 3 — Shield never executes the VALUE of a transport override to inspect it", async () => {
  const repo = await makeRepo();
  const marker = path.join(repo, "SHOULD-NEVER-EXIST");
  try {
    // If anything ever tried to run GIT_SSH_COMMAND to "see what it does",
    // this file would appear. Detection is presence-only, forever.
    const result = await runPush(repo, { ...baseEnv(), GIT_SSH_COMMAND: `touch ${marker}` });
    assert.notEqual(result.code, 0);
    assert.equal(await fs.readFile(marker).catch(() => null), null);
  } finally {
    await cleanup(repo);
  }
});
