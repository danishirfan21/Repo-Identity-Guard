import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { buildPreCommitHookScript, buildPrePushHookScript } from "../shield/artifacts";
import { checkPushAccount } from "../identity/pushAccountProbe";
import { serializeShieldPolicy } from "../shield/policy";
import { SHIELD_REASON_CATALOG } from "../shield/reasonCatalog";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { ShieldReasonId } from "../shield/types";
import { makeFakeSshBin } from "./testUtil/fakeSsh";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";
import { sshTargetArgs } from "../shield/sshEndpoint";
import { AUTHENTICATED_AS, makeRouteFakeSsh, routeFakeRunner } from "./testUtil/routeFakeSsh";
import { EVALUATOR_SOURCE, WORK_IDENTITY, WORK_IDENTITY_WITH_LOGIN, parseBlockPrelude, testPolicy } from "./testUtil/lockFixtures";

/**
 * The block-message contract. Every block — from the evaluator or from a
 * hook shim — starts with a machine-readable prelude a future UI (or an
 * agent reading a failed `git commit`) can parse without scraping prose:
 *
 *   REPO_IDENTITY_GUARD_BLOCK
 *   ACTION: commit|push
 *   REASON: <short code from SHIELD_REASON_CATALOG>
 *   REASON_ID: <ShieldReasonId>
 *   IDENTITY: <label>                         (when a policy was loaded)
 *   EXPECTED_* / FOUND_* / DETAIL / ...       (action-specific)
 *   <blank line>
 *   Repo Identity Guard blocked this <action>.
 *
 * Each prelude value is a single line (no injection of extra fields), and
 * no message ever prints a credential.
 */

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rig-output-")));
  const run = (args: string[]) => execFileAsync("git", args, { cwd: dir });
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.name", "Danish Irfan"]);
  await run(["config", "user.email", "work@example.com"]);
  await fs.writeFile(path.join(dir, "f.txt"), "x\n");
  await run(["add", "f.txt"]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

async function writePolicy(repo: string, raw: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
  const commonDir = stdout.trim();
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), raw);
}

const cleanupDirs: string[] = [];
test.after(async () => {
  await Promise.all(cleanupDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function evaluate(repo: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, stdin = "") {
  const fakeSsh = await makeFakeSshBin();
  cleanupDirs.push(fakeSsh);
  return runEvaluatorScript(repo, process.env, fakeSsh, EVALUATOR_SOURCE, args, extraEnv, stdin);
}

function preludeLines(stderr: string): string[] {
  const lines = stderr.replace(/\r\n/g, "\n").split("\n");
  const end = lines.indexOf("");
  return lines.slice(0, end);
}

test("the shell's reason_code table is exactly SHIELD_REASON_CATALOG (no drift between the two implementations)", async () => {
  const script = await fs.readFile(EVALUATOR_SOURCE, "utf8");
  const body = script.slice(script.indexOf("reason_code() {"), script.indexOf("esac", script.indexOf("reason_code() {")));
  const shellCodes: Record<string, string> = {};
  let fallback: string | undefined;
  for (const match of body.matchAll(/^\s+([a-z*-]+)\) echo ([a-z_]+) ;;$/gm)) {
    if (match[1] === "*") fallback = match[2];
    else shellCodes[match[1]] = match[2];
  }
  const catalog = Object.fromEntries(Object.entries(SHIELD_REASON_CATALOG).map(([id, d]) => [id, d.code]));
  // The fallback branch carries the one remaining id.
  const fallbackIds = Object.keys(catalog).filter((id) => !(id in shellCodes));
  assert.deepEqual(fallbackIds, ["inspection-failed"]);
  assert.equal(fallback, catalog["inspection-failed"]);
  for (const [id, code] of Object.entries(shellCodes)) {
    assert.equal(code, catalog[id as ShieldReasonId], id);
  }
  // Codes are unique and snake_case.
  const codes = Object.values(catalog);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) assert.match(code, /^[a-z]+(_[a-z]+)*$/);
});

test("commit block: exact prelude order and fields, then the human message and the no-bypass note", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, serializeShieldPolicy(testPolicy(WORK_IDENTITY)));
  const result = await evaluate(repo, ["commit"], { GIT_AUTHOR_EMAIL: "personal@example.com", GIT_COMMITTER_EMAIL: "personal@example.com" });
  assert.notEqual(result.code, 0);
  assert.deepEqual(preludeLines(result.stderr), [
    "REPO_IDENTITY_GUARD_BLOCK",
    "ACTION: commit",
    "REASON: identity_override",
    "REASON_ID: commit-identity-override",
    "IDENTITY: Work",
    "EXPECTED_NAME: Danish Irfan",
    "EXPECTED_EMAIL: work@example.com",
    "FOUND_NAME: Danish Irfan",
    "FOUND_EMAIL: personal@example.com",
    "FOUND_ROLE: author,committer",
  ]);
  assert.match(result.stderr, /\n\nRepo Identity Guard blocked this commit\.\n/);
  assert.match(result.stderr, /Do not bypass this check \(for example with --no-verify\)/);
  assert.match(result.stderr, /Unlock Current Repository/);
});

