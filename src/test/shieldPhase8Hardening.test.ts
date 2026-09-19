import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { collectRepoFacts } from "../services/gitService";
import { SHIELD_CHAIN_ORIGINAL_SUFFIX } from "../shield/artifacts";
import {
  SHIELD_MIN_GIT_VERSION_DISPLAY,
  compareGitVersions,
  evaluateGitVersionSupport,
  parseGitVersion,
} from "../shield/gitVersion";
import {
  isGitHubSshEndpoint,
  parseSshEffectiveRoute,
  sshConfigHasIdentitiesOnly,
} from "../shield/githubSshVerification";
import {
  normalizeHookDirs,
  parseShieldInstallRecord,
  sameHookDir,
  serializeShieldInstallRecord,
  shieldInstallRecordFilePath,
} from "../shield/installRecord";
import { ShieldManager } from "../shield/manager";
import { parseShieldPolicy } from "../shield/policy";
import { shieldStorageDir } from "../shield/storage";
import { Profile, RepoFacts } from "../types";

/**
 * Phase 8 — core correctness hardening.
 *
 * Every test here was written to reproduce a specific, empirically
 * confirmed defect BEFORE the corresponding fix landed, and each names the
 * defect it pins down. Real temporary Git repositories, the real shipped
 * evaluator, and the real `git` binary throughout — nothing here mocks
 * Shield's own behavior.
 *
 * Areas covered:
 *  - approved push destination is built from the plain-push destination,
 *    not origin's fetch URL (`branch.<name>.pushRemote`,
 *    `remote.pushDefault`, `remote.<name>.pushurl`, asymmetric fetch/push);
 *  - full-integrity health checks (evaluator drift, profile drift, push
 *    destination drift) and `inspect()` staying strictly read-only;
 *  - durable installation metadata, `core.hooksPath` drift, orphaned
 *    hooks, and worktrees;
 *  - foreign-hook chaining safety (binary, symlink, non-executable);
 *  - Shield's minimum Git version;
 *  - SSH effective-route parsing.
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  strictPushSetup: true,
  trustedSshHostAliases: ["github-work"],
};

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

async function makeTempRepo(prefix = "shield-p8-"): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const repo: Repo = { dir, env };
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", workProfile.gitName as string]);
  await git(repo, ["config", "user.email", workProfile.gitEmail]);
  await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
  await git(repo, ["add", "f.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
}

async function hooksDirFor(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

async function commonDirFor(repo: Repo): Promise<string> {
  return git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true).catch(() => false);
}

/**
 * A fake `ssh -G` that echoes back whatever host/alias it was asked
 * about, matching real unconfigured-OpenSSH passthrough behavior. Used so
 * that `approvedPushDestination.canonicalHost/canonicalPort` resolve to a
 * deterministic value regardless of whether the machine running these
 * tests has a real `ssh` binary on PATH at all (CI images do; this
 * sandbox does not).
 */
let identityFakeSshBinPromise: Promise<string> | undefined;
async function identityFakeSshBin(): Promise<string> {
  if (!identityFakeSshBinPromise) {
    identityFakeSshBinPromise = (async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p8-identity-ssh-"));
      const implPath = path.join(binDir, "impl.js");
      await fs.writeFile(
        implPath,
        `"use strict";
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  const target = args[args.length - 1] || "";
  const at = target.lastIndexOf("@");
  const host = at !== -1 ? target.slice(at + 1) : target;
  let port = "22";
  const pIdx = args.indexOf("-p");
  if (pIdx !== -1 && args[pIdx + 1]) port = args[pIdx + 1];
  process.stdout.write("user git\\nhostname " + host.toLowerCase() + "\\nport " + port + "\\n");
  process.exit(0);
}
process.stderr.write("fake-ssh-identity: unexpected invocation: " + joined + "\\n");
process.exit(1);
`,
      );
      await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
      await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
      return binDir;
    })();
  }
  return identityFakeSshBinPromise;
}

function withIdentityFakeSshPath(env: NodeJS.ProcessEnv, fakeSshBin: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  let existingPath: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      existingPath = existingPath ?? value;
      continue;
    }
    result[key] = value;
  }
  result.PATH = `${fakeSshBin}${path.delimiter}${existingPath ?? ""}`;
  return result;
}

/**
 * Enables Shield from facts collected FRESH off the real repository, the
 * way the extension command now does — so what these tests assert about
 * `approvedPushDestination` reflects the real `git config` arrangement
 * each test set up, not a hand-written fixture that could quietly disagree
 * with it.
 */
async function enableFromRealRepo(
  manager: ShieldManager,
  repo: Repo,
  profiles: Profile[] = [workProfile],
  env?: NodeJS.ProcessEnv,
): Promise<{ facts: RepoFacts; result: Awaited<ReturnType<ShieldManager["enable"]>> }> {
  const facts = await collectRepoFacts(repo.dir);
  const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, { facts, profiles, protectedBranches: [], env });
  return { facts, result };
}

