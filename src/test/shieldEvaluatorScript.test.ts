import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCommit, evaluatePush } from "../shield/evaluator";
import { ShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { makeFakeSshBin } from "./testUtil/fakeSsh";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";
import { WORK_IDENTITY, WORK_IDENTITY_WITH_LOGIN, identityWith, testPolicy } from "./testUtil/lockFixtures";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

/**
 * Integration tests for the actual shipped runtime artifact
 * (resources/shield/shield-evaluate.sh) against real temporary
 * repositories — not the TypeScript reference. They run `sh` directly and
 * assert on exit code + stderr, exactly the interface the Git hooks rely
 * on. Several scenarios also cross-check the TypeScript reference.
 */

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
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
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

async function writeRawPolicy(repo: string, raw: string): Promise<void> {
  const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), raw);
}

async function writePolicy(repo: string, policy: ShieldPolicy): Promise<void> {
  await writeRawPolicy(repo, serializeShieldPolicy(policy));
}

async function cleanup(repo: string): Promise<void> {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
}

// ==================== policy load ====================

test("no policy file -> exit non-zero with policy-missing, before touching any Git state", async () => {
  const repo = await makeTempRepo();
  try {
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /REASON_ID: policy-missing/);
  } finally {
    await cleanup(repo);
  }
});

test("corrupt (non-JSON garbage) policy file -> exit non-zero with policy-corrupt", async () => {
  const repo = await makeTempRepo();
  try {
    await writeRawPolicy(repo, "this is not json at all");
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo);
  }
});

// ==================== commit ====================

test("matching identity -> exit 0 (allow) with no output", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy());
    const result = await runScript(repo, ["commit"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    await cleanup(repo);
  }
});

test("branch policy and repository state are never enforced: main, a detached HEAD, a dirty tree, and an in-progress rebase with conflicts are all ALLOWED with the right identity", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy());
    await git(repo, ["branch", "-m", "main"]);
    assert.equal((await runScript(repo, ["commit"])).code, 0, "main branch");

    await fs.writeFile(path.join(repo, "f.txt"), "dirty\n");
    assert.equal((await runScript(repo, ["commit"])).code, 0, "dirty tree");
    await git(repo, ["checkout", "--", "f.txt"]);

    const sha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "--detach", sha]);
    assert.equal((await runScript(repo, ["commit"])).code, 0, "detached HEAD");
    await git(repo, ["checkout", "-q", "main"]);

    await git(repo, ["checkout", "-q", "-b", "feature/login"]);
    await fs.writeFile(path.join(repo, "f.txt"), "branch change\n");
    await git(repo, ["commit", "-q", "-am", "branch change"]);
    await git(repo, ["checkout", "-q", "-b", "feature/other", "HEAD~1"]);
    await fs.writeFile(path.join(repo, "f.txt"), "conflicting change\n");
    await git(repo, ["commit", "-q", "-am", "conflicting change"]);
    await git(repo, ["rebase", "feature/login"]).catch(() => undefined); // stops with a conflict
    const midRebase = await runScript(repo, ["commit"]);
    assert.equal(midRebase.code, 0, `rebase in progress with conflicts must not be a lock concern: ${midRebase.stderr}`);
    await git(repo, ["rebase", "--abort"]).catch(() => undefined);
  } finally {
    await cleanup(repo);
  }
});

test("effective identity overridden by environment (GIT_AUTHOR_*) -> commit-identity-override, matching the TS evaluator", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy());
    const env = { ...process.env, GIT_AUTHOR_EMAIL: "personal@example.com", GIT_AUTHOR_NAME: "Someone Else" };
    const result = await runScript(repo, ["commit"], "", env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /REASON_ID: commit-identity-override/);

    const decision = evaluateCommit(testPolicy(), {
      effectiveAuthorName: "Someone Else",
      effectiveAuthorEmail: "personal@example.com",
      effectiveCommitterName: "Danish Irfan",
      effectiveCommitterEmail: "work@example.com",
      configuredName: "Danish Irfan",
      configuredEmail: "work@example.com",
    });
    assert.deepEqual(decision.reasons.map((r) => r.id), ["commit-identity-override"]);
  } finally {
    await cleanup(repo);
  }
});

test("wrong configured identity -> commit-identity-mismatch", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy());
    await git(repo, ["config", "user.email", "wrong@example.com"]);
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /REASON_ID: commit-identity-mismatch/);
  } finally {
    await cleanup(repo);
  }
});

