import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCommit, evaluatePush } from "../shield/evaluator";
import { ShieldPolicy, buildShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { Profile } from "../types";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

/**
 * Integration tests for the actual shipped runtime artifact
 * (resources/shield/shield-evaluate.sh) against real temporary
 * repositories — not the TypeScript reference implementation. These use
 * `sh` directly (no Node dependency in the artifact under test; Node is
 * only this test *runner's* own tooling, which the whole extension already
 * requires) and assert on exit code + stderr, exactly the interface a
 * future Git hook would rely on.
 *
 * Several scenarios also run the equivalent facts through the pure
 * TypeScript evaluator (src/shield/evaluator.ts) and assert both agree —
 * a cross-check that keeps the two from silently drifting apart, per the
 * module header comments in both files.
 */

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  expectedBranchPatterns: ["feature/*"],
  strictPushSetup: true,
  trustedSshHostAliases: ["github-work"],
};

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", env: env ?? process.env });
  return stdout.trim();
}

interface RunResult {
  code: number;
  stderr: string;
}

function runScript(cwd: string, args: string[], stdin = "", env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile("sh", [SCRIPT_PATH, ...args], { cwd, encoding: "utf8", env: env ?? process.env }, (error, _stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") {
        reject(error);
        return;
      }
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ code, stderr });
    }).stdin?.end(stdin);
  });
}

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-eval-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "work@example.com"]);
  await git(dir, ["config", "user.name", "Danish Irfan"]);
  await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
  await git(dir, ["add", "f.txt"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function writePolicy(repo: string, policy: ShieldPolicy): Promise<void> {
  const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), serializeShieldPolicy(policy));
}

function defaultPolicy(overrides: Partial<Parameters<typeof buildShieldPolicy>[0]> = {}): ShieldPolicy {
  return buildShieldPolicy({
    profile: workProfile,
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
    protectedBranches: ["main", "master"],
    enabledActions: ["commit", "push"],
    now: 1,
    ...overrides,
  });
}

async function cleanup(repo: string): Promise<void> {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
}

test("no policy file -> exit non-zero with policy-missing, before touching any Git state", async () => {
  const repo = await makeTempRepo();
  try {
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-missing/);
  } finally {
    await cleanup(repo);
  }
});

test("corrupt (non-JSON garbage) policy file -> exit non-zero with policy-corrupt", async () => {
  const repo = await makeTempRepo();
  try {
    const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
    await fs.writeFile(shieldPolicyFilePath(commonDir), "this is not json at all");
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo);
  }
});

test("wrong policyVersion -> exit non-zero with policy-corrupt", async () => {
  const repo = await makeTempRepo();
  try {
    const policy = { ...defaultPolicy(), policyVersion: 999 as unknown as 1 };
    await writePolicy(repo, policy);
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo);
  }
});

test("matching identity on a non-protected branch -> exit 0 (allow)", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["checkout", "-q", "-b", "feature/login"]);
    const result = await runScript(repo, ["commit"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    await cleanup(repo);
  }
});

test("effective identity overridden by environment (GIT_AUTHOR_*) -> blocked with commit-identity-override, matching the TS evaluator", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["checkout", "-q", "-b", "feature/login"]);
    const env = { ...process.env, GIT_AUTHOR_EMAIL: "personal@example.com", GIT_AUTHOR_NAME: "Someone Else" };
    const result = await runScript(repo, ["commit"], "", env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-override/);

    // Cross-check: the same facts fed to the TS reference evaluator reach
    // the same conclusion.
    const decision = evaluateCommit(defaultPolicy(), {
      effectiveAuthorName: "Someone Else",
      effectiveAuthorEmail: "personal@example.com",
      effectiveCommitterName: "Danish Irfan",
      effectiveCommitterEmail: "work@example.com",
      configuredName: "Danish Irfan",
      configuredEmail: "work@example.com",
      isDetachedHead: false,
      currentBranch: "feature/login",
      hasMergeConflicts: false,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasons[0].id, "commit-identity-override");
  } finally {
    await cleanup(repo);
  }
});

test("wrong configured identity (not just an env override) -> blocked with commit-identity-mismatch", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["checkout", "-q", "-b", "feature/login"]);
    await git(repo, ["config", "user.email", "wrong@example.com"]);
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /commit-identity-mismatch/);
  } finally {
    await cleanup(repo);
  }
});

test("protected branch (case-insensitive) -> blocked with protected-branch", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    // Default branch from `git init` in this environment; force it to
    // a known protected name to avoid depending on init.defaultBranch.
    await git(repo, ["branch", "-m", "MAIN"]);
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /protected-branch/);
  } finally {
    await cleanup(repo);
  }
});

test("detached HEAD -> blocked with detached-head", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    const sha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "--detach", sha]);
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /detached-head/);
  } finally {
    await cleanup(repo);
  }
});