async function readPolicy(repo: Repo) {
  const commonDir = await commonDirFor(repo);
  const raw = await fs.readFile(path.join(commonDir, "repo-identity-guard", "shield-policy.json"), "utf8");
  const parsed = parseShieldPolicy(raw);
  assert.equal(parsed.ok, true, `policy should be valid: ${JSON.stringify(parsed)}`);
  return (parsed as { ok: true; policy: ReturnType<typeof parseShieldPolicy> extends never ? never : never }).ok
    ? (parsed as unknown as { policy: import("../shield/policy").ShieldPolicy }).policy
    : (undefined as never);
}

// ====================================================================
// FINDING 4 — approved push destination must come from the plain-push
// destination, never from origin's fetch URL.
//
// Confirmed defect: buildPolicyForRepo built approvedPushDestination from
// facts.remoteHost/remoteOwner/remoteRepo (origin FETCH). Git offers four
// separate ways for the push destination to differ from origin's fetch
// URL, and in every one of them Shield approved the wrong place.
// ====================================================================

test("push destination: an ordinary repo whose only remote is origin approves origin's owner/repo (baseline)", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    const env = withIdentityFakeSshPath(repo.env, await identityFakeSshBin());
    const { result } = await enableFromRealRepo(manager, repo, [workProfile], env);
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));

    const policy = await readPolicy(repo);
    assert.deepEqual(policy.approvedPushDestination, {
      host: "github-work",
      owner: "AcmeSoftware",
      repo: "acme-frontend",
      canonicalHost: "github-work",
      canonicalPort: "22",
    });
  } finally {
    await cleanup(repo.dir);
  }
});

test("push destination: branch.<name>.pushRemote is what gets approved, NOT origin's fetch URL", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    await git(repo, ["remote", "add", "elsewhere", "git@github-work:AcmeSoftware/acme-mirror.git"]);
    await git(repo, ["config", "branch.main.pushRemote", "elsewhere"]);

    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);
    const policy = await readPolicy(repo);

    assert.equal(policy.approvedPushDestination?.repo, "acme-mirror", "must approve where a plain push ACTUALLY lands");
    // The canonical repository identity is still origin-based — the two
    // facts are deliberately not conflated.
    assert.match(policy.approvedRepositoryKey as string, /acme-frontend/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("push destination: remote.pushDefault is what gets approved", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    await git(repo, ["remote", "add", "publish", "git@github-work:AcmeSoftware/acme-published.git"]);
    await git(repo, ["config", "remote.pushDefault", "publish"]);

    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);
    const policy = await readPolicy(repo);
    assert.equal(policy.approvedPushDestination?.repo, "acme-published");
  } finally {
    await cleanup(repo.dir);
  }
});

test("push destination: remote.<name>.pushurl (asymmetric fetch/push URL) is what gets approved, not the fetch URL", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    await git(repo, ["config", "remote.origin.pushurl", "git@github-work:AcmeSoftware/acme-writable.git"]);

    const manager = new ShieldManager();
    const { facts } = await enableFromRealRepo(manager, repo);
    // Sanity: the fact collection itself really did separate the two.
    assert.equal(facts.remoteRepo, "acme-frontend");
    assert.equal(facts.pushRemoteRepo, "acme-writable");

    const policy = await readPolicy(repo);
    assert.equal(policy.approvedPushDestination?.repo, "acme-writable");
  } finally {
    await cleanup(repo.dir);
  }
});

test("push destination: an origin fetch remote under a DIFFERENT owner than the push destination approves the push owner", async () => {
  const repo = await makeTempRepo();
  try {
    // The classic fork arrangement inverted: fetch from upstream's URL on
    // origin, push to the user's own fork.
    await git(repo, ["remote", "add", "origin", "git@github-work:UpstreamOrg/acme-frontend.git"]);
    await git(repo, ["config", "remote.origin.pushurl", "git@github-work:AcmeSoftware/acme-frontend.git"]);

    const manager = new ShieldManager();
    // The profile has to match the repo's canonical (origin) identity for
    // Shield to be enableable at all — which is precisely the point: the
    // profile is chosen by origin, the approved push destination is not.
    const forkProfile: Profile = { ...workProfile, expectedRemoteOwners: ["UpstreamOrg", "AcmeSoftware"] };
    const { result } = await enableFromRealRepo(manager, repo, [forkProfile]);
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));

    const policy = await readPolicy(repo);
    assert.equal(policy.approvedPushDestination?.owner, "AcmeSoftware");
    assert.notEqual(policy.approvedPushDestination?.owner, "UpstreamOrg");
    // Canonical identity still tracks origin's fetch URL.
    assert.match(policy.approvedRepositoryKey as string, /upstreamorg/i);
  } finally {
    await cleanup(repo.dir);
  }
});

test("push destination: repair after an intentional push-destination change re-approves the NEW destination", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);
    assert.equal((await readPolicy(repo)).approvedPushDestination?.repo, "acme-frontend");

    // Deliberately move the push destination, then repair.
    await git(repo, ["config", "remote.origin.pushurl", "git@github-work:AcmeSoftware/acme-next.git"]);
    const freshFacts = await collectRepoFacts(repo.dir);
    const repaired = await manager.repair(repo.dir, EVALUATOR_SOURCE, {
      facts: freshFacts,
      profiles: [workProfile],
      protectedBranches: [],
    });
    assert.equal(repaired.ok, true, repaired.inspection.reasons.join("; "));
    assert.equal((await readPolicy(repo)).approvedPushDestination?.repo, "acme-next");
  } finally {
    await cleanup(repo.dir);
  }
});