test("policy-missing block: prelude without IDENTITY (nothing was loaded), still parseable", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  const result = await evaluate(repo, ["commit"]);
  assert.notEqual(result.code, 0);
  assert.deepEqual(preludeLines(result.stderr), ["REPO_IDENTITY_GUARD_BLOCK", "ACTION: commit", "REASON: policy_missing", "REASON_ID: policy-missing"]);
  assert.match(result.stderr, /Repair Identity Lock/);
});

test("a legacy (v2) policy is refused as policy-corrupt with a migration hint, never evaluated", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, JSON.stringify({ policyVersion: 2, matchedProfileId: "work", expectedGitEmail: "work@example.com", enabledActions: ["commit"] }));
  const result = await evaluate(repo, ["commit"]);
  assert.notEqual(result.code, 0);
  assert.equal(parseBlockPrelude(result.stderr).REASON, "policy_corrupt");
  assert.match(result.stderr, /legacy Repo Identity Guard "Shield" policy/);
});

test("push account mismatch: EXPECTED/FOUND GitHub login, DETAIL, REMOTE and ROUTE_HOST in the prelude", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, serializeShieldPolicy(testPolicy(WORK_IDENTITY_WITH_LOGIN)));
  const result = await evaluate(repo, ["push", "origin", "git@github-work:AcmeSoftware/acme.git"], { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-personal") });
  assert.notEqual(result.code, 0);
  assert.deepEqual(parseBlockPrelude(result.stderr), {
    ACTION: "push",
    REASON: "wrong_push_account",
    REASON_ID: "push-account-mismatch",
    IDENTITY: "Work",
    EXPECTED_GITHUB_LOGIN: "danish-work",
    FOUND_GITHUB_LOGIN: "danish-personal",
    DETAIL: "account_mismatch",
    REMOTE: "origin",
    ROUTE_HOST: "github-work",
  });
});

test("push route blocks name the route problem in DETAIL (https, generic host, untrusted alias)", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, serializeShieldPolicy(testPolicy(WORK_IDENTITY_WITH_LOGIN)));
  for (const [url, detail] of [
    ["https://github.com/AcmeSoftware/acme.git", "https"],
    ["git@github.com:AcmeSoftware/acme.git", "generic_ssh_host"],
    ["git@github-personal:AcmeSoftware/acme.git", "untrusted_alias"],
  ] as const) {
    const result = await evaluate(repo, ["push", "origin", url]);
    assert.notEqual(result.code, 0, url);
    const prelude = parseBlockPrelude(result.stderr);
    assert.equal(prelude.DETAIL, detail, url);
    assert.equal(prelude.FOUND_GITHUB_LOGIN, "unverified", url);
    assert.equal(prelude.EXPECTED_GITHUB_LOGIN, "danish-work", url);
  }
});

test("NO SECRETS: credentials embedded in a remote URL are never printed in a block", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, serializeShieldPolicy(testPolicy(WORK_IDENTITY_WITH_LOGIN)));
  for (const url of [
    "https://x-access-token:ghp_SUPERSECRET0123456789@github.com/AcmeSoftware/acme.git",
    "https://danish:ghp_SUPERSECRET0123456789@github.com/AcmeSoftware/acme.git",
    "ssh://git:ghp_SUPERSECRET0123456789@github-work/AcmeSoftware/acme.git",
  ]) {
    const result = await evaluate(repo, ["push", "origin", url], { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-personal") });
    assert.notEqual(result.code, 0, url);
    assert.doesNotMatch(result.stderr, /SUPERSECRET/, `a credential leaked for ${url}:\n${result.stderr}`);
  }
});