test("the lock policy is found identically from a linked worktree, end-to-end through the real script", async () => {
  const repo = await makeTempRepo();
  const worktreeDir = path.join(path.dirname(repo), path.basename(repo) + "-wt");
  try {
    await writePolicy(repo, testPolicy());
    await git(repo, ["branch", "feature/from-worktree"]);
    await git(repo, ["worktree", "add", worktreeDir, "feature/from-worktree"]);
    assert.equal((await runScript(worktreeDir, ["commit"])).code, 0);
    await git(worktreeDir, ["config", "--worktree", "user.email", "x@example.com"]).catch(() => git(worktreeDir, ["config", "user.email", "x@example.com"]));
    const blocked = await runScript(worktreeDir, ["commit"]);
    assert.notEqual(blocked.code, 0);
  } finally {
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
    await cleanup(repo);
  }
});

// ==================== push ====================

test("a lock whose identity has no expected GitHub login BLOCKS every push (push-identity-not-configured), over any route — matching the TS evaluator", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeFakeSshBin();
  try {
    await writePolicy(repo, testPolicy(WORK_IDENTITY));
    for (const url of ["https://github.com/AcmeSoftware/acme-frontend.git", "git@github.com:x/y.git", "git@unknown:x/y.git", "git@github-work:AcmeSoftware/acme-frontend.git"]) {
      // Even a trusted alias that would authenticate as the right person.
      const result = await runEvaluatorScript(repo, process.env, fakeSshBin, SCRIPT_PATH, ["push", "origin", url], {
        FAKE_SSH_AUTH_OUTPUT: "Hi danish-work! You've successfully authenticated, but GitHub does not provide shell access.",
      });
      assert.notEqual(result.code, 0, `${url}: an assigned repository let a push through unchecked`);
      assert.match(result.stderr, /^REASON_ID: push-identity-not-configured$/m, url);
      const decision = evaluatePush(testPolicy(WORK_IDENTITY), { remoteName: "origin", remoteUrl: url, sshCommandOverrides: [], githubAccountCheck: { kind: "authenticated-user", login: "danish-work" } });
      assert.deepEqual(decision.reasons.map((r) => r.id), ["push-identity-not-configured"], url);
    }
    // Commits are still enforced exactly as before for the same policy.
    assert.equal((await runScript(repo, ["commit"])).code, 0);
  } finally {
    await cleanup(repo);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("push through a trusted SSH alias that authenticates as the expected account -> allowed, to ANY repository (no destination policy), matching the TS evaluator", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeFakeSshBin();
  try {
    await writePolicy(repo, testPolicy(WORK_IDENTITY_WITH_LOGIN));
    for (const url of ["git@github-work:AcmeSoftware/acme-frontend.git", "git@github-work:SomeoneElse/other-repo.git"]) {
      const result = await runEvaluatorScript(repo, process.env, fakeSshBin, SCRIPT_PATH, ["push", "origin", url], {
        FAKE_SSH_AUTH_OUTPUT: "Hi danish-work! You've successfully authenticated, but GitHub does not provide shell access.",
      });
      assert.equal(result.code, 0, `${url}: ${result.stderr}`);
      const decision = evaluatePush(testPolicy(WORK_IDENTITY_WITH_LOGIN), {
        remoteName: "origin",
        remoteUrl: url,
        sshCommandOverrides: [],
        githubAccountCheck: { kind: "authenticated-user", login: "danish-work" },
      });
      assert.equal(decision.allowed, true);
    }
  } finally {
    await cleanup(repo);
  }
});

test("push over HTTPS, a generic SSH host, or an untrusted alias is blocked for a lock that expects a GitHub login", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy(WORK_IDENTITY_WITH_LOGIN));
    for (const url of ["https://github.com/AcmeSoftware/acme-frontend.git", "git@github.com:AcmeSoftware/acme-frontend.git", "git@github-personal:AcmeSoftware/acme-frontend.git"]) {
      const result = await runScript(repo, ["push", "origin", url]);
      assert.notEqual(result.code, 0, url);
      assert.match(result.stderr, /REASON_ID: push-route-unverified/, url);
    }
  } finally {
    await cleanup(repo);
  }
});