// ====================================================================
// FINDING 2 — health check must perform FULL integrity checks.
//
// Confirmed defect: extension.ts called healthCheck(repoRoot) with no
// options, so all three of inspect()'s opt-in drift checks were silently
// skipped and a drifted Shield reported a confident "active".
// ====================================================================

test("health check: with NO drift inputs supplied, a hand-edited evaluator that keeps the marker still reports active (the shape of the original defect)", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const commonDir = await commonDirFor(repo);
    const evaluatorPath = path.join(commonDir, "repo-identity-guard", "shield-evaluate.sh");
    const original = await fs.readFile(evaluatorPath, "utf8");
    // Marker and version comment deliberately preserved — only the body
    // is changed, which is exactly what a real tamper would look like.
    await fs.writeFile(evaluatorPath, original.replace(/^set -eu$/m, "set -eu\nexit 0 # tampered"), { mode: 0o755 });

    const blind = await manager.healthCheck(repo.dir);
    assert.equal(blind.state, "active", "documents the defect: without the source path, drift is invisible");

    const full = await manager.healthCheck(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.equal(full.state, "degraded");
    assert.match(full.summary, /modified outside Repo Identity Guard/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("health check: trustedSshHostAliases changed after enable -> degraded", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const edited: Profile = { ...workProfile, trustedSshHostAliases: ["github-work", "github-extra"] };
    const health = await manager.healthCheck(repo.dir, {
      evaluatorScriptSource: EVALUATOR_SOURCE,
      currentProfiles: [edited],
    });
    assert.equal(health.state, "degraded");
    assert.match(health.summary, /trustedSshHostAliases/);
  } finally {
    await cleanup(repo.dir);
  }
});

test("health check: expectedGitHubLogin / strictPushSetup / Git identity changes each report degraded with the changed field named", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    for (const [field, edited] of [
      ["expectedGitHubLogin", { ...workProfile, expectedGitHubLogin: "danish-work" }],
      ["strictPushSetup", { ...workProfile, strictPushSetup: false }],
      ["gitEmail", { ...workProfile, gitEmail: "other@example.com" }],
      ["gitName", { ...workProfile, gitName: "Someone Else" }],
    ] as const) {
      const health = await manager.healthCheck(repo.dir, {
        evaluatorScriptSource: EVALUATOR_SOURCE,
        currentProfiles: [edited],
      });
      assert.equal(health.state, "degraded", `${field} drift should be degraded`);
      assert.match(health.summary, new RegExp(field), `${field} should be named in the reason`);
    }
  } finally {
    await cleanup(repo.dir);
  }
});

test("health check: a push destination that moved after enable -> degraded", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    await git(repo, ["remote", "set-url", "origin", "git@github-work:SomeoneElse/acme-frontend.git"]);
    const moved = await collectRepoFacts(repo.dir);
    const health = await manager.healthCheck(repo.dir, {
      evaluatorScriptSource: EVALUATOR_SOURCE,
      currentProfiles: [workProfile],
      currentPushDestination: { host: moved.pushRemoteHost, owner: moved.pushRemoteOwner, repo: moved.pushRemoteRepo },
    });
    assert.equal(health.state, "degraded");
    assert.match(health.summary, /push destination/i);
  } finally {
    await cleanup(repo.dir);
  }
});

test("health check: inspect() with every drift check enabled still writes NOTHING (read-only, never self-repairs)", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const commonDir = await commonDirFor(repo);
    const storage = shieldStorageDir(commonDir);
    const hooksDir = await hooksDirFor(repo);
    const watched = [
      path.join(storage, "shield-policy.json"),
      path.join(storage, "shield-evaluate.sh"),
      path.join(storage, "installations.json"),
      path.join(hooksDir, "pre-commit"),
      path.join(hooksDir, "pre-merge-commit"),
      path.join(hooksDir, "pre-push"),
    ];
    // Tamper first, so inspect() has something it might be tempted to fix.
    const evaluatorPath = path.join(storage, "shield-evaluate.sh");
    const original = await fs.readFile(evaluatorPath, "utf8");
    await fs.writeFile(evaluatorPath, `${original}\n# hand edit\n`, { mode: 0o755 });

    const before = await Promise.all(watched.map(async (p) => [p, await fs.readFile(p).then((b) => b.toString("latin1"))] as const));
    const inspection = await manager.inspect(repo.dir, {
      evaluatorScriptSource: EVALUATOR_SOURCE,
      currentProfiles: [{ ...workProfile, strictPushSetup: false }],
      currentPushDestination: { host: "github-work", owner: "SomeoneElse", repo: "other" },
    });
    assert.equal(inspection.state, "degraded");

    for (const [p, contentBefore] of before) {
      const after = await fs.readFile(p).then((b) => b.toString("latin1"));
      assert.equal(after, contentBefore, `inspect() must not have modified ${p}`);
    }
  } finally {
    await cleanup(repo.dir);
  }
});

// ====================================================================
// FINDING 3 — no durable policy may be built from stale/cached UI facts.
// ====================================================================

