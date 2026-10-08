import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { identitiesFromLegacyProfiles } from "../identity/identityConfig";
import { IdentityLockService } from "../identity/identityLockService";
import type { Identity } from "../identity/types";
import { SHIELD_ARTIFACT_MARKER, SHIELD_ARTIFACT_VERSION, SHIELD_CHAIN_ORIGINAL_SUFFIX } from "../shield/artifacts";
import { shieldInstallRecordFilePath, writeShieldInstallRecord } from "../shield/installRecord";
import { ShieldManager } from "../shield/manager";
import { parseShieldPolicy } from "../shield/policy";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";
import { EVALUATOR_SOURCE, WORK_IDENTITY, WORK_IDENTITY_WITH_LOGIN, identityWith, parseBlockPrelude } from "./testUtil/lockFixtures";
import { AUTHENTICATED_AS, makeRouteFakeSsh } from "./testUtil/routeFakeSsh";

/**
 * The product contract of the identity lock, end to end, against real
 * temporary Git repositories and the real shipped evaluator:
 *
 *  - an UNASSIGNED repository is completely untouched and never blocked;
 *  - nothing is ever assigned implicitly (no owner/org matching, no legacy
 *    owner pattern, no "similar repository");
 *  - assignment IS enforcement, is keyed to the git common dir (linked
 *    worktrees share it, an unrelated clone does not), and is
 *    all-or-nothing;
 *  - change/unlock/repair/drift behave transactionally;
 *  - an ASSIGNED repository always governs push too: an identity with no
 *    GitHub login (or no trusted alias) blocks every push and is never
 *    reported active;
 *  - legacy Shield installations are migrated conservatively, and v3
 *    locks from the previous release are upgraded in place (assignment
 *    kept, pushes fail-closed).
 */

const execFileAsync = promisify(execFile);

/** A COMPLETE (enforcement-ready) identity: Git identity + GitHub login + trusted alias. */
const WORK = WORK_IDENTITY_WITH_LOGIN;
/** The same person's identity with NO GitHub login configured — structurally valid, not enforcement-ready. */
const WORK_NO_LOGIN = WORK_IDENTITY;
const PERSONAL: Identity = { id: "personal", label: "Personal", gitName: "Danish", gitEmail: "me@example.com" };

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

const tempDirs: string[] = [];
test.after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  return env;
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

function tryGit(repo: Repo, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function makeRepo(prefix = "rig-lock-"): Promise<Repo> {
  const dir = await tempDir(prefix);
  const repo: Repo = { dir, env: envFor(dir) };
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", WORK.gitName!]);
  await git(repo, ["config", "user.email", WORK.gitEmail]);
  await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
  await git(repo, ["add", "f.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

let fileCounter = 0;
async function commitAs(repo: Repo, email: string, name = WORK.gitName!): Promise<{ code: number; stderr: string }> {
  await git(repo, ["config", "user.email", email]);
  await git(repo, ["config", "user.name", name]);
  fileCounter += 1;
  await fs.writeFile(path.join(repo.dir, `c${fileCounter}.txt`), `${fileCounter}\n`);
  await git(repo, ["add", `c${fileCounter}.txt`]);
  return tryGit(repo, ["commit", "-q", "-m", `commit ${fileCounter}`]);
}

async function hooksDir(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

async function commonDir(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true).catch(() => false);
}

/** Every file under the repository's git common dir that is NOT Git's own sample hook — the "did we touch anything" snapshot. */
async function nonSampleHookFiles(repo: Repo): Promise<string[]> {
  return (await fs.readdir(await hooksDir(repo))).filter((name) => !name.endsWith(".sample")).sort();
}

function service(options: { shield?: ShieldManager } = {}): IdentityLockService {
  let counter = 0;
  return new IdentityLockService({ evaluatorScriptSource: EVALUATOR_SOURCE, shield: options.shield, now: () => 1_700_000_000_000, newLockId: () => `lock-${++counter}` });
}

async function ref(svc: IdentityLockService, repo: Repo) {
  const resolved = await svc.resolveRepository(repo.dir);
  assert.ok(resolved, `${repo.dir} must resolve as a repository`);
  return resolved;
}

// ==================== unassigned repositories are left alone ====================

test("UNASSIGNED: status is unassigned, nothing is written, and wrong-identity commits AND pushes go through", async () => {
  const repo = await makeRepo();
  const remoteParent = await tempDir("rig-lock-remote-");
  const bare = path.join(remoteParent, "remote.git");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  const svc = service();
  const repoRef = await ref(svc, repo);

  const before = await nonSampleHookFiles(repo);
  const status = await svc.getStatus(repoRef, [WORK, PERSONAL]);
  assert.equal(status.enforcement.state, "unassigned");
  assert.equal(status.enforcement.commitEnforced, false);
  assert.equal(status.enforcement.push, "none");
  assert.equal(status.assignment, undefined);
  assert.equal(status.legacy, false);

  // Passive status, and the trusted-scan migration hook, write nothing.
  assert.deepEqual(await svc.migrateLegacy(repoRef, { legacyProfiles: [], identities: [WORK] }), { kind: "none" });
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard")), false);
  assert.deepEqual(await nonSampleHookFiles(repo), before);

  const committed = await commitAs(repo, "anyone@else.example", "Somebody Else");
  assert.equal(committed.code, 0, committed.stderr);
  await git(repo, ["remote", "add", "origin", bare]);
  const pushed = await tryGit(repo, ["push", "-q", "origin", "main"]);
  assert.equal(pushed.code, 0, pushed.stderr);
});

test("NO IMPLICIT ASSIGNMENT: an origin under an owner a legacy profile matched (and listed in exactRepos) stays unassigned without a legacy install", async () => {
  const repo = await makeRepo();
  await git(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
  const legacyProfiles = [
    { id: "work", label: "Work", gitEmail: "work@example.com", expectedRemoteOwners: ["AcmeSoftware"], exactRepos: ["github.com/AcmeSoftware/acme-frontend"] },
  ];
  const svc = service();
  const repoRef = await ref(svc, repo);

  const outcome = await svc.migrateLegacy(repoRef, { legacyProfiles, identities: identitiesFromLegacyProfiles(legacyProfiles).identities });
  assert.deepEqual(outcome, { kind: "none" });
  const status = await svc.getStatus(repoRef, [WORK]);
  assert.equal(status.enforcement.state, "unassigned");
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard")), false);
  const committed = await commitAs(repo, "personal@example.com");
  assert.equal(committed.code, 0, committed.stderr);
});

// ==================== assignment ====================

test("ASSIGN: assignment is enforcement — the right identity commits, the wrong one is blocked with a parseable prelude", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);

  const assigned = await svc.assign(repoRef, WORK, { identities: [WORK, PERSONAL] });
  assert.equal(assigned.ok, true, `${assigned.message} ${assigned.details.join(" | ")}`);
  assert.equal(assigned.message, 'This repository is locked to "Work".');
  assert.deepEqual(assigned.details, [], "a complete identity has nothing to warn about");
  assert.equal(assigned.status?.enforcement.state, "active");
  assert.equal(assigned.status?.enforcement.commitEnforced, true);
  assert.equal(assigned.status?.enforcement.push, "enforced");
  assert.deepEqual(assigned.status?.assignment, { repoKey: repoRef.repoKey, identityId: "work", assignedAt: 1_700_000_000_000 });
  assert.equal(assigned.status?.assignmentView?.identityStillDefined, true);

  const ok = await commitAs(repo, WORK.gitEmail);
  assert.equal(ok.code, 0, ok.stderr);

  const blocked = await commitAs(repo, PERSONAL.gitEmail);
  assert.notEqual(blocked.code, 0);
  const prelude = parseBlockPrelude(blocked.stderr);
  assert.equal(prelude.ACTION, "commit");
  assert.equal(prelude.REASON, "wrong_identity");
  assert.equal(prelude.IDENTITY, "Work");
  assert.equal(prelude.EXPECTED_EMAIL, WORK.gitEmail);
  assert.equal(prelude.FOUND_EMAIL, PERSONAL.gitEmail);
});

test("ASSIGN: an identity with a GitHub login also governs push — an unverifiable route is refused before anything is sent", async () => {
  const repo = await makeRepo();
  const remoteParent = await tempDir("rig-lock-remote-");
  const bare = path.join(remoteParent, "remote.git");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  const svc = service();
  const repoRef = await ref(svc, repo);
  const withLogin = identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: ["github-work"] });

  const assigned = await svc.assign(repoRef, withLogin);
  assert.equal(assigned.ok, true, assigned.details.join(" | "));
  assert.equal(assigned.status?.enforcement.push, "enforced");

  await git(repo, ["remote", "add", "origin", bare]);
  const pushed = await tryGit(repo, ["push", "origin", "main"]);
  assert.notEqual(pushed.code, 0);
  const prelude = parseBlockPrelude(pushed.stderr);
  assert.equal(prelude.ACTION, "push");
  assert.equal(prelude.EXPECTED_GITHUB_LOGIN, "danish-work");
  assert.equal(prelude.FOUND_GITHUB_LOGIN, "unverified");
  const remoteHead = await execFileAsync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/main"]).catch(() => null);
  assert.equal(remoteHead, null, "nothing may have reached the remote");
});

test("ASSIGN: a login without any trusted alias is needs-attention, and every push is really BLOCKED (whatever the route)", async () => {
  const repo = await makeRepo();
  const remoteParent = await tempDir("rig-lock-remote-");
  const bare = path.join(remoteParent, "remote.git");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  const svc = service();
  const repoRef = await ref(svc, repo);
  const noAlias = identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: [] });
  const assigned = await svc.assign(repoRef, noAlias);
  assert.equal(assigned.ok, true);
  assert.match(assigned.details.join(" "), /lists no trusted SSH host alias.*every push is blocked until an alias is added/);
  assert.equal(assigned.status?.enforcement.state, "needs_attention");
  assert.equal(assigned.status?.enforcement.push, "unverifiable");
  assert.equal(assigned.status?.enforcement.commitEnforced, true);

  // Commits with the assigned identity are still allowed.
  const committed = await commitAs(repo, noAlias.gitEmail);
  assert.equal(committed.code, 0, committed.stderr);

  // A real push (git only runs pre-push once the remote is reachable, so a
  // local bare repository stands in for it; other route shapes are covered
  // against the evaluator directly in identityLockOutput.test.ts).
  await git(repo, ["remote", "add", "origin", bare]);
  const pushed = await tryGit(repo, ["push", "origin", "main"]);
  assert.notEqual(pushed.code, 0);
  assert.equal(parseBlockPrelude(pushed.stderr).REASON, "push_route_unverified");
  assert.match(pushed.stderr, /lists no trusted SSH host alias/);
  const remoteHead = await execFileAsync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/main"]).catch(() => null);
  assert.equal(remoteHead, null, "nothing may have reached the remote");
});