test("OPTION INJECTION: an SSH user or host beginning with '-' is refused before ssh is ever invoked (shell and TypeScript agree)", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  const policy = testPolicy({ ...WORK_IDENTITY_WITH_LOGIN, trustedSshHostAliases: ["github-work"] });
  await writePolicy(repo, serializeShieldPolicy(policy));
  const fakeSsh = await makeRouteFakeSsh();
  cleanupDirs.push(fakeSsh);
  const argvLog = path.join(fakeSsh, "argv.log");
  for (const url of [
    "ssh://-oProxyCommand=touch%20pwned@github-work/AcmeSoftware/acme.git",
    "-oProxyCommand=x@github-work:AcmeSoftware/acme.git",
  ]) {
    const result = await runEvaluatorScript(repo, process.env, fakeSsh, EVALUATOR_SOURCE, ["push", "origin", url], { FAKE_SSH_ARGV_LOG: argvLog });
    assert.notEqual(result.code, 0, url);
    const prelude = parseBlockPrelude(result.stderr);
    assert.equal(prelude.REASON_ID, "push-route-unverified", url);
    assert.equal(prelude.DETAIL, "malformed", url);
    const log: string[][] = [];
    const ts = await checkPushAccount({ identity: WORK_IDENTITY_WITH_LOGIN, transport: {}, env: {}, pushRemoteUrl: url, runner: routeFakeRunner({}, log) });
    assert.equal(ts.status, "unverifiable", url);
    assert.equal(ts.reasonId, "push-route-unverified", url);
    assert.deepEqual(log, [], `TypeScript probe ran ssh for ${url}`);
  }
  assert.equal(await fs.stat(argvLog).then(() => true).catch(() => false), false, "the shell evaluator must never have run ssh");
  assert.throws(() => sshTargetArgs("github-work", { user: "-oProxyCommand=x" }));
  assert.throws(() => sshTargetArgs("-oProxyCommand=x"));
  assert.throws(() => sshTargetArgs("github-work", { port: "22 -oProxyCommand=x" }));
});

test("prelude values are single lines: a label with a newline cannot reach the policy, and one_line flattens anything that does", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  // Bypass TypeScript validation entirely: a hand-edited policy file.
  const policy = { ...testPolicy(WORK_IDENTITY), identityLabel: "Work\nREASON: allowed" };
  await writePolicy(repo, JSON.stringify(policy));
  const result = await evaluate(repo, ["commit"], { GIT_AUTHOR_EMAIL: "personal@example.com" });
  assert.notEqual(result.code, 0);
  const reasonLines = result.stderr.split("\n").filter((line) => line.startsWith("REASON: "));
  assert.equal(reasonLines.length, 1, `exactly one REASON line:\n${result.stderr}`);
  assert.notEqual(reasonLines[0], "REASON: allowed");
});

test("hook shims: internal errors use the same prelude (REASON: internal_error) and point at repair/unlock", () => {
  for (const script of [buildPreCommitHookScript(), buildPrePushHookScript()]) {
    assert.match(script, /echo 'REPO_IDENTITY_GUARD_BLOCK'/);
    assert.match(script, /echo 'REASON: internal_error'/);
    assert.match(script, /Repair Identity Lock/);
    assert.match(script, /Unlock Current Repository/);
    // A block from the evaluator is passed through verbatim, not re-wrapped.
    assert.match(script, /REPO_IDENTITY_GUARD_BLOCK\*\)/);
  }
});

