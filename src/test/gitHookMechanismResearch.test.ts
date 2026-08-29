import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * PART 14 — pinned findings from the Git hook mechanism research.
 *
 * The full write-up (what fires `reference-transaction`, in which phases,
 * with what stdin, at what cost, and why it was NOT wired into enforcement)
 * lives in docs/SHIELD_MODE.md, "Phase 9: Git hook mechanism research".
 * Nothing in this file changes Shield's behavior — these tests exist so the
 * two facts that decision actually rests on cannot rot silently under a
 * future Git upgrade:
 *
 *  1. `hook.<name>.command` config is IGNORED, so the foreign-hook sidecar
 *     chaining Shield implements has no native replacement to migrate to.
 *     If a future Git starts honouring it, this test fails and the
 *     migration question is genuinely worth reopening.
 *  2. `reference-transaction` fires for a clean cherry-pick (which
 *     `pre-commit` misses), is NOT suppressed by `--no-verify`, and aborts
 *     the operation on a non-zero `prepared` exit — but also fires for
 *     `git gc`, `git branch`, `git tag` and ref deletions, which is the
 *     reason it was rejected as an enforcement point.
 *
 * Both are observations about GIT, not about Shield, so a failure here is
 * information ("Git changed"), not a regression.
 */

const execFileAsync = promisify(execFile);

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
  log: string;
}

function gitSync(repo: Repo, args: string[]): string {
  return execFileSync("git", args, { cwd: repo.dir, env: repo.env, encoding: "utf8" }).trim();
}

function gitTry(repo: Repo, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo.dir, env: repo.env, encoding: "utf8" }, (error) => {
      if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
      resolve(error ? ((error as { code?: number }).code ?? 1) : 0);
    });
  });
}