test("ASSIGN without a GitHub login: commits are locked, EVERY push is blocked (push_identity_not_configured), and the status is needs-attention — never active", async () => {
  const repo = await makeRepo();
  const remoteParent = await tempDir("rig-lock-remote-");
  const bare = path.join(remoteParent, "remote.git");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  const svc = service();
  const repoRef = await ref(svc, repo);

  const assigned = await svc.assign(repoRef, WORK_NO_LOGIN, { identities: [WORK_NO_LOGIN] });
  assert.equal(assigned.ok, true, assigned.details.join(" | "));
  assert.equal(assigned.message, 'This repository is locked to "Work".');
  assert.match(assigned.details.join(" "), /"Work" has no GitHub account configured for push verification, so every push from this repository is blocked/);
  assert.doesNotMatch(assigned.details.join(" "), /not account-checked|Commits only/i);
  const status = await svc.getStatus(repoRef, [WORK_NO_LOGIN]);
  assert.equal(status.enforcement.state, "needs_attention");
  assert.notEqual(status.enforcement.state, "active");
  assert.equal(status.enforcement.push, "needs_configuration");
  assert.equal(status.enforcement.commitEnforced, true);
  assert.equal(status.enforcement.repairAvailable, false, "repair cannot help until the identity is completed");
  assert.equal(status.enforcement.unlockAvailable, true);
  assert.match(status.enforcement.reason ?? "", /Configure the GitHub account \(expectedGitHubLogin\) for "Work"/);
  assert.equal(status.assignment?.identityId, "work", "it is still assigned");

  // Commit: correct Git identity allowed, wrong one blocked.
  const ok = await commitAs(repo, WORK_NO_LOGIN.gitEmail);
  assert.equal(ok.code, 0, ok.stderr);
  const wrong = await commitAs(repo, PERSONAL.gitEmail);
  assert.notEqual(wrong.code, 0);
  assert.equal(parseBlockPrelude(wrong.stderr).REASON, "wrong_identity");
  await commitAs(repo, WORK_NO_LOGIN.gitEmail);

  // Push: a real `git push` through the installed pre-push hook is blocked
  // (every other route shape is covered against the evaluator directly).
  await git(repo, ["remote", "add", "origin", bare]);
  const pushed = await tryGit(repo, ["push", "origin", "main"]);
  assert.notEqual(pushed.code, 0);
  const prelude = parseBlockPrelude(pushed.stderr);
  assert.equal(prelude.ACTION, "push");
  assert.equal(prelude.REASON, "push_identity_not_configured");
  assert.equal(prelude.IDENTITY, "Work");
  assert.match(pushed.stderr, /does not yet have\na GitHub account configured for push verification/);
  const remoteHead = await execFileAsync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/main"]).catch(() => null);
  assert.equal(remoteHead, null, "nothing may have reached the remote");

  // Completing the identity (in settings) shows as drift; Repair applies it and the lock becomes active.
  const completed: Identity = { ...WORK_NO_LOGIN, expectedGitHubLogin: "danish-work", trustedSshHostAliases: ["github-work"] };
  const drifted = await svc.getStatus(repoRef, [completed]);
  assert.equal(drifted.enforcement.state, "needs_attention");
  assert.equal(drifted.enforcement.repairAvailable, true);
  const repaired = await svc.repair(repoRef, [completed]);
  assert.equal(repaired.ok, true, repaired.details.join(" | "));
  assert.equal(repaired.status?.enforcement.state, "active");
  assert.equal(repaired.status?.enforcement.push, "enforced");
});

