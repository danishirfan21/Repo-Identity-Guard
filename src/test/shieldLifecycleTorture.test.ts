import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { SHIELD_ARTIFACT_MARKER, SHIELD_ARTIFACT_VERSION } from "../shield/artifacts";
import { ShieldInspection, ShieldManager } from "../shield/manager";
import { shieldEvaluatorScriptFilePath, shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { shieldInstallRecordFilePath } from "../shield/installRecord";
import { fuzzSeed, rngFrom } from "./fuzzHarness";
import type { Identity } from "../identity/types";
import { WORK_IDENTITY } from "./testUtil/lockFixtures";

/**
 * PART 10 — lifecycle state-machine torture test.
 *
 * Shield's lifecycle is not a straight line. In real use it is a long,
 * arbitrary sequence: enable, health-check, edit a profile, repair, move
 * `core.hooksPath`, add a worktree, have a foreign hook appear, delete the
 * evaluator, corrupt the install record, disable, enable again. Individual
 * transitions all have their own tests; what those cannot catch is a state
 * only reachable after five operations in a particular order.
 *
 * So this drives randomized (seeded, reproducible) operation sequences
 * against real Git repositories and re-asserts the same invariants after
 * EVERY transition:
 *
 *  A. ACTIVE implies everything ACTIVE claims — a valid policy, a
 *     supported Git, an evaluator present and Shield-owned and at the
 *     current artifact version, every hook the policy governs present and
 *     Shield-owned and byte-current, no unresolved recorded orphan, and no
 *     detected drift. An "active" that is any of those things minus one is
 *     the single most dangerous state Shield can report, because the user
 *     stops looking.
 *  B. OFF implies no live Shield-owned hook remains at any hooks directory
 *     Shield knows about — unless the operation explicitly reported an
 *     unresolved cleanup condition.
 *  C. No operation ever deletes or modifies a FOREIGN hook. The exact
 *     bytes of every foreign file placed during the run are re-checked
 *     after every step.
 *  D. No corrupted state ever reports ACTIVE.
 *  E. Repeated operations are idempotent where they should be: a second
 *     enable/repair/disable in a row changes nothing.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");
const SEED = fuzzSeed(0x70127e);
const SEQUENCES = 12;
const STEPS_PER_SEQUENCE = 14;

const HOOK_NAMES = ["pre-commit", "pre-merge-commit", "pre-push"] as const;

/**
 * The options the EXTENSION actually passes (see `checkShieldHealth` in
 * src/extension.ts). Inspecting without `evaluatorScriptSource` cannot
 * populate `evaluatorModified` at all — it is documented as `false`, never
 * "unknown" — so a torture test that omitted it would be quietly unable to
 * see a hand-edited evaluator, which is one of the exact tamper cases it
 * exists to catch.
 */
const INSPECT_OPTIONS = { evaluatorScriptSource: EVALUATOR_SOURCE } as const;

// A commit-only identity, and one that also enforces push identity (all
// three hooks governed) — repairs alternate between them.
const profileA: Identity = WORK_IDENTITY;
const profileB: Identity = { ...WORK_IDENTITY, gitEmail: "work2@example.com", expectedGitHubLogin: "danish-work" };

function lockInput(identity: Identity, chainForeignHooks?: boolean) {
  return { identity, lockId: "torture", assignedAt: 1, chainForeignHooks };
}

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
  gitCommonDir: string;
  /** Foreign files placed during this run, with the exact bytes they must still have. */
  foreign: Map<string, Buffer>;
  /** Every hooks directory this run has ever pointed Git at. */
  knownHookDirs: Set<string>;
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

async function makeRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-torture-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, "gc"),
    GIT_CONFIG_SYSTEM: path.join(dir, "gs"),
  };
  await fs.writeFile(path.join(dir, "gc"), "");
  await fs.writeFile(path.join(dir, "gs"), "");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["config", "user.name", "Danish Irfan"], { cwd: dir, env });
  execFileSync("git", ["config", "user.email", "work@example.com"], { cwd: dir, env });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:AcmeSoftware/thing.git"], { cwd: dir, env });
  await fs.writeFile(path.join(dir, "f.txt"), "hi\n");
  execFileSync("git", ["add", "f.txt"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
  const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: dir,
    env,
    encoding: "utf8",
  }).trim();
  const repo: Repo = { dir, env, gitCommonDir, foreign: new Map(), knownHookDirs: new Set() };
  repo.knownHookDirs.add(await hooksDirOf(repo));
  return repo;
}

