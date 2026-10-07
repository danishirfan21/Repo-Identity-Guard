import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { checkPushAccount } from "../identity/pushAccountProbe";
import { parseRemoteUrl } from "../services/gitService";
import { serializeShieldPolicy } from "../shield/policy";
import { sshTargetArgs } from "../shield/sshEndpoint";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";
import { EVALUATOR_SOURCE, identityWith, testPolicy } from "./testUtil/lockFixtures";
import { AUTHENTICATED_AS, makeRouteFakeSsh, routeFakeRunner } from "./testUtil/routeFakeSsh";

/**
 * The SSH user must never be invented.
 *
 * For `ssh://host/owner/repo.git` or `host:owner/repo.git` with NO user,
 * Git/ssh determine the effective user via ordinary OpenSSH rules (the
 * local user, or a config `User` directive) — never universally "git".
 * Because OpenSSH supports username-sensitive configuration (`Match user
 * ...`), probing "git@host" when the real push connects as bare "host"
 * can resolve to a DIFFERENT route — and verify the wrong account. So the
 * probe target is `<user>@<host>` only when the URL names a user, and the
 * BARE host otherwise, in both the shipped shell evaluator and the
 * TypeScript probe.
 */

const execFileAsync = promisify(execFile);
const LOGIN_IDENTITY = identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: ["github-work"] });

async function makeRepo(): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rig-user-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  await fs.writeFile(path.join(dir, "gc"), "");
  await execFileAsync("git", ["init", "-q"], { cwd: dir, env });
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, env });
  await fs.mkdir(shieldStorageDir(stdout.trim()), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(stdout.trim()), serializeShieldPolicy(testPolicy(LOGIN_IDENTITY)));
  return { dir, env };
}

async function runBoth(url: string, extraEnv: NodeJS.ProcessEnv): Promise<{ shellCode: number; shellStderr: string; shellTargets: string[]; tsStatus: string; tsTargets: string[] }> {
  const repo = await makeRepo();
  const fakeSshBin = await makeRouteFakeSsh();
  const argvLog = path.join(repo.dir, "argv.log");
  try {
    const env = { FAKE_SSH_ARGV_LOG: argvLog, FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work"), ...extraEnv };
    const shell = await runEvaluatorScript(repo.dir, repo.env, fakeSshBin, EVALUATOR_SOURCE, ["push", "origin", url], env);
    const shellTargets = (await fs.readFile(argvLog, "utf8").catch(() => "")).trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(" ").pop() as string);
    const tsLog: string[][] = [];
    const ts = await checkPushAccount({ identity: LOGIN_IDENTITY, pushRemoteUrl: url, transport: {}, runner: routeFakeRunner(env, tsLog) });
    return { shellCode: shell.code, shellStderr: shell.stderr, shellTargets, tsStatus: ts.status, tsTargets: tsLog.map((args) => args[args.length - 1]) };
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("parseRemoteUrl never invents a user: explicit users are kept, omitted users stay undefined (ssh:// and scp-like)", () => {
  assert.equal(parseRemoteUrl("git@github-work:acme/repo.git").sshUser, "git");
  assert.equal(parseRemoteUrl("ssh://deploy@github-work:443/acme/repo.git").sshUser, "deploy");
  assert.equal(parseRemoteUrl("ssh://github-work/acme/repo.git").sshUser, undefined);
  assert.equal(parseRemoteUrl("github-work:acme/repo.git").sshUser, undefined);
  assert.deepEqual(sshTargetArgs("github-work", {}), ["github-work"]);
  assert.deepEqual(sshTargetArgs("github-work", { user: "deploy", port: "443" }), ["-p", "443", "deploy@github-work"]);
});

const TARGET_CASES: Array<[string, string]> = [
  ["git@github-work:acme/repo.git", "git@github-work"],
  ["ssh://deploy@github-work:443/acme/repo.git", "deploy@github-work"],
  ["ssh://github-work/acme/repo.git", "github-work"],
  ["github-work:acme/repo.git", "github-work"],
];

for (const [url, expectedTarget] of TARGET_CASES) {
  test(`both probes connect to exactly "${expectedTarget}" for ${url}`, async () => {
    const result = await runBoth(url, {});
    assert.equal(result.shellCode, 0, result.shellStderr);
    assert.equal(result.tsStatus, "verified");
    assert.deepEqual(result.shellTargets, [expectedTarget, expectedTarget]);
    assert.deepEqual(result.tsTargets, result.shellTargets);
  });
}

test("username-sensitive routing: an omitted-user URL is verified over the BARE route — if that route is not GitHub, the push is blocked (inventing 'git@' would have falsely verified it)", async () => {
  const env = { FAKE_SSH_HOSTNAME_NO_USER: "evil.example", FAKE_SSH_HOSTNAME_USER_git: "github.com" };
  const omitted = await runBoth("github-work:acme/repo.git", env);
  assert.notEqual(omitted.shellCode, 0);
  assert.match(omitted.shellStderr, /DETAIL: route_not_github/);
  assert.equal(omitted.tsStatus, "unverifiable");

  const explicit = await runBoth("git@github-work:acme/repo.git", env);
  assert.equal(explicit.shellCode, 0, explicit.shellStderr);
  assert.equal(explicit.tsStatus, "verified");
});

test("username-sensitive routing, reversed: an explicit git@ URL is verified over the git@ route, never the bare one", async () => {
  const env = { FAKE_SSH_HOSTNAME_NO_USER: "github.com", FAKE_SSH_HOSTNAME_USER_git: "evil.example" };
  const explicit = await runBoth("git@github-work:acme/repo.git", env);
  assert.notEqual(explicit.shellCode, 0);
  assert.equal(explicit.tsStatus, "unverifiable");
  const omitted = await runBoth("github-work:acme/repo.git", env);
  assert.equal(omitted.shellCode, 0, omitted.shellStderr);
  assert.equal(omitted.tsStatus, "verified");
});