test("stale facts: a policy built from facts captured by an EARLIER scan differs from one built from facts collected immediately before enable — the fresh facts must win", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/old-repo.git"]);

    // What a sidebar scan / background watcher captured earlier.
    const staleFacts = await collectRepoFacts(repo.dir);
    assert.equal(staleFacts.pushRemoteRepo, "old-repo");

    // The world moves on before the user runs Enable Shield.
    await git(repo, ["remote", "set-url", "origin", "git@github-work:AcmeSoftware/new-repo.git"]);

    const manager = new ShieldManager();

    // (a) The defect, reproduced: enabling from the cached snapshot bakes
    // the OLD destination into the durable policy.
    const withStale = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts: staleFacts,
      profiles: [workProfile],
      protectedBranches: [],
    });
    assert.equal(withStale.ok, true, withStale.inspection.reasons.join("; "));
    assert.equal((await readPolicy(repo)).approvedPushDestination?.repo, "old-repo");

    // (b) The fix, as the command now behaves: re-collect immediately
    // before the write, and the fresh facts win.
    const freshFacts = await collectRepoFacts(repo.dir);
    assert.equal(freshFacts.pushRemoteRepo, "new-repo");
    const withFresh = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts: freshFacts,
      profiles: [workProfile],
      protectedBranches: [],
    });
    assert.equal(withFresh.ok, true, withFresh.inspection.reasons.join("; "));
    assert.equal((await readPolicy(repo)).approvedPushDestination?.repo, "new-repo");
  } finally {
    await cleanup(repo.dir);
  }
});

test("stale facts: a profile edited after the last scan is honoured when the policy is built from fresh inputs", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    const facts = await collectRepoFacts(repo.dir);

    const editedProfile: Profile = { ...workProfile, expectedGitHubLogin: "danish-work", strictPushSetup: false };
    await manager.enable(repo.dir, EVALUATOR_SOURCE, { facts, profiles: [editedProfile], protectedBranches: [] });

    const policy = await readPolicy(repo);
    assert.equal(policy.expectedGitHubLogin, "danish-work");
    assert.equal(policy.strictPushSetup, false);
    // And a health check against the same live profile sees no drift.
    const health = await manager.healthCheck(repo.dir, {
      evaluatorScriptSource: EVALUATOR_SOURCE,
      currentProfiles: [editedProfile],
    });
    assert.equal(health.state, "active", health.summary);
  } finally {
    await cleanup(repo.dir);
  }
});

// ====================================================================
// FINDING 5 — core.hooksPath drift / orphaned hooks / installation record.
//
// Confirmed defect (empirically reproduced): enable with hooksDir=A, move
// core.hooksPath to B, disable — Shield's hooks stayed in A forever.
// Harmless while hooks failed open; a permanent, unrepairable block once
// they fail closed.
// ====================================================================

test("install record: enable writes a durable, non-secret installation record under Git metadata naming the hooks directory it used", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const recordPath = shieldInstallRecordFilePath(shieldStorageDir(await commonDirFor(repo)));
    const raw = await fs.readFile(recordPath, "utf8");
    const record = parseShieldInstallRecord(raw);
    assert.ok(record, "record must parse");
    const liveHooksDir = path.resolve(await hooksDirFor(repo));
    assert.ok(record.hookDirs.some((d) => sameHookDir(d, liveHooksDir)));

    // Non-secret by construction: paths and a timestamp, nothing else.
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["hookDirs", "recordVersion", "updatedAt"]);

    // Under Git metadata, so it is never a tracked working-tree file.
    assert.ok(recordPath.includes(`${path.sep}.git${path.sep}`) || recordPath.includes("/.git/"));
    assert.equal(await git(repo, ["status", "--porcelain"]), "", "Shield must not create any tracked/untracked working-tree file");
  } finally {
    await cleanup(repo.dir);
  }
});

test("hooksPath drift: enable at A, move core.hooksPath to B, then DISABLE — Shield's hooks are removed from A too, so a switch back to A cannot resurrect them", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const dirA = path.resolve(await hooksDirFor(repo));
    assert.ok(await exists(path.join(dirA, "pre-commit")));

    const dirB = path.join(repo.dir, "hooks-b");
    await fs.mkdir(dirB, { recursive: true });
    await git(repo, ["config", "core.hooksPath", dirB]);
    // `git rev-parse --path-format=absolute` canonicalizes the path (it
    // resolves the macOS /var -> /private/var symlink and Windows' 8.3
    // short-name TEMP form), while `dirB` here is a plain JS-side string
    // join off `repo.dir` that never went through that canonicalization.
    // Compare like-for-like via realpath rather than raw string equality.
    assert.equal(path.resolve(await hooksDirFor(repo)), await fs.realpath(dirB));

    // Health reports the orphan rather than a bare "hook is missing".
    const health = await manager.healthCheck(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.equal(health.state, "degraded");
    assert.match(health.summary, /not the hooks directory Git currently uses/);

    await manager.disable(repo.dir);

    for (const name of ["pre-commit", "pre-merge-commit", "pre-push"]) {
      assert.equal(await exists(path.join(dirA, name)), false, `${name} must have been removed from the previous location A`);
    }

    // Switch back to A: nothing of Shield's is there to spring back to life.
    await git(repo, ["config", "--unset", "core.hooksPath"]);
    const after = await manager.inspect(repo.dir);
    assert.equal(after.state, "off", after.reasons.join("; "));
    assert.deepEqual(after.orphanedHookPaths, []);
  } finally {
    await cleanup(repo.dir);
  }
});

