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
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";
import { EVALUATOR_SOURCE, identityWith, testPolicy } from "./testUtil/lockFixtures";
import { AUTHENTICATED_AS, makeRouteFakeSsh, routeFakeRunner } from "./testUtil/routeFakeSsh";

/**
 * Explicit SSH ports — the push-account probe must travel EXACTLY the
 * host:port route the push itself will.
 *
 * Kept from the release-blocker work (round 3) because it is identity
 * correctness, not destination policy: `ssh -G host` and `ssh -G -p 443
 * host` can legitimately resolve DIFFERENT effective routes (per-port
 * config), so if the probe asked a different question than `git push`
 * does, a verified account could belong to a different route than the
 * one actually used. The rules, identical in the shipped shell evaluator
 * and the TypeScript probe (`checkPushAccount`):
 *
 *  - `-p <port>` is passed to BOTH `ssh -G` and `ssh -T` exactly when the
 *    URL carries an explicit port — only the `ssh://` form can; in the
 *    scp-like `host:path` form everything after `:` is the PATH;
 *  - no URL port means NO `-p` at all (the effective config decides,
 *    exactly as for the real transport) — never an invented 22;
 *  - IPv4, hostnames and bracketed IPv6 literals all extract the same way.
 *
 * Both sides run on every platform: the shell evaluator is sourced through
 * `runEvaluatorScript` (the proven cross-platform mechanism), and the
 * TypeScript probe uses an injected in-process runner.
 */

const execFileAsync = promisify(execFile);

/** The route-relevant part of an ssh argv: everything except `-o <option>` pairs (timeouts etc. legitimately differ between the two probes). */
function routeArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o") {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

async function makeRepo(): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rig-port-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, "gc"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  await fs.writeFile(path.join(dir, "gc"), "");
  await execFileAsync("git", ["init", "-q"], { cwd: dir, env });
  return { dir, env };
}

async function installPolicy(repoDir: string, env: NodeJS.ProcessEnv, alias: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoDir, env });
  await fs.mkdir(shieldStorageDir(stdout.trim()), { recursive: true });
  await fs.writeFile(
    shieldPolicyFilePath(stdout.trim()),
    serializeShieldPolicy(testPolicy(identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: [alias] }))),
  );
}

interface PortCase {
  url: string;
  host: string;
  port: string | undefined;
}

const PORT_CORPUS: PortCase[] = [
  { url: "ssh://git@github-work:443/acme/repo.git", host: "github-work", port: "443" },
  { url: "ssh://git@github-work/acme/repo.git", host: "github-work", port: undefined },
  { url: "git@github-work:acme/repo.git", host: "github-work", port: undefined },
  // scp-like: "2222/acme/repo.git" is a PATH, never a port (Git's own rule).
  { url: "git@github-work:2222/acme/repo.git", host: "github-work", port: undefined },
  { url: "ssh://git@192.0.2.10:2222/acme/repo.git", host: "192.0.2.10", port: "2222" },
  { url: "ssh://git@192.0.2.10/acme/repo.git", host: "192.0.2.10", port: undefined },
  { url: "ssh://git@[2001:db8::1]:2222/acme/repo.git", host: "[2001:db8::1]", port: "2222" },
  { url: "ssh://git@[2001:db8::1]/acme/repo.git", host: "[2001:db8::1]", port: undefined },
];

test("parseRemoteUrl extracts host and explicit port identically across hostname/IPv4/IPv6 forms, with and without one", () => {
  for (const { url, host, port } of PORT_CORPUS) {
    const parsed = parseRemoteUrl(url);
    assert.equal(parsed.protocol, "ssh", url);
    assert.equal(parsed.host, host, `host mismatch for ${url}`);
    assert.equal(parsed.port, port, `port mismatch for ${url}`);
    assert.equal(parsed.sshUser, "git", `sshUser mismatch for ${url}`);
  }
});

for (const testCase of PORT_CORPUS) {
  test(`the shipped evaluator and the TypeScript probe send the SAME ssh -G and ssh -T route for ${testCase.url}`, async () => {
    const repo = await makeRepo();
    const fakeSshBin = await makeRouteFakeSsh();
    const argvLog = path.join(repo.dir, "argv.log");
    try {
      await installPolicy(repo.dir, repo.env, testCase.host);
      const env = { FAKE_SSH_ARGV_LOG: argvLog, FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work") };
      const shell = await runEvaluatorScript(repo.dir, repo.env, fakeSshBin, EVALUATOR_SOURCE, ["push", "origin", testCase.url], env);
      assert.equal(shell.code, 0, shell.stderr);
      const shellArgv = (await fs.readFile(argvLog, "utf8")).trim().split(/\r?\n/).map((line) => routeArgs(line.split(" ")));

      const tsArgv: string[][] = [];
      const ts = await checkPushAccount({
        identity: identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: [testCase.host] }),
        pushRemoteUrl: testCase.url,
        transport: {},
        runner: routeFakeRunner(env, tsArgv),
      });
      assert.equal(ts.status, "verified", ts.message);

      const portArgs = testCase.port ? ["-p", testCase.port] : [];
      const target = `git@${testCase.host}`;
      assert.deepEqual(shellArgv, [["-G", ...portArgs, target], ["-T", ...portArgs, target]], "shell probe route");
      assert.deepEqual(tsArgv.map(routeArgs), shellArgv, "TypeScript probe must ask the identical questions");
    } finally {
      await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

test("no URL port + an alias whose effective config uses a non-default port: no -p is invented, and the push is verified over the config's route", async () => {
  const repo = await makeRepo();
  const fakeSshBin = await makeRouteFakeSsh();
  const argvLog = path.join(repo.dir, "argv.log");
  try {
    await installPolicy(repo.dir, repo.env, "github-work");
    const env = { FAKE_SSH_ARGV_LOG: argvLog, FAKE_SSH_CONFIG_PORT: "2222", FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work") };
    const shell = await runEvaluatorScript(repo.dir, repo.env, fakeSshBin, EVALUATOR_SOURCE, ["push", "origin", "git@github-work:acme/repo.git"], env);
    assert.equal(shell.code, 0, shell.stderr);
    assert.doesNotMatch(await fs.readFile(argvLog, "utf8"), /-p /);
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});
