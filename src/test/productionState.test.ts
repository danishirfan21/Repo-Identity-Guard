import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { checkEffectiveIdentity } from "../identity/effectiveIdentityCheck";
import { IdentityLockService } from "../identity/identityLockService";
import { Identity } from "../identity/types";
import { RepoIdentityUiState, buildIdentitySummary, buildRepoIdentityUiState } from "../ui/productionState";
import { EVALUATOR_SOURCE, WORK_IDENTITY, WORK_IDENTITY_WITH_LOGIN } from "./testUtil/lockFixtures";

/**
 * `buildRepoIdentityUiState` against a real `IdentityLockService` and real
 * temporary Git repositories — the lock-state matrix from the task spec's
 * "TESTS" section, exercised end to end rather than against hand-built
 * `LockStatus` fixtures (which would risk testing the mapper's own
 * assumptions about `ShieldInspection` rather than reality).
 */

const execFileAsync = promisify(execFile);
const WORK = WORK_IDENTITY_WITH_LOGIN;
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
  return { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

async function makeRepo(): Promise<Repo> {
  const dir = await tempDir("rig-uistate-");
  const repo: Repo = { dir, env: envFor(dir) };
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", WORK.gitName!]);
  await git(repo, ["config", "user.email", WORK.gitEmail]);
  await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
  await git(repo, ["add", "f.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function service(): IdentityLockService {
  return new IdentityLockService({ evaluatorScriptSource: EVALUATOR_SOURCE, now: () => 1_700_000_000_000 });
}

async function hooksDir(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

test("UNASSIGNED repository -> lock.state 'unassigned'", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const status = await svc.getStatus(repoRef, [WORK]);
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK], notes: [], isWorkspaceTrusted: true, repo: { id: repo.dir, name: "x" } });
  assert.equal(ui.lock.state, "unassigned");
});

test("assigned + fully installed + push enforced + effective identity correct -> lock.state 'locked'", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const assigned = await svc.assign(repoRef, WORK, { identities: [WORK] });
  assert.equal(assigned.ok, true, assigned.message);
  const status = assigned.status!;
  const passive = await checkEffectiveIdentity(repo.dir, { gitEmail: WORK.gitEmail, gitName: WORK.gitName });
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK], passiveIdentityCheck: passive, notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "locked");
  if (ui.lock.state === "locked") {
    assert.equal(ui.lock.identity.id, "work");
    assert.equal(ui.lock.identity.complete, true);
    assert.deepEqual(ui.lock.identity.sshAliases, WORK.trustedSshHostAliases);
  }
});

test("assigned + fully installed, but the EFFECTIVE (local) Git identity is wrong -> 'needs_attention' / git_identity_mismatch, never falsely 'locked'", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const assigned = await svc.assign(repoRef, WORK, { identities: [WORK] });
  assert.equal(assigned.ok, true, assigned.message);
  // Drift the LOCAL config away from the assigned identity after the lock
  // was installed (e.g. a stray `git config user.email` by hand).
  await git(repo, ["config", "user.email", "someone-else@example.com"]);
  const status = await svc.getStatus(repoRef, [WORK]);
  const passive = await checkEffectiveIdentity(repo.dir, { gitEmail: WORK.gitEmail, gitName: WORK.gitName });
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK], passiveIdentityCheck: passive, notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "needs_attention");
  if (ui.lock.state === "needs_attention") {
    assert.equal(ui.lock.cause, "git_identity_mismatch");
    assert.equal(ui.lock.detail?.effectiveGitEmail, "someone-else@example.com");
    assert.equal(ui.lock.detail?.expectedGitEmail, WORK.gitEmail);
  }
});