test("hooksPath drift: enabling under B after having been enabled under A consolidates — A is cleaned up, only B stays live", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);
    const dirA = path.resolve(await hooksDirFor(repo));

    const dirB = path.join(repo.dir, "hooks-b");
    await fs.mkdir(dirB, { recursive: true });
    await git(repo, ["config", "core.hooksPath", dirB]);
    const second = await enableFromRealRepo(manager, repo);
    assert.equal(second.result.ok, true, second.result.inspection.reasons.join("; "));

    assert.ok(await exists(path.join(dirB, "pre-commit")), "the new location must be live");
    assert.equal(await exists(path.join(dirA, "pre-commit")), false, "the previous location must have been cleaned up");
    assert.equal(second.result.inspection.state, "active");
  } finally {
    await cleanup(repo.dir);
  }
});

test("hooksPath drift: Shield never deletes a hook at a recorded location that it cannot prove it owns", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);
    const dirA = path.resolve(await hooksDirFor(repo));

    // Someone else takes over the hook slot at the old location.
    const foreign = "#!/bin/sh\n# somebody else's hook\nexit 0\n";
    await fs.writeFile(path.join(dirA, "pre-commit"), foreign, { mode: 0o755 });

    const dirB = path.join(repo.dir, "hooks-b");
    await fs.mkdir(dirB, { recursive: true });
    await git(repo, ["config", "core.hooksPath", dirB]);
    await manager.disable(repo.dir);

    assert.equal(await fs.readFile(path.join(dirA, "pre-commit"), "utf8"), foreign, "a foreign hook must survive untouched");
  } finally {
    await cleanup(repo.dir);
  }
});

test("worktrees: a linked worktree shares the installation record and the same hooks directory, and disabling from the worktree cleans up correctly", async () => {
  const repo = await makeTempRepo();
  const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p8-wt-"));
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const wtDir = path.join(worktreeParent, "wt");
    await git(repo, ["worktree", "add", "-q", "-b", "wt-branch", wtDir]);
    const worktree: Repo = { dir: wtDir, env: repo.env };

    // The record lives under the SHARED git-common-dir, so it is the same
    // file from both — this is what makes worktree cleanup correct.
    assert.equal(await commonDirFor(worktree), await commonDirFor(repo));
    assert.equal(path.resolve(await hooksDirFor(worktree)), path.resolve(await hooksDirFor(repo)));

    const fromWorktree = await manager.inspect(wtDir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.equal(fromWorktree.state, "active", fromWorktree.reasons.join("; "));

    await manager.disable(wtDir);
    assert.equal((await manager.inspect(repo.dir)).state, "off");
    assert.equal(await exists(path.join(await hooksDirFor(repo), "pre-commit")), false);
  } finally {
    await cleanup(repo.dir, worktreeParent);
  }
});

test("install record: a corrupt or hand-edited record is treated as absent and never causes Shield to touch a path it does not own", async () => {
  const repo = await makeTempRepo();
  const bystander = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p8-bystander-"));
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);

    const recordPath = shieldInstallRecordFilePath(shieldStorageDir(await commonDirFor(repo)));
    // Point the record at an unrelated directory holding a file Shield
    // certainly does not own.
    const victim = path.join(bystander, "pre-commit");
    await fs.writeFile(victim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(recordPath, serializeShieldInstallRecord({ recordVersion: 1, hookDirs: [bystander], updatedAt: 1 }));

    await manager.disable(repo.dir);
    assert.equal(await exists(victim), true, "Shield must never delete a hook path it cannot prove it owns");

    // An outright corrupt record is still never FATAL and still never
    // makes Shield touch a path it cannot prove it owns — but as of Phase
    // 9 it is no longer reported as a healthy "active" either.
    //
    // This assertion used to read `assert.equal(inspection.state,
    // "active")`. The Part 10 lifecycle torture harness showed that to be
    // the wrong verdict: a corrupt record reads as *absent* by design, and
    // absent meant "no previous locations to check", so the single state
    // this record exists to prevent — live Shield hooks that nothing is
    // keeping track of — was precisely the state `inspect()` could not
    // report. Move `core.hooksPath` from there and Disable Shield can no
    // longer reach those hooks; move it back and they are live again with
    // no evaluator beside them, blocking every commit and push.
    //
    // So the expectation is now DEGRADED with an actionable reason, which
    // is strictly stricter than before. Everything this test actually
    // guards — that a tampered record never causes a deletion, and never
    // makes an operation fail — is unchanged and still asserted.
    await enableFromRealRepo(manager, repo);
    await fs.writeFile(recordPath, "{ not json");
    const inspection = await manager.inspect(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.equal(inspection.state, "degraded", inspection.reasons.join("; "));
    assert.ok(
      inspection.reasons.some((r) => /installation record does not name that directory/.test(r)),
      inspection.reasons.join("; "),
    );
    assert.deepEqual(inspection.orphanedHookPaths, []);
    // Every Shield hook is still installed and still enforcing — a broken
    // record is a tracking problem, never a reason to stop enforcing.
    for (const hook of inspection.hooks) assert.equal(hook.ownership, "shield");
    // And Repair restores the record and the healthy verdict.
    await enableFromRealRepo(manager, repo);
    assert.equal((await manager.inspect(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE })).state, "active");
  } finally {
    await cleanup(repo.dir, bystander);
  }
});