test("ASSIGN: an invalid identity is refused and nothing is written", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  const result = await svc.assign(repoRef, { ...WORK, gitEmail: "bad\nREASON: none" });
  assert.equal(result.ok, false);
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard")), false);
  assert.deepEqual(await nonSampleHookFiles(repo), []);
});

test("ASSIGN is keyed to the git common dir: a linked worktree shares the lock; an unrelated clone does not", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  assert.equal((await svc.assign(repoRef, WORK)).ok, true);

  // Linked worktree: same assignment, same enforcement.
  const worktreeDir = path.join(await tempDir("rig-lock-wt-parent-"), "wt");
  await git(repo, ["worktree", "add", "-q", "-b", "feature/wt", worktreeDir]);
  const worktree: Repo = { dir: worktreeDir, env: repo.env };
  const worktreeRef = await ref(svc, worktree);
  assert.equal(worktreeRef.repoKey, repoRef.repoKey);
  assert.equal((await svc.getStatus(worktreeRef, [WORK])).enforcement.state, "active");
  const blockedInWorktree = await commitAs(worktree, PERSONAL.gitEmail);
  assert.notEqual(blockedInWorktree.code, 0);
  assert.match(blockedInWorktree.stderr, /^REASON: wrong_identity$/m);

  // Unrelated clone of the same history: a different repository, unassigned.
  const cloneDir = path.join(await tempDir("rig-lock-clone-parent-"), "clone");
  await execFileAsync("git", ["clone", "-q", repo.dir, cloneDir], { env: repo.env });
  const clone: Repo = { dir: cloneDir, env: repo.env };
  const cloneRef = await ref(svc, clone);
  assert.notEqual(cloneRef.repoKey, repoRef.repoKey);
  assert.equal((await svc.getStatus(cloneRef, [WORK])).enforcement.state, "unassigned");
  const allowedInClone = await commitAs(clone, PERSONAL.gitEmail);
  assert.equal(allowedInClone.code, 0, allowedInClone.stderr);
});

test("ASSIGN is all-or-nothing: a foreign hook without chaining refuses the whole assignment — nothing persisted, nothing blocks", async () => {
  const repo = await makeRepo();
  const hookPath = path.join(await hooksDir(repo), "pre-commit");
  const foreign = "#!/bin/sh\n# the user's own hook\nexit 0\n";
  await fs.writeFile(hookPath, foreign, { mode: 0o755 });
  const svc = service();
  const repoRef = await ref(svc, repo);

  const result = await svc.assign(repoRef, WORK);
  assert.equal(result.ok, false);
  assert.match(result.message, /NOT locked to "Work"; nothing was left installed/);
  assert.match(result.details.join(" "), /did not create/);
  assert.equal(await fs.readFile(hookPath, "utf8"), foreign, "the foreign hook is untouched");
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard", "shield-policy.json")), false, "no assignment was persisted");
  assert.deepEqual(await nonSampleHookFiles(repo), ["pre-commit"]);
  assert.equal(result.status?.enforcement.state, "unassigned");
  const committed = await commitAs(repo, PERSONAL.gitEmail);
  assert.equal(committed.code, 0, committed.stderr);
});

test("CHANGE identity rebuilds the lock for the new identity (new lockId); re-assigning the same identity keeps lockId/assignedAt", async () => {
  const repo = await makeRepo();
  let now = 1_000;
  let counter = 0;
  const svc = new IdentityLockService({ evaluatorScriptSource: EVALUATOR_SOURCE, now: () => now, newLockId: () => `lock-${++counter}` });
  const repoRef = await ref(svc, repo);

  assert.equal((await svc.assign(repoRef, WORK)).ok, true);
  const policyPath = path.join(await commonDir(repo), "repo-identity-guard", "shield-policy.json");
  const first = parseShieldPolicy(await fs.readFile(policyPath, "utf8"));
  assert.ok(first.ok);
  assert.equal(first.policy.lockId, "lock-1");

  now = 2_000;
  const resync = await svc.assign(repoRef, WORK);
  assert.equal(resync.ok, true);
  const second = parseShieldPolicy(await fs.readFile(policyPath, "utf8"));
  assert.ok(second.ok);
  assert.equal(second.policy.lockId, "lock-1", "same identity: a re-sync, not a new assignment");
  assert.equal(second.policy.assignedAt, 1_000);

  now = 3_000;
  const changed = await svc.assign(repoRef, PERSONAL, { identities: [WORK, PERSONAL] });
  assert.equal(changed.ok, true);
  assert.equal(changed.message, 'This repository is now locked to "Personal" (was "Work").');
  const third = parseShieldPolicy(await fs.readFile(policyPath, "utf8"));
  assert.ok(third.ok);
  assert.equal(third.policy.lockId, "lock-2");
  assert.equal(third.policy.assignedAt, 3_000);
  assert.equal(third.policy.identityId, "personal");

  assert.notEqual((await commitAs(repo, WORK.gitEmail)).code, 0, "the previous identity is now the wrong one");
  const asPersonal = await commitAs(repo, PERSONAL.gitEmail, PERSONAL.gitName);
  assert.equal(asPersonal.code, 0, asPersonal.stderr);
});

