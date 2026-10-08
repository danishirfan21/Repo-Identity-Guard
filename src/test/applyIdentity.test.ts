import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { checkEffectiveIdentity } from "../identity/effectiveIdentityCheck";
import { IdentityLockService } from "../identity/identityLockService";
import { getEffectiveAuthorIdent } from "../services/gitService";
import { SafeActionRunner } from "../services/safeActionRunner";
import { EVALUATOR_SOURCE, WORK_IDENTITY_WITH_LOGIN } from "./testUtil/lockFixtures";

/**
 * DIRECT tests for "Use Assigned Identity in Git Config" (SafeActionRunner.
 * setLocalIdentity — "applyAssignedIdentity" in the production protocol),
 * against real temporary Git repositories. See "APPLY ASSIGNED IDENTITY"
 * in the task spec.
 *
 * Workspace Trust itself is NOT this layer's concern: SafeActionRunner has
 * no `vscode` dependency and no trust gate by design — trust is checked by
 * the caller (`extension.ts`'s `requireTrust`, and
 * `src/ui/protocol.ts#operationRequiresTrust("applyAssignedIdentity")` ===
 * true for the production contract, asserted in `protocol.test.ts`) BEFORE
 * this runner is ever invoked. Exercising that gate needs a `vscode` host
 * and is covered by `placeholderWebview.test.ts`'s trust-boundary tests.
 */

const execFileAsync = promisify(execFile);
const WORK = WORK_IDENTITY_WITH_LOGIN;

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

const tempDirs: string[] = [];
test.after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rig-apply-")));
  tempDirs.push(dir);
  return dir;
}

function envFor(dir: string, globalFile: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: "1" };
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

async function makeRepo(): Promise<{ repo: Repo; globalConfigFile: string }> {
  const dir = await tempDir();
  const globalConfigFile = path.join(dir, ".isolated-global-gitconfig");
  await fs.writeFile(globalConfigFile, "[user]\n\tname = Global Default\n\temail = global-default@example.com\n");
  const repo: Repo = { dir, env: envFor(dir, globalConfigFile) };
  await git(repo, ["init", "-q", "-b", "main"]);
  return { repo, globalConfigFile };
}

test("writes the correct user.name/user.email LOCALLY", async () => {
  const { repo } = await makeRepo();
  const runner = new SafeActionRunner();
  await runner.setLocalIdentity(repo.dir, WORK.gitName, WORK.gitEmail, "local");
  assert.equal(await git(repo, ["config", "--local", "user.name"]), WORK.gitName);
  assert.equal(await git(repo, ["config", "--local", "user.email"]), WORK.gitEmail);
});

test("the GLOBAL Git config is never touched", async () => {
  const { repo, globalConfigFile } = await makeRepo();
  const before = await fs.readFile(globalConfigFile, "utf8");
  const runner = new SafeActionRunner();
  await runner.setLocalIdentity(repo.dir, WORK.gitName, WORK.gitEmail, "local");
  const after = await fs.readFile(globalConfigFile, "utf8");
  assert.equal(after, before, "SafeActionRunner.setLocalIdentity must never write global config");
  // And the global value itself, read independently, is unchanged.
  assert.equal(await git(repo, ["config", "--global", "user.email"]), "global-default@example.com");
});

test("an identity with no gitName writes ONLY the email — an existing user.name is left as it is", async () => {
  const { repo } = await makeRepo();
  await git(repo, ["config", "--local", "user.name", "Existing Name"]);
  const runner = new SafeActionRunner();
  await runner.setLocalIdentity(repo.dir, undefined, "only-email@example.com", "local");
  assert.equal(await git(repo, ["config", "--local", "user.name"]), "Existing Name");
  assert.equal(await git(repo, ["config", "--local", "user.email"]), "only-email@example.com");
});

test("an empty email is refused — never silently writes an empty value", async () => {
  const { repo } = await makeRepo();
  const runner = new SafeActionRunner();
  await assert.rejects(() => runner.setLocalIdentity(repo.dir, WORK.gitName, "   ", "local"));
  // No user.email key was ever written — reading it fails (git's own "no
  // such key" exit code), it does not come back as an empty string.
  await assert.rejects(() => git(repo, ["config", "--local", "--get", "user.email"]));
});

test("write failure (not a Git repository at all) surfaces as a rejected promise, never a silent no-op", async () => {
  const dir = await tempDir(); // never `git init`-ed
  const runner = new SafeActionRunner();
  await assert.rejects(() => runner.setLocalIdentity(dir, WORK.gitName, WORK.gitEmail, "local"));
});

test("state is re-evaluated after success: IdentityLockService reports the repository's own local identity updated", async () => {
  const { repo } = await makeRepo();
  const svc = new IdentityLockService({ evaluatorScriptSource: EVALUATOR_SOURCE });
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const runner = new SafeActionRunner();
  await runner.setLocalIdentity(repo.dir, WORK.gitName, WORK.gitEmail, "local");
  // The repository's own LOCAL config now wins over whatever global
  // default is active in this process, so no global isolation is needed
  // to prove the state re-evaluation: `getEffectiveAuthorIdent` (the same
  // read the lock's passive inspection and the hook's own semantics use)
  // must reflect the freshly-applied identity.
  const effective = await getEffectiveAuthorIdent(repo.dir);
  assert.equal(effective.email, WORK.gitEmail);
  assert.equal(effective.name, WORK.gitName);
});

test("effective identity still wrong due to a HIGHER-PRECEDENCE override is never falsely reported fixed", async () => {
  const { repo } = await makeRepo();
  const runner = new SafeActionRunner();
  await runner.setLocalIdentity(repo.dir, WORK.gitName, WORK.gitEmail, "local");

  // Local config is now CORRECT, but an environment variable (higher
  // precedence than any config file — exactly what getEffectiveAuthorIdent
  // / checkEffectiveIdentity exist to catch) still overrides it.
  const saved = { GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME };
  process.env.GIT_AUTHOR_EMAIL = "env-still-wrong@example.com";
  process.env.GIT_AUTHOR_NAME = "Still Wrong";
  try {
    const check = await checkEffectiveIdentity(repo.dir, { gitEmail: WORK.gitEmail, gitName: WORK.gitName });
    assert.equal(check.matches, false, "a higher-precedence environment override must never be reported as fixed");
    assert.equal(check.effectiveAuthor.email, "env-still-wrong@example.com");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