async function makeRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-hook-research-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, "gc"),
    GIT_CONFIG_SYSTEM: path.join(dir, "gs"),
  };
  await fs.writeFile(path.join(dir, "gc"), "");
  await fs.writeFile(path.join(dir, "gs"), "");
  const repo: Repo = { dir, env, log: path.join(dir, "hook.log") };
  gitSync(repo, ["init", "-q", "-b", "main"]);
  gitSync(repo, ["config", "user.name", "A"]);
  gitSync(repo, ["config", "user.email", "a@b.c"]);
  await fs.writeFile(path.join(dir, "f.txt"), "a\n");
  gitSync(repo, ["add", "f.txt"]);
  gitSync(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

async function writeHook(repo: Repo, name: string, body: string): Promise<void> {
  const hooksDir = gitSync(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(path.join(hooksDir, name), body, { mode: 0o755 });
}

async function readLog(repo: Repo): Promise<string> {
  return fs.readFile(repo.log, "utf8").catch(() => "");
}

const SKIP_ON_WINDOWS =
  process.platform === "win32"
    ? "these hooks are POSIX shell scripts run from a scratch repository; Git for Windows runs them under its bundled sh, but the harness's own file-mode and shell assumptions are POSIX-only. The findings are about Git's behavior, which is not platform-specific, and are verified on the ubuntu and macos legs."
    : false;

test("PART 14(A) — `hook.<name>.command` config is accepted by git config and then completely IGNORED", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeRepo();
  try {
    const configured = path.join(repo.dir, "configured.sh");
    await fs.writeFile(configured, `#!/bin/sh\necho CONFIGURED >> ${repo.log}\nexit 1\n`, { mode: 0o755 });
    await writeHook(repo, "pre-commit", `#!/bin/sh\necho TRADITIONAL >> ${repo.log}\nexit 0\n`);

    gitSync(repo, ["config", "--add", "hook.pre-commit.command", configured]);
    // git config genuinely stores it...
    assert.equal(gitSync(repo, ["config", "--get-all", "hook.pre-commit.command"]), configured);

    await fs.writeFile(path.join(repo.dir, "b.txt"), "b\n");
    gitSync(repo, ["add", "b.txt"]);
    const code = await gitTry(repo, ["commit", "-q", "-m", "two"]);

    const log = await readLog(repo);
    assert.match(log, /TRADITIONAL/, "the traditional hook file did not run");
    // ...and then never runs it. Note the configured hook exits 1: if Git
    // honoured it at all, the commit would have been blocked.
    assert.doesNotMatch(
      log,
      /CONFIGURED/,
      "This Git RUNS hook.<name>.command entries. docs/SHIELD_MODE.md \"Phase 9\" concludes that no native replacement for Shield's sidecar chaining exists — that conclusion may now be out of date and is worth reopening.",
    );
    assert.equal(code, 0, "the commit was blocked, which would mean the configured hook ran");

    // `git hook run` (Git 2.36+) resolves exactly one script per event too.
    await fs.rm(repo.log, { force: true });
    await gitTry(repo, ["hook", "run", "pre-commit"]);
    const runLog = await readLog(repo);
    assert.match(runLog, /TRADITIONAL/);
    assert.doesNotMatch(runLog, /CONFIGURED/, "`git hook run` executed a configured hook — see the note above");
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 14(B) — reference-transaction fires for a clean cherry-pick, which pre-commit never sees", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeRepo();
  try {
    await writeHook(repo, "pre-commit", `#!/bin/sh\necho PRE_COMMIT >> ${repo.log}\nexit 0\n`);
    await writeHook(
      repo,
      "reference-transaction",
      `#!/bin/sh\nwhile IFS= read -r l; do echo "REFTX $1 $l" >> ${repo.log}; done\nexit 0\n`,
    );

    gitSync(repo, ["checkout", "-q", "-b", "side"]);
    await fs.writeFile(path.join(repo.dir, "s.txt"), "s\n");
    gitSync(repo, ["add", "s.txt"]);
    gitSync(repo, ["commit", "-q", "-m", "side"]);
    gitSync(repo, ["checkout", "-q", "main"]);

    await fs.rm(repo.log, { force: true });
    assert.equal(await gitTry(repo, ["cherry-pick", "side"]), 0);

    const log = await readLog(repo);
    // THE gap: a clean cherry-pick invokes no commit hook at all...
    assert.doesNotMatch(log, /PRE_COMMIT/, "pre-commit unexpectedly ran for a clean cherry-pick — the Phase 7 gap may have closed");
    // ...but reference-transaction sees the resulting branch update.
    assert.match(log, /REFTX prepared .* refs\/heads\/main/);
    assert.match(log, /REFTX committed .* refs\/heads\/main/);
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 14(B) — a non-zero reference-transaction `prepared` exit aborts the operation, and --no-verify does NOT suppress it", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeRepo();
  try {
    await writeHook(
      repo,
      "reference-transaction",
      `#!/bin/sh\ncat >/dev/null\n[ "$1" = "prepared" ] && exit 1\nexit 0\n`,
    );
    const before = gitSync(repo, ["rev-parse", "HEAD"]);

    await fs.writeFile(path.join(repo.dir, "c.txt"), "c\n");
    gitSync(repo, ["add", "c.txt"]);
    assert.notEqual(await gitTry(repo, ["commit", "-q", "-m", "refused"]), 0);
    assert.equal(gitSync(repo, ["rev-parse", "HEAD"]), before, "the commit was created despite a refusing hook");

    // The property that makes this hook interesting AND makes it a poor
    // fit for Shield's documented "--no-verify is a sanctioned escape
    // hatch" boundary: the flag does not turn it off.
    assert.notEqual(await gitTry(repo, ["commit", "-q", "--no-verify", "-m", "refused too"]), 0);
    assert.equal(gitSync(repo, ["rev-parse", "HEAD"]), before, "--no-verify bypassed the reference-transaction hook");

    // And it is not commit-specific: creating a branch is refused too,
    // which is exactly why Shield does not enforce here.
    assert.notEqual(await gitTry(repo, ["branch", "should-not-exist"]), 0);
    assert.doesNotMatch(gitSync(repo, ["branch", "--format=%(refname:short)"]), /should-not-exist/);
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 14(B) — reference-transaction also fires for gc, branch, tag and ref deletion: the blast radius that ruled it out", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeRepo();
  try {
    await writeHook(
      repo,
      "reference-transaction",
      `#!/bin/sh\nwhile IFS= read -r l; do echo "REFTX $1 $l" >> ${repo.log}; done\nexit 0\n`,
    );

    const observed = async (label: string, args: string[]): Promise<boolean> => {
      await fs.rm(repo.log, { force: true });
      await gitTry(repo, args);
      const fired = (await readLog(repo)).includes("REFTX");
      assert.ok(fired, `reference-transaction did NOT fire for ${label} — docs/SHIELD_MODE.md "Phase 9" says it does`);
      return fired;
    };

    await observed("git branch", ["branch", "topic"]);
    await observed("git tag", ["tag", "v1"]);
    await observed("git branch -d", ["branch", "-D", "topic"]);
    await observed("git gc", ["gc", "--quiet", "--prune=now"]);

    // ...while an operation that updates no ref does not fire it, which is
    // the only reason filtering looked feasible at all.
    await fs.rm(repo.log, { force: true });
    await gitTry(repo, ["status", "--porcelain=v2"]);
    assert.equal((await readLog(repo)).includes("REFTX"), false);
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 14 — the research write-up exists and still records both conclusions", async () => {
  const doc = await fs.readFile(path.join(__dirname, "..", "..", "docs", "SHIELD_MODE.md"), "utf8");
  assert.match(doc, /Phase 9: Git hook mechanism research/);
  assert.match(doc, /hook\.<name>\.command/);
  assert.match(doc, /reference-transaction/);
  assert.match(doc, /nothing migrated|no production change/i);
});