test("CHANGE that cannot complete leaves the PREVIOUS lock fully in place", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  assert.equal((await svc.assign(repoRef, WORK)).ok, true);

  // A foreign pre-push hook replaces the Work lock's own pre-push hook.
  // Changing identity re-installs every slot (push is always governed),
  // and chaining was not requested — so the change must be refused up
  // front, leaving Work's lock (policy, pre-commit) exactly as it was.
  await fs.writeFile(path.join(await hooksDir(repo), "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const personalWithLogin = { ...PERSONAL, expectedGitHubLogin: "danish-personal", trustedSshHostAliases: ["github-personal"] };
  const result = await svc.assign(repoRef, personalWithLogin, { identities: [WORK, personalWithLogin] });
  assert.equal(result.ok, false);
  assert.match(result.message, /NOT changed to "Personal"; its previous lock is unchanged/);
  const status = await svc.getStatus(repoRef, [WORK, personalWithLogin]);
  assert.equal(status.assignment?.identityId, "work");
  assert.notEqual((await commitAs(repo, PERSONAL.gitEmail)).code, 0, "Work is still enforced");
});

// ==================== unlock ====================

test("UNLOCK removes the lock and restores a chained hook EXACTLY (bytes and mode); the repository is unassigned and unrestricted", async () => {
  const repo = await makeRepo();
  const hookPath = path.join(await hooksDir(repo), "pre-commit");
  const marker = path.join(repo.dir, "foreign-ran.txt");
  const foreign = `#!/bin/sh\n# user's hook — must survive byte-for-byte\necho ran > ${JSON.stringify(marker)}\nexit 0\n`;
  await fs.writeFile(hookPath, foreign, { mode: 0o750 });
  const originalMode = (await fs.stat(hookPath)).mode & 0o777;

  const svc = service();
  const repoRef = await ref(svc, repo);
  const assigned = await svc.assign(repoRef, WORK, { chainForeignHooks: true });
  assert.equal(assigned.ok, true, assigned.details.join(" | "));
  assert.equal(await exists(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), true);
  assert.equal((await commitAs(repo, WORK.gitEmail)).code, 0);
  assert.equal(await exists(marker), true, "the chained hook ran after the identity check passed");

  const unlocked = await svc.unlock(repoRef, [WORK]);
  assert.equal(unlocked.ok, true, unlocked.message);
  assert.equal(unlocked.message, 'This repository is no longer locked to "Work". Git is unrestricted here again.');
  assert.equal(unlocked.status?.enforcement.state, "unassigned");
  assert.equal(await fs.readFile(hookPath, "utf8"), foreign);
  if (process.platform !== "win32") assert.equal((await fs.stat(hookPath)).mode & 0o777, originalMode);
  assert.equal(await exists(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), false);
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard")), false, "no lock artifacts remain");
  assert.deepEqual(await nonSampleHookFiles(repo), ["pre-commit"]);
  const committed = await commitAs(repo, PERSONAL.gitEmail);
  assert.equal(committed.code, 0, committed.stderr);

  // Unlocking an unlocked repository is a harmless no-op.
  const again = await svc.unlock(repoRef, [WORK]);
  assert.equal(again.ok, true);
  assert.equal(again.message, "This repository is not locked.");
});

test("UNLOCK failure keeps the assignment — the repository never claims to be unlocked while a lock hook can still block", async () => {
  const repo = await makeRepo();
  class FailingDisable extends ShieldManager {
    override async disable(): Promise<never> {
      throw new Error("simulated I/O failure while removing hooks");
    }
  }
  const svc = service({ shield: new FailingDisable() });
  const repoRef = await ref(svc, repo);
  assert.equal((await svc.assign(repoRef, WORK)).ok, true);

  const result = await svc.unlock(repoRef, [WORK]);
  assert.equal(result.ok, false);
  assert.match(result.message, /Unlock could not finish \(simulated I\/O failure.*The repository is still locked/);
  assert.equal(result.status?.assignment?.identityId, "work");
  assert.equal(result.status?.enforcement.state, "active");
  assert.notEqual((await commitAs(repo, PERSONAL.gitEmail)).code, 0, "still enforced, exactly as reported");
});

// ==================== drift / repair ====================

test("DRIFT: an identity edited in settings shows needs-attention with repair; repair applies the edit", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  assert.equal((await svc.assign(repoRef, WORK)).ok, true);

  const edited: Identity = { ...WORK, gitEmail: "work-new@example.com" };
  const drifted = await svc.getStatus(repoRef, [edited]);
  assert.equal(drifted.enforcement.state, "needs_attention");
  assert.equal(drifted.enforcement.repairAvailable, true);
  assert.match(drifted.enforcement.reason ?? "", /gitEmail/);
  // Until repaired, the lock keeps enforcing what was assigned — never a silent change.
  assert.equal((await commitAs(repo, WORK.gitEmail)).code, 0);

  const repaired = await svc.repair(repoRef, [edited]);
  assert.equal(repaired.ok, true, repaired.details.join(" | "));
  assert.equal(repaired.status?.enforcement.state, "active");
  assert.notEqual((await commitAs(repo, WORK.gitEmail)).code, 0);
  assert.equal((await commitAs(repo, "work-new@example.com")).code, 0);
});

test("DRIFT: an assigned identity REMOVED from settings is needs-attention; repair refuses (never guesses), unlock still works", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  assert.equal((await svc.assign(repoRef, WORK)).ok, true);

  const status = await svc.getStatus(repoRef, [PERSONAL]);
  assert.equal(status.enforcement.state, "needs_attention");
  assert.equal(status.enforcement.repairAvailable, false);
  assert.equal(status.enforcement.unlockAvailable, true);
  assert.equal(status.assignmentView?.identityStillDefined, false);
  assert.equal(status.assignmentView?.gitEmail, WORK.gitEmail, "the enforced snapshot is still reported");

  const repair = await svc.repair(repoRef, [PERSONAL]);
  assert.equal(repair.ok, false);
  assert.match(repair.message, /no longer exists in settings/);
  assert.notEqual((await commitAs(repo, PERSONAL.gitEmail)).code, 0, "still enforcing the snapshot");

  assert.equal((await svc.unlock(repoRef, [PERSONAL])).ok, true);
});

test("REPAIR restores a deleted hook; repair of an unassigned repository refuses", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  const unassigned = await svc.repair(repoRef, [WORK]);
  assert.equal(unassigned.ok, false);
  assert.match(unassigned.message, /no identity assigned/);

  assert.equal((await svc.assign(repoRef, WORK)).ok, true);
  await fs.rm(path.join(await hooksDir(repo), "pre-commit"));
  const broken = await svc.getStatus(repoRef, [WORK]);
  assert.equal(broken.enforcement.state, "needs_attention");
  assert.equal(broken.enforcement.repairAvailable, true);

  const repaired = await svc.repair(repoRef, [WORK]);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.status?.enforcement.state, "active");
  assert.notEqual((await commitAs(repo, PERSONAL.gitEmail)).code, 0);
});

// ==================== legacy Shield migration ====================

const LEGACY_KEY = "github.com/acmesoftware/acme-frontend";

/**
 * A pre-identity-lock ("Shield Mode", artifact v5) installation, as an
 * older release left it: a v2 policy plus owned hooks that (like the real
 * v5 shims against a policy this build cannot evaluate) block every
 * commit and push.
 */
