import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldManager } from "../shield/manager";
import { WORK_IDENTITY, enableLock } from "./testUtil/lockFixtures";

/**
 * PART 15 — the bypasses the identity lock does NOT close, proven and kept honest.
 *
 * These tests exist to FAIL if someone ever "fixes" one of them, or starts
 * describing the lock as something it is not. It is a safety net against
 * ACCIDENTAL use of the wrong identity. It is not, and cannot be, a
 * defence against a user or process willing to pass a flag or run a shell
 * command — no client-side hook mechanism can be — and that is explicitly
 * outside the threat model.
 *
 * The three documented boundaries:
 *
 *  1. `git commit --no-verify` / `-n`, and `git push --no-verify`.
 *  2. Deliberately pointing `core.hooksPath` somewhere Shield's hooks are
 *     not (or deleting the hook files by hand).
 *  3. Arbitrary local shell access — which can do either of the above, plus
 *     rewrite Shield's own artifacts, or shadow `git`/`ssh` on PATH.
 *
 * `shieldHardeningMatrix.test.ts` already proves (1) for the long-form flag
 * on commit and push and proves (2) for a redirected `core.hooksPath`. This
 * file adds the shapes those do not cover — the `-n` short form, and a
 * merge commit, which goes through `pre-merge-commit` rather than
 * `pre-commit` — and then asserts the second, easily-forgotten half: that
 * the product's own words still say so.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");
void execFileAsync;
const REPO_ROOT = path.join(__dirname, "..", "..");

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

function gitSync(repo: Repo, args: string[]): string {
  return execFileSync("git", args, { cwd: repo.dir, env: repo.env, encoding: "utf8" }).trim();
}

/** Runs git tolerating a non-zero exit — the whole point here is observing blocks. */
function gitTry(repo: Repo, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo.dir, env: repo.env, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
    });
  });
}

async function makeShieldedRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-bypass-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, "gc"),
    GIT_CONFIG_SYSTEM: path.join(dir, "gs"),
  };
  await fs.writeFile(path.join(dir, "gc"), "");
  await fs.writeFile(path.join(dir, "gs"), "");
  const repo: Repo = { dir, env };
  gitSync(repo, ["init", "-q", "-b", "main"]);
  gitSync(repo, ["config", "user.name", "Danish Irfan"]);
  gitSync(repo, ["config", "user.email", "work@example.com"]);
  gitSync(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/thing.git"]);
  await fs.writeFile(path.join(dir, "f.txt"), "hi\n");
  gitSync(repo, ["add", "f.txt"]);
  gitSync(repo, ["commit", "-q", "-m", "init"]);

  const result = await enableLock(new ShieldManager(), dir, WORK_IDENTITY);
  assert.equal(result.inspection.state, "active", result.inspection.reasons.join(" | "));
  // The WRONG identity is configured from here on, so an ordinary commit is
  // blocked and every bypass below is unambiguously the flag's doing.
  gitSync(repo, ["config", "user.email", "personal@example.com"]);
  return repo;
}

async function cleanup(repo: Repo): Promise<void> {
  await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
}

// ==================== the bypasses themselves ====================

test("PART 15 — the lock genuinely blocks the ordinary case, so the bypasses below are attributable to the flag", async () => {
  const repo = await makeShieldedRepo();
  try {
    await fs.writeFile(path.join(repo.dir, "a.txt"), "x\n");
    gitSync(repo, ["add", "a.txt"]);
    const blocked = await gitTry(repo, ["commit", "-q", "-m", "ordinary"]);
    assert.notEqual(blocked.code, 0, "the lock did not block a commit with the wrong identity");
    assert.match(blocked.stderr, /REPO_IDENTITY_GUARD_BLOCK/);
    assert.match(blocked.stderr, /commit-identity-mismatch/);
  } finally {
    await cleanup(repo);
  }
});