// ==================== install record: pure unit tests ====================

test("install record parser rejects an unknown version, non-array hookDirs, and relative paths", () => {
  assert.equal(parseShieldInstallRecord("not json"), undefined);
  assert.equal(parseShieldInstallRecord(JSON.stringify({ recordVersion: 99, hookDirs: [] })), undefined);
  assert.equal(parseShieldInstallRecord(JSON.stringify({ recordVersion: 1, hookDirs: "nope" })), undefined);

  const record = parseShieldInstallRecord(
    JSON.stringify({ recordVersion: 1, hookDirs: [path.resolve("/tmp/a"), "relative/path", 7], updatedAt: 5 }),
  );
  assert.deepEqual(record?.hookDirs, [path.resolve("/tmp/a")], "relative and non-string entries are dropped, never accepted");
});

test("normalizeHookDirs resolves, de-duplicates, and preserves order", () => {
  const dirs = normalizeHookDirs([path.resolve("/tmp/x"), path.resolve("/tmp/x/../x"), path.resolve("/tmp/y"), ""]);
  assert.deepEqual(dirs, [path.resolve("/tmp/x"), path.resolve("/tmp/y")]);
  assert.equal(sameHookDir("/tmp/x", "/tmp/x/"), true);
  assert.equal(sameHookDir("/tmp/x", "/tmp/y"), false);
});

// ====================================================================
// FINDING 6 — foreign-hook chaining must never corrupt or misrun a hook.
//
// Confirmed defects (all three empirically reproduced):
//  - a binary hook was read as UTF-8 and written back with U+FFFD
//    replacement characters, silently destroying it;
//  - a symlinked hook was flattened into a regular-file copy;
//  - a NON-EXECUTABLE hook was chained anyway, so Shield's shim tried to
//    exec it and every commit died with "exec: ...: Permission denied".
// ====================================================================

const SKIP_ON_WINDOWS =
  process.platform === "win32"
    ? "POSIX file-type/permission semantics (symlinks, the executable bit) do not apply on Windows; Git for Windows runs any hook file it finds regardless. Covered on ubuntu-latest/macos-latest."
    : false;

test("chaining: an executable regular foreign hook is preserved BYTE-FOR-BYTE, including non-UTF-8 bytes", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    // A native executable's leading bytes: invalid UTF-8 on purpose.
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x0a]);
    await fs.writeFile(hookPath, binary, { mode: 0o755 });

    const manager = new ShieldManager();
    const facts = await collectRepoFacts(repo.dir);
    await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      chainForeignHooks: true,
    });

    const sidecar = await fs.readFile(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`);
    assert.ok(sidecar.equals(binary), `bytes must round-trip exactly; got ${sidecar.toString("hex")}`);
    assert.equal((await fs.stat(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`)).mode & 0o111 ? true : false, true, "executable bit preserved");
  } finally {
    await cleanup(repo.dir);
  }
});

test("chaining: a SYMLINKED foreign hook is refused, left exactly as a symlink, and reported degraded with a precise explanation", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const target = path.join(repo.dir, "real-hook.sh");
    await fs.writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const hookPath = path.join(await hooksDirFor(repo), "pre-commit");
    await fs.symlink(target, hookPath);

    const manager = new ShieldManager();
    const facts = await collectRepoFacts(repo.dir);
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      chainForeignHooks: true,
    });

    assert.equal((await fs.lstat(hookPath)).isSymbolicLink(), true, "the symlink must still be a symlink");
    assert.equal(await fs.readlink(hookPath), target, "and must still point at the same target");
    assert.equal(await exists(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), false, "no sidecar copy is made");
    assert.equal(result.inspection.state, "degraded");
    assert.ok(
      result.inspection.reasons.some((r) => /symbolic link/.test(r)),
      `reason should explain the refusal precisely: ${result.inspection.reasons.join(" | ")}`,
    );
  } finally {
    await cleanup(repo.dir);
  }
});

test("chaining: a NON-EXECUTABLE foreign hook is refused rather than chained into an un-runnable exec", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const hookPath = path.join(await hooksDirFor(repo), "pre-commit");
    const contents = "#!/bin/sh\necho foreign\nexit 0\n";
    await fs.writeFile(hookPath, contents, { mode: 0o644 });

    const manager = new ShieldManager();
    const facts = await collectRepoFacts(repo.dir);
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      chainForeignHooks: true,
    });

    assert.equal(await fs.readFile(hookPath, "utf8"), contents, "left completely untouched");
    assert.equal(await exists(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), false);
    assert.equal(result.inspection.state, "degraded");
    assert.ok(result.inspection.reasons.some((r) => /not executable/.test(r)));

    // The whole point: an ordinary commit still works, rather than dying
    // with a bare "Permission denied" from a chained exec.
    await fs.writeFile(path.join(repo.dir, "a.txt"), "x");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "still works"]);
  } finally {
    await cleanup(repo.dir);
  }
});

