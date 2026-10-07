import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { SHIELD_ARTIFACT_MARKER } from "../shield/artifacts";
import { ShieldManager } from "../shield/manager";
import { shieldEvaluatorScriptFilePath, shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { shieldInstallRecordFilePath } from "../shield/installRecord";
import { WORK_IDENTITY } from "./testUtil/lockFixtures";

/**
 * PART 1 + PART 2 — Shield's install transaction under fault injection.
 *
 * Shield's durable installation record is the ONLY thing that lets
 * `disable()` find hooks at a directory `core.hooksPath` has since moved
 * away from. Under v5 fail-CLOSED hook shims, a Shield hook that Disable
 * cannot reach is not a cosmetic leak — pointing `core.hooksPath` back at
 * it resurrects a hook whose evaluator was deleted, which blocks every
 * commit and push in the repository with no Shield left to repair it.
 *
 * So these tests inject a real failure at each step of
 * `ShieldManager.enable`/`repair` and assert the four properties that
 * matter after every one of them:
 *
 *   (a) no unrecorded Shield-owned hook exists anywhere afterwards;
 *   (b) an already-working Shield installation is never destroyed;
 *   (c) `inspect()` describes whatever remains accurately, and never
 *       reports ACTIVE out of a failed operation;
 *   (d) a later Repair (once the fault is cleared) recovers, and a later
 *       Disable cleans everything up.
 *
 * ## Fault-injection technique
 *
 * These tests run as whatever user the test runner runs as, which in CI
 * and in this project's dev container is frequently **root** — and root
 * ignores permission bits, so `chmod 0o555` is not a portable way to make
 * a write fail. Instead a path is made un-writable *structurally*: the
 * target file path is replaced by a NON-EMPTY DIRECTORY. Every Shield
 * write is a same-directory temp file plus `rename()`, and `rename()` onto
 * a non-empty directory fails with ENOTDIR/ENOTEMPTY/EISDIR for every
 * user including root. That is a genuine I/O failure of exactly the shape
 * a full disk, a read-only mount, or a hostile permission set produces —
 * not a mock.
 *
 * The one failure that cannot be produced structurally (a `rename` that
 * fails only for one specific hook file) is injected by temporarily
 * replacing `fs.promises.rename` for that one path. That is still the real
 * ShieldManager code under test; only the syscall it calls is made to
 * fail.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

const workProfile = WORK_IDENTITY;

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

async function makeRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-txn-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig-global"),
    GIT_CONFIG_SYSTEM: path.join(dir, "gitconfig-system"),
  };
  await fs.writeFile(path.join(dir, "gitconfig-global"), "");
  await fs.writeFile(path.join(dir, "gitconfig-system"), "");
  const repo: Repo = { dir, env };
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "Danish Irfan"]);
  await git(repo, ["config", "user.email", "work@example.com"]);
  await git(repo, ["remote", "add", "origin", "git@github.com:AcmeSoftware/thing.git"]);
  await fs.writeFile(path.join(dir, "f.txt"), "hi\n");
  await git(repo, ["add", "f.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function enableInput(_repo: Repo, chainForeignHooks = false) {
  return { identity: workProfile, lockId: "test-lock", assignedAt: 1, chainForeignHooks };
}

/** Makes `filePath` structurally un-writable by a temp-file-plus-rename write, for any user including root. */
async function blockPath(filePath: string): Promise<void> {
  await fs.mkdir(filePath, { recursive: true });
  await fs.writeFile(path.join(filePath, "occupied"), "x");
}

async function unblockPath(filePath: string): Promise<void> {
  await fs.rm(filePath, { recursive: true, force: true });
}

/**
 * Runs `fn` with every atomic `rename()` onto a path matching `matches`
 * failing with EIO. Unlike {@link blockPath} this leaves the target file
 * READABLE, which is what a read-only filesystem or a quota-exhausted
 * volume actually looks like — and is the only way to test "the existing
 * record can still be read but a new one cannot be written."
 */
async function withRenameFailures<T>(matches: (destination: string) => boolean, fn: () => Promise<T>): Promise<T> {
  const realRename = nodeFs.promises.rename;
  (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = (async (
    from: Parameters<typeof realRename>[0],
    to: Parameters<typeof realRename>[1],
  ) => {
    if (matches(String(to))) throw Object.assign(new Error("EIO: simulated read-only filesystem"), { code: "EIO" });
    return realRename(from, to);
  }) as typeof nodeFs.promises.rename;
  try {
    return await fn();
  } finally {
    (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = realRename;
  }
}

async function gitCommonDirOf(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

async function hooksDirOf(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

const HOOK_NAMES = ["pre-commit", "pre-merge-commit", "pre-push"] as const;

/** Every Shield-owned hook file under `dir`, by name. */
async function shieldHooksIn(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of HOOK_NAMES) {
    const bytes = await fs.readFile(path.join(dir, name)).catch(() => null);
    if (bytes !== null && bytes.includes(SHIELD_ARTIFACT_MARKER)) found.push(name);
  }
  return found;
}

/** The hooks directories Shield's durable record currently names (empty when there is no readable record). */
async function recordedDirs(repo: Repo): Promise<string[]> {
  const recordPath = shieldInstallRecordFilePath(shieldStorageDir(await gitCommonDirOf(repo)));
  const raw = await fs.readFile(recordPath, "utf8").catch(() => null);
  if (raw === null) return [];
  try {
    return (JSON.parse(raw).hookDirs as string[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * INVARIANT (a): every Shield-owned hook that exists anywhere Shield could
 * have installed into is named by the durable record. `candidateDirs` are
 * the hooks directories this test knows Shield has ever been pointed at.
 */
async function assertNoUnrecordedShieldHook(repo: Repo, candidateDirs: string[]): Promise<void> {
  const recorded = await recordedDirs(repo);
  for (const dir of candidateDirs) {
    const live = await shieldHooksIn(dir);
    if (live.length === 0) continue;
    // The record is populated from `fs.realpath`-canonicalized directories
    // (see ShieldManager.resolveGitContext), so a candidate built as a
    // plain JS path.join off a temp-dir root -- which may itself be a
    // symlink, e.g. macOS's /var -> /private/var -- has to be
    // canonicalized the same way before comparing, or a directory Shield
    // correctly recorded reads as "unrecorded" by string mismatch alone.
    const canonicalDir = await fs.realpath(dir).catch(() => dir);
    assert.ok(
      recorded.some((r) => path.resolve(r) === canonicalDir),
      `Shield-owned hooks ${live.join(", ")} exist at ${dir} (${canonicalDir}) but that directory is not in Shield's installation record (${JSON.stringify(recorded)}).`,
    );
  }
}

async function cleanup(repo: Repo): Promise<void> {
  await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
}

// ==================== PART 1: the record is a safety prerequisite ====================

test("PART 1 — FIRST ENABLE with an unwritable install record installs NOTHING, never reports active, and leaves no Shield state behind", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const storage = shieldStorageDir(commonDir);
    await blockPath(shieldInstallRecordFilePath(storage));

    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));

    assert.equal(result.ok, false);
    assert.notEqual(result.inspection.state, "active");
    assert.match(result.inspection.reasons[0], /could not durably record which hooks directory/);
    assert.match(result.inspection.reasons[0], /The identity lock was NOT installed/);
    assert.match(result.inspection.reasons[0], /Nothing was installed/);

    // No hook installed at all.
    assert.deepEqual(await shieldHooksIn(await hooksDirOf(repo)), []);
    // No policy, no evaluator copy left behind.
    assert.equal(await fs.readFile(shieldPolicyFilePath(commonDir), "utf8").catch(() => null), null);
    assert.equal(await fs.readFile(shieldEvaluatorScriptFilePath(commonDir), "utf8").catch(() => null), null);
    await assertNoUnrecordedShieldHook(repo, [await hooksDirOf(repo)]);
  } finally {
    await cleanup(repo);
  }
});

test("PART 1 — after the record fault is cleared, a later Repair succeeds and a later Disable removes everything", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const recordPath = shieldInstallRecordFilePath(shieldStorageDir(commonDir));
    await blockPath(recordPath);
    assert.equal((await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).ok, false);

    await unblockPath(recordPath);
    const repaired = await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    assert.equal(repaired.inspection.state, "active", repaired.inspection.reasons.join(" | "));
    assert.equal(repaired.ok, true);
    assert.deepEqual((await shieldHooksIn(await hooksDirOf(repo))).sort(), [...HOOK_NAMES].sort());
    await assertNoUnrecordedShieldHook(repo, [await hooksDirOf(repo)]);

    const afterDisable = await manager.disable(repo.dir);
    assert.equal(afterDisable.state, "off");
    assert.deepEqual(await shieldHooksIn(await hooksDirOf(repo)), []);
    assert.equal(await fs.readFile(shieldPolicyFilePath(commonDir), "utf8").catch(() => null), null);
    assert.equal(await fs.readFile(shieldEvaluatorScriptFilePath(commonDir), "utf8").catch(() => null), null);
    assert.equal(await fs.readFile(recordPath, "utf8").catch(() => null), null);
  } finally {
    await cleanup(repo);
  }
});

test("PART 1 — REPAIR with an unwritable install record aborts without destroying the existing, working enforcement", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const hooksDir = await hooksDirOf(repo);

    const first = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    assert.equal(first.inspection.state, "active");
    const hookBytesBefore = await fs.readFile(path.join(hooksDir, "pre-commit"));
    const policyBefore = await fs.readFile(shieldPolicyFilePath(commonDir), "utf8");
    const evaluatorBefore = await fs.readFile(shieldEvaluatorScriptFilePath(commonDir));

    // The record stays readable but can no longer be updated. Since the
    // hooks directory has NOT moved, the record already on disk still names
    // every location involved — but Shield must not simply assume that, so
    // this asserts the abort happens on the shape where it genuinely must:
    // the recorded set and the required set differ.
    const recordPath = shieldInstallRecordFilePath(shieldStorageDir(commonDir));
    await fs.writeFile(
      recordPath,
      `${JSON.stringify({ recordVersion: 1, hookDirs: [path.join(repo.dir, "somewhere-else")], updatedAt: 1 }, null, 2)}\n`,
    );

    const repaired = await withRenameFailures(
      (to) => to === recordPath,
      () => manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo)),
    );
    assert.equal(repaired.ok, false);
    assert.equal(repaired.inspection.state, "degraded");
    assert.match(repaired.inspection.reasons[0], /this operation was ABORTED before touching anything/);
    assert.match(repaired.inspection.reasons[0], /unchanged and still enforcing/);

    // (b) existing enforcement is byte-for-byte intact.
    assert.ok(hookBytesBefore.equals(await fs.readFile(path.join(hooksDir, "pre-commit"))));
    assert.deepEqual((await shieldHooksIn(hooksDir)).sort(), [...HOOK_NAMES].sort());
    assert.equal(await fs.readFile(shieldPolicyFilePath(commonDir), "utf8"), policyBefore);
    assert.ok(evaluatorBefore.equals(await fs.readFile(shieldEvaluatorScriptFilePath(commonDir))));

    // (d) once the fault is cleared, Repair recovers and Disable cleans up.
    assert.equal((await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");
    assert.equal((await manager.disable(repo.dir)).state, "off");
    assert.deepEqual(await shieldHooksIn(hooksDir), []);
  } finally {
    await cleanup(repo);
  }
});