async function installLegacyShield(repo: Repo, options: { chainedOriginal?: string; policy?: Record<string, unknown> } = {}): Promise<void> {
  const storage = path.join(await commonDir(repo), "repo-identity-guard");
  await fs.mkdir(storage, { recursive: true });
  const policy = options.policy ?? {
    policyVersion: 2,
    generatedAt: 1,
    matchedProfileId: "work",
    profileLabel: "Work",
    expectedGitEmail: "work@example.com",
    trustedSshHostAliases: [],
    strictPushSetup: false,
    protectedBranches: ["main"],
    expectedBranchPatterns: [],
    enabledActions: ["commit", "push"],
    approvedRepositoryKey: LEGACY_KEY,
  };
  await fs.writeFile(path.join(storage, "shield-policy.json"), JSON.stringify(policy));
  await fs.writeFile(path.join(storage, "shield-evaluate.sh"), `#!/bin/sh\n# ${SHIELD_ARTIFACT_MARKER} v5 (evaluator)\necho 'Shield: [policy-corrupt] legacy' >&2\nexit 1\n`, { mode: 0o755 });
  const hooks = await hooksDir(repo);
  for (const name of ["pre-commit", "pre-merge-commit", "pre-push"]) {
    await fs.writeFile(path.join(hooks, name), `#!/bin/sh\n# ${SHIELD_ARTIFACT_MARKER} v5 (${name})\necho 'COMMIT BLOCKED (legacy Shield)' >&2\nexit 1\n`, { mode: 0o755 });
  }
  if (options.chainedOriginal !== undefined) {
    await fs.writeFile(path.join(hooks, `pre-commit${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), options.chainedOriginal, { mode: 0o755 });
  }
}

const LEGACY_WORK_PROFILE = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  exactRepos: ["github.com/AcmeSoftware/acme-frontend"],
};

test("LEGACY A: a provable exactRepos binding is migrated to an identity lock for that identity; a second run is a no-op", async () => {
  const repo = await makeRepo();
  await git(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
  await installLegacyShield(repo);
  const svc = service();
  const repoRef = await ref(svc, repo);

  const before = await svc.getStatus(repoRef, []);
  assert.equal(before.legacy, true);
  assert.equal(before.enforcement.state, "needs_attention");
  assert.notEqual((await commitAs(repo, WORK.gitEmail)).code, 0, "the legacy install blocks everything until migrated");

  const legacyProfiles = [LEGACY_WORK_PROFILE];
  const identities = identitiesFromLegacyProfiles(legacyProfiles).identities;
  const outcome = await svc.migrateLegacy(repoRef, { legacyProfiles, identities });
  assert.equal(outcome.kind, "migrated", JSON.stringify(outcome));
  assert.equal(outcome.kind === "migrated" && outcome.identityLabel, "Work");
  const status = await svc.getStatus(repoRef, identities);
  // The legacy profile declared no GitHub login: the migrated lock governs
  // commits AND pushes, so it is needs_attention (pushes blocked), never active.
  assert.equal(status.enforcement.state, "needs_attention");
  assert.equal(status.enforcement.push, "needs_configuration");
  assert.equal(status.enforcement.commitEnforced, true);
  assert.equal(status.assignment?.identityId, "work");
  assert.equal(status.inspection.hooks.find((h) => h.fileName === "pre-commit")?.version, SHIELD_ARTIFACT_VERSION);

  assert.equal((await commitAs(repo, WORK.gitEmail)).code, 0);
  const wrong = await commitAs(repo, PERSONAL.gitEmail);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /^REASON: wrong_identity$/m);

  const remoteParent = await tempDir("rig-lock-remote-");
  const bare = path.join(remoteParent, "remote.git");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  await git(repo, ["remote", "add", "local", bare]);
  const pushed = await tryGit(repo, ["push", "local", "main"]);
  assert.notEqual(pushed.code, 0);
  assert.equal(parseBlockPrelude(pushed.stderr).REASON, "push_identity_not_configured");

  assert.deepEqual(await svc.migrateLegacy(repoRef, { legacyProfiles, identities }), { kind: "none" }, "idempotent");
});

test("LEGACY B: an owner-pattern-only legacy install is REMOVED (chained hook restored exactly); the repository ends unassigned and unrestricted", async () => {
  const repo = await makeRepo();
  await git(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
  const original = "#!/bin/sh\n# the user's pre-existing hook\nexit 0\n";
  await installLegacyShield(repo, { chainedOriginal: original });
  const svc = service();
  const repoRef = await ref(svc, repo);
  const legacyProfiles = [{ ...LEGACY_WORK_PROFILE, exactRepos: undefined, expectedRemoteOwners: ["AcmeSoftware"] }];
  const identities = identitiesFromLegacyProfiles(legacyProfiles).identities;

  const outcome = await svc.migrateLegacy(repoRef, { legacyProfiles, identities });
  assert.equal(outcome.kind, "removed", JSON.stringify(outcome));
  assert.match(outcome.kind === "removed" ? outcome.message : "", /owner-pattern matches are never migrated/);
  const status = await svc.getStatus(repoRef, identities);
  assert.equal(status.enforcement.state, "unassigned");
  assert.equal(status.legacy, false);

  const hooks = await hooksDir(repo);
  assert.equal(await fs.readFile(path.join(hooks, "pre-commit"), "utf8"), original);
  assert.deepEqual(await nonSampleHookFiles(repo), ["pre-commit"]);
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard")), false);
  const committed = await commitAs(repo, PERSONAL.gitEmail);
  assert.equal(committed.code, 0, committed.stderr);

  assert.deepEqual(await svc.migrateLegacy(repoRef, { legacyProfiles, identities }), { kind: "none" }, "idempotent");
});

test("LEGACY B: an unreadable legacy policy, or one whose repository no longer matches origin, is removed — never guessed", async () => {
  for (const variant of ["corrupt-policy", "origin-changed"] as const) {
    const repo = await makeRepo();
    await git(repo, ["remote", "add", "origin", variant === "origin-changed" ? "git@github.com:AcmeSoftware/other.git" : "git@github.com:AcmeSoftware/acme-frontend.git"]);
    await installLegacyShield(repo);
    if (variant === "corrupt-policy") {
      await fs.writeFile(path.join(await commonDir(repo), "repo-identity-guard", "shield-policy.json"), "{ not json");
    }
    const svc = service();
    const repoRef = await ref(svc, repo);
    const legacyProfiles = [LEGACY_WORK_PROFILE];
    const outcome = await svc.migrateLegacy(repoRef, { legacyProfiles, identities: identitiesFromLegacyProfiles(legacyProfiles).identities });
    assert.equal(outcome.kind, "removed", `${variant}: ${JSON.stringify(outcome)}`);
    assert.equal((await svc.getStatus(repoRef, [])).enforcement.state, "unassigned", variant);
    assert.equal((await commitAs(repo, PERSONAL.gitEmail)).code, 0, variant);
  }
});

test("LEGACY: a legacy install can be unlocked explicitly too", async () => {
  const repo = await makeRepo();
  await installLegacyShield(repo);
  const svc = service();
  const repoRef = await ref(svc, repo);
  const result = await svc.unlock(repoRef, []);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /legacy Repo Identity Guard installation was removed/);
  assert.equal(result.status?.enforcement.state, "unassigned");
});

// ---- the REAL 0.2.0 artifacts ----
//
// src/test/fixtures/legacy-shield-v5/ holds the exact pre-commit / pre-push
// hooks and shield-evaluate.sh that release 0.2.0 (commit 981e252)
// installed — generated from that commit's own sources, byte-for-byte. A
// legacy repository built from them really enforces the OLD Shield policy
// (protected branches, destination approval, ...), which is what makes the
// before/after assertions below meaningful.

const LEGACY_FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "legacy-shield-v5");

async function installRealLegacyShield(repo: Repo, options: { chainedOriginal?: string; matchedProfileId?: string } = {}): Promise<void> {
  const storage = path.join(await commonDir(repo), "repo-identity-guard");
  await fs.mkdir(storage, { recursive: true });
  await fs.copyFile(path.join(LEGACY_FIXTURES, "shield-evaluate.sh"), path.join(storage, "shield-evaluate.sh"));
  await fs.chmod(path.join(storage, "shield-evaluate.sh"), 0o755);
  await fs.writeFile(
    path.join(storage, "shield-policy.json"),
    JSON.stringify(
      {
        policyVersion: 2,
        generatedAt: 1,
        matchedProfileId: options.matchedProfileId ?? "work",
        profileLabel: "Work",
        expectedGitName: WORK.gitName,
        expectedGitEmail: WORK.gitEmail,
        approvedRepositoryKey: LEGACY_KEY,
        approvedPushDestination: { host: "github.com", owner: "acmesoftware", repo: "acme-frontend", canonicalHost: "github.com", canonicalPort: "22" },
        trustedSshHostAliases: [],
        strictPushSetup: false,
        protectedBranches: ["main"],
        expectedBranchPatterns: [],
        enabledActions: ["commit", "push"],
      },
      null,
      2,
    ),
  );
  const hooks = await hooksDir(repo);
  for (const [name, fixture] of [
    ["pre-commit", "pre-commit"],
    ["pre-merge-commit", "pre-commit"],
    ["pre-push", "pre-push"],
  ]) {
    await fs.copyFile(path.join(LEGACY_FIXTURES, fixture), path.join(hooks, name));
    await fs.chmod(path.join(hooks, name), 0o755);
  }
  if (options.chainedOriginal !== undefined) {
    await fs.writeFile(path.join(hooks, `pre-commit${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), options.chainedOriginal, { mode: 0o755 });
  }
}

test("REAL 0.2.0 LEGACY, binding provable: the old protected-branch rule stops applying; the repository is locked to the bound identity instead", async () => {
  const repo = await makeRepo();
  await git(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
  await installRealLegacyShield(repo);
  const svc = service();
  const repoRef = await ref(svc, repo);

  // Before: the real 0.2.0 hooks enforce the old policy — even the RIGHT
  // identity cannot commit on the protected branch "main".
  const before = await commitAs(repo, WORK.gitEmail);
  assert.notEqual(before.code, 0);
  assert.match(before.stderr, /protected-branch/);

  const legacyProfiles = [LEGACY_WORK_PROFILE];
  const identities = identitiesFromLegacyProfiles(legacyProfiles).identities;
  const outcome = await svc.migrateLegacy(repoRef, { legacyProfiles, identities });
  assert.equal(outcome.kind, "migrated", JSON.stringify(outcome));

  const allowed = await commitAs(repo, WORK.gitEmail);
  assert.equal(allowed.code, 0, `branch policy must be gone: ${allowed.stderr}`);
  const blocked = await commitAs(repo, PERSONAL.gitEmail);
  assert.notEqual(blocked.code, 0);
  assert.equal(parseBlockPrelude(blocked.stderr).REASON, "wrong_identity");
});

test("REAL 0.2.0 LEGACY, owner pattern only: removed completely, the user's chained hook restored, Git unrestricted", async () => {
  const repo = await makeRepo();
  await git(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
  const original = "#!/bin/sh\n# pre-existing hook the user had before enabling Shield\nexit 0\n";
  await installRealLegacyShield(repo, { chainedOriginal: original });
  const svc = service();
  const repoRef = await ref(svc, repo);
  const legacyProfiles = [{ id: "work", label: "Work", gitName: WORK.gitName, gitEmail: WORK.gitEmail, expectedRemoteOwners: ["AcmeSoftware"] }];

  const outcome = await svc.migrateLegacy(repoRef, { legacyProfiles, identities: identitiesFromLegacyProfiles(legacyProfiles).identities });
  assert.equal(outcome.kind, "removed", JSON.stringify(outcome));
  assert.equal((await svc.getStatus(repoRef, [WORK])).enforcement.state, "unassigned");
  assert.equal(await fs.readFile(path.join(await hooksDir(repo), "pre-commit"), "utf8"), original);
  assert.deepEqual(await nonSampleHookFiles(repo), ["pre-commit"]);
  assert.equal(await exists(path.join(await commonDir(repo), "repo-identity-guard")), false);
  // Protected branch, wrong identity: nothing restricts Git any more.
  const committed = await commitAs(repo, PERSONAL.gitEmail);
  assert.equal(committed.code, 0, committed.stderr);
});

// ==================== v3 (release 0.3.0) locks are upgraded in place ====================
//
// src/test/fixtures/identity-lock-v6/ holds the exact pre-commit / pre-push
// hooks and shield-evaluate.sh that release 0.3.0 (commit 1acdacd) installed
// for an identity lock — generated from that commit's own sources,
// byte-for-byte. With a v3 policy for an identity that had no GitHub login
// ("commit-only"), that evaluator let EVERY push through unchecked: the bug
// this upgrade closes.

const V6_LOCK_FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "identity-lock-v6");

function v3PolicyFor(identity: Identity, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const policy: Record<string, unknown> = {
    policyVersion: 3,
    lockId: "lock-from-0.3.0",
    assignedAt: 1_600_000_000_000,
    generatedAt: 1_600_000_000_000,
    identityId: identity.id,
    identityLabel: identity.label,
    expectedGitEmail: identity.gitEmail,
    trustedSshHostAliases: identity.trustedSshHostAliases ?? [],
    enforcedActions: identity.expectedGitHubLogin ? ["commit", "push"] : ["commit"],
    ...overrides,
  };
  if (identity.gitName) policy.expectedGitName = identity.gitName;
  if (identity.expectedGitHubLogin) policy.expectedGitHubLogin = identity.expectedGitHubLogin;
  return policy;
}

/** Installs a lock exactly as release 0.3.0 left it: v3 policy, v6 evaluator, v6 hooks, and an install record naming the hooks dir. */
async function installV3Lock(repo: Repo, identity: Identity, options: { skipPrePush?: boolean } = {}): Promise<void> {
  const storage = path.join(await commonDir(repo), "repo-identity-guard");
  await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, "shield-policy.json"), JSON.stringify(v3PolicyFor(identity), null, 2));
  await fs.copyFile(path.join(V6_LOCK_FIXTURES, "shield-evaluate.sh"), path.join(storage, "shield-evaluate.sh"));
  await fs.chmod(path.join(storage, "shield-evaluate.sh"), 0o755);
  const hooks = await hooksDir(repo);
  await fs.mkdir(hooks, { recursive: true });
  for (const [name, fixture] of [
    ["pre-commit", "pre-commit"],
    ["pre-merge-commit", "pre-commit"],
    ["pre-push", "pre-push"],
  ] as const) {
    if (name === "pre-push" && options.skipPrePush) continue;
    await fs.copyFile(path.join(V6_LOCK_FIXTURES, fixture), path.join(hooks, name));
    await fs.chmod(path.join(hooks, name), 0o755);
  }
  assert.equal(await writeShieldInstallRecord(shieldInstallRecordFilePath(storage), [hooks], 1_600_000_000_000), true);
}