test("chaining: an executable shell foreign hook is chained and actually RUNS after Shield allows the commit", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const marker = path.join(repo.dir, "foreign-ran.txt");
    const hookPath = path.join(await hooksDirFor(repo), "pre-commit");
    await fs.writeFile(hookPath, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });

    const manager = new ShieldManager();
    const facts = await collectRepoFacts(repo.dir);
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      chainForeignHooks: true,
    });
    assert.equal(result.inspection.state, "active", result.inspection.reasons.join("; "));

    await fs.writeFile(path.join(repo.dir, "a.txt"), "x");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "chained"]);
    assert.equal(await exists(marker), true, "the chained original hook must actually have run");

    // And disable restores it exactly.
    await manager.disable(repo.dir);
    assert.match(await fs.readFile(hookPath, "utf8"), /foreign-ran\.txt/);
    assert.equal(await exists(`${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`), false);
  } finally {
    await cleanup(repo.dir);
  }
});

test("chaining: an existing Shield sidecar is never overwritten by chaining a second foreign hook on top of it", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const hooksDir = await hooksDirFor(repo);
    const hookPath = path.join(hooksDir, "pre-commit");
    const sidecarPath = `${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`;
    await fs.writeFile(sidecarPath, "#!/bin/sh\n# the FIRST original\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(hookPath, "#!/bin/sh\n# a SECOND foreign hook\nexit 0\n", { mode: 0o755 });

    const manager = new ShieldManager();
    const facts = await collectRepoFacts(repo.dir);
    await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      chainForeignHooks: true,
    });

    assert.match(await fs.readFile(sidecarPath, "utf8"), /the FIRST original/, "the existing sidecar must be preserved");
    assert.match(await fs.readFile(hookPath, "utf8"), /a SECOND foreign hook/, "and the foreign hook left alone");
  } finally {
    await cleanup(repo.dir);
  }
});

// ====================================================================
// FINDING 7 — no predictable pre-push temp fallback.
// ====================================================================

test("pre-push shim: contains no predictable PID-based temp fallback, and fails closed when mktemp cannot produce a file", async () => {
  const { buildPrePushHookScript } = await import("../shield/artifacts");
  const script = buildPrePushHookScript();
  assert.doesNotMatch(script, /prepush-stdin\.\$\$/, "the guessable $$-based fallback path must be gone");
  assert.match(script, /mktemp/);
  assert.match(script, /PUSH BLOCKED \(Shield internal error\)/);
  // The failure path must not create OR truncate anything.
  const failureBlock = script.slice(script.indexOf("STDIN_CAPTURE=$(mktemp"), script.indexOf("chmod 600"));
  assert.doesNotMatch(failureBlock, /: > "\$STDIN_CAPTURE"/, "must never truncate a path it did not securely create");
});

/**
 * Runs the REAL installed pre-push shim directly, exactly the way Git
 * invokes it (argv = remote name + remote location, ref lines on stdin),
 * with `mktemp` shadowed on PATH by one that always fails — which is how a
 * full, unwritable, or inode-exhausted TMPDIR behaves. Driving the shim
 * itself rather than a whole `git push` is deliberate: the failure being
 * tested is entirely inside the shim, and this way the assertion cannot be
 * confused by transport/remote setup.
 */
test("pre-push shim: with mktemp forced to fail, the push is BLOCKED as a Shield internal error and no predictable path is created", { skip: SKIP_ON_WINDOWS }, async () => {
  const repo = await makeTempRepo();
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p8-bin-"));
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p8-tmp-"));
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    const { result } = await enableFromRealRepo(manager, repo);
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));

    await fs.writeFile(path.join(fakeBin, "mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const hookPath = path.join(await hooksDirFor(repo), "pre-push");
    const env = {
      ...repo.env,
      PATH: `${fakeBin}${path.delimiter}${repo.env.PATH}`,
      TMPDIR: tmpHome,
    };

    const head = await git(repo, ["rev-parse", "HEAD"]);
    const run = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = execFile(
        "sh",
        [hookPath, "origin", "git@github-work:AcmeSoftware/acme-frontend.git"],
        { cwd: repo.dir, encoding: "utf8", env },
        (error, _o, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
        },
      );
      child.stdin?.end(`refs/heads/main ${head} refs/heads/main ${"0".repeat(40)}\n`);
    });

    assert.notEqual(run.code, 0, "a push must never proceed when no secure temp file can be created");
    assert.match(run.stderr, /Shield internal error/);
    assert.match(run.stderr, /predictable temporary file name/);
    // Nothing at all may have been created in the temp directory — in
    // particular not the old `...prepush-stdin.<pid>` shape.
    assert.deepEqual(await fs.readdir(tmpHome), [], "the failure path must create nothing");
  } finally {
    await cleanup(repo.dir, fakeBin, tmpHome);
  }
});

// ====================================================================
// FINDING 8 — Shield's real minimum Git version.
// ====================================================================

