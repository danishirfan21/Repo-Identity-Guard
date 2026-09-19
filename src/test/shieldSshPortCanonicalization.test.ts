import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { collectRepoFacts, parseRemoteUrl } from "../services/gitService";
import { evaluatePush } from "../shield/evaluator";
import { ShieldManager, SshResolver } from "../shield/manager";
import { ShieldPolicy, buildShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";
import { Profile, RepoFacts } from "../types";
import { runEvaluatorScript } from "./testUtil/evaluatorShell";

/**
 * Release-blocker fix (independent re-review, round 3) — the canonical
 * physical push endpoint's PORT.
 *
 * ## The gap this closes
 *
 * `parseRemoteUrl`/`RepoFacts` tracked protocol/host/owner/repo but not an
 * explicit SSH URL port (`ssh://git@ssh.github.com:443/...`). At
 * enable/repair time `ShieldManager.buildPolicyForRepo` canonicalized the
 * approved destination with `ssh -G <host>` — no `-p` — while at push time
 * `shield-evaluate.sh` already correctly canonicalized with `ssh -G -p
 * 443 <host>` whenever the URL carried an explicit port (see
 * `resolve_canonical_ssh_route` and `URL_PORT`). Those are two DIFFERENT
 * `ssh -G` questions, and OpenSSH is not guaranteed to answer them the
 * same way — an unchanged, correctly-configured destination could
 * legitimately canonicalize to two different ports depending on which
 * side asked, and Shield would report a port MISMATCH on a push that
 * never changed at all.
 *
 * Fixed by extending `ParsedRemote`/`RepoFacts` with the explicit URL
 * port and SSH user (gitService.ts), and threading them into
 * `ShieldManager.canonicalizeDestination` so enable/repair asks the SAME
 * `ssh -G [-p <port>] <user>@<host>` question the hook does
 * (sshEndpoint.ts, manager.ts).
 *
 * ## Method
 *
 * The manager-level half (does `enable()` persist the port the URL
 * actually carried?) uses `ShieldEnableInput.sshResolver` dependency
 * injection — deterministic on all three platforms, unlike PATH-shadowing
 * a fake `ssh` binary onto Node's own `execFile`, which Windows does not
 * resolve the same way a POSIX shell does (see shieldCoexistenceAndIntegrity
 * .test.ts's case F fix for the fuller writeup). The hook-level half (does
 * the REAL shipped `shield-evaluate.sh` agree?) sources the real script
 * through `runEvaluatorScript`, the proven cross-platform mechanism from
 * shieldAccountVerificationCrossPlatform.test.ts — so every case below is
 * verified on ubuntu-latest, macos-latest, AND windows-latest, with no
 * platform skip anywhere in this file.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-port-"));
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

/**
 * Deterministic in-process stand-in for a real `ssh -G` resolution, used
 * for the manager-level (enable/repair) half of these tests. Mirrors real
 * OpenSSH's own port precedence: an explicit `-p` always wins; absent
 * one, it reports whatever the (simulated) `~/.ssh/config` says for this
 * host — `configPort`, defaulting to "22".
 */
function fakeResolver(hostname: string, configPort = "22"): SshResolver {
  return async (_host, options) => ({ host: hostname, port: options.port ?? configPort });
}

// ==================== A/B/C: manager-level canonicalization ====================

test("port regression A: enable() from an explicit-port ssh:// URL persists that SAME port as canonicalPort", async () => {
  const repo = await makeTempRepo();
  try {
    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: "ssh",
      pushRemoteHost: "ssh.github.com",
      pushRemoteOwner: "AcmeSoftware",
      pushRemoteRepo: "acme-frontend",
      pushRemotePort: "443",
      pushRemoteUser: "git",
      remoteHost: "ssh.github.com",
      remoteOwner: "AcmeSoftware",
      remoteRepo: "acme-frontend",
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: fakeResolver("ssh.github.com", "22"), // config default would be 22 -- the explicit :443 must win
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
    assert.equal(result.inspection.policySnapshot?.approvedPushDestination?.canonicalPort, "443");
  } finally {
    await cleanup(repo);
  }
});

test("port regression B/C: enable/repair and the shipped hook must AGREE on port for an unchanged destination, and BLOCK when it genuinely changes", async () => {
  // Case B: approved at port 443; the push URL is unchanged (still :443)
  // -> destination confirmed (no port-mismatch reason).
  const policyAt443 = buildShieldPolicy({
    profile: workProfile,
    approvedPushDestination: {
      host: "ssh.github.com",
      owner: "AcmeSoftware",
      repo: "acme-frontend",
      canonicalHost: "ssh.github.com",
      canonicalPort: "443",
    },
    protectedBranches: [],
    enabledActions: ["push"],
    now: 1,
  });
  const decisionUnchanged = evaluatePush(policyAt443, {
    remoteName: "origin",
    remoteUrl: "ssh://git@ssh.github.com:443/AcmeSoftware/acme-frontend.git",
    sshCommandOverrides: [],
    resolvedHost: "ssh.github.com",
    resolvedPort: "443",
  });
  assert.equal(decisionUnchanged.allowed, true, decisionUnchanged.reasons.map((r) => r.message).join("\n"));

  // Case B proper: approved at 443, the URL now reads :22 (a genuine port
  // change) -> BLOCKED.
  const decisionDowngraded = evaluatePush(policyAt443, {
    remoteName: "origin",
    remoteUrl: "ssh://git@ssh.github.com:22/AcmeSoftware/acme-frontend.git",
    sshCommandOverrides: [],
    resolvedHost: "ssh.github.com",
    resolvedPort: "22",
  });
  assert.equal(decisionDowngraded.allowed, false);
  assert.ok(decisionDowngraded.reasons.some((r) => r.id === "push-destination-mismatch"));

  // Case C: approved at port 22 (the default, e.g. no explicit port at
  // enable time), the URL now reads :443 -> BLOCKED.
  const policyAt22 = buildShieldPolicy({
    profile: workProfile,
    approvedPushDestination: {
      host: "ssh.github.com",
      owner: "AcmeSoftware",
      repo: "acme-frontend",
      canonicalHost: "ssh.github.com",
      canonicalPort: "22",
    },
    protectedBranches: [],
    enabledActions: ["push"],
    now: 1,
  });
  const decisionUpgraded = evaluatePush(policyAt22, {
    remoteName: "origin",
    remoteUrl: "ssh://git@ssh.github.com:443/AcmeSoftware/acme-frontend.git",
    sshCommandOverrides: [],
    resolvedHost: "ssh.github.com",
    resolvedPort: "443",
  });
  assert.equal(decisionUpgraded.allowed, false);
  assert.ok(decisionUpgraded.reasons.some((r) => r.id === "push-destination-mismatch"));
});

// ==================== D/E: explicit port vs config default, hook-level ====================

/**
 * A port-aware fake `ssh -G`: when invoked with an explicit `-p PORT`,
 * echoes PORT back (mirroring real OpenSSH's own precedence — an explicit
 * command-line port always wins); otherwise echoes `FAKE_SSH_CONFIG_PORT`
 * (default "22"), simulating a `~/.ssh/config` `Host` block that sets a
 * non-default port for an alias with no port in the URL at all.
 */
async function makePortAwareFakeSsh(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-port-fakessh-"));
  const implPath = path.join(binDir, "impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  const pIdx = args.indexOf("-p");
  const port = pIdx !== -1 && args[pIdx + 1] ? args[pIdx + 1] : (process.env.FAKE_SSH_CONFIG_PORT || "22");
  const hostname = process.env.FAKE_SSH_HOSTNAME || "ssh.github.com";
  process.stdout.write("user git\\nhostname " + hostname + "\\nport " + port + "\\n");
  process.exit(0);
}
process.stderr.write("fake-ssh-port: unexpected invocation: " + joined + "\\n");
process.exit(1);
`,
  );
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
}

async function writeRawPolicy(repo: Repo, policy: ShieldPolicy): Promise<void> {
  const commonDir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  await fs.mkdir(shieldStorageDir(commonDir), { recursive: true });
  await fs.writeFile(shieldPolicyFilePath(commonDir), serializeShieldPolicy(policy));
}

test("port regression D: no URL port, but the alias's effective ssh config specifies a non-default port -> enable and hook agree", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makePortAwareFakeSsh();
  try {
    // Enable-time: no explicit port in the URL (facts.pushRemotePort is
    // undefined) -- the resolver must be asked WITHOUT "-p", exactly the
    // way an omitted port always has been, and the fake reports the
    // config's own non-default port (2222).
    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: "ssh",
      pushRemoteHost: "github-work",
      pushRemoteOwner: "AcmeSoftware",
      pushRemoteRepo: "acme-frontend",
      pushRemoteUser: "git",
      remoteHost: "github-work",
      remoteOwner: "AcmeSoftware",
      remoteRepo: "acme-frontend",
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: async (host, options) => {
        assert.equal(options.port, undefined, "no URL port must mean no -p at all, not a guessed default");
        return { host: "ssh.github.com", port: "2222" };
      },
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));
    assert.equal(result.inspection.policySnapshot?.approvedPushDestination?.canonicalPort, "2222");

    // Hook-time: the REAL shipped evaluator, given the same alias with no
    // URL port, must resolve to the SAME config-driven port via the same
    // port-aware fake ssh -- proving enable() and the hook ask (and
    // answer) the identical question.
    const policy = buildShieldPolicy({
      profile: workProfile,
      approvedPushDestination: {
        host: "github-work",
        owner: "AcmeSoftware",
        repo: "acme-frontend",
        canonicalHost: "ssh.github.com",
        canonicalPort: "2222",
      },
      protectedBranches: [],
      enabledActions: ["push"],
      now: 1,
    });
    await writeRawPolicy(repo, policy);
    const push = await runEvaluatorScript(
      repo.dir,
      { ...repo.env, FAKE_SSH_CONFIG_PORT: "2222" },
      fakeSshBin,
      EVALUATOR_SOURCE,
      ["push", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"],
    );
    assert.equal(push.code, 0, push.stderr);
  } finally {
    await cleanup(repo);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("port regression E: an explicit URL port overrides the alias's config default, identically at enable time and hook time", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makePortAwareFakeSsh();
  try {
    // The alias's OWN config default is 2222 (FAKE_SSH_CONFIG_PORT below),
    // but the URL explicitly says :443 -- the explicit port must win on
    // BOTH sides, exactly like real OpenSSH's own `-p` precedence.
    const policy = buildShieldPolicy({
      profile: workProfile,
      approvedPushDestination: {
        host: "github-work",
        owner: "AcmeSoftware",
        repo: "acme-frontend",
        canonicalHost: "ssh.github.com",
        canonicalPort: "443",
      },
      protectedBranches: [],
      enabledActions: ["push"],
      now: 1,
    });
    await writeRawPolicy(repo, policy);
    const push = await runEvaluatorScript(
      repo.dir,
      { ...repo.env, FAKE_SSH_CONFIG_PORT: "2222" },
      fakeSshBin,
      EVALUATOR_SOURCE,
      ["push", "origin", "ssh://git@github-work:443/AcmeSoftware/acme-frontend.git"],
    );
    assert.equal(push.code, 0, push.stderr);

    // Sanity: the SAME alias, same config default, but WITHOUT the
    // explicit URL port, must NOT match a policy approved at 443 (it
    // resolves to the config's 2222 instead) -- proving the explicit port
    // genuinely changed the outcome, not that port is ignored entirely.
    const noExplicitPort = await runEvaluatorScript(
      repo.dir,
      { ...repo.env, FAKE_SSH_CONFIG_PORT: "2222" },
      fakeSshBin,
      EVALUATOR_SOURCE,
      ["push", "origin", "git@github-work:AcmeSoftware/acme-frontend.git"],
    );
    assert.notEqual(noExplicitPort.code, 0);
    assert.match(noExplicitPort.stderr, /push-destination-mismatch/);
  } finally {
    await cleanup(repo);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ==================== F: SSH username-sensitive config ====================

test("port regression F: an explicit non-default SSH username in the URL is what enable() and the hook both resolve against", async () => {
  const repo = await makeTempRepo();
  const fakeSshBin = await makePortAwareFakeSsh();
  try {
    // Enable-time: the resolver must receive the URL's own user ("deploy"),
    // never a silently-assumed "git".
    const facts: RepoFacts = {
      isGitRepo: true,
      pushRemoteProtocol: "ssh",
      pushRemoteHost: "ssh.github.com",
      pushRemoteOwner: "AcmeSoftware",
      pushRemoteRepo: "acme-frontend",
      pushRemotePort: "443",
      pushRemoteUser: "deploy",
      remoteHost: "ssh.github.com",
      remoteOwner: "AcmeSoftware",
      remoteRepo: "acme-frontend",
    };
    const manager = new ShieldManager();
    const result = await manager.enable(repo.dir, EVALUATOR_SOURCE, {
      facts,
      profiles: [workProfile],
      protectedBranches: [],
      sshResolver: async (host, options) => {
        assert.equal(options.user, "deploy", "the URL's own ssh user must reach the resolver, not a hardcoded 'git'");
        return { host, port: options.port ?? "22" };
      },
    });
    assert.equal(result.ok, true, result.inspection.reasons.join("; "));

    // Hook-time: parseRemoteUrl's own sshUser extraction, cross-checked
    // against the shell's SSH_USER extraction for the same URL shape.
    const parsed = parseRemoteUrl("ssh://deploy@ssh.github.com:443/AcmeSoftware/acme-frontend.git");
    assert.equal(parsed.sshUser, "deploy");
  } finally {
    await cleanup(repo);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ==================== G: TypeScript vs shell parity across host/port forms ====================

const PORT_CORPUS: Array<{ url: string; expectHost: string; expectPort: string | undefined }> = [
  { url: "ssh://git@ssh.github.com:443/acme/repo.git", expectHost: "ssh.github.com", expectPort: "443" },
  { url: "ssh://git@ssh.github.com/acme/repo.git", expectHost: "ssh.github.com", expectPort: undefined },
  { url: "git@github.com:acme/repo.git", expectHost: "github.com", expectPort: undefined },
  { url: "ssh://git@192.0.2.10:2222/acme/repo.git", expectHost: "192.0.2.10", expectPort: "2222" },
  { url: "ssh://git@192.0.2.10/acme/repo.git", expectHost: "192.0.2.10", expectPort: undefined },
  { url: "ssh://git@[2001:db8::1]:2222/acme/repo.git", expectHost: "[2001:db8::1]", expectPort: "2222" },
  { url: "ssh://git@[2001:db8::1]/acme/repo.git", expectHost: "[2001:db8::1]", expectPort: undefined },
];

test("port regression G: parseRemoteUrl extracts the explicit port identically across IPv4/hostname/IPv6 forms, with and without one", () => {
  for (const { url, expectHost, expectPort } of PORT_CORPUS) {
    const parsed = parseRemoteUrl(url);
    assert.equal(parsed.host, expectHost, `host mismatch for ${url}`);
    assert.equal(parsed.port, expectPort, `port mismatch for ${url}`);
    assert.equal(parsed.sshUser, "git", `sshUser mismatch for ${url}`);
  }
});

test("port regression G: the shell evaluator's URL_PORT extraction (via a real push) agrees with parseRemoteUrl for every corpus entry", async () => {
  const fakeSshBin = await makePortAwareFakeSsh();
  try {
    for (const { url, expectPort } of PORT_CORPUS) {
      const repo = await makeTempRepo();
      try {
        const parsed = parseRemoteUrl(url);
        const policy = buildShieldPolicy({
          profile: workProfile,
          approvedPushDestination: {
            host: parsed.host,
            owner: "acme",
            repo: "repo",
            canonicalHost: parsed.host,
            canonicalPort: expectPort ?? "22", // the fake's own config default when the URL carries none
          },
          protectedBranches: [],
          enabledActions: ["push"],
          now: 1,
        });
        await writeRawPolicy(repo, policy);
        const push = await runEvaluatorScript(repo.dir, { ...repo.env, FAKE_SSH_HOSTNAME: parsed.host, FAKE_SSH_CONFIG_PORT: "22" }, fakeSshBin, EVALUATOR_SOURCE, [
          "push",
          "origin",
          url,
        ]);
        assert.equal(push.code, 0, `${url}: ${push.stderr}`);
      } finally {
        await cleanup(repo);
      }
    }
  } finally {
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});