test("wrong COMMITTER only (author correct) -> still 'needs_attention' / git_identity_mismatch", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const assigned = await svc.assign(repoRef, WORK, { identities: [WORK] });
  assert.equal(assigned.ok, true, assigned.message);
  const saved = { GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL, GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME };
  process.env.GIT_COMMITTER_EMAIL = "different-committer@example.com";
  process.env.GIT_COMMITTER_NAME = "Different Committer";
  try {
    const status = await svc.getStatus(repoRef, [WORK]);
    const passive = await checkEffectiveIdentity(repo.dir, { gitEmail: WORK.gitEmail, gitName: WORK.gitName });
    const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK], passiveIdentityCheck: passive, notes: [], isWorkspaceTrusted: true });
    assert.equal(ui.lock.state, "needs_attention");
    if (ui.lock.state === "needs_attention") {
      assert.equal(ui.lock.cause, "git_identity_mismatch");
      assert.equal(ui.lock.detail?.violatingRole, "committer");
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("push incomplete (no GitHub login) -> 'needs_attention' / push_identity_incomplete, with structured missing fields — never 'repair'", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const assigned = await svc.assign(repoRef, WORK_NO_LOGIN, { identities: [WORK_NO_LOGIN] });
  assert.equal(assigned.ok, true, assigned.message);
  const status = assigned.status!;
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK_NO_LOGIN], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "needs_attention");
  if (ui.lock.state === "needs_attention") {
    assert.equal(ui.lock.cause, "push_identity_incomplete");
    assert.equal(ui.lock.detail?.missingGitHubUsername, true);
    assert.equal(ui.lock.detail?.missingSshProfile, false);
  }
});

test("push unverifiable (login set, no trusted SSH alias) -> 'needs_attention' / push_identity_unverifiable", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const unverifiable: Identity = { ...WORK, trustedSshHostAliases: undefined };
  const assigned = await svc.assign(repoRef, unverifiable, { identities: [unverifiable] });
  assert.equal(assigned.ok, true, assigned.message);
  const ui = buildRepoIdentityUiState({ status: assigned.status!, liveIdentities: [unverifiable], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "needs_attention");
  if (ui.lock.state === "needs_attention") {
    assert.equal(ui.lock.cause, "push_identity_unverifiable");
    assert.equal(ui.lock.detail?.missingGitHubUsername, false);
    assert.equal(ui.lock.detail?.missingSshProfile, true);
  }
});

test("enforcement broken (hook file corrupted outside the extension) -> lock.state 'repair', never 'needs_attention'", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const assigned = await svc.assign(repoRef, WORK, { identities: [WORK] });
  assert.equal(assigned.ok, true, assigned.message);
  const preCommit = path.join(await hooksDir(repo), "pre-commit");
  await fs.appendFile(preCommit, "\n# hand-edited\n");
  const status = await svc.getStatus(repoRef, [WORK]);
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "repair");
  if (ui.lock.state === "repair") {
    assert.equal(ui.lock.identity?.id, "work");
    assert.equal(ui.lock.detail?.repairAvailable, true);
    assert.ok(ui.lock.detail!.reasons.length > 0);
  }
});

test("assigned identity removed from settings -> 'needs_attention' / identity_missing, even though artifacts are degraded — never 'repair'", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const assigned = await svc.assign(repoRef, WORK, { identities: [WORK] });
  assert.equal(assigned.ok, true, assigned.message);
  // The identity no longer exists in the LIVE list (deleted in settings).
  const status = await svc.getStatus(repoRef, []);
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "needs_attention");
  if (ui.lock.state === "needs_attention") {
    assert.equal(ui.lock.cause, "identity_missing");
    assert.equal(ui.lock.identity?.id, "work", "the lock's own recorded snapshot still names which identity is missing");
  }
});