test("KNOWN BYPASS (PART 15): `git commit -n` — the SHORT form of --no-verify — skips the lock exactly the same way", async () => {
  const repo = await makeShieldedRepo();
  try {
    await fs.writeFile(path.join(repo.dir, "a.txt"), "x\n");
    gitSync(repo, ["add", "a.txt"]);
    const result = await gitTry(repo, ["commit", "-q", "-n", "-m", "bypassed with the short flag"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /REPO_IDENTITY_GUARD_BLOCK/);
    // Documented Git behavior, identical to --no-verify. Recorded here so
    // that "we block --no-verify" can never be believed on the strength of
    // a test that only ever tried the long form.
  } finally {
    await cleanup(repo);
  }
});

test("KNOWN BYPASS (PART 15): `git merge --no-verify` skips the pre-merge-commit hook too", async () => {
  const repo = await makeShieldedRepo();
  try {
    // Build a genuine non-fast-forward merge, which Git commits via
    // `pre-merge-commit` (not `pre-commit`) — the hook Shield added in
    // Phase 7 precisely because that path was previously uncovered.
    gitSync(repo, ["checkout", "-q", "-b", "side"]);
    await fs.writeFile(path.join(repo.dir, "side.txt"), "s\n");
    gitSync(repo, ["add", "side.txt"]);
    gitSync(repo, ["commit", "-q", "-n", "-m", "side"]);
    gitSync(repo, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(repo.dir, "main.txt"), "m\n");
    gitSync(repo, ["add", "main.txt"]);
    gitSync(repo, ["commit", "-q", "-n", "-m", "main"]);

    // Without the flag, the lock blocks it (wrong identity).
    const blocked = await gitTry(repo, ["merge", "--no-ff", "-m", "merge", "side"]);
    assert.notEqual(blocked.code, 0, "the lock did not block a merge commit with the wrong identity");
    assert.match(blocked.stderr, /REPO_IDENTITY_GUARD_BLOCK/);
    await gitTry(repo, ["merge", "--abort"]);

    // With it, the merge commit is created unchecked.
    const bypassed = await gitTry(repo, ["merge", "--no-ff", "--no-verify", "-m", "merge", "side"]);
    assert.equal(bypassed.code, 0, bypassed.stderr);
    assert.doesNotMatch(bypassed.stderr, /REPO_IDENTITY_GUARD_BLOCK/);
  } finally {
    await cleanup(repo);
  }
});

test("KNOWN BYPASS (PART 15): deleting the lock's hook files by hand disables enforcement, and the lock reports that honestly", async () => {
  const repo = await makeShieldedRepo();
  try {
    const hooksDir = gitSync(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
    for (const name of ["pre-commit", "pre-merge-commit", "pre-push"]) {
      await fs.rm(path.join(hooksDir, name), { force: true });
    }
    await fs.writeFile(path.join(repo.dir, "a.txt"), "x\n");
    gitSync(repo, ["add", "a.txt"]);
    const result = await gitTry(repo, ["commit", "-q", "-m", "hooks deleted"]);
    assert.equal(result.code, 0, result.stderr);

    // Anyone with write access to `.git/` can do this; Shield cannot stop
    // it. What Shield CAN do is never claim to be healthy afterwards.
    const inspection = await new ShieldManager().inspect(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.notEqual(inspection.state, "active");
    assert.ok(inspection.reasons.some((r) => /hook is missing/.test(r)), inspection.reasons.join(" | "));
  } finally {
    await cleanup(repo);
  }
});

// ==================== the copy must stay honest ====================

const SHIPPED_TEXT_FILES = [
  "README.md",
  "docs/SHIELD_MODE.md",
  "CHANGELOG.md",
  "TESTING.md",
  "package.json",
  "src/shield/artifacts.ts",
  "src/shield/manager.ts",
  "src/shield/reasonCatalog.ts",
  "docs/IDENTITY_LOCK.md",
  "src/webview/client/placeholderView.ts",
  "src/identity/identityLockService.ts",
  "resources/shield/shield-evaluate.sh",
];

test("PART 15 — nothing anywhere claims the lock cannot be bypassed", async () => {
  const overclaims: Array<[RegExp, string]> = [
    [/\bunbypassable\b/i, "\"unbypassable\""],
    [/\bcannot be bypassed\b/i, "\"cannot be bypassed\""],
    [/\bimpossible to bypass\b/i, "\"impossible to bypass\""],
    [/\bcan(?:'|no)?t be (?:disabled|circumvented|defeated)\b/i, "a \"can't be disabled/circumvented\" claim"],
    [/\bguarantees? (?:that )?(?:no|nothing)\b/i, "an absolute guarantee"],
    [/\bblocks all\b/i, "\"blocks all\""],
    [/\bprevents all\b/i, "\"prevents all\""],
    [/\bfully prevents\b/i, "\"fully prevents\""],
    [/\bcompletely prevents\b/i, "\"completely prevents\""],
    [/\btamper[- ]proof\b/i, "\"tamper-proof\""],
    [/\bfoolproof\b/i, "\"foolproof\""],
  ];
  for (const relative of SHIPPED_TEXT_FILES) {
    const text = await fs.readFile(path.join(REPO_ROOT, relative), "utf8");
    for (const [pattern, description] of overclaims) {
      const match = pattern.exec(text);
      assert.equal(
        match,
        null,
        `${relative} contains ${description}: "${text.slice(Math.max(0, (match?.index ?? 0) - 90), (match?.index ?? 0) + 90).replace(/\n/g, " ")}"`,
      );
    }
  }
});

test("PART 15 — the three documented bypasses are still named, in the user-facing docs", async () => {
  for (const relative of ["README.md", "docs/IDENTITY_LOCK.md", "docs/SHIELD_MODE.md"]) {
    const text = await fs.readFile(path.join(REPO_ROOT, relative), "utf8");
    assert.match(text, /--no-verify/, `${relative} no longer documents the --no-verify bypass`);
    assert.match(text, /core\.hooksPath/, `${relative} no longer documents the core.hooksPath bypass`);
    assert.match(
      text,
      /arbitrary local shell|local shell access|shell access/i,
      `${relative} no longer documents the arbitrary-local-shell boundary`,
    );
  }
});