async function bareRemote(): Promise<string> {
  const bare = path.join(await tempDir("rig-lock-remote-"), "remote.git");
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  return bare;
}

test("MIGRATION (real 0.3.0 artifacts): a commit-only v3 lock stays assigned and commit-enforced, but its pushes become BLOCKED until a GitHub login is configured", async () => {
  const repo = await makeRepo();
  const bare = await bareRemote();
  await git(repo, ["remote", "add", "origin", bare]);
  await installV3Lock(repo, WORK_NO_LOGIN);
  const svc = service();
  const repoRef = await ref(svc, repo);

  // Before: the real 0.3.0 evaluator enforces commits but lets the push through unchecked — the bug.
  assert.notEqual((await commitAs(repo, PERSONAL.gitEmail)).code, 0, "0.3.0 enforced commits");
  assert.equal((await commitAs(repo, WORK_NO_LOGIN.gitEmail)).code, 0);
  const unchecked = await tryGit(repo, ["push", "-q", "origin", "main"]);
  assert.equal(unchecked.code, 0, `the 0.3.0 artifacts really did allow it: ${unchecked.stderr}`);

  // Passive status: still ASSIGNED (never unassigned, never "legacy"), but needs attention — not active.
  const before = await svc.getStatus(repoRef, [WORK_NO_LOGIN]);
  assert.equal(before.legacy, false, "a v3 identity lock is not a legacy Shield installation — it is never removed");
  assert.equal(before.inspection.policyNeedsUpgrade, true);
  assert.equal(before.assignment?.identityId, "work");
  assert.equal(before.assignment?.assignedAt, 1_600_000_000_000);
  assert.equal(before.enforcement.state, "needs_attention");
  assert.equal(before.enforcement.push, "needs_configuration");
  assert.equal(before.enforcement.repairAvailable, true);
  assert.match(before.enforcement.reason ?? "", /earlier version.*upgraded.*every push from this repository is blocked/);
  // Legacy-Shield migration never touches it.
  assert.deepEqual(await svc.migrateLegacy(repoRef, { legacyProfiles: [], identities: [WORK_NO_LOGIN] }), { kind: "none" });

  // Upgrade (what a trusted-workspace scan runs).
  const upgraded = await svc.upgradePreviousLock(repoRef, { identities: [WORK_NO_LOGIN] });
  assert.equal(upgraded.kind, "upgraded", JSON.stringify(upgraded));
  assert.ok(upgraded.kind === "upgraded");
  assert.match(upgraded.message, /still assigned and commits are still checked/);
  assert.match(upgraded.message, /every push from this repository is blocked/);
  const policy = parseShieldPolicy(await fs.readFile(path.join(await commonDir(repo), "repo-identity-guard", "shield-policy.json"), "utf8"));
  assert.ok(policy.ok, "the policy is now a valid v4 policy");
  assert.equal(policy.policy.policyVersion, 4);
  assert.equal(policy.policy.lockId, "lock-from-0.3.0", "same assignment: lockId kept");
  assert.equal(policy.policy.assignedAt, 1_600_000_000_000, "same assignment: assignedAt kept");
  assert.equal(policy.policy.expectedGitHubLogin, undefined, "a login is never guessed");

  const after = await svc.getStatus(repoRef, [WORK_NO_LOGIN]);
  assert.equal(after.inspection.policyNeedsUpgrade, false);
  assert.equal(after.assignment?.identityId, "work");
  assert.equal(after.enforcement.state, "needs_attention");
  assert.equal(after.enforcement.push, "needs_configuration");
  assert.equal(after.enforcement.commitEnforced, true);
  for (const hook of after.inspection.hooks) assert.equal(hook.version, SHIELD_ARTIFACT_VERSION, hook.fileName);

  // Commits: unchanged. Pushes: now fail-closed.
  assert.equal((await commitAs(repo, WORK_NO_LOGIN.gitEmail)).code, 0);
  const wrong = await commitAs(repo, PERSONAL.gitEmail);
  assert.notEqual(wrong.code, 0);
  assert.equal(parseBlockPrelude(wrong.stderr).REASON, "wrong_identity");
  await commitAs(repo, WORK_NO_LOGIN.gitEmail);
  const pushed = await tryGit(repo, ["push", "origin", "main"]);
  assert.notEqual(pushed.code, 0, "a migrated commit-only lock must block the push");
  assert.equal(parseBlockPrelude(pushed.stderr).REASON, "push_identity_not_configured");

  assert.deepEqual(await svc.upgradePreviousLock(repoRef, { identities: [WORK_NO_LOGIN] }), { kind: "none" }, "idempotent");
});

