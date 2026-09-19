import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteUrl } from "../services/gitService";
import { ShieldManager, SshResolver } from "../shield/manager";
import { ShieldPolicy, buildShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { Profile, RepoFacts } from "../types";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";

/**
 * Release-blocker fix (independent re-review, round 4) — never inventing
 * an SSH user Shield's canonical `ssh -G` resolution asks about.
 *
 * ## The gap this closes
 *
 * `parseRemoteUrl` used to default a missing URL user to `"git"`
 * (`sshUser: parsed.username || "git"`), and `shield-evaluate.sh`
 * likewise did `[ -z "$SSH_USER" ] && SSH_USER=git`. That is not real Git
 * SSH semantics: for `ssh://host/owner/repo.git` or `host:owner/repo.git`
 * with NO user in the URL, Git/ssh determines the effective user via
 * ordinary OpenSSH rules (the local user, or a config-driven `User`
 * directive) — never universally "git". Because OpenSSH supports
 * username-sensitive configuration (`Match user ...`), asking `ssh -G` a
 * "git@host" question when the real push asks a bare "host" question can
 * resolve to a DIFFERENT effective hostname/port than the real transport
 * would use — the exact class of bug round 2/3 exist to close, just
 * introduced by Shield's OWN canonicalization inventing evidence the URL
 * never provided, rather than by an attacker.
 *
 * ## The fix
 *
 * `ParsedRemote.sshUser` (`src/services/gitService.ts`) is now `undefined`
 * — never `"git"` — when the URL/alias names no user, for both the
 * `ssh://` form and the scp-like form. `resolveCanonicalSshEndpoint`
 * (`src/shield/sshEndpoint.ts`) passes the BARE host to `ssh -G` when no
 * user is given, never `"git@" + host`. `shield-evaluate.sh`'s
 * `resolve_canonical_ssh_route` and `verify_github_account` do the same
 * (a `TARGET` built as `${user}@${host}` only when a user is present, the
 * bare host otherwise).
 */

const workProfile: Profile = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  expectedRemoteOwners: ["AcmeSoftware"],
  strictPushSetup: false,
  trustedSshHostAliases: [],
};

const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

interface Repo {
  dir: string;
  env: NodeJS.ProcessEnv;
}

async function git(repo: Repo, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", args, { cwd: repo.dir, encoding: "utf8", env: repo.env });
  return stdout.trim();
}

async function makeTempRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-sshuser-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(dir, ".test-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const repo: Repo = { dir, env };
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "Danish Irfan"]);
  await git(repo, ["config", "user.email", "work@example.com"]);
  await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
  await git(repo, ["add", "f.txt"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

async function cleanup(repo: Repo): Promise<void> {
  await fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined);
}

async function writeRawPolicy(repo: Repo, policy: ShieldPolicy): Promise<void> {
  const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), serializeShieldPolicy(policy));
}

// ==================== A/B/C/D: parseRemoteUrl + enable-time resolver ====================

test("ssh-user regression A: explicit git@host -> the resolver is called with the explicit user 'git'", async () => {
  const repo = await makeTempRepo();
  try {
    const parsed = parseRemoteUrl("git@ssh.github.com:AcmeSoftware/acme-frontend.git");
    assert.equal(parsed.sshUser, "git");

    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: parsed.protocol,
      pushRemoteHost: parsed.host,
      pushRemoteOwner: parsed.owner,
      pushRemoteRepo: parsed.repo,
      pushRemoteUser: parsed.sshUser,
      remoteHost: parsed.host,
      remoteOwner: parsed.owner,
      remoteRepo: parsed.repo,
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: async (host, options) => {
        assert.equal(options.user, "git");
        return { host, port: options.port ?? "22" };
      },
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
  } finally {
    await cleanup(repo);
  }
});