test("an identity with a GitHub login but no trusted alias blocks every push", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy(identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: [] })));
    const result = await runScript(repo, ["push", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /push-route-unverified/);
    assert.match(result.stderr, /lists no trusted SSH host alias, so no push route can be verified/);
    assert.match(result.stderr, /every push from this repository is blocked until one is configured/);
  } finally {
    await cleanup(repo);
  }
});

test("no message from the script ever claims cryptographic account verification", async () => {
  const repo = await makeTempRepo();
  try {
    await writePolicy(repo, testPolicy(WORK_IDENTITY_WITH_LOGIN));
    for (const url of ["https://github.com/AcmeSoftware/acme-frontend.git", "git@github.com:AcmeSoftware/acme-frontend.git", "git@github-work:SomeoneElse/other.git"]) {
      const result = await runScript(repo, ["push", "origin", url]);
      assert.doesNotMatch(result.stderr, /verified account|verified key|cryptographically verif/i);
    }
  } finally {
    await cleanup(repo);
  }
});

// ====================================================================
// Policy parsing (Phase 8 hardening, kept). The previous line-scanning
// parser had reproduced FAIL-OPEN holes (arrays packed onto one line, a
// truncated file). The strict recursive-descent parser makes formatting
// irrelevant and every malformation `policy-corrupt`, which fails closed.
// ====================================================================

const VALID_ONE_LINE_POLICY =
  '{ "policyVersion": 4, "lockId": "lock-1", "assignedAt": 1, "generatedAt": 1, "identityId": "work", "identityLabel": "Work",' +
  ' "expectedGitName": "Danish Irfan", "expectedGitEmail": "work@example.com",' +
  ' "trustedSshHostAliases": ["github-work"] }';

/** VALID_ONE_LINE_POLICY with one extra top-level field appended. */
function withField(field: string): string {
  return VALID_ONE_LINE_POLICY.replace('"trustedSshHostAliases": ["github-work"]', `"trustedSshHostAliases": ["github-work"], ${field}`);
}

test("policy parsing: a VALID policy formatted entirely on one line is honoured — both the allow AND the block half", async () => {
  const repo = await makeTempRepo();
  try {
    await writeRawPolicy(repo, VALID_ONE_LINE_POLICY);
    assert.equal((await runScript(repo, ["commit"])).code, 0);
    // The half that used to fail open: enforcement silently parsed as empty.
    const blocked = await runScript(repo, ["commit"], "", { ...process.env, GIT_AUTHOR_EMAIL: "attacker@example.com" });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /commit-identity-override/);
  } finally {
    await cleanup(repo);
  }
});

test("policy parsing: a TRUNCATED policy (partial write) fails CLOSED as policy-corrupt", async () => {
  const repo = await makeTempRepo();
  try {
    const full = JSON.stringify(testPolicy(), null, 2);
    await writeRawPolicy(repo, full.slice(0, Math.floor(full.length * 0.6)));
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0, "a truncated policy must never allow a commit");
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo);
  }
});