test("MIGRATION: a v3 lock is upgraded from its RECORDED snapshot — even when its identity was since removed from settings — and a v3 lock with a login becomes active", async () => {
  const removedRepo = await makeRepo();
  await installV3Lock(removedRepo, WORK_NO_LOGIN);
  const svc = service();
  const removedRef = await ref(svc, removedRepo);
  const stillShown = await svc.getStatus(removedRef, []);
  assert.equal(stillShown.assignmentView?.identityStillDefined, false);
  assert.equal(stillShown.enforcement.repairAvailable, true, "an upgrade needs no live identity");
  const repaired = await svc.repair(removedRef, []);
  assert.equal(repaired.ok, true, `${repaired.message} ${repaired.details.join(" | ")}`);
  assert.equal(repaired.status?.assignment?.identityId, "work");
  assert.equal(repaired.status?.enforcement.push, "needs_configuration");
  assert.notEqual((await commitAs(removedRepo, PERSONAL.gitEmail)).code, 0, "still enforcing the recorded identity");

  const completeRepo = await makeRepo();
  await installV3Lock(completeRepo, WORK);
  const completeRef = await ref(svc, completeRepo);
  const outcome = await svc.upgradePreviousLock(completeRef, { identities: [WORK] });
  assert.equal(outcome.kind, "upgraded", JSON.stringify(outcome));
  const status = await svc.getStatus(completeRef, [WORK]);
  assert.equal(status.enforcement.state, "active");
  assert.equal(status.enforcement.push, "enforced");
  assert.equal(status.inspection.policySnapshot?.expectedGitHubLogin, "danish-work");
});