test("ssh-user regression B: explicit deploy@host -> the resolver is called with 'deploy', never a hardcoded 'git'", async () => {
  const repo = await makeTempRepo();
  try {
    const parsed = parseRemoteUrl("ssh://deploy@ssh.github.com/AcmeSoftware/acme-frontend.git");
    assert.equal(parsed.sshUser, "deploy");

    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: parsed.protocol,
      pushRemoteHost: parsed.host,
      pushRemoteOwner: parsed.owner,
      pushRemoteRepo: parsed.repo,
      pushRemoteUser: parsed.sshUser,
      remoteHost: parsed.host,
      remoteOwner: parsed.owner,
      remoteRepo: parsed.repo,
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: async (host, options) => {
        assert.equal(options.user, "deploy");
        return { host, port: options.port ?? "22" };
      },
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
  } finally {
    await cleanup(repo);
  }
});

test("ssh-user regression C: ssh://host/owner/repo.git with NO user -> the resolver target contains no invented user", async () => {
  const repo = await makeTempRepo();
  try {
    const parsed = parseRemoteUrl("ssh://ssh.github.com/AcmeSoftware/acme-frontend.git");
    assert.equal(parsed.sshUser, undefined, "no user in the URL must mean no user at all, not a default 'git'");

    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: parsed.protocol,
      pushRemoteHost: parsed.host,
      pushRemoteOwner: parsed.owner,
      pushRemoteRepo: parsed.repo,
      pushRemoteUser: parsed.sshUser,
      remoteHost: parsed.host,
      remoteOwner: parsed.owner,
      remoteRepo: parsed.repo,
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: async (host, options) => {
        assert.equal(options.user, undefined, "the resolver must be asked about the bare host, never 'git@host'");
        return { host, port: options.port ?? "22" };
      },
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
  } finally {
    await cleanup(repo);
  }
});