test("PART 1 — a hooksPath MIGRATION with an unwritable record never installs into the new, unrecordable location", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const originalHooksDir = await hooksDirOf(repo);

    assert.equal((await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");
    assert.deepEqual((await shieldHooksIn(originalHooksDir)).sort(), [...HOOK_NAMES].sort());

    // Move core.hooksPath somewhere new. The existing record stays READABLE
    // (so Shield still knows about the old location) but cannot be UPDATED
    // to name the new one — the exact condition under which installing
    // there would strand an unrecordable hook.
    const newHooksDir = path.join(repo.dir, "custom-hooks");
    await fs.mkdir(newHooksDir, { recursive: true });
    await git(repo, ["config", "core.hooksPath", newHooksDir]);
    const recordPath = shieldInstallRecordFilePath(shieldStorageDir(commonDir));

    const repaired = await withRenameFailures(
      (to) => to === recordPath,
      () => manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo)),
    );
    assert.equal(repaired.ok, false);
    assert.notEqual(repaired.inspection.state, "active");
    assert.match(repaired.inspection.reasons[0], /this operation was ABORTED before touching anything/);

    // Nothing installed into the unrecordable new location...
    assert.deepEqual(await shieldHooksIn(newHooksDir), []);
    // ...and the previous, known-good installation was NOT destroyed.
    assert.deepEqual((await shieldHooksIn(originalHooksDir)).sort(), [...HOOK_NAMES].sort());

    // Recoverable: clear the fault, repair, and Shield consolidates onto
    // the new location while cleaning up the old one.
    const recovered = await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    assert.equal(recovered.inspection.state, "active", recovered.inspection.reasons.join(" | "));
    assert.deepEqual((await shieldHooksIn(newHooksDir)).sort(), [...HOOK_NAMES].sort());
    assert.deepEqual(await shieldHooksIn(originalHooksDir), []);
    await assertNoUnrecordedShieldHook(repo, [originalHooksDir, newHooksDir]);

    // And Disable reaches everything.
    assert.equal((await manager.disable(repo.dir)).state, "off");
    assert.deepEqual(await shieldHooksIn(newHooksDir), []);
    assert.deepEqual(await shieldHooksIn(originalHooksDir), []);
  } finally {
    await cleanup(repo);
  }
});

