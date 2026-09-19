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
import { makeFakeSshBin, withFakeSshOnPath } from "./testUtil/fakeSsh";

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
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend", canonicalHost: "github.com" },
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
    const policy = { ...defaultPolicy(), policyVersion: 999 as unknown as 2 };
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
  const fakeSshBin = await makeFakeSshBin();
  try {
    await writePolicy(repo, defaultPolicy());
    // The destination check now canonicalizes the alias's route via a real
    // "ssh -G" call (see resources/shield/shield-evaluate.sh's
    // resolve_canonical_ssh_host) — a fake ssh answering "github.com" for
    // any "-G" query (the shim's default) stands in for a real
    // ~/.ssh/config "Host github-work \ HostName github.com" alias.
    const env = withFakeSshOnPath(process.env, fakeSshBin);
    const result = await runScript(repo, ["push", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"], "", env);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await cleanup(repo);
  }
});

test("push to a different owner than approved -> blocked with push-destination-mismatch, matching the TS evaluator", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeFakeSshBin();
  try {
    await writePolicy(repo, defaultPolicy());
    const env = withFakeSshOnPath(process.env, fakeSshBin);
    const result = await runScript(repo, ["push", "origin", "git@github-work:SomeoneElse/other-repo.git"], "", env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /push-destination-mismatch/);

    const decision = evaluatePush(defaultPolicy(), {
      remoteName: "origin",
      remoteUrl: "git@github-work:SomeoneElse/other-repo.git",
      sshCommandOverrides: [],
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

// ====================================================================
// Phase 8 — FINDING 10: incomplete push-URL parsing must not count as a
// match, in EITHER implementation.
//
// Confirmed defect: destinationReasons() matched when the actual push
// URL produced no repository name (`!repo`), so a policy naming a
// specific repository was satisfied purely because the OWNER happened to
// parse. Both the TypeScript reference implementation and the shell
// evaluator had the same hole, and both are asserted together here so
// they can never drift apart on it.
// ====================================================================

async function writeRawPolicy(repo: string, raw: string): Promise<void> {
  const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), raw);
}

const INCOMPLETE_PUSH_URLS: ReadonlyArray<readonly [string, string]> = [
  ["owner-only scp-like path", "git@github.com:AcmeSoftware"],
  ["owner-only https path", "https://github.com/AcmeSoftware"],
  ["a bare path with no owner segment at all", "git@github.com:acme-frontend.git"],
  ["a local filesystem path with no owner/repo structure", "/srv/git/bare.git"],
];

for (const [label, url] of INCOMPLETE_PUSH_URLS) {
  test(`push destination fails CLOSED when the policy names a repository but the URL cannot produce one -- ${label} (shell evaluator)`, async () => {
    const repo = await makeTempRepo();
    try {
      await writePolicy(repo, defaultPolicy());
      const result = await runScript(repo, ["push", "origin", url]);
      assert.notEqual(result.code, 0, `"${url}" must not satisfy an approved owner/repo`);
      assert.match(result.stderr, /push-destination-mismatch/);
    } finally {
      await cleanup(repo);
    }
  });

  test(`push destination fails CLOSED for the same URL in the TypeScript reference evaluator -- ${label} (1:1 cross-check)`, () => {
    const decision = evaluatePush(defaultPolicy(), { remoteName: "origin", remoteUrl: url, sshCommandOverrides: [] }, 1);
    assert.equal(decision.allowed, false, `"${url}" must not satisfy an approved owner/repo`);
    assert.ok(decision.reasons.some((r) => r.id === "push-destination-mismatch"));
  });
}

test("a policy that never recorded a repository name IS still satisfied by owner alone -- absence in the POLICY is different from absence in the URL", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeFakeSshBin();
  try {
    const ownerOnlyPolicy = defaultPolicy({
      approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", canonicalHost: "github.com" },
      profile: { ...workProfile, strictPushSetup: false },
    });
    await writePolicy(repo, ownerOnlyPolicy);
    const env = withFakeSshOnPath(process.env, fakeSshBin);
    const result = await runScript(repo, ["push", "origin", "git@github.com:AcmeSoftware/anything.git"], "", env);
    assert.equal(result.code, 0, result.stderr);

    const decision = evaluatePush(
      ownerOnlyPolicy,
      { remoteName: "origin", remoteUrl: "git@github.com:AcmeSoftware/anything.git", sshCommandOverrides: [], resolvedHost: "github.com" },
      1,
    );
    assert.equal(decision.allowed, true);
  } finally {
    await cleanup(repo);
  }
});

// ====================================================================
// Phase 8 — FINDING 11: the standalone evaluator's policy parsing.
//
// The previous awk line-scanning parser had two reproduced FAIL-OPEN
// holes (exit 0, action allowed): arrays packed onto a single line, and a
// truncated policy file. Both are now `policy-corrupt`, which fails
// closed. These tests pin down the whole adversarial matrix.
// ====================================================================

const VALID_ONE_LINE_POLICY =
  '{ "policyVersion": 2, "generatedAt": 1, "matchedProfileId": "work", "profileLabel": "Work",' +
  ' "expectedGitName": "Danish Irfan", "expectedGitEmail": "work@example.com",' +
  ' "approvedPushDestination": { "host": "github.com", "owner": "AcmeSoftware", "repo": "acme-frontend", "canonicalHost": "github.com" },' +
  ' "trustedSshHostAliases": [], "strictPushSetup": false, "protectedBranches": [],' +
  ' "expectedBranchPatterns": [], "enabledActions": ["commit","push"] }';

test("policy parsing: a VALID policy formatted entirely on one line is honoured (formatting is no longer load-bearing)", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeFakeSshBin();
  try {
    await writeRawPolicy(repo, VALID_ONE_LINE_POLICY);
    const env = withFakeSshOnPath(process.env, fakeSshBin);
    // Governed and matching -> allowed.
    const allowed = await runScript(repo, ["push", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"], "", env);
    assert.equal(allowed.code, 0, allowed.stderr);
    // Governed and NOT matching -> blocked. This is the half that used to
    // fail open: enabledActions parsed as empty, so nothing was enforced.
    const blocked = await runScript(repo, ["push", "origin", "git@github.com:Attacker/acme-frontend.git"], "", env);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /push-destination-mismatch/);
  } finally {
    await cleanup(repo);
  }
});

test("policy parsing: a TRUNCATED policy (partial write) fails CLOSED as policy-corrupt, never silently allowing the action", async () => {
  const repo = await makeTempRepo();
  try {
    const full = JSON.stringify(defaultPolicy(), null, 2);
    await writeRawPolicy(repo, full.slice(0, Math.floor(full.length * 0.6)));
    const result = await runScript(repo, ["commit"]);
    assert.notEqual(result.code, 0, "a truncated policy must never allow a commit");
    assert.match(result.stderr, /policy-corrupt/);
  } finally {
    await cleanup(repo);
  }
});

const ADVERSARIAL_POLICIES: ReadonlyArray<readonly [string, string, RegExp]> = [
  [
    "duplicate approved-destination field (which of the two owners was meant?)",
    VALID_ONE_LINE_POLICY.replace('"owner": "AcmeSoftware"', '"owner": "AcmeSoftware", "owner": "Attacker"'),
    /duplicate key/,
  ],
  [
    "duplicate top-level field",
    `{ "policyVersion": 1, ${VALID_ONE_LINE_POLICY.slice(1)}`,
    /duplicate key/,
  ],
  [
    "trailing content after the policy object",
    `${VALID_ONE_LINE_POLICY} and then some junk`,
    /trailing content/,
  ],
  [
    "malformed boolean strictPushSetup (used to silently mean non-strict, disabling every route and account check)",
    VALID_ONE_LINE_POLICY.replace('"strictPushSetup": false', '"strictPushSetup": "yes"'),
    /strictPushSetup must be a boolean/,
  ],
  [
    "enabledActions is not an array",
    VALID_ONE_LINE_POLICY.replace('"enabledActions": ["commit","push"]', '"enabledActions": "commit"'),
    /enabledActions must be an array/,
  ],
  [
    "enabledActions contains a non-string element",
    VALID_ONE_LINE_POLICY.replace('"enabledActions": ["commit","push"]', '"enabledActions": ["commit", 7]'),
    /enabledActions must contain only strings/,
  ],
  [
    "protectedBranches is not an array",
    VALID_ONE_LINE_POLICY.replace('"protectedBranches": []', '"protectedBranches": null'),
    /protectedBranches must be an array/,
  ],
  [
    "approvedPushDestination.owner is not a string",
    VALID_ONE_LINE_POLICY.replace('"owner": "AcmeSoftware"', '"owner": 12345'),
    /approvedPushDestination\.owner must be a string/,
  ],
  [
    "approvedPushDestination is not an object",
    VALID_ONE_LINE_POLICY.replace(
      '"approvedPushDestination": { "host": "github.com", "owner": "AcmeSoftware", "repo": "acme-frontend", "canonicalHost": "github.com" }',
      '"approvedPushDestination": "github.com/AcmeSoftware/acme-frontend"',
    ),
    /approvedPushDestination must be an object/,
  ],
  [
    "missing required expectedGitEmail",
    VALID_ONE_LINE_POLICY.replace('"expectedGitEmail": "work@example.com", ', ""),
    /expectedGitEmail/,
  ],
  [
    "empty required profileLabel",
    VALID_ONE_LINE_POLICY.replace('"profileLabel": "Work"', '"profileLabel": ""'),
    /profileLabel/,
  ],
  [
    "wrong policyVersion",
    VALID_ONE_LINE_POLICY.replace('"policyVersion": 2', '"policyVersion": 1'),
    /policyVersion/,
  ],
  [
    "a secret-shaped field that should never have been persisted",
    VALID_ONE_LINE_POLICY.replace('"generatedAt": 1', '"generatedAt": 1, "token": "ghp_example"'),
    /must not contain a "token" field/,
  ],
  [
    // A file whose last line ends mid-string trips the raw-control-
    // character rule first (JSON forbids a literal newline inside a
    // string); with no trailing newline at all it trips "unterminated
    // string". Both are correct, both fail closed -- the assertion
    // accepts either rather than pinning down which one wins.
    "unterminated string",
    '{ "policyVersion": 1, "profileLabel": "Work',
    /unterminated string|raw control character inside a string/,
  ],
  [
    "invalid escape sequence inside a string",
    VALID_ONE_LINE_POLICY.replace('"profileLabel": "Work"', '"profileLabel": "Wo\\qrk"'),
    /invalid escape/,
  ],
  [
    "invalid number",
    VALID_ONE_LINE_POLICY.replace('"generatedAt": 1', '"generatedAt": 01'),
    /policy-corrupt/,
  ],
  [
    "the whole file is a JSON array, not an object",
    "[1, 2, 3]",
    /must contain a JSON object/,
  ],
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

      // And identically for a push -- corruption is never action-specific.
      const pushResult = await runScript(repo, ["push", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"]);
      assert.notEqual(pushResult.code, 0, "a malformed policy must never allow a push");
      assert.match(pushResult.stderr, /policy-corrupt/);
    } finally {
      await cleanup(repo);
    }
  });
}