test("ssh-user regression D: host:owner/repo.git (scp-like) with NO user -> same as the ssh:// form", async () => {
  const parsed = parseRemoteUrl("ssh.github.com:AcmeSoftware/acme-frontend.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.sshUser, undefined, "no user in the scp-like URL must mean no user at all, not a default 'git'");
});

// ==================== E/F/G: username-sensitive resolution, enable/hook agreement ====================

/**
 * A user-sensitive fake `ssh -G`: resolves DIFFERENTLY depending on
 * whether an explicit user was passed at all, simulating an OpenSSH
 * `Match user` block. Queried with a bare host (no user) it answers
 * `FAKE_SSH_NO_USER_HOSTNAME`; queried with an explicit user it answers
 * `FAKE_SSH_EXPLICIT_USER_HOSTNAME`.
 */
async function makeUserSensitiveFakeSsh(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-sshuser-fakessh-"));
  const implPath = path.join(binDir, "impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  const target = args[args.length - 1] || "";
  const hasUser = target.includes("@");
  const hostname = hasUser
    ? (process.env.FAKE_SSH_EXPLICIT_USER_HOSTNAME || "explicit-user.example")
    : (process.env.FAKE_SSH_NO_USER_HOSTNAME || "no-user.example");
  process.stdout.write("user git\\nhostname " + hostname + "\\nport 22\\n");
  process.exit(0);
}
process.stderr.write("fake-ssh-sshuser: unexpected invocation: " + joined + "\\n");
process.exit(1);
`,
  );
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
}

function userSensitiveResolver(): SshResolver {
  return async (host, options) => {
    const hostname = options.user ? "explicit-user.example" : "no-user.example";
    return { host: hostname, port: "22" };
  };
}

test("ssh-user regression E: an omitted-user route and an explicit-git route can resolve DIFFERENTLY, and Shield follows the omitted-user route for an omitted-user URL", async () => {
  const repo = await makeTempRepo();
  try {
    // Enable from a URL with NO user -- the resolver (simulating a
    // Match-user-sensitive ~/.ssh/config) must be consulted WITHOUT a
    // user, and the persisted canonicalHost must be the no-user route's
    // answer, never the explicit-user route's.
    const parsed = parseRemoteUrl("ssh://github-work/AcmeSoftware/acme-frontend.git");
    assert.equal(parsed.sshUser, undefined);
    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: parsed.protocol,
      pushRemoteHost: parsed.host,
      pushRemoteOwner: parsed.owner,
      pushRemoteRepo: parsed.repo,
      pushRemoteUser: parsed.sshUser,
      remoteHost: parsed.host,
      remoteOwner: parsed.owner,
      remoteRepo: parsed.repo,
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: userSensitiveResolver(),
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
    assert.equal(result.inspection.policySnapshot?.approvedPushDestination?.canonicalHost, "no-user.example");
  } finally {
    await cleanup(repo);
  }
});

test("ssh-user regression F: enable/repair and the shipped hook resolve the SAME omitted-user route, via the real ssh -G call", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeUserSensitiveFakeSsh();
  try {
    // Enable-time (dependency-injected resolver, deterministic cross-platform).
    const parsed = parseRemoteUrl("ssh://github-work/AcmeSoftware/acme-frontend.git");
    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: parsed.protocol,
      pushRemoteHost: parsed.host,
      pushRemoteOwner: parsed.owner,
      pushRemoteRepo: parsed.repo,
      pushRemoteUser: parsed.sshUser,
      remoteHost: parsed.host,
      remoteOwner: parsed.owner,
      remoteRepo: parsed.repo,
    };
    const manager = new ShieldManager();
    const enableResult = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: userSensitiveResolver(),
    });
    assert.equal(enableResult.ok, true, enableResult.inspection.reasons.join("; "));
    assert.equal(enableResult.inspection.policySnapshot?.approvedPushDestination?.canonicalHost, "no-user.example");

    // Hook-time: the REAL shipped evaluator, given the SAME omitted-user
    // URL, must resolve via the real (user-sensitive) fake ssh to the
    // SAME "no-user.example" route -- proving enable() and the hook ask
    // (and answer) the identical question about the user.
    const policy = buildShieldPolicy({
      profile: workProfile,
      approvedPushDestination: {
        host: "github-work",
        owner: "AcmeSoftware",
        repo: "acme-frontend",
        canonicalHost: "no-user.example",
        canonicalPort: "22",
      },
      protectedBranches: [],
      enabledActions: ["push"],
      now: 1,
    });
    await writeRawPolicy(repo, policy);
    const push = await runEvaluatorScript(repo.dir, repo.env, fakeSshBin, EVALUATOR_SOURCE, [
      "push",
      "origin",
      "ssh://github-work/AcmeSoftware/acme-frontend.git",
    ]);
    assert.equal(push.code, 0, push.stderr);
  } finally {
    await cleanup(repo);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("ssh-user regression G: a destination change caused ONLY by username-sensitive effective routing blocks, rather than falsely confirming", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makeUserSensitiveFakeSsh();
  try {
    // Policy approved from the OMITTED-user route ("no-user.example"),
    // but the push URL now explicitly names a user ("deploy@github-work")
    // -- same alias, same owner/repo, but the effective route genuinely
    // differs because the user changed the resolution. Must BLOCK.
    const policy = buildShieldPolicy({
      profile: workProfile,
      approvedPushDestination: {
        host: "github-work",
        owner: "AcmeSoftware",
        repo: "acme-frontend",
        canonicalHost: "no-user.example",
        canonicalPort: "22",
      },
      protectedBranches: [],
      enabledActions: ["push"],
      now: 1,
    });
    await writeRawPolicy(repo, policy);
    const push = await runEvaluatorScript(repo.dir, repo.env, fakeSshBin, EVALUATOR_SOURCE, [
      "push",
      "origin",
      "ssh://deploy@github-work/AcmeSoftware/acme-frontend.git",
    ]);
    assert.notEqual(push.code, 0, "a user-sensitive routing change must block, never silently confirm");
    assert.match(push.stderr, /push-destination-mismatch/);
  } finally {
    await cleanup(repo);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});