async function hooksDirOf(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

async function readBytes(file: string): Promise<Buffer | null> {
  return fs.readFile(file).catch(() => null);
}

async function isShieldOwned(file: string): Promise<boolean> {
  const bytes = await readBytes(file);
  return bytes !== null && bytes.includes(SHIELD_ARTIFACT_MARKER);
}

async function liveShieldHooks(repo: Repo): Promise<string[]> {
  const found: string[] = [];
  for (const dir of repo.knownHookDirs) {
    for (const name of HOOK_NAMES) {
      const file = path.join(dir, name);
      if (await isShieldOwned(file)) found.push(file);
    }
  }
  return found;
}

async function recordedDirs(repo: Repo): Promise<string[]> {
  const raw = await fs.readFile(shieldInstallRecordFilePath(shieldStorageDir(repo.gitCommonDir)), "utf8").catch(() => null);
  if (raw === null) return [];
  try {
    return (JSON.parse(raw).hookDirs as string[]) ?? [];
  } catch {
    return [];
  }
}

// ==================== the invariants ====================

async function assertInvariants(repo: Repo, manager: ShieldManager, inspection: ShieldInspection, context: string): Promise<void> {
  const where = `${context}\n  state=${inspection.state}\n  reasons=${JSON.stringify(inspection.reasons)}`;

  // ---- C: a foreign file's exact bytes are never lost ----
  //
  // Two legal resting places, and only two: the hook path itself (Shield
  // left it alone, the default) or its `.repo-identity-guard-original`
  // sidecar (Shield CHAINED it, which these sequences opt into at random).
  // Chaining is a deliberate, explicit move -- not a deletion -- and the
  // bytes must be identical either way. Anything else means Shield
  // destroyed or rewrote a file it does not own.
  for (const [file, expected] of repo.foreign) {
    const atHook = await readBytes(file);
    const atSidecar = await readBytes(`${file}.repo-identity-guard-original`);
    const found = [atHook, atSidecar].filter((b): b is Buffer => b !== null);
    assert.ok(
      found.length > 0,
      `a FOREIGN file was deleted (present at neither ${file} nor its chained-original sidecar)\n${where}`,
    );
    assert.ok(
      found.some((bytes) => expected.equals(bytes)),
      `a FOREIGN file's bytes were modified: ${file}\n${where}`,
    );
  }

  // ---- A: ACTIVE means everything ACTIVE claims ----
  if (inspection.state === "active") {
    assert.equal(inspection.policyPresent, true, `active with no policy\n${where}`);
    assert.equal(inspection.policyValid, true, `active with an invalid policy\n${where}`);
    assert.equal(inspection.gitVersionSupported, true, `active on an unsupported Git\n${where}`);
    assert.equal(inspection.evaluatorPresent, true, `active with no evaluator\n${where}`);
    assert.equal(inspection.evaluatorOwned, true, `active with a foreign evaluator\n${where}`);
    assert.equal(inspection.evaluatorModified, false, `active with a modified evaluator\n${where}`);
    assert.equal(inspection.evaluatorVersion, SHIELD_ARTIFACT_VERSION, `active with an outdated evaluator\n${where}`);
    assert.deepEqual(inspection.orphanedHookPaths, [], `active with recorded orphans\n${where}`);
    assert.equal(inspection.identityDrift, false, `active with identity drift\n${where}`);
    // Every hook is the lock's own: a lock governs commit AND push for
    // every identity (one with no GitHub login blocks pushes through its
    // pre-push hook), so no slot may be left to a foreign hook.
    for (const hook of inspection.hooks) {
      assert.equal(hook.ownership, "shield", `active with a ${hook.ownership} ${hook.fileName}\n${where}`);
      assert.equal(hook.contentModified, false, `active with a modified ${hook.fileName}\n${where}`);
      assert.equal(hook.version, SHIELD_ARTIFACT_VERSION, `active with an outdated ${hook.fileName}\n${where}`);
      // And it is genuinely on disk right now, not merely reported so.
      assert.ok(await isShieldOwned(hook.path), `active but ${hook.path} is not Shield-owned on disk\n${where}`);
    }
    // Every live hook is recorded, so Disable can reach it.
    const recorded = (await recordedDirs(repo)).map((d) => path.resolve(d));
    for (const live of await liveShieldHooks(repo)) {
      assert.ok(recorded.includes(path.resolve(path.dirname(live))), `active with an UNRECORDED live hook at ${live}\n${where}`);
    }
  }

  // ---- B: OFF means nothing of Shield's is still live ----
  if (inspection.state === "off" && inspection.reasons.length === 0) {
    assert.deepEqual(await liveShieldHooks(repo), [], `off but Shield-owned hooks remain\n${where}`);
  }

  // ---- D: the verdict is re-derivable, never carried over ----
  const fresh = await manager.inspect(repo.dir, INSPECT_OPTIONS);
  assert.equal(fresh.state, inspection.state === "active" ? "active" : fresh.state, "state is not stable across a re-inspection");
  if (inspection.state === "active") {
    assert.equal(fresh.state, "active", `a re-inspection disagreed with an "active" verdict\n${where}`);
  }
}

// ==================== the operations ====================

type Op = { name: string; run: (repo: Repo, manager: ShieldManager) => Promise<void> };

function operations(rng: ReturnType<typeof rngFrom>): Op[] {
  return [
    {
      name: "enable",
      run: async (repo, manager) => {
        await manager.enable(repo.dir, EVALUATOR_SOURCE, lockInput(profileA, rng.bool(0.4)));
      },
    },
    {
      name: "repair",
      run: async (repo, manager) => {
        await manager.repair(repo.dir, EVALUATOR_SOURCE, lockInput(rng.bool() ? profileA : profileB, rng.bool(0.4)));
      },
    },
    { name: "disable", run: async (repo, manager) => void (await manager.disable(repo.dir)) },
    { name: "health-check", run: async (repo, manager) => void (await manager.healthCheck(repo.dir, INSPECT_OPTIONS)) },
    {
      name: "change core.hooksPath",
      run: async (repo) => {
        const dir = path.join(repo.dir, `hooks-${rng.int(3)}`);
        await fs.mkdir(dir, { recursive: true });
        await git(repo, ["config", "core.hooksPath", dir]);
        repo.knownHookDirs.add(await hooksDirOf(repo));
      },
    },
    {
      name: "unset core.hooksPath",
      run: async (repo) => {
        await git(repo, ["config", "--unset", "core.hooksPath"]).catch(() => undefined);
        repo.knownHookDirs.add(await hooksDirOf(repo));
      },
    },
    {
      name: "change pushurl",
      run: async (repo) => {
        await git(repo, ["remote", "set-url", "--push", "origin", `git@github.com:Other${rng.int(3)}/thing.git`]).catch(() => undefined);
      },
    },
    {
      name: "a foreign hook appears",
      run: async (repo) => {
        const hooksDir = await hooksDirOf(repo);
        await fs.mkdir(hooksDir, { recursive: true });
        const name = HOOK_NAMES[rng.int(HOOK_NAMES.length)];
        const file = path.join(hooksDir, name);
        if (await isShieldOwned(file)) return; // never clobber Shield's own with a "foreign" one
        const body = Buffer.from(`#!/bin/sh\n# foreign tool ${rng.int(1000)}\nexit 0\n`);
        await fs.writeFile(file, body, { mode: 0o755 });
        repo.foreign.set(file, body);
      },
    },
    {
      name: "a foreign hook disappears",
      run: async (repo) => {
        const entries = [...repo.foreign.keys()];
        if (entries.length === 0) return;
        const file = entries[rng.int(entries.length)];
        await fs.rm(file, { force: true });
        repo.foreign.delete(file);
      },
    },
    {
      name: "delete the evaluator",
      run: async (repo) => void (await fs.rm(shieldEvaluatorScriptFilePath(repo.gitCommonDir), { force: true })),
    },
    {
      name: "corrupt the evaluator",
      run: async (repo) => {
        const file = shieldEvaluatorScriptFilePath(repo.gitCommonDir);
        if ((await readBytes(file)) === null) return;
        await fs.appendFile(file, "\n# tampered\n");
      },
    },
    {
      name: "delete a Shield hook",
      run: async (repo) => {
        const hooksDir = await hooksDirOf(repo);
        const name = HOOK_NAMES[rng.int(HOOK_NAMES.length)];
        const file = path.join(hooksDir, name);
        if (await isShieldOwned(file)) await fs.rm(file, { force: true });
      },
    },
    {
      name: "modify a Shield hook",
      run: async (repo) => {
        const hooksDir = await hooksDirOf(repo);
        const name = HOOK_NAMES[rng.int(HOOK_NAMES.length)];
        const file = path.join(hooksDir, name);
        if (await isShieldOwned(file)) await fs.appendFile(file, "\n# hand-edited\n");
      },
    },
    {
      name: "corrupt the policy",
      run: async (repo) => {
        const file = shieldPolicyFilePath(repo.gitCommonDir);
        if ((await readBytes(file)) === null) return;
        await fs.writeFile(file, rng.bool() ? "{ not json" : JSON.stringify({ policyVersion: 99 }));
      },
    },
    {
      name: "delete the policy",
      run: async (repo) => void (await fs.rm(shieldPolicyFilePath(repo.gitCommonDir), { force: true })),
    },
    {
      name: "corrupt the install record",
      run: async (repo) => {
        const file = shieldInstallRecordFilePath(shieldStorageDir(repo.gitCommonDir));
        if ((await readBytes(file)) === null) return;
        await fs.writeFile(file, rng.bool() ? "}}garbage" : JSON.stringify({ recordVersion: 42, hookDirs: ["relative/path"] }));
      },
    },
    {
      name: "delete the install record",
      run: async (repo) => void (await fs.rm(shieldInstallRecordFilePath(shieldStorageDir(repo.gitCommonDir)), { force: true })),
    },
    {
      name: "add a worktree",
      run: async (repo) => {
        const wt = path.join(repo.dir, `wt-${rng.int(3)}`);
        await git(repo, ["worktree", "add", "-q", "-b", `wt-${rng.int(1000)}`, wt]).catch(() => undefined);
      },
    },
    {
      name: "remove all worktrees",
      run: async (repo) => {
        const listing = await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "");
        for (const line of listing.split("\n")) {
          const match = /^worktree (.+)$/.exec(line.trim());
          if (match && path.resolve(match[1]) !== path.resolve(repo.dir)) {
            await git(repo, ["worktree", "remove", "--force", match[1]]).catch(() => undefined);
          }
        }
      },
    },
  ];
}