const ADVERSARIAL_POLICIES: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["duplicate expectedGitEmail (which of the two was meant?)", VALID_ONE_LINE_POLICY.replace('"expectedGitEmail": "work@example.com"', '"expectedGitEmail": "work@example.com", "expectedGitEmail": "attacker@example.com"'), /duplicate key/],
  ["duplicate top-level field", `{ "policyVersion": 4, ${VALID_ONE_LINE_POLICY.slice(1)}`, /duplicate key/],
  ["trailing content after the policy object", `${VALID_ONE_LINE_POLICY} and then some junk`, /trailing content/],
  // v4 has no per-action switch: a v3-style list (that could take push out
  // of the lock) is refused in any shape, never silently honoured or ignored.
  ["a v3-style enforcedActions list that drops push", withField('"enforcedActions": ["commit"]'), /must not contain an enforcedActions field/],
  ["a v3-style enforcedActions list naming both actions", withField('"enforcedActions": ["commit", "push"]'), /must not contain an enforcedActions field/],
  ["an enforcedActions field of any other shape", withField('"enforcedActions": null'), /must not contain an enforcedActions field/],
  ["trustedSshHostAliases is not an array", VALID_ONE_LINE_POLICY.replace('"trustedSshHostAliases": ["github-work"]', '"trustedSshHostAliases": null'), /trustedSshHostAliases must be an array/],
  ["expectedGitHubLogin is not a string", VALID_ONE_LINE_POLICY.replace('"identityLabel": "Work"', '"identityLabel": "Work", "expectedGitHubLogin": 12345'), /expectedGitHubLogin must be a string/],
  ["missing required expectedGitEmail", VALID_ONE_LINE_POLICY.replace('"expectedGitEmail": "work@example.com", ', ""), /expectedGitEmail/],
  ["empty required identityLabel", VALID_ONE_LINE_POLICY.replace('"identityLabel": "Work"', '"identityLabel": ""'), /identityLabel/],
  ["missing lockId", VALID_ONE_LINE_POLICY.replace('"lockId": "lock-1", ', ""), /lockId/],
  ["missing assignedAt", VALID_ONE_LINE_POLICY.replace('"assignedAt": 1, ', ""), /assignedAt/],
  ["a legacy Shield (v2) policy", VALID_ONE_LINE_POLICY.replace('"policyVersion": 4', '"policyVersion": 2'), /legacy Repo Identity Guard "Shield" policy/],
  [
    "a previous identity-lock (v3) policy, even a well-formed one",
    withField('"enforcedActions": ["commit"]').replace('"policyVersion": 4', '"policyVersion": 3'),
    /earlier version of Repo Identity Guard \(policy version 3\)/,
  ],
  ["a future policyVersion", VALID_ONE_LINE_POLICY.replace('"policyVersion": 4', '"policyVersion": 5'), /policyVersion/],
  ["a secret-shaped field that should never have been persisted", VALID_ONE_LINE_POLICY.replace('"generatedAt": 1', '"generatedAt": 1, "token": "ghp_example"'), /must not contain a "token" field/],
  ["unterminated string", '{ "policyVersion": 4, "identityLabel": "Work', /unterminated string|raw control character inside a string/],
  ["invalid escape sequence inside a string", VALID_ONE_LINE_POLICY.replace('"identityLabel": "Work"', '"identityLabel": "Wo\\qrk"'), /invalid escape/],
  ["invalid number", VALID_ONE_LINE_POLICY.replace('"generatedAt": 1', '"generatedAt": 01'), /policy-corrupt/],
  ["the whole file is a JSON array, not an object", "[1, 2, 3]", /must contain a JSON object/],
];

for (const [label, raw, expected] of ADVERSARIAL_POLICIES) {
  test(`policy parsing: ${label} -> policy-corrupt, action BLOCKED`, async () => {
    const repo = await makeTempRepo();
    try {
      await writeRawPolicy(repo, raw);
      const commitResult = await runScript(repo, ["commit"]);
      assert.notEqual(commitResult.code, 0, "a malformed policy must never allow a commit");
      assert.match(commitResult.stderr, /policy-corrupt/);
      assert.match(commitResult.stderr, expected);
      const pushResult = await runScript(repo, ["push", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
      assert.notEqual(pushResult.code, 0, "a malformed policy must never allow a push");
      assert.match(pushResult.stderr, /policy-corrupt/);
    } finally {
      await cleanup(repo);
    }
  });
}

test("policy parsing: an escaped quote inside a string value cannot forge a key, and is decoded for display", async () => {
  const repo = await makeTempRepo();
  try {
    const raw = VALID_ONE_LINE_POLICY.replace('"identityLabel": "Work"', '"identityLabel": "evil \\"expectedGitEmail\\": \\"attacker@example.com\\" label"');
    await writeRawPolicy(repo, raw);
    const result = await runScript(repo, ["commit"], "", { ...process.env, GIT_AUTHOR_EMAIL: "attacker@example.com", GIT_COMMITTER_EMAIL: "attacker@example.com" });
    assert.notEqual(result.code, 0, "the real expectedGitEmail (work@example.com) must still win");
    assert.match(result.stderr, /EXPECTED_EMAIL: work@example\.com/);
    assert.match(result.stderr, /evil "expectedGitEmail": "attacker@example\.com" label/);
  } finally {
    await cleanup(repo);
  }
});

test("policy parsing: arbitrary whitespace, tabs, and newlines between every token are accepted", async () => {
  const repo = await makeTempRepo();
  try {
    await writeRawPolicy(repo, VALID_ONE_LINE_POLICY.replace(/([{}[\],:])/g, "\n \t$1\t \n"));
    const result = await runScript(repo, ["commit"]);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("policy parsing: an empty policy file fails CLOSED", async () => {
  const repo = await makeTempRepo();
  try {
    await writeRawPolicy(repo, "");
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo);
  }
});