test("PART 1 — the record is written as a SUPERSET before any hook moves, so a live hook is never momentarily unrecorded", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const originalHooksDir = await hooksDirOf(repo);
    await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));

    const newHooksDir = path.join(repo.dir, "custom-hooks");
    await fs.mkdir(newHooksDir, { recursive: true });
    await git(repo, ["config", "core.hooksPath", newHooksDir]);

    // Observe the record at the exact moment the first hook is written:
    // it must already name BOTH directories.
    let recordAtFirstHookWrite: string[] = [];
    const realWriteFile = nodeFs.promises.writeFile;
    (nodeFs.promises as { writeFile: typeof nodeFs.promises.writeFile }).writeFile = (async (
      file: Parameters<typeof realWriteFile>[0],
      ...rest: unknown[]
    ) => {
      if (recordAtFirstHookWrite.length === 0 && String(file).includes("pre-commit")) {
        recordAtFirstHookWrite = await recordedDirs(repo);
      }
      return (realWriteFile as (...a: unknown[]) => Promise<void>)(file, ...rest);
    }) as typeof nodeFs.promises.writeFile;

    try {
      await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    } finally {
      (nodeFs.promises as { writeFile: typeof nodeFs.promises.writeFile }).writeFile = realWriteFile;
    }

    // The record holds `fs.realpath`-canonicalized directories (see
    // ShieldManager.resolveGitContext); `newHooksDir` here is a plain
    // path.join off `repo.dir`, which may itself be a symlink (e.g.
    // macOS's /var -> /private/var), so canonicalize before comparing.
    const resolved = recordAtFirstHookWrite.map((d) => path.resolve(d));
    assert.ok(resolved.includes(path.resolve(originalHooksDir)), JSON.stringify(recordAtFirstHookWrite));
    assert.ok(resolved.includes(await fs.realpath(newHooksDir)), JSON.stringify(recordAtFirstHookWrite));
  } finally {
    await cleanup(repo);
  }
});