test("the on-demand push check (TypeScript) agrees with the hook: verified / mismatch / route refused without any ssh call", async () => {
  const log: string[][] = [];
  const base = { identity: WORK_IDENTITY_WITH_LOGIN, transport: {}, env: {} };

  const verified = await checkPushAccount({ ...base, pushRemoteUrl: "git@github-work:AcmeSoftware/acme.git", runner: routeFakeRunner({ FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work") }, log) });
  assert.equal(verified.status, "verified");
  assert.equal(verified.authenticatedLogin, "danish-work");

  const mismatch = await checkPushAccount({ ...base, pushRemoteUrl: "git@github-work:AcmeSoftware/acme.git", runner: routeFakeRunner({ FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("someone-else") }, log) });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.reasonId, "push-account-mismatch");
  assert.equal(mismatch.authenticatedLogin, "someone-else");

  const before = log.length;
  for (const url of ["https://github.com/AcmeSoftware/acme.git", "git@github.com:AcmeSoftware/acme.git", "git@github-personal:AcmeSoftware/acme.git"]) {
    const refused = await checkPushAccount({ ...base, pushRemoteUrl: url, runner: routeFakeRunner({}, log) });
    assert.equal(refused.status, "unverifiable", url);
    assert.equal(refused.reasonId, "push-route-unverified", url);
  }
  assert.equal(log.length, before, "an unverifiable route is refused before any ssh invocation");

  const overridden = await checkPushAccount({ ...base, transport: { gitSshCommand: "ssh -i ~/.ssh/other" }, pushRemoteUrl: "git@github-work:AcmeSoftware/acme.git", runner: routeFakeRunner({}, log) });
  assert.equal(overridden.status, "unverifiable");
  assert.equal(overridden.reasonId, "push-route-override");

  // No GitHub login: a BLOCK (whatever the remote, even none), never "nothing to check" — and no ssh call.
  for (const pushRemoteUrl of ["git@github-work:AcmeSoftware/acme.git", "x", undefined]) {
    const beforeNoLogin = log.length;
    const noLogin = await checkPushAccount({ ...base, identity: WORK_IDENTITY, pushRemoteUrl, runner: routeFakeRunner({ FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work") }, log) });
    assert.equal(noLogin.status, "needs_configuration", String(pushRemoteUrl));
    assert.equal(noLogin.reasonId, "push-identity-not-configured", String(pushRemoteUrl));
    assert.match(noLogin.message, /would be blocked.*does not yet have a GitHub account configured for push verification/);
    assert.equal(log.length, beforeNoLogin, "no ssh probe without a login to verify");
  }
  assert.equal((await checkPushAccount({ ...base, pushRemoteUrl: undefined })).status, "no_push_remote");
});

// ==================== incomplete push requirement: block output ====================

test("push identity not configured: exact prelude, actionable message, no-bypass note — and the remote URL is never echoed", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, serializeShieldPolicy(testPolicy(WORK_IDENTITY)));
  const result = await evaluate(repo, ["push", "origin", "https://x-access-token:ghp_SUPERSECRET0123456789@github.com/AcmeSoftware/acme.git"]);
  assert.notEqual(result.code, 0);
  assert.deepEqual(preludeLines(result.stderr), [
    "REPO_IDENTITY_GUARD_BLOCK",
    "ACTION: push",
    "REASON: push_identity_not_configured",
    "REASON_ID: push-identity-not-configured",
    "IDENTITY: Work",
    "EXPECTED_GITHUB_LOGIN: (not configured)",
    "DETAIL: github_login_not_configured",
    "REMOTE: origin",
  ]);
  assert.match(result.stderr, /\n\nRepo Identity Guard blocked this push\.\n/);
  assert.match(result.stderr, /This repository is locked to "Work", but that identity does not yet have\na GitHub account configured for push verification/);
  assert.match(result.stderr, /configure the GitHub account for "Work" in Repo Identity Guard/);
  assert.match(result.stderr, /Do not bypass this check \(for example with --no-verify\)/);
  assert.doesNotMatch(result.stderr, /SUPERSECRET|x-access-token/);
  assert.doesNotMatch(result.stderr, /not account-checked|Commits only/i);
});

test("login present but NO trusted SSH alias: blocked as push_route_unverified, and the message explains the alias requirement", async () => {
  const repo = await makeRepo();
  cleanupDirs.push(repo);
  await writePolicy(repo, serializeShieldPolicy(testPolicy({ ...WORK_IDENTITY_WITH_LOGIN, trustedSshHostAliases: [] })));
  for (const url of ["git@github-work:AcmeSoftware/acme.git", "https://github.com/AcmeSoftware/acme.git", "git@github.com:AcmeSoftware/acme.git"]) {
    const result = await evaluate(repo, ["push", "origin", url], { FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work") });
    assert.notEqual(result.code, 0, url);
    const prelude = parseBlockPrelude(result.stderr);
    assert.equal(prelude.REASON, "push_route_unverified", url);
    assert.equal(prelude.EXPECTED_GITHUB_LOGIN, "danish-work", url);
    assert.match(result.stderr, /"Work" lists no trusted SSH host alias, so no push route can be verified as "danish-work"/, url);
    assert.match(result.stderr, /every push from this repository is blocked until one is configured/, url);
    assert.match(result.stderr, /trustedSshHostAliases/, url);
  }
});