// ==================== the sweep ====================

test("PART 10 — randomized lifecycle sequences never break Shield's invariants", { timeout: 900_000 }, async () => {
  const rng = rngFrom(SEED);
  const manager = new ShieldManager();

  for (let sequence = 0; sequence < SEQUENCES; sequence++) {
    const repo = await makeRepo();
    const ops = operations(rng);
    const trail: string[] = [];
    try {
      for (let step = 0; step < STEPS_PER_SEQUENCE; step++) {
        const op = ops[rng.int(ops.length)];
        trail.push(op.name);
        await op.run(repo, manager);
        repo.knownHookDirs.add(await hooksDirOf(repo));
        const inspection = await manager.inspect(repo.dir, INSPECT_OPTIONS);
        await assertInvariants(
          repo,
          manager,
          inspection,
          `seed ${SEED}, sequence ${sequence}, after step ${step} "${op.name}"\n  trail: ${trail.join(" -> ")}`,
        );
      }

      // ---- every sequence ends the same way: repair back to health, then
      // disable, and the repository must be genuinely clean afterwards ----
      await git(repo, ["config", "--unset", "core.hooksPath"]).catch(() => undefined);
      await git(repo, ["remote", "set-url", "--push", "origin", "git@github.com:AcmeSoftware/thing.git"]).catch(() => undefined);
      // Clear any foreign hook standing in Shield's way, so "repair returns
      // to health" is a fair expectation rather than a coexistence test.
      for (const file of [...repo.foreign.keys()]) {
        await fs.rm(file, { force: true });
        repo.foreign.delete(file);
      }
      const repaired = await manager.repair(repo.dir, EVALUATOR_SOURCE, lockInput(profileB));
      assert.equal(
        repaired.inspection.state,
        "active",
        `seed ${SEED}, sequence ${sequence}: repair could not restore health after ${trail.join(" -> ")}\n${repaired.inspection.reasons.join(" | ")}`,
      );
      await assertInvariants(repo, manager, repaired.inspection, `seed ${SEED}, sequence ${sequence}, final repair`);

      // Idempotence: a second repair changes nothing.
      const again = await manager.repair(repo.dir, EVALUATOR_SOURCE, lockInput(profileB));
      assert.equal(again.inspection.state, "active");

      const off = await manager.disable(repo.dir);
      assert.equal(off.state, "off", `seed ${SEED}, sequence ${sequence}: disable left ${off.state}: ${off.reasons.join(" | ")}`);
      assert.deepEqual(
        await liveShieldHooks(repo),
        [],
        `seed ${SEED}, sequence ${sequence}: Shield-owned hooks survived disable after ${trail.join(" -> ")}`,
      );
      assert.equal(await readBytes(shieldPolicyFilePath(repo.gitCommonDir)), null);
      assert.equal(await readBytes(shieldEvaluatorScriptFilePath(repo.gitCommonDir)), null);

      // Idempotence: a second disable is a clean no-op.
      const offAgain = await manager.disable(repo.dir);
      assert.equal(offAgain.state, "off");
      assert.deepEqual(offAgain.reasons, []);
    } finally {
      await git(repo, ["worktree", "prune"]).catch(() => undefined);
      await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

test("PART 10 — a corrupted state never reports ACTIVE, for every single-fault corruption", async () => {
  const manager = new ShieldManager();
  const corruptions: Array<[string, (repo: Repo) => Promise<void>]> = [
    ["policy deleted", async (repo) => void (await fs.rm(shieldPolicyFilePath(repo.gitCommonDir), { force: true }))],
    ["policy corrupted", async (repo) => void (await fs.writeFile(shieldPolicyFilePath(repo.gitCommonDir), "{"))],
    ["evaluator deleted", async (repo) => void (await fs.rm(shieldEvaluatorScriptFilePath(repo.gitCommonDir), { force: true }))],
    ["evaluator modified", async (repo) => void (await fs.appendFile(shieldEvaluatorScriptFilePath(repo.gitCommonDir), "\n#x\n"))],
    ["evaluator replaced by a foreign script", async (repo) => void (await fs.writeFile(shieldEvaluatorScriptFilePath(repo.gitCommonDir), "#!/bin/sh\nexit 0\n"))],
    ["pre-commit deleted", async (repo) => void (await fs.rm(path.join(await hooksDirOf(repo), "pre-commit"), { force: true }))],
    ["pre-merge-commit deleted", async (repo) => void (await fs.rm(path.join(await hooksDirOf(repo), "pre-merge-commit"), { force: true }))],
    ["pre-push deleted", async (repo) => void (await fs.rm(path.join(await hooksDirOf(repo), "pre-push"), { force: true }))],
    ["pre-commit modified", async (repo) => void (await fs.appendFile(path.join(await hooksDirOf(repo), "pre-commit"), "\n#x\n"))],
    [
      "core.hooksPath moved away, orphaning the install",
      async (repo) => {
        const dir = path.join(repo.dir, "elsewhere");
        await fs.mkdir(dir, { recursive: true });
        await git(repo, ["config", "core.hooksPath", dir]);
        repo.knownHookDirs.add(dir);
      },
    ],
  ];

  for (const [label, corrupt] of corruptions) {
    const repo = await makeRepo();
    try {
      // profileB enforces push too, so all three hooks are governed and
      // every single-fault corruption below must surface.
      const enabled = await manager.enable(repo.dir, EVALUATOR_SOURCE, lockInput(profileB));
      assert.equal(enabled.inspection.state, "active", `precondition failed for "${label}"`);

      await corrupt(repo);
      const inspection = await manager.inspect(repo.dir, INSPECT_OPTIONS);
      assert.notEqual(inspection.state, "active", `"${label}" still reported ACTIVE`);
      assert.ok(inspection.reasons.length > 0, `"${label}" reported ${inspection.state} with no explanation`);

      // ...and every one of them is recoverable, then cleanly removable.
      await git(repo, ["config", "--unset", "core.hooksPath"]).catch(() => undefined);
      const repaired = await manager.repair(repo.dir, EVALUATOR_SOURCE, lockInput(profileB));
      assert.equal(repaired.inspection.state, "active", `"${label}" was not repairable: ${repaired.inspection.reasons.join(" | ")}`);
      assert.equal((await manager.disable(repo.dir)).state, "off", `"${label}" was not cleanly disableable`);
      assert.deepEqual(await liveShieldHooks(repo), [], `"${label}" left Shield hooks behind after disable`);
    } finally {
      await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

test("PART 10 — a foreign hook is never deleted by enable, repair, or disable, in any order", async () => {
  const manager = new ShieldManager();
  const repo = await makeRepo();
  try {
    const hooksDir = await hooksDirOf(repo);
    await fs.mkdir(hooksDir, { recursive: true });
    const foreignBody = Buffer.from("#!/bin/sh\n# husky-ish\nexit 0\n");
    for (const name of HOOK_NAMES) {
      await fs.writeFile(path.join(hooksDir, name), foreignBody, { mode: 0o755 });
      repo.foreign.set(path.join(hooksDir, name), foreignBody);
    }

    const input = lockInput(profileB);
    for (const step of ["enable", "repair", "disable", "enable"] as const) {
      if (step === "disable") await manager.disable(repo.dir);
      else await manager[step](repo.dir, EVALUATOR_SOURCE, input);
      for (const [file, expected] of repo.foreign) {
        const actual = await readBytes(file);
        assert.notEqual(actual, null, `${step} deleted the foreign hook ${file}`);
        assert.ok(expected.equals(actual as Buffer), `${step} modified the foreign hook ${file}`);
      }
    }

    // Shield never got installed into any of the three occupied slots, and
    // said so rather than claiming active.
    const inspection = await manager.inspect(repo.dir, INSPECT_OPTIONS);
    assert.equal(inspection.state, "degraded", inspection.reasons.join(" | "));
    assert.ok(inspection.reasons.some((r) => /did not create/.test(r)));

    // And a final disable still leaves every foreign hook untouched.
    await manager.disable(repo.dir);
    for (const [file, expected] of repo.foreign) {
      const actual = await readBytes(file);
      assert.notEqual(actual, null, `disable deleted the foreign hook ${file}`);
      assert.ok(expected.equals(actual as Buffer), `disable modified the foreign hook ${file}`);
    }
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
