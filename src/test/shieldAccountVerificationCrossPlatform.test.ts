import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";

/**
 * PART 3 (Windows-skip reduction) — GitHub SSH account verification,
 * exercised on EVERY platform including Windows.
 *
 * ## The gap this closes
 *
 * `shieldGitHubAccountBinding.test.ts` covers this same behavior by
 * performing a real `git push` with a fake `ssh` shadowed onto PATH, and
 * skips all sixteen of those tests on Windows for a real reason: **Git for
 * Windows does not resolve its ssh transport through the caller's PATH**,
 * so the fake is never reached and a genuine DNS/auth failure surfaces
 * before Shield's pre-push hook ever runs.
 *
 * That reason applies to GIT's transport. It does not apply to Shield's
 * verification probe, which is a different program on a different code
 * path: `resources/shield/shield-evaluate.sh` runs `ssh -G` and `ssh -T`
 * itself, from a POSIX shell, resolved through ordinary PATH search — and
 * on Windows that shell is Git's own bundled `sh`, which does use PATH.
 * (This is exactly the divergence Part 3 investigated: the hook's `ssh` and
 * Git's transport `ssh` are resolved by different mechanisms.)
 *
 * So driving the evaluator directly, rather than through `git push`,
 * genuinely moves the account-verification decision matrix from
 * "Linux/macOS only" to "all three platforms". These tests carry NO
 * platform skip.
 *
 * What still cannot be covered on Windows, and is deliberately left to the
 * other suite: the second half of those tests — that a real `git push`
 * then did or did not move the remote ref. That needs Git's own transport
 * to go through the fake, which is precisely what Git for Windows will not
 * do.
 */

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

const TRUSTED_ALIAS = "github-work";
const REMOTE_URL = `git@${TRUSTED_ALIAS}:AcmeSoftware/acme-frontend.git`;

function policyWithLogin(login: string | undefined): ShieldPolicy {
  return {
    policyVersion: 1,
    generatedAt: 1,
    matchedProfileId: "work",
    profileLabel: "Work",
    expectedGitName: "Danish Irfan",
    expectedGitEmail: "work@example.com",
    approvedRepositoryKey: "github.com/AcmeSoftware/acme-frontend",
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
    trustedSshHostAliases: [TRUSTED_ALIAS],
    expectedGitHubLogin: login,
    strictPushSetup: true,
    protectedBranches: [],
    expectedBranchPatterns: [],
    enabledActions: ["commit", "push"],
  };
}

/**
 * A fake `ssh` on PATH answering the two shapes Shield's evaluator invokes.
 *
 * Written as an extension-less launcher (found by POSIX `sh`, including
 * Git for Windows' bundled one) PLUS an `ssh.cmd` (found by Windows' own
 * PATHEXT-based lookup, should anything resolve it that way). A bare
 * extension-less file is invisible to Windows' native PATH search, which is
 * the Phase 7 finding that made the original fake unusable there.
 */