test("no repository open -> lock.state 'unassigned' and repo is undefined", () => {
  const ui: RepoIdentityUiState = buildRepoIdentityUiState({ liveIdentities: [PERSONAL], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "unassigned");
  assert.equal(ui.repo, undefined);
});

// ==================== status inspection failure (see "STATUS INSPECTION FAILURE") ====================

test("STATUS INSPECTION FAILURE 1/3: no repo at all (status undefined, repo also undefined) -> lock.state 'unassigned', repo undefined (unchanged no-repository behavior)", () => {
  const ui = buildRepoIdentityUiState({ liveIdentities: [PERSONAL], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.lock.state, "unassigned");
  assert.equal(ui.repo, undefined);
});

test("STATUS INSPECTION FAILURE 2/3: a real repo with a genuine unassigned LockStatus -> lock.state 'unassigned' (unchanged)", async () => {
  const repo = await makeRepo();
  const svc = service();
  const repoRef = await svc.resolveRepository(repo.dir);
  assert.ok(repoRef);
  const status = await svc.getStatus(repoRef, [WORK]);
  const ui = buildRepoIdentityUiState({ status, liveIdentities: [WORK], notes: [], isWorkspaceTrusted: true, repo: { id: repo.dir, name: "x" } });
  assert.equal(ui.lock.state, "unassigned");
  assert.ok(ui.repo, "a genuinely unassigned repository still carries its repo identity");
});

test("STATUS INSPECTION FAILURE 3/3: repo IS present but status is undefined (inspection threw, e.g. scan()'s getStatus failed) -> NEVER 'unassigned' — a needs_attention/inspection_failed state instead, with no claim of lock/unlock state", () => {
  const ui = buildRepoIdentityUiState({
    repo: { id: "repo-1", name: "acme" },
    status: undefined,
    liveIdentities: [PERSONAL],
    notes: [],
    isWorkspaceTrusted: true,
  });
  assert.notEqual(ui.lock.state, "unassigned", "inspection failing must never be reported as 'unassigned' — it proves nothing about whether an identity is locked");
  assert.equal(ui.lock.state, "needs_attention");
  assert.ok(ui.repo, "the repository is still named — this is not the no-repository case");
  if (ui.lock.state === "needs_attention") {
    assert.equal(ui.lock.cause, "inspection_failed");
    assert.equal(ui.lock.repairAvailable, false, "repair is never implied by an inspection failure alone");
    assert.equal(ui.lock.identity, undefined);
  }
  // The UI-facing DTO must never use "unassigned"/"unrestricted" wording for this case — asserted structurally
  // (the DTO carries no free-text copy at all, only the `cause` enum the webview branches on), and the webview's
  // own rendering of this cause is covered separately in productionWebview.test.ts.
  const serialized = JSON.stringify(ui).toLowerCase();
  assert.equal(serialized.includes("unrestricted"), false);
  assert.equal(/"state":"unassigned"/.test(serialized), false);
});

test("identities list never leaks Shield internals, and incomplete identities are still listed with missing-field flags", () => {
  const ui = buildRepoIdentityUiState({ liveIdentities: [WORK_NO_LOGIN, PERSONAL], notes: [], isWorkspaceTrusted: true });
  assert.equal(ui.identities.length, 2);
  const personal = ui.identities.find((i) => i.id === "personal")!;
  assert.equal(personal.complete, false);
  assert.equal(personal.missingGithubUsername, true);
  assert.equal(personal.missingSshProfile, true);
  for (const identity of ui.identities) {
    assert.ok(!("expectedGitHubLogin" in identity), "the UI DTO must use product field names, not raw Identity field names");
  }
});

test("buildIdentitySummary: multiple SSH aliases are never truncated to one", () => {
  const identity: Identity = { id: "x", label: "X", gitEmail: "x@example.com", trustedSshHostAliases: ["a", "b", "c"] };
  const summary = buildIdentitySummary(identity);
  assert.deepEqual(summary.sshAliases, ["a", "b", "c"]);
});

test("notes: full text is preserved (no backend truncation) and the DTO shape matches NoteUiModel exactly", () => {
  const longText = "x".repeat(5000);
  const ui = buildRepoIdentityUiState({
    liveIdentities: [],
    notes: [{ id: "n1", text: longText, pinned: true, createdAt: 1, updatedAt: 2 }],
    isWorkspaceTrusted: true,
  });
  assert.equal(ui.notes[0].text.length, 5000);
  assert.deepEqual(ui.notes[0], { id: "n1", text: longText, pinned: true, createdAt: 1, updatedAt: 2 });
});