test("ordinary dirty working tree (no conflicts, no in-progress op) -> exit 0, matching 'must never block on dirty tree alone'", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["checkout", "-q", "-b", "feature/login"]);
    await fs.writeFile(path.join(repo, "f.txt"), "changed but not committed\n");
    const result = await runScript(repo, ["commit"]);
    assert.equal(result.code, 0);
  } finally {
    await cleanup(repo);
  }
});

test("branch-pattern mismatch alone -> exit 0 (stays a non-blocking warning, never silently upgraded)", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["checkout", "-q", "-b", "chore/unrelated"]);
    const result = await runScript(repo, ["commit"]);
    assert.equal(result.code, 0);
  } finally {
    await cleanup(repo);
  }
});

test("a rebase in progress -> blocked with repo-operation-in-progress", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["checkout", "-q", "-b", "feature/login"]);
    await fs.writeFile(path.join(repo, "f.txt"), "branch change\n");
    await git(repo, ["commit", "-q", "-am", "branch change"]);
    await git(repo, ["checkout", "-q", "-b", "feature/other", "HEAD~1"]);
    await fs.writeFile(path.join(repo, "f.txt"), "conflicting change\n");
    await git(repo, ["commit", "-q", "-am", "conflicting change"]);
    await git(repo, ["rebase", "feature/login"]).catch(() => undefined); // expected to stop with a conflict

    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /repo-operation-in-progress/);
    assert.match(result.stderr, /merge-conflicts/);

    await git(repo, ["rebase", "--abort"]).catch(() => undefined);
  } finally {
    await cleanup(repo);
  }
});

test("enabledActions excludes 'commit' -> exit 0 regardless of otherwise-blocking Git state", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy({ enabledActions: ["push"] }));
    const sha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "--detach", sha]);
    const result = await runScript(repo, ["commit"]);
    assert.equal(result.code, 0);
  } finally {
    await cleanup(repo);
  }
});

test("Shield's policy is found identically from a linked worktree, end-to-end through the real script", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), path.basename(repo) + "-wt");
  try {
    await writePolicy(repo, defaultPolicy());
    await git(repo, ["branch", "feature/from-worktree"]);
    await git(repo, ["worktree", "add", worktreeDir, "feature/from-worktree"]);

    const result = await runScript(worktreeDir, ["commit"]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await cleanup(repo);
  }
});

// ---------------- push ----------------

test("push through the trusted SSH alias to the approved owner -> exit 0", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    const result = await runScript(repo, ["push", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"], "");
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("push to a different owner than approved -> blocked with push-destination-mismatch, matching the TS evaluator", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    const result = await runScript(repo, ["push", "origin", "git@github-work:SomeoneElse/other-repo.git"], "");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /push-destination-mismatch/);

    const decision = evaluatePush(defaultPolicy(), {
      remoteName: "origin",
      remoteUrl: "git@github-work:SomeoneElse/other-repo.git",
    });
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.some((r) => r.id === "push-destination-mismatch"));
  } finally {
    await cleanup(repo);
  }
});

test("push over HTTPS is blocked under a strict profile and allowed under a relaxed one", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    const strictResult = await runScript(repo, ["push", "origin", "https://github.com/AcmeSoftware/acme-frontend.git"], "");
    assert.notEqual(strictResult.code, 0);
    assert.match(strictResult.stderr, /push-route-unverified/);

    const relaxedProfile: Profile = { ...workProfile, strictPushSetup: false };
    await writePolicy(repo, defaultPolicy({ profile: relaxedProfile }));
    const relaxedResult = await runScript(repo, ["push", "origin", "https://github.com/AcmeSoftware/acme-frontend.git"], "");
    assert.equal(relaxedResult.code, 0, relaxedResult.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("push through a dedicated-looking but untrusted SSH alias is blocked under a strict profile", async () => {
  const repo = await makeTempRepo();
  try {
    const profileNoAliases: Profile = { ...workProfile, trustedSshHostAliases: [] };
    await writePolicy(repo, defaultPolicy({ profile: profileNoAliases }));
    const result = await runScript(repo, ["push", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"], "");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /push-route-unverified/);
  } finally {
    await cleanup(repo);
  }
});

test("no reason message from the script ever claims cryptographic account verification", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, defaultPolicy());
    const urls = [
      "https://github.com/AcmeSoftware/acme-frontend.git",
      "git@github.com:AcmeSoftware/acme-frontend.git",
      "git@github-work:SomeoneElse/other.git",
    ];
    for (const url of urls) {
      const result = await runScript(repo, ["push", "origin", url], "");
      assert.doesNotMatch(result.stderr, /verified account|verified key|cryptographically verif/i);
    }
  } finally {
    await cleanup(repo);
  }
});