// ==================== PART 2: fault injection at every install step ====================

test("PART 2 — storage-directory creation failure aborts before any hook is installed", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    // The storage dir path itself occupied by a plain FILE: mkdir fails.
    await fs.writeFile(shieldStorageDir(commonDir), "not a directory");

    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    assert.equal(result.ok, false);
    assert.notEqual(result.inspection.state, "active");
    assert.match(result.inspection.reasons[0], /storage directory .* could not be created/);
    assert.deepEqual(await shieldHooksIn(await hooksDirOf(repo)), []);

    // Recovery.
    await fs.rm(shieldStorageDir(commonDir), { force: true });
    assert.equal((await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");
    assert.equal((await manager.disable(repo.dir)).state, "off");
  } finally {
    await cleanup(repo);
  }
});

test("PART 2 — policy write failure rolls back completely: no hook, no evaluator, nothing stranded", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const hooksDir = await hooksDirOf(repo);
    await blockPath(shieldPolicyFilePath(commonDir));

    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    assert.equal(result.ok, false);
    assert.notEqual(result.inspection.state, "active");
    assert.match(result.inspection.reasons[0], /could not finish installing/);

    assert.deepEqual(await shieldHooksIn(hooksDir), []);
    assert.equal(await fs.readFile(shieldEvaluatorScriptFilePath(commonDir)).catch(() => null), null);
    // Whatever remains, the record still names this hooks directory so a
    // later Disable can reach it — and there is nothing unrecorded.
    await assertNoUnrecordedShieldHook(repo, [hooksDir]);

    await unblockPath(shieldPolicyFilePath(commonDir));
    assert.equal((await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");
    assert.equal((await manager.disable(repo.dir)).state, "off");
  } finally {
    await cleanup(repo);
  }
});