test("policy parsing: a nested key can never be mistaken for a top-level one, and an escaped quote inside a string value cannot forge a key", async () => {
  const repo = await makeTempRepo();
  try {
    // The label deliberately contains the exact text of a destination key.
    // A substring-scanning parser could be fooled by this; a real parse
    // cannot, because it is a string VALUE, not a key.
    const raw = VALID_ONE_LINE_POLICY.replace(
      '"profileLabel": "Work"',
      '"profileLabel": "evil \\"owner\\": \\"Attacker\\" label"',
    );
    await writeRawPolicy(repo, raw);
    const result = await runScript(repo, ["push", "origin", "git@github.com:Attacker/acme-frontend.git"]);
    assert.notEqual(result.code, 0, "the real approved owner (AcmeSoftware) must still win");
    assert.match(result.stderr, /push-destination-mismatch/);
    // The escaped quotes are decoded for display, not left as raw backslashes.
    assert.match(result.stderr, /evil "owner": "Attacker" label/);
  } finally {
    await cleanup(repo);
  }
});

test("policy parsing: arbitrary whitespace, tabs, and newlines between every token are accepted", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeFakeSshBin();
  try {
    const spaced = VALID_ONE_LINE_POLICY.replace(/([{}[\],:])/g, "\n \t$1\t \n");
    await writeRawPolicy(repo, spaced);
    const env = withFakeSshOnPath(process.env, fakeSshBin);
    const result = await runScript(repo, ["push", "origin", "git@github.com:AcmeSoftware/acme-frontend.git"], "", env);
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
