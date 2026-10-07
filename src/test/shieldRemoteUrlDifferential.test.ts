import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createRepoPool,
  destroyRepoPool,
  fuzzCaseCount,
  fuzzPoolSize,
  fuzzSeed,
  mapWithRepos,
  rngFrom,
  runEvaluator as runEvaluatorRaw,
  writeRawPolicy,
} from "./fuzzHarness";
import { parseRemoteUrl } from "../services/gitService";
import { evaluatePush } from "../shield/evaluator";
import { ShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { identityWith, testPolicy } from "./testUtil/lockFixtures";

/**
 * PART 9 — remote-URL parsing: TypeScript vs the shipped shell evaluator.
 *
 * `parseRemoteUrl()` (TypeScript, `URL` + one scp-like regex) and the
 * evaluator's `case`/`sed` parsing are two independent implementations of
 * "which route will this push authenticate over". For the identity lock
 * that is a PROTOCOL + HOST question (is this SSH through a trusted alias,
 * or HTTPS, a generic host, an unknown alias, a look-alike?) — a
 * disagreement would mean verifying, or refusing, the wrong route. The
 * repository owner/path is no longer part of any decision (the push
 * destination policy was removed), so it is not compared here.
 *
 * The shell has no "return a parse" mode; each URL is driven through a
 * real `push` evaluation against a policy crafted so the REASON ID reveals
 * the classification, and the TypeScript reference is asked the same
 * question directly.
 */

const SEED = fuzzSeed(0x9a2b1c);

// ==================== identity fake ssh ====================
//
// A fake `ssh -G` that simply ECHOES BACK whatever host/alias it was asked
// about — exactly what a real, unconfigured `ssh` does for a host with no
// matching `Host` block. Such a hostname is never a GitHub endpoint, so the
// account probe always stops at route_not_github, before any `ssh -T` (the
// fake rejects any other invocation, which would surface as a mismatch).
let identityFakeSshBinPromise: Promise<string> | undefined;
async function identityFakeSshBin(): Promise<string> {
  if (!identityFakeSshBinPromise) {
    identityFakeSshBinPromise = (async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-p9-identity-ssh-"));
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

async function runEvaluator(
  repo: Parameters<typeof runEvaluatorRaw>[0],
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): ReturnType<typeof runEvaluatorRaw> {
  const baseEnv = options.env ?? repo.env;
  const env = withIdentityFakeSshPath(baseEnv, await identityFakeSshBin());
  return runEvaluatorRaw(repo, args, { ...options, env });
}

// ==================== corpus ====================

interface UrlCase {
  url: string;
  note: string;
}

const CORPUS: UrlCase[] = [
  // --- canonical GitHub shapes ---
  { url: "git@github.com:acme/repo.git", note: "scp-like, generic host" },
  { url: "git@github.com:acme/repo", note: "scp-like, no .git" },
  { url: "git@github-work:acme/repo.git", note: "scp-like via a custom alias" },
  { url: "ssh://git@github.com/acme/repo.git", note: "ssh:// URL" },
  { url: "ssh://git@github-work/acme/repo.git", note: "ssh:// URL via alias" },
  { url: "ssh://git@ssh.github.com:443/acme/repo.git", note: "GitHub's port-443 endpoint" },
  { url: "ssh://git@github.com:22/acme/repo.git", note: "explicit default port" },
  { url: "ssh://git@github-work:2222/acme/repo.git", note: "non-standard port" },
  { url: "https://github.com/acme/repo.git", note: "HTTPS" },
  { url: "https://github.com/acme/repo", note: "HTTPS, no .git" },
  { url: "https://user@github.com/acme/repo.git", note: "HTTPS with a username" },
  { url: "https://user:token@github.com/acme/repo.git", note: "HTTPS with userinfo (never echoed back)" },
  { url: "https://github.com:443/acme/repo.git", note: "HTTPS explicit port" },
  { url: "http://github.com/acme/repo.git", note: "plain HTTP" },
  { url: "git://github.com/acme/repo.git", note: "git:// protocol" },

  // --- other hosts / self-hosted ---
  { url: "git@gitlab.com:acme/repo.git", note: "generic gitlab host" },
  { url: "git@bitbucket.org:acme/repo.git", note: "generic bitbucket host" },
  { url: "git@git.internal.example:acme/repo.git", note: "self-hosted, non-generic" },
  { url: "ssh://git@git.internal.example:2222/acme/repo.git", note: "self-hosted with port" },

  // --- nested namespaces (GitLab-style) ---
  { url: "git@gitlab.com:acme/group/repo.git", note: "one nesting level" },
  { url: "git@gitlab.com:acme/group/sub/repo.git", note: "two nesting levels" },
  { url: "ssh://git@gitlab.com/acme/group/repo.git", note: "nested via ssh://" },
  { url: "https://gitlab.com/acme/group/repo.git", note: "nested via https" },

  // --- slashes, casing, suffixes ---
  { url: "git@github.com:/acme/repo.git", note: "leading slash in the path" },
  { url: "git@github.com://acme//repo.git", note: "repeated slashes" },
  { url: "git@github.com:acme/repo.git/", note: "trailing slash" },
  { url: "git@github.com:acme/repo.git//", note: "repeated trailing slashes" },
  { url: "https://github.com/acme/repo.git/", note: "https trailing slash" },
  { url: "git@GITHUB.COM:ACME/REPO.GIT", note: "all upper case" },
  { url: "git@GitHub.com:Acme/Repo.Git", note: "mixed case" },
  { url: "git@github.com:acme/repo.git.git", note: "double .git suffix" },
  { url: "git@github.com:acme/.git", note: "repo named exactly .git" },

  // --- IP literals and unusual authorities ---
  { url: "ssh://git@192.0.2.10/acme/repo.git", note: "IPv4 literal" },
  { url: "ssh://git@192.0.2.10:2222/acme/repo.git", note: "IPv4 literal with port" },
  { url: "ssh://git@[2001:db8::1]/acme/repo.git", note: "IPv6 literal" },
  { url: "ssh://git@[2001:db8::1]:2222/acme/repo.git", note: "IPv6 literal with port" },
  { url: "https://[2001:db8::1]/acme/repo.git", note: "IPv6 over https" },
  { url: "ssh://deploy@github.com/acme/repo.git", note: "non-git ssh username" },
  { url: "ssh://github.com/acme/repo.git", note: "ssh:// with no username at all" },
  { url: "github.com:acme/repo.git", note: "scp-like with no username" },

  // --- look-alikes that must never be confused ---
  { url: "git@github.com.evil.example:acme/repo.git", note: "look-alike suffix host" },
  { url: "git@evil.example:acme/repo.git", note: "unrelated host, same path" },
  { url: "git@github-work.evil.example:acme/repo.git", note: "alias-shaped look-alike" },

  // --- local paths and file:// ---
  { url: "/srv/git/acme/repo.git", note: "absolute POSIX path" },
  { url: "./relative/repo.git", note: "relative path" },
  { url: "file:///srv/git/acme/repo.git", note: "file:// with empty authority" },
  { url: "file://localhost/srv/git/acme/repo.git", note: "file:// with a host" },

  // --- Windows-shaped paths ---
  { url: "C:/repos/acme/repo.git", note: "Windows drive letter, forward slashes" },
  { url: "C:\\repos\\acme\\repo.git", note: "Windows drive letter, backslashes" },
  { url: "\\\\server\\share\\acme\\repo.git", note: "UNC path" },
  { url: "//server/share/acme/repo.git", note: "UNC path, forward slashes" },

  // --- percent encoding and unusual-but-legal names ---
  { url: "https://github.com/acme/repo%2Ename.git", note: "percent-encoded dot in repo name" },
  { url: "https://github.com/acme%2Dorg/repo.git", note: "percent-encoded dash in owner" },
  { url: "git@github.com:acme/repo.name.git", note: "dots inside the repo name" },
  { url: "git@github.com:acme/repo-name_v2.git", note: "dash and underscore" },
  { url: "git@github.com:acme/.hidden.git", note: "leading dot in repo name" },
  { url: "git@github.com:a/b.git", note: "single-character owner and repo" },

  // --- malformed / partial ---
  { url: "", note: "empty string" },
  { url: "   ", note: "whitespace only" },
  { url: "git@github.com:", note: "colon with nothing after it" },
  { url: "git@github.com", note: "no colon at all" },
  { url: ":acme/repo.git", note: "leading colon, no host" },
  { url: "git@:acme/repo.git", note: "empty host" },
  { url: "ssh://", note: "scheme only" },
  { url: "https://", note: "https scheme only" },
  { url: "ssh:///acme/repo.git", note: "ssh:// with empty authority" },
  { url: "://github.com/acme/repo.git", note: "missing scheme name" },
  { url: "git@github.com:acme/repo.git extra", note: "trailing junk after the URL" },
  { url: "not a url at all", note: "free text" },
  { url: "git@github.com:acme/repo.git\n", note: "trailing newline" },
];

/** Pairs where exactly one host may be read as the trusted alias — a look-alike must never be. */
const ROUTE_MUST_DIFFER: Array<[string, string, string]> = [
  ["git@github-work:acme/repo.git", "git@github-work.evil.example:acme/repo.git", "a subdomain look-alike is not the trusted alias"],
  ["git@github-work:acme/repo.git", "git@evil.example.github-work:acme/repo.git", "a suffix look-alike is not the trusted alias"],
  ["git@github-work:acme/repo.git", "git@github-work2:acme/repo.git", "a one-character alias difference is a different alias"],
  ["git@github-work:acme/repo.git", "ssh://git@github-work.evil.example/acme/repo.git", "a look-alike over ssh:// is not the trusted alias either"],
];

// ==================== a policy whose decision reveals the route parse ====================

// A lock that expects a GitHub login and trusts exactly one alias. The
// fake `ssh -G` above echoes the asked-about host back as the effective
// hostname — never a GitHub endpoint — so a push through the trusted alias
// stops at `push-account-unverified` (route_not_github) without any
// network, while every other route stops earlier at `push-route-unverified`
// / `push-route-override`. The reason id therefore reveals exactly how the
// URL's protocol and host were classified.
function routePolicy(): ShieldPolicy {
  return testPolicy(identityWith({ expectedGitHubLogin: "danish-work", trustedSshHostAliases: ["github-work"] }));
}

function referenceIds(url: string): string[] {
  const parsed = parseRemoteUrl(url);
  return evaluatePush(routePolicy(), {
    remoteName: "origin",
    remoteUrl: url,
    sshCommandOverrides: [],
    githubAccountCheck: { kind: "route-not-github", hostname: (parsed.host ?? "").toLowerCase(), port: "22" },
  }).reasons.map((r) => r.id);
}

test("PART 9 — the shell evaluator and the TypeScript reference classify protocol/host identically for every URL in the corpus", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const failures = await mapWithRepos(repos, CORPUS, async (repo, testCase) => {
      await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
      const shell = await runEvaluator(repo, ["push", "origin", testCase.url]);
      // An entirely empty remote URL never reaches URL parsing at all: the
      // hook contract requires one, so the evaluator reports
      // `inspection-failed` first. More informative than the reference
      // (which is only ever handed a URL) and still fail-closed.
      const expected = testCase.url === "" ? ["inspection-failed"] : referenceIds(testCase.url);
      if (shell.allowed || JSON.stringify(shell.reasonIds) !== JSON.stringify(expected)) {
        return { url: testCase.url, note: testCase.note, shellReasons: shell.reasonIds, expected, referenceParse: parseRemoteUrl(testCase.url), stderr: shell.stderr.slice(0, 400) };
      }
      return undefined;
    });
    const bad = failures.filter(Boolean);
    assert.equal(bad.length, 0, `${bad.length}/${CORPUS.length} URLs classified differently:\n${JSON.stringify(bad, null, 2)}`);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — a look-alike host is never read as the trusted SSH alias", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const results = await mapWithRepos(repos, ROUTE_MUST_DIFFER, async (repo, [trusted, lookAlike, why]) => {
      await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
      return { trusted, lookAlike, why, trustedResult: await runEvaluator(repo, ["push", "origin", trusted]), lookAlikeResult: await runEvaluator(repo, ["push", "origin", lookAlike]) };
    });
    for (const { trusted, lookAlike, why, trustedResult, lookAlikeResult } of results) {
      assert.deepEqual(trustedResult.reasonIds, ["push-account-unverified"], `the trusted alias "${trusted}" did not reach the account check: ${trustedResult.stderr.slice(0, 300)}`);
      assert.deepEqual(lookAlikeResult.reasonIds, ["push-route-unverified"], `"${lookAlike}" was accepted as a trusted route — ${why}`);
      assert.deepEqual(referenceIds(trusted), ["push-account-unverified"]);
      assert.deepEqual(referenceIds(lookAlike), ["push-route-unverified"]);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — a scp-like colon introduces a PATH, an ssh:// colon a PORT (both parsers)", () => {
  assert.equal(parseRemoteUrl("git@github-work:2222/repo.git").port, undefined);
  assert.equal(parseRemoteUrl("git@github-work:2222/repo.git").host, "github-work");
  assert.equal(parseRemoteUrl("ssh://git@github-work:2222/repo.git").port, "2222");
  // The shell side of the same rule is asserted on the real probe argv in
  // shieldSshPortCanonicalization.test.ts.
});

test("PART 9 — an unparseable or hostless URL always fails CLOSED for a login lock, never allowed by default", { timeout: 600_000 }, async () => {
  const hostless = CORPUS.filter((c) => {
    const parsed = parseRemoteUrl(c.url);
    return parsed.protocol === "unknown" || !parsed.host;
  });
  assert.ok(hostless.length >= 8, `expected the corpus to contain hostless/unparseable URLs, found ${hostless.length}`);
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const results = await mapWithRepos(repos, hostless, async (repo, testCase) => {
      await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
      return { testCase, result: await runEvaluator(repo, ["push", "origin", testCase.url]) };
    });
    for (const { testCase, result } of results) {
      assert.equal(result.allowed, false, `"${testCase.url}" (${testCase.note}) was allowed`);
      assert.ok(
        result.reasonIds.includes("push-route-unverified") || result.reasonIds.includes("inspection-failed"),
        `"${testCase.url}" blocked for an unexpected reason: ${result.reasonIds.join(", ")}`,
      );
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — a URL carrying credentials is never echoed back in a block message", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(1);
  const repo = repos[0];
  try {
    await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
    for (const url of ["https://user:s3cr3t-token@github.com/other/elsewhere.git", "ssh://user:s3cr3t-token@github-work/acme/repo.git"]) {
      const result = await runEvaluator(repo, ["push", "origin", url]);
      assert.equal(result.allowed, false);
      assert.ok(!result.stderr.includes("s3cr3t-token"), `the block message leaked credentials:\n${result.stderr}`);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — randomized URL sweep: shell and TypeScript agree on route classification", { timeout: 900_000 }, async () => {
  const rng = rngFrom(SEED);
  const OWNERS = ["acme", "Acme", "acme-org", "a"];
  const REPOS = ["repo", "Repo", "repo.name", "r"];
  const HOSTS = ["github.com", "github-work", "GitHub-Work", "gitlab.com", "git.internal.example", "192.0.2.10", "github-work.evil"];
  const cases: string[] = Array.from({ length: fuzzCaseCount(400) }, () => {
    const owner = rng.pick(OWNERS);
    const repo = rng.pick(REPOS);
    const host = rng.pick(HOSTS);
    const suffix = rng.bool(0.6) ? ".git" : "";
    const nest = rng.bool(0.2) ? "group/" : "";
    const user = rng.pick(["git@", "git@", "", "deploy@"]);
    switch (rng.int(6)) {
      case 0:
        return `${user}${host}:${nest}${owner}/${repo}${suffix}`;
      case 1:
        return `ssh://${user}${host}/${nest}${owner}/${repo}${suffix}`;
      case 2:
        return `ssh://${user}${host}:${rng.pick(["22", "443", "2222"])}/${nest}${owner}/${repo}${suffix}`;
      case 3:
        return `https://${host}/${nest}${owner}/${repo}${suffix}`;
      case 4:
        return `file:///${owner}/${repo}${suffix}`;
      default:
        return `git://${host}/${nest}${owner}/${repo}${suffix}`;
    }
  });

  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const failures = await mapWithRepos(repos, cases, async (repo, url) => {
      await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
      const shell = await runEvaluator(repo, ["push", "origin", url]);
      const expected = referenceIds(url);
      if (shell.allowed || JSON.stringify(shell.reasonIds) !== JSON.stringify(expected)) {
        return { url, parsed: parseRemoteUrl(url), shellReasons: shell.reasonIds, expected, stderr: shell.stderr.slice(0, 300) };
      }
      return undefined;
    });
    const bad = failures.filter(Boolean);
    assert.equal(bad.length, 0, `${bad.length}/${cases.length} randomized URLs disagreed (seed ${SEED}):\n${JSON.stringify(bad.slice(0, 5), null, 2)}`);
  } finally {
    await destroyRepoPool(repos);
  }
});