test("MIGRATION: a v3 commit-only lock whose pre-push slot holds a FOREIGN hook is never silently chained — the upgrade is refused and the lock left as it was (needs attention); Repair with chaining completes it", async () => {
  const repo = await makeRepo();
  await installV3Lock(repo, WORK_NO_LOGIN, { skipPrePush: true });
  const foreign = "#!/bin/sh\n# the user's own pre-push hook, left alone by the 0.3.0 commit-only lock\nexit 0\n";
  const prePush = path.join(await hooksDir(repo), "pre-push");
  await fs.writeFile(prePush, foreign, { mode: 0o755 });
  const svc = service();
  const repoRef = await ref(svc, repo);

  const failed = await svc.upgradePreviousLock(repoRef, { identities: [WORK_NO_LOGIN] });
  assert.equal(failed.kind, "failed", JSON.stringify(failed));
  assert.equal(await fs.readFile(prePush, "utf8"), foreign, "the foreign hook is untouched");
  const status = await svc.getStatus(repoRef, [WORK_NO_LOGIN]);
  assert.equal(status.assignment?.identityId, "work", "still assigned");
  assert.equal(status.inspection.policyNeedsUpgrade, true, "left exactly as it was");
  assert.equal(status.enforcement.state, "needs_attention");

  const repaired = await svc.repair(repoRef, [WORK_NO_LOGIN], { chainForeignHooks: true });
  assert.equal(repaired.ok, true, `${repaired.message} ${repaired.details.join(" | ")}`);
  assert.equal(await fs.readFile(`${prePush}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`, "utf8"), foreign, "chained, byte-for-byte");
  const bare = await bareRemote();
  await git(repo, ["remote", "add", "origin", bare]);
  const pushed = await tryGit(repo, ["push", "origin", "main"]);
  assert.notEqual(pushed.code, 0);
  assert.equal(parseBlockPrelude(pushed.stderr).REASON, "push_identity_not_configured");
});

// ==================== the invariant, stated directly ====================

test("NO PATH: an assigned repository whose push identity is unconfigured or unverifiable NEVER allows a push, and is NEVER reported active", async () => {
  // Every way an assigned identity's push requirement can be incomplete,
  // plus the complete identity as the control that proves the harness CAN
  // allow a push (so a "blocked" below is a real decision, not a broken rig).
  const variants: Array<{ name: string; identity: Identity; complete: boolean }> = [
    { name: "complete (control)", identity: WORK, complete: true },
    { name: "no GitHub login", identity: WORK_NO_LOGIN, complete: false },
    { name: "no GitHub login, no alias", identity: { ...WORK_NO_LOGIN, trustedSshHostAliases: undefined }, complete: false },
    { name: "login but no trusted alias", identity: { ...WORK, trustedSshHostAliases: undefined }, complete: false },
    { name: "empty login", identity: { ...WORK, expectedGitHubLogin: "" }, complete: false },
  ];
  // The single route on which a complete identity's push IS allowed: its
  // trusted alias, authenticating live as exactly the expected login.
  const allowedRoute = "git@github-work:AcmeSoftware/acme.git";
  const routes = [allowedRoute, "git@github.com:AcmeSoftware/acme.git", "https://github.com/AcmeSoftware/acme.git", "/srv/git/acme.git", "git@github-personal:AcmeSoftware/acme.git"];
  const fakeSsh = await makeRouteFakeSsh();
  tempDirs.push(fakeSsh);
  const svc = service();

  for (const variant of variants) {
    for (const via of ["assigned", "migrated from v3"] as const) {
      const repo = await makeRepo();
      const repoRef = await ref(svc, repo);
      if (via === "assigned") {
        const assigned = await svc.assign(repoRef, variant.identity, { identities: [variant.identity] });
        assert.equal(assigned.ok, true, `${variant.name}: ${assigned.message} ${assigned.details.join(" | ")}`);
      } else {
        await installV3Lock(repo, variant.identity);
        const upgraded = await svc.upgradePreviousLock(repoRef, { identities: [variant.identity] });
        assert.equal(upgraded.kind, "upgraded", `${variant.name}: ${JSON.stringify(upgraded)}`);
      }
      const where = `${variant.name} (${via})`;

      const status = await svc.getStatus(repoRef, [variant.identity]);
      assert.ok(status.assignment, `${where}: assigned`);
      assert.equal(status.enforcement.commitEnforced, true, `${where}: commits are enforced`);
      if (!variant.complete) {
        assert.notEqual(status.enforcement.push, "enforced", where);
        assert.notEqual(status.enforcement.state, "active", `${where}: an incomplete push requirement must never be reported active`);
        assert.equal(status.enforcement.state, "needs_attention", where);
      } else {
        assert.equal(status.enforcement.state, "active", where);
      }

      // The INSTALLED evaluator — the real enforcement point with VS Code
      // closed — over every route, with ssh answering as the right account.
      const installedEvaluator = path.join(await commonDir(repo), "repo-identity-guard", "shield-evaluate.sh");
      for (const url of routes) {
        const result = await runEvaluatorScript(repo.dir, repo.env, fakeSsh, installedEvaluator, ["push", "origin", url], {
          FAKE_SSH_AUTH_OUTPUT: AUTHENTICATED_AS("danish-work"),
        });
        const expectAllowed = variant.complete && url === allowedRoute;
        if (expectAllowed) {
          assert.equal(result.code, 0, `${where} via ${url}: the control must be allowed: ${result.stderr}`);
        } else {
          assert.notEqual(result.code, 0, `${where} via ${url}: an assigned repository let a push through`);
          assert.match(result.stderr, /^REPO_IDENTITY_GUARD_BLOCK$/m, `${where} via ${url}`);
        }
        if (!variant.complete) {
          const reasonId = parseBlockPrelude(result.stderr).REASON_ID;
          assert.ok(
            reasonId === "push-identity-not-configured" || reasonId === "push-route-unverified",
            `${where} via ${url}: blocked for the incomplete push identity, not some other reason (got ${reasonId})`,
          );
        }
      }

      // And through a real `git push` with the installed pre-push hook.
      const bare = await bareRemote();
      await git(repo, ["remote", "add", "origin", bare]);
      const pushed = await tryGit(repo, ["push", "origin", "main"]);
      assert.notEqual(pushed.code, 0, `${where}: a real git push got through`);
      const remoteHead = await execFileAsync("git", ["--git-dir", bare, "rev-parse", "--verify", "refs/heads/main"]).catch(() => null);
      assert.equal(remoteHead, null, `${where}: nothing may reach the remote`);
    }
  }
});

// ==================== passive status performs no network I/O ====================

test("PERFORMANCE: getStatus never invokes ssh, even for a push-enforcing lock", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
  assert.equal((await svc.assign(repoRef, identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: ["github-work"] }))).ok, true);

  const binDir = await tempDir("rig-lock-nossh-");
  const log = path.join(binDir, "ssh-invocations.log");
  await fs.writeFile(path.join(binDir, "ssh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    for (let i = 0; i < 3; i += 1) await svc.getStatus(repoRef, [WORK]);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(await exists(log), false, "a passive status refresh must never run ssh");
});
