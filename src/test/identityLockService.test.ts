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
import { ShieldManager } from "../shield/manager";
import { parseShieldPolicy } from "../shield/policy";
import { EVALUATOR_SOURCE, WORK_IDENTITY, identityWith, parseBlockPrelude } from "./testUtil/lockFixtures";

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
 *  - legacy Shield installations are migrated conservatively.
 */

const execFileAsync = promisify(execFile);

const WORK = WORK_IDENTITY;
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
  assert.match(assigned.details.join(" "), /declares no GitHub login, so pushes are not account-checked/);
  assert.equal(assigned.status?.enforcement.state, "active");
  assert.equal(assigned.status?.enforcement.commitEnforced, true);
  assert.equal(assigned.status?.enforcement.push, "not_configured");
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

test("ASSIGN: a login without any trusted alias is reported as needs-attention (every push would be blocked)", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await ref(svc, repo);
  const noAlias = identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: [] });
  const assigned = await svc.assign(repoRef, noAlias);
  assert.equal(assigned.ok, true);
  assert.match(assigned.details.join(" "), /every push from this repository will be blocked/);
  assert.equal(assigned.status?.enforcement.state, "needs_attention");
  assert.equal(assigned.status?.enforcement.push, "unverifiable");
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

  // A foreign pre-push hook takes over the (commit-only) Work lock's
  // ungoverned pre-push slot. Changing to an identity WITH a GitHub login
  // needs that slot, and chaining was not requested — so the change must
  // be refused up front, leaving Work's lock exactly as it was.
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
  assert.equal(status.enforcement.state, "active");
  assert.equal(status.assignment?.identityId, "work");
  assert.equal(status.inspection.hooks.find((h) => h.fileName === "pre-commit")?.version, SHIELD_ARTIFACT_VERSION);

  assert.equal((await commitAs(repo, WORK.gitEmail)).code, 0);
  const wrong = await commitAs(repo, PERSONAL.gitEmail);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /^REASON: wrong_identity$/m);

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