test("PART 2 — evaluator write failure rolls back the policy too, so no hook is ever left without its evaluator", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const hooksDir = await hooksDirOf(repo);
    await blockPath(shieldEvaluatorScriptFilePath(commonDir));

    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    assert.equal(result.ok, false);
    assert.notEqual(result.inspection.state, "active");
    // THE invariant that matters under fail-closed shims: no hook exists
    // that would block every operation because its evaluator is missing.
    assert.deepEqual(await shieldHooksIn(hooksDir), []);
    // And the policy write that DID succeed was rolled back.
    assert.equal(await fs.readFile(shieldPolicyFilePath(commonDir), "utf8").catch(() => null), null);

    await unblockPath(shieldEvaluatorScriptFilePath(commonDir));
    assert.equal((await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");
    assert.equal((await manager.disable(repo.dir)).state, "off");
  } finally {
    await cleanup(repo);
  }
});

test("PART 2 — a hook write failure rolls back every earlier write in reverse order (hooks, then evaluator, then policy)", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);
    const hooksDir = await hooksDirOf(repo);

    // Fail the rename of exactly ONE hook (pre-push, the last one written),
    // so pre-commit and pre-merge-commit have already landed when it blows
    // up — the case where a partial, live, fail-closed install would remain.
    const realRename = nodeFs.promises.rename;
    (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = (async (
      from: Parameters<typeof realRename>[0],
      to: Parameters<typeof realRename>[1],
    ) => {
      if (String(to).endsWith(`${path.sep}pre-push`)) {
        throw Object.assign(new Error("EIO: simulated disk failure"), { code: "EIO" });
      }
      return realRename(from, to);
    }) as typeof nodeFs.promises.rename;

    let result;
    try {
      result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
    } finally {
      (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = realRename;
    }

    assert.equal(result.ok, false);
    assert.notEqual(result.inspection.state, "active");
    assert.match(result.inspection.reasons[0], /could not finish installing/);

    // Full rollback: no hook survived, and the evaluator/policy went with them.
    assert.deepEqual(await shieldHooksIn(hooksDir), []);
    assert.equal(await fs.readFile(shieldEvaluatorScriptFilePath(commonDir)).catch(() => null), null);
    assert.equal(await fs.readFile(shieldPolicyFilePath(commonDir), "utf8").catch(() => null), null);
    await assertNoUnrecordedShieldHook(repo, [hooksDir]);

    assert.equal((await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");
    assert.equal((await manager.disable(repo.dir)).state, "off");
  } finally {
    await cleanup(repo);
  }
});

test("PART 2 — a foreign-hook SIDECAR write failure never destroys or loses the foreign hook", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const hooksDir = await hooksDirOf(repo);
    await fs.mkdir(hooksDir, { recursive: true });
    const foreignBody = "#!/bin/sh\necho 'husky-ish'\nexit 0\n";
    await fs.writeFile(path.join(hooksDir, "pre-commit"), foreignBody, { mode: 0o755 });

    const realRename = nodeFs.promises.rename;
    (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = (async (
      from: Parameters<typeof realRename>[0],
      to: Parameters<typeof realRename>[1],
    ) => {
      if (String(to).endsWith(".repo-identity-guard-original")) {
        throw Object.assign(new Error("EIO: simulated disk failure"), { code: "EIO" });
      }
      return realRename(from, to);
    }) as typeof nodeFs.promises.rename;

    let result;
    try {
      result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo, true));
    } finally {
      (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = realRename;
    }

    assert.equal(result.ok, false);
    assert.notEqual(result.inspection.state, "active");
    // The foreign hook is exactly as it was — never moved, never replaced.
    assert.equal(await fs.readFile(path.join(hooksDir, "pre-commit"), "utf8"), foreignBody);
    assert.equal(await fs.readFile(path.join(hooksDir, "pre-commit.repo-identity-guard-original"), "utf8").catch(() => null), null);
    // And Shield installed no hook of its own anywhere.
    assert.deepEqual(await shieldHooksIn(hooksDir), []);
  } finally {
    await cleanup(repo);
  }
});