test("git version: parses every vendor suffix shape seen in the wild", () => {
  assert.deepEqual(pick(parseGitVersion("git version 2.43.0")), { major: 2, minor: 43, patch: 0 });
  assert.deepEqual(pick(parseGitVersion("git version 2.39.5 (Apple Git-154)")), { major: 2, minor: 39, patch: 5 });
  assert.deepEqual(pick(parseGitVersion("git version 2.45.1.windows.1")), { major: 2, minor: 45, patch: 1 });
  assert.deepEqual(pick(parseGitVersion("git version 3.0")), { major: 3, minor: 0, patch: 0 });
  assert.equal(parseGitVersion("no version here"), undefined);

  function pick(v: ReturnType<typeof parseGitVersion>) {
    return v ? { major: v.major, minor: v.minor, patch: v.patch } : undefined;
  }
});

test("git version: comparison orders major, then minor, then patch", () => {
  const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
  assert.equal(compareGitVersions(v(2, 30, 9), v(2, 31, 0)), -1);
  assert.equal(compareGitVersions(v(2, 31, 0), v(2, 31, 0)), 0);
  assert.equal(compareGitVersions(v(3, 0, 0), v(2, 99, 99)), 1);
});

test("git version: Shield's floor is 2.31 (rev-parse --path-format), and below it the missing coverage is named explicitly", () => {
  assert.equal(SHIELD_MIN_GIT_VERSION_DISPLAY, "2.31.0");

  const tooOldForPathFormat = evaluateGitVersionSupport("git version 2.30.2");
  assert.equal(tooOldForPathFormat.supported, false);
  assert.match(tooOldForPathFormat.reason as string, /--path-format/);

  const noPreMergeCommit = evaluateGitVersionSupport("git version 2.20.0");
  assert.equal(noPreMergeCommit.supported, false);
  assert.match(noPreMergeCommit.reason as string, /pre-merge-commit/);
  assert.match(noPreMergeCommit.reason as string, /merge --no-ff/);

  assert.equal(evaluateGitVersionSupport("git version 2.31.0").supported, true);
  assert.equal(evaluateGitVersionSupport("git version 2.43.0").supported, true);
});

test("git version: an unreadable/unparseable version is NEVER treated as supported", () => {
  assert.equal(evaluateGitVersionSupport(undefined).supported, false);
  assert.equal(evaluateGitVersionSupport(null).supported, false);
  assert.equal(evaluateGitVersionSupport("").supported, false);
  assert.equal(evaluateGitVersionSupport("something else entirely").supported, false);
});

test("git version: inspect() on a real repo reports the machine's Git as supported (this CI runs a modern Git)", async () => {
  const repo = await makeTempRepo();
  try {
    await git(repo, ["remote", "add", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"]);
    const manager = new ShieldManager();
    await enableFromRealRepo(manager, repo);
    const inspection = await manager.inspect(repo.dir, { evaluatorScriptSource: EVALUATOR_SOURCE });
    assert.equal(inspection.gitVersionSupported, true, `git version was: ${inspection.gitVersionRaw}`);
    assert.match(inspection.gitVersionRaw as string, /^git version /);
    assert.equal(inspection.state, "active", inspection.reasons.join("; "));
  } finally {
    await cleanup(repo.dir);
  }
});

// ====================================================================
// FINDING 9 — GitHub SSH verification must check the EFFECTIVE route.
// Pure parser tests; the fake-ssh integration half lives in
// shieldGitHubAccountBinding.test.ts.
// ====================================================================

test("ssh -G parsing: reads hostname, port, user and IdentitiesOnly out of real ssh -G output", () => {
  const output = [
    "user git",
    "hostname ssh.github.com",
    "port 443",
    "addressfamily any",
    "identitiesonly yes",
    "identityfile ~/.ssh/id_ed25519_work",
  ].join("\n");
  const route = parseSshEffectiveRoute(output);
  assert.deepEqual(route, { hostname: "ssh.github.com", port: "443", user: "git", identitiesOnly: true });
  assert.equal(sshConfigHasIdentitiesOnly(output), true);
});

test("ssh -G parsing: defaults port to 22, treats a missing hostname as unresolvable, and never guesses IdentitiesOnly", () => {
  assert.equal(parseSshEffectiveRoute("user git\nidentitiesonly yes\n"), undefined, "no hostname -> unresolvable");
  const route = parseSshEffectiveRoute("hostname github.com\nuser git\n");
  assert.deepEqual(route, { hostname: "github.com", port: "22", user: "git", identitiesOnly: false });
  assert.equal(sshConfigHasIdentitiesOnly("identitiesonly no\n"), false);
  assert.equal(sshConfigHasIdentitiesOnly(""), false);
  // A keyword that merely *contains* the name must not match.
  assert.equal(sshConfigHasIdentitiesOnly("xidentitiesonly yes\n"), false);
});

test("GitHub endpoint check: only github.com, ssh.github.com and *.github.com count; look-alikes and Enterprise hosts do not", () => {
  for (const host of ["github.com", "GitHub.com", "ssh.github.com", "nc.github.com", "github.com."]) {
    assert.equal(isGitHubSshEndpoint(host), true, `${host} should be a GitHub endpoint`);
  }
  for (const host of [
    "github.example",
    "github.com.evil.test",
    "notgithub.com",
    "githubcom",
    "git.acme-corp.internal",
    "192.0.2.10",
    "",
  ]) {
    assert.equal(isGitHubSshEndpoint(host), false, `${host} must NOT be a GitHub endpoint`);
  }
});