async function makeFakeSsh(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-xplat-ssh-"));
  const implPath = path.join(binDir, "impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  if (process.env.FAKE_SSH_G_FAIL === "1") { process.stdout.write("user git\\n"); process.exit(0); }
  process.stdout.write(
    "user " + (process.env.FAKE_SSH_USER || "git") + "\\n" +
    "hostname " + (process.env.FAKE_SSH_HOSTNAME || "github.com") + "\\n" +
    "port " + (process.env.FAKE_SSH_PORT || "22") + "\\n" +
    "identitiesonly " + (process.env.FAKE_SSH_IDENTITIES_ONLY || "yes") + "\\n"
  );
  process.exit(0);
}
if (joined.includes(" -T ")) {
  if (process.env.FAKE_SSH_PROBE_LOG) {
    require("node:fs").appendFileSync(process.env.FAKE_SSH_PROBE_LOG, args.join(" ") + "\\n");
  }
  process.stderr.write(process.env.FAKE_SSH_AUTH_OUTPUT || "");
  process.exit(parseInt(process.env.FAKE_SSH_AUTH_EXIT || "1", 10));
}
process.stderr.write("fake-ssh: unexpected invocation: " + joined + "\\n");
process.exit(1);
`,
  );
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
}

/** Windows environments can carry `Path` rather than `PATH`; setting the wrong one silently does nothing. */
function withPath(env: NodeJS.ProcessEnv, prepend: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  let existing: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      existing = existing ?? value;
      continue;
    }
    result[key] = value;
  }
  result.PATH = `${prepend}${path.delimiter}${existing ?? ""}`;
  return result;
}

interface Fixture {
  repoDir: string;
  fakeSshBin: string;
  baseEnv: NodeJS.ProcessEnv;
}

// `null` means "this profile sets no expectedGitHubLogin at all". Using
// `undefined` for that would silently hit the DEFAULT parameter instead —
// which is exactly the mistake that first made this suite's own "never
// probes" test run against a policy that did request an account.
async function setUp(login: string | null = "danish-work"): Promise<Fixture> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-xplat-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(repoDir, "gc"),
    GIT_CONFIG_SYSTEM: path.join(repoDir, "gs"),
  };
  await fs.writeFile(path.join(repoDir, "gc"), "");
  await fs.writeFile(path.join(repoDir, "gs"), "");
  for (const key of ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_PARAMETERS"]) delete env[key];

  await execFileAsync("git", ["init", "-q"], { cwd: repoDir, env });
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoDir, env });
  const commonDir = stdout.trim();
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), serializeShieldPolicy(policyWithLogin(login ?? undefined)));

  const fakeSshBin = await makeFakeSsh();
  return { repoDir, fakeSshBin, baseEnv: env };
}

interface Result {
  code: number;
  stderr: string;
  reasonIds: string[];
}

function evaluatePush(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}, url = REMOTE_URL): Promise<Result> {
  const env = { ...withPath(fixture.baseEnv, fixture.fakeSshBin), ...extraEnv };
  return new Promise((resolve, reject) => {
    const child = execFile(
      "sh",
      [SCRIPT_PATH, "push", "origin", url],
      { cwd: fixture.repoDir, encoding: "utf8", env },
      (error, _stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stderr, reasonIds: [...stderr.matchAll(/^Shield: \[([a-z-]+)\]/gm)].map((m) => m[1]) });
      },
    );
    child.stdin?.end("");
  });
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fs.rm(fixture.repoDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(fixture.fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
}

const AUTHENTICATED = (who: string) => `Hi ${who}! You've successfully authenticated, but GitHub does not provide shell access.\n`;

// ==================== the outcome matrix, on every platform ====================

test("PART 3/xplat — the expected GitHub login authenticates -> allowed", async () => {
  const fixture = await setUp();
  try {
    const result = await evaluatePush(fixture, { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work") });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(fixture);
  }
});

test("PART 3/xplat — a DIFFERENT GitHub account authenticates -> push-account-mismatch, blocked", async () => {
  const fixture = await setUp();
  try {
    const result = await evaluatePush(fixture, { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("someone-else") });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.reasonIds, ["push-account-mismatch"]);
    assert.match(result.stderr, /someone-else/);
  } finally {
    await cleanup(fixture);
  }
});

test("PART 3/xplat — the login match is case-insensitive, exactly as the TypeScript reference is", async () => {
  const fixture = await setUp();
  try {
    const result = await evaluatePush(fixture, { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("DANISH-WORK") });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(fixture);
  }
});

const UNVERIFIABLE: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
  [
    "a deploy-key-style identity can never be confirmed against a personal login",
    { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("AcmeSoftware/acme-frontend") },
    /deploy-key-style identity/,
  ],
  [
    "SSH authentication refused (permission denied)",
    { FAKE_SSH_AUTH_OUTPUT: "git@github.com: Permission denied (publickey).\n" },
    /permission denied/i,
  ],
  [
    "an untrusted host key — Shield refuses to connect automatically",
    { FAKE_SSH_AUTH_OUTPUT: "Host key verification failed.\n" },
    /known_hosts/,
  ],
  [
    "the connection timed out",
    { FAKE_SSH_AUTH_OUTPUT: "ssh: connect to host github.com port 22: Connection timed out\n" },
    /timed out/i,
  ],
  [
    "an unrecognized response is never guessed at",
    { FAKE_SSH_AUTH_OUTPUT: "something entirely unexpected\n" },
    /could not be parsed/,
  ],
  [
    "IdentitiesOnly is not set, so the route is not strongly bound to one key",
    { FAKE_SSH_IDENTITIES_ONLY: "no", FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work") },
    /IdentitiesOnly/,
  ],
  [
    "the trusted alias's EFFECTIVE hostname is not GitHub, however perfect the greeting",
    { FAKE_SSH_HOSTNAME: "evil.example", FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work") },
    /not a GitHub SSH endpoint/,
  ],
  [
    "a look-alike hostname is not a GitHub endpoint",
    { FAKE_SSH_HOSTNAME: "github.com.evil.example", FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work") },
    /not a GitHub SSH endpoint/,
  ],
  [
    "`ssh -G` reports no hostname at all — never assumed to be fine",
    { FAKE_SSH_G_FAIL: "1", FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work") },
    /could not resolve this SSH route/,
  ],
];

for (const [label, env, expectedMessage] of UNVERIFIABLE) {
  test(`PART 3/xplat — UNVERIFIED and blocked: ${label}`, async () => {
    const fixture = await setUp();
    try {
      const result = await evaluatePush(fixture, env);
      assert.notEqual(result.code, 0, result.stderr);
      assert.deepEqual(result.reasonIds, ["push-account-unverified"]);
      assert.match(result.stderr, expectedMessage);
    } finally {
      await cleanup(fixture);
    }
  });
}

test("PART 3/xplat — GitHub's documented port-443 endpoint IS accepted", async () => {
  const fixture = await setUp();
  try {
    const result = await evaluatePush(fixture, {
      FAKE_SSH_HOSTNAME: "ssh.github.com",
      FAKE_SSH_PORT: "443",
      FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work"),
    });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(fixture);
  }
});

test("PART 3/xplat — a non-GitHub effective route is rejected BEFORE the network probe is ever attempted", async () => {
  const fixture = await setUp();
  const probeLog = path.join(fixture.repoDir, "probe.log");
  try {
    const result = await evaluatePush(fixture, {
      FAKE_SSH_HOSTNAME: "evil.example",
      FAKE_SSH_PROBE_LOG: probeLog,
      FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work"),
    });
    assert.notEqual(result.code, 0);
    assert.equal(await fs.readFile(probeLog, "utf8").catch(() => null), null, "ssh -T was attempted against a non-GitHub route");
  } finally {
    await cleanup(fixture);
  }
});

test("PART 3/xplat — the probe travels the same host:port route the push would, including an explicit URL port", async () => {
  const fixture = await setUp();
  const probeLog = path.join(fixture.repoDir, "probe.log");
  try {
    const result = await evaluatePush(
      fixture,
      { FAKE_SSH_PORT: "443", FAKE_SSH_HOSTNAME: "ssh.github.com", FAKE_SSH_PROBE_LOG: probeLog, FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work") },
      `ssh://git@${TRUSTED_ALIAS}:443/AcmeSoftware/acme-frontend.git`,
    );
    assert.equal(result.code, 0, result.stderr);
    const probe = await fs.readFile(probeLog, "utf8");
    assert.match(probe, /-p 443/, probe);
    assert.match(probe, new RegExp(`git@${TRUSTED_ALIAS}`), probe);
  } finally {
    await cleanup(fixture);
  }
});

test("PART 3/xplat — a profile with no expectedGitHubLogin never probes at all (route trust alone)", async () => {
  const fixture = await setUp(null);
  const probeLog = path.join(fixture.repoDir, "probe.log");
  try {
    const result = await evaluatePush(fixture, { FAKE_SSH_PROBE_LOG: probeLog, FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("someone-else") });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fs.readFile(probeLog, "utf8").catch(() => null), null, "an account probe ran for a profile that never asked for one");
  } finally {
    await cleanup(fixture);
  }
});

test("PART 3/xplat — an SSH transport override short-circuits verification entirely, without any probe", async () => {
  const fixture = await setUp();
  const probeLog = path.join(fixture.repoDir, "probe.log");
  try {
    // Both override families: a command override, and a non-OpenSSH variant.
    for (const override of [{ GIT_SSH_COMMAND: "ssh -v" }, { GIT_SSH_VARIANT: "plink" }]) {
      const result = await evaluatePush(fixture, {
        ...override,
        FAKE_SSH_PROBE_LOG: probeLog,
        FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED("danish-work"),
      });
      assert.notEqual(result.code, 0, JSON.stringify(override));
      assert.deepEqual(result.reasonIds, ["push-route-override"], JSON.stringify(override));
      assert.equal(
        await fs.readFile(probeLog, "utf8").catch(() => null),
        null,
        `an account probe ran despite ${JSON.stringify(override)} — an unprovable route must never be probed as if it were provable`,
      );
    }
  } finally {
    await cleanup(fixture);
  }
});
