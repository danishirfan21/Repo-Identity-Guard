import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { checkEffectiveIdentity } from "../identity/effectiveIdentityCheck";

/**
 * Passive effective-identity inspection, against real temporary Git
 * repositories — the same "effective identity" semantics
 * `getEffectiveAuthorIdent`/`getEffectiveCommitterIdent` (and so the
 * enforcement hook itself) trust: `git var GIT_AUTHOR_IDENT`/
 * `GIT_COMMITTER_IDENT`, never a plain `git config user.email` read.
 */

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
test.after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rig-eic-")));
  tempDirs.push(dir);
  return dir;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$|^EMAIL$/.test(key)) delete env[key];
  }
  return env;
}

async function makeRepo(): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = await tempDir();
  const env = envFor(dir);
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir, env });
  await git(["init", "-q", "-b", "main"]);
  return { dir, env };
}

async function setLocalIdentity(repo: { dir: string; env: NodeJS.ProcessEnv }, name: string, email: string): Promise<void> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: repo.dir, env: repo.env });
  await git(["config", "user.name", name]);
  await git(["config", "user.email", email]);
}

const EXPECTED = { gitName: "Danish Irfan", gitEmail: "work@example.com" };

test("correct effective identity: matches", async () => {
  const repo = await makeRepo();
  await setLocalIdentity(repo, EXPECTED.gitName, EXPECTED.gitEmail);
  const result = await checkEffectiveIdentity(repo.dir, EXPECTED);
  assert.equal(result.inspectionFailed, false);
  assert.equal(result.matches, true);
  assert.equal(result.authorViolates, false);
  assert.equal(result.committerViolates, false);
  assert.equal(result.violatingRole, undefined);
});

test("wrong LOCAL identity: email mismatch is reported, not guessed away", async () => {
  const repo = await makeRepo();
  await setLocalIdentity(repo, EXPECTED.gitName, "someone-else@example.com");
  const result = await checkEffectiveIdentity(repo.dir, EXPECTED);
  assert.equal(result.matches, false);
  assert.equal(result.authorViolates, true);
  assert.equal(result.committerViolates, true);
  assert.equal(result.violatingRole, "both");
  assert.equal(result.effectiveAuthor.email, "someone-else@example.com");
});

test("wrong GLOBAL identity (no local override): still detected, via the effective (git var) read", async () => {
  // `checkEffectiveIdentity` always runs `git` as a child of THIS process
  // (process.env), so isolating "global" config for it — rather than for
  // some other `git` invocation made with an explicit env — means pointing
  // process.env's own GIT_CONFIG_GLOBAL at a private file for the
  // duration of this test (restored after), the same technique
  // `withEnvOverride` uses for GIT_AUTHOR_EMAIL/GIT_COMMITTER_EMAIL below.
  const repo = await makeRepo(); // has no local user.name/user.email
  const globalConfigFile = path.join(repo.dir, ".isolated-global-gitconfig");
  await fs.writeFile(globalConfigFile, "[user]\n\tname = Wrong Person\n\temail = wrong@example.com\n");
  const result = await withEnvOverride(
    { GIT_CONFIG_GLOBAL: globalConfigFile, GIT_CONFIG_NOSYSTEM: "1" },
    () => checkEffectiveIdentity(repo.dir, EXPECTED),
  );
  assert.equal(result.matches, false);
  assert.equal(result.effectiveAuthor.email, "wrong@example.com");
});

test("only the gitName mismatches (email correct): still a violation — the name is enforced whenever the identity specifies one", async () => {
  const repo = await makeRepo();
  await setLocalIdentity(repo, "Someone Else", EXPECTED.gitEmail);
  const result = await checkEffectiveIdentity(repo.dir, EXPECTED);
  assert.equal(result.matches, false);
  assert.equal(result.authorViolates, true);
});

test("identity with no gitName only constrains the email — a different local name alone is not a violation", async () => {
  const repo = await makeRepo();
  await setLocalIdentity(repo, "Whatever Name", "work@example.com");
  const result = await checkEffectiveIdentity(repo.dir, { gitEmail: "work@example.com" });
  assert.equal(result.matches, true);
});

/**
 * `checkEffectiveIdentity` (via `getEffectiveAuthorIdent`/
 * `getEffectiveCommitterIdent`) always runs `git` as a child of THIS
 * process, so an environment override has to be set on `process.env`
 * itself to be visible to it. Saved and restored around each use so it
 * cannot leak into any other test in this file or process.
 */
async function withEnvOverride<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("environment override (GIT_AUTHOR_EMAIL) is detected — a plain `git config` read would miss this", async () => {
  const repo = await makeRepo();
  await setLocalIdentity(repo, EXPECTED.gitName, EXPECTED.gitEmail);
  // Local config is CORRECT; an environment override still makes the
  // effective identity wrong, and the passive check must catch it the
  // same way the enforcement hook would.
  const result = await withEnvOverride(
    { GIT_AUTHOR_EMAIL: "env-override@example.com", GIT_AUTHOR_NAME: "Env Override" },
    () => checkEffectiveIdentity(repo.dir, EXPECTED),
  );
  assert.equal(result.matches, false);
  assert.equal(result.authorViolates, true);
  assert.equal(result.effectiveAuthor.email, "env-override@example.com");
  // Committer was not overridden, and local config is correct for it.
  assert.equal(result.committerViolates, false);
  assert.equal(result.violatingRole, "author");
});

test("author/committer divergence: a mismatched COMMITTER alone (author correct) is still reported — never falsely 'healthy'", async () => {
  const repo = await makeRepo();
  await setLocalIdentity(repo, EXPECTED.gitName, EXPECTED.gitEmail);
  const result = await withEnvOverride(
    { GIT_COMMITTER_EMAIL: "different-committer@example.com", GIT_COMMITTER_NAME: "Different Committer" },
    () => checkEffectiveIdentity(repo.dir, EXPECTED),
  );
  assert.equal(result.authorViolates, false);
  assert.equal(result.committerViolates, true);
  assert.equal(result.matches, false, "author OR committer violating must still be reported as needing attention");
  assert.equal(result.violatingRole, "committer");
});

test("inspection failure (the directory itself cannot be used as a `git` cwd) is reported truthfully, never guessed as a match", async () => {
  // A nonexistent cwd makes the child process spawn itself fail (ENOENT),
  // which `isExpectedMissingValue` does NOT treat as "no value" (that's
  // reserved for git's own exit codes 1/2/128) — so it propagates, and
  // `checkEffectiveIdentity` must report that as a genuine inspection
  // failure rather than silently defaulting to a match or a mismatch.
  const parent = await tempDir();
  const missing = path.join(parent, "does-not-exist");
  const result = await checkEffectiveIdentity(missing, EXPECTED);
  assert.equal(result.inspectionFailed, true);
  assert.equal(result.matches, false);
  assert.equal(result.violatingRole, undefined);
});