test("PART 2 — a repair that fails mid-install restores the PREVIOUS Shield hooks byte-for-byte rather than leaving a half-written one", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const hooksDir = await hooksDirOf(repo);
    assert.equal((await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo))).inspection.state, "active");

    const before = new Map<string, Buffer>();
    for (const name of HOOK_NAMES) before.set(name, await fs.readFile(path.join(hooksDir, name)));

    const realRename = nodeFs.promises.rename;
    (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = (async (
      from: Parameters<typeof realRename>[0],
      to: Parameters<typeof realRename>[1],
    ) => {
      if (String(to).endsWith(`${path.sep}pre-push`)) {
        throw Object.assign(new Error("EIO: simulated disk failure"), { code: "EIO" });
      }
      return realRename(from, to);
    }) as typeof nodeFs.promises.rename;

    try {
      const repaired = await manager.repair(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
      assert.equal(repaired.ok, false);
    } finally {
      (nodeFs.promises as { rename: typeof nodeFs.promises.rename }).rename = realRename;
    }

    // Enforcement never regressed: every hook is back to exactly the bytes
    // it had before the failed repair — fail-closed is preserved, and no
    // hook was left without an evaluator.
    for (const name of HOOK_NAMES) {
      assert.ok(before.get(name)!.equals(await fs.readFile(path.join(hooksDir, name))), `${name} was not restored`);
    }
    assert.equal((await manager.disable(repo.dir)).state, "off");
  } finally {
    await cleanup(repo);
  }
});

test("PART 2 — inspect() describes each failed-install residue accurately and never reports ACTIVE out of one", async () => {
  const repo = await makeRepo();
  try {
    const manager = new ShieldManager();
    const commonDir = await gitCommonDirOf(repo);

    for (const blocked of [
      shieldInstallRecordFilePath(shieldStorageDir(commonDir)),
      shieldPolicyFilePath(commonDir),
      shieldEvaluatorScriptFilePath(commonDir),
    ]) {
      await blockPath(blocked);
      const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, enableInput(repo));
      assert.equal(result.ok, false, `expected failure with ${blocked} blocked`);
      assert.notEqual(result.inspection.state, "active");
      // A fresh, independent inspection agrees — the verdict is re-derived
      // from disk, never carried over from the failed operation.
      const fresh = await manager.inspect(repo.dir);
      assert.notEqual(fresh.state, "active", `${blocked}: fresh inspect reported active`);
      await unblockPath(blocked);
      await manager.disable(repo.dir).catch(() => undefined);
    }
  } finally {
    await cleanup(repo);
  }
});
