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
import { ShieldPolicy, serializeShieldPolicy } from "../shield/policy";

/**
 * PART 9 — remote-URL parsing: TypeScript vs the shipped shell evaluator.
 *
 * `parseRemoteUrl()` (TypeScript, `URL` + one scp-like regex) and the
 * evaluator's `case`/`sed` parsing are two independent implementations of
 * "where would this push actually go". A push is blocked or allowed on the
 * OWNER and REPO they extract and on the PROTOCOL and HOST they classify,
 * so a disagreement is not cosmetic — it is Shield approving, or refusing,
 * the wrong destination.
 *
 * Rather than compare the parsers directly (the shell has no
 * "return a parse" mode; it only ever produces a decision), each URL is
 * driven through the shell as a real `push` evaluation against policies
 * crafted so the DECISION reveals the parse:
 *
 *  - a policy approving exactly `owner/repo` — allowed only if the parser
 *    extracted exactly that owner and repo;
 *  - a strict policy trusting exactly one alias — the route reason id
 *    reveals whether the protocol read as ssh/https/unknown and whether
 *    the host read as generic, trusted, or neither.
 *
 * The TypeScript reference is asked the same questions directly, and the
 * two answers must match.
 *
 * ## The conservative-resolution rule
 *
 * Ambiguity must never collapse two meaningfully different destinations
 * into one. The corpus therefore contains deliberately confusable PAIRS —
 * `acme/repo` vs `acme/group/repo`, `github.com` vs `github.com.evil.example`,
 * a scp-like `host:2222/x` (where `2222/x` is a PATH, not a port) vs an
 * `ssh://host:2222/x` (where it IS a port) — and asserts they never
 * resolve to the same approved destination.
 */

const SEED = fuzzSeed(0x9a2b1c);

// ==================== identity fake ssh ====================
//
// Round-2 release-blocker fix: the evaluator now canonicalizes an
// ssh-protocol destination's CURRENT host via a real "ssh -G" call,
// unconditionally (see resolve_canonical_ssh_route in
// shield-evaluate.sh) — there is no literal-comparison fallback left for
// ssh at all. This differential suite's whole point is comparing the
// TypeScript reference against the shell for OWNER/REPO extraction across
// a large URL corpus, independent of host-identity canonicalization
// (which has its own dedicated coverage in shieldEvaluator.test.ts /
// shieldCoexistenceAndIntegrity.test.ts). So rather than driving a real
// `~/.ssh/config`, this fake `ssh -G` simply ECHOES BACK whatever
// host/alias it was asked about — exactly what a real, unconfigured `ssh`
// does for a host with no matching `Host` block. Paired with policies
// built with `canonicalHost` set to the SAME literal host the test
// approves, canonical resolution trivially agrees with the literal text,
// which keeps every test below isolated to what it actually probes.
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

/**
 * Confusable pairs whose OWNER/REPO must never collapse into one approved
 * destination.
 *
 * Note what is deliberately NOT here: a pair that differs only by HOST.
 * Destination matching is owner-based by design, not host-based — see
 * `destinationReasons()` in src/shield/evaluator.ts — because a push
 * through a trusted SSH alias has a literally different hostname from the
 * repository's canonical remote host while going to the same account, and
 * comparing hosts would false-flag every alias-based push. Host confusion
 * is a ROUTE question, and is covered by `ROUTE_MUST_DIFFER` below.
 */
const DESTINATION_MUST_DIFFER: Array<[string, string, string]> = [
  ["git@github.com:acme/repo.git", "git@github.com:acme/group/repo.git", "a nested namespace names a different owner"],
  // In the scp-like form everything after the colon is the PATH (Git's own
  // rule), so "2222" is a path segment and becomes the OWNER; in the
  // ssh:// form the same "2222" is a PORT and the path has no owner at all.
  ["git@github-work:2222/repo.git", "ssh://git@github-work:2222/repo.git", "a scp-like colon introduces a PATH, an ssh:// colon a PORT"],
  ["git@github.com:acme/repo.git", "git@github.com:acme2/repo.git", "a one-character owner difference is a different owner"],
  ["https://github.com/acme/repo.git", "https://github.com/acme/repo2.git", "a one-character repo difference is a different repo"],
  ["git@github.com:acme/repo.git", "git@github.com:acme/repo.git.evil", "a suffix on the repo name is a different repo"],
];

/** Pairs where exactly one host may be read as the trusted alias — a look-alike must never be. */
const ROUTE_MUST_DIFFER: Array<[string, string, string]> = [
  ["git@github-work:acme/repo.git", "git@github-work.evil.example:acme/repo.git", "a subdomain look-alike is not the trusted alias"],
  ["git@github-work:acme/repo.git", "git@evil.example.github-work:acme/repo.git", "a suffix look-alike is not the trusted alias"],
  ["git@github-work:acme/repo.git", "git@github-work2:acme/repo.git", "a one-character alias difference is a different alias"],
  ["git@github-work:acme/repo.git", "ssh://git@github-work.evil.example/acme/repo.git", "a look-alike over ssh:// is not the trusted alias either"],
];

// ==================== policies that make a decision reveal the parse ====================

// `host` defaults to "github.com" for callers that don't care about it
// (e.g. `routePolicy()` overrides `approvedPushDestination` itself). A
// caller probing DESTINATION agreement for a specific URL must pass that
// URL's own parsed host — the release-blocker fix requires the approved
// and actual hosts to match too (literally, or canonically via "ssh -G",
// which this differential suite never sets up), so leaving it fixed at
// "github.com" would make every non-"github.com" URL in the corpus
// disagree on HOST even when it agrees on owner/repo, which is not what
// these tests are probing.
function destinationPolicy(owner: string, repo: string, host = "github.com"): ShieldPolicy {
  return {
    policyVersion: 2,
    generatedAt: 1_700_000_000_000,
    matchedProfileId: "work",
    profileLabel: "Work",
    expectedGitName: undefined,
    expectedGitEmail: "work@example.com",
    approvedRepositoryKey: undefined,
    // canonicalHost = host: paired with the identity fake ssh above, "ssh
    // -G" for an ssh-protocol destination echoes back the SAME literal
    // host it was asked about, so canonical resolution trivially agrees
    // with a literal match here — isolating this file's owner/repo
    // differential from the (separately covered) host-canonicalization
    // requirement itself.
    approvedPushDestination: { host, owner, repo, canonicalHost: host },
    trustedSshHostAliases: ["github-work"],
    expectedGitHubLogin: undefined,
    // Non-strict: the route is not a blocking factor here, so the ONLY
    // thing that can block is the destination, i.e. the parsed owner/repo
    // (and, as of the release-blocker fix, host).
    strictPushSetup: false,
    protectedBranches: [],
    expectedBranchPatterns: [],
    enabledActions: ["push"],
  };
}

function routePolicy(): ShieldPolicy {
  return {
    ...destinationPolicy("acme", "repo"),
    // Strict, and the destination is deliberately left wide (owner only)
    // so a destination mismatch does not mask the route reason. The route
    // reason id is what reveals protocol/host classification.
    approvedPushDestination: { host: "github.com", owner: "acme", canonicalHost: "github.com" },
    strictPushSetup: true,
  };
}

/**
 * What the TypeScript reference says the decision should be, for the
 * destination probe. `host` defaults to "github.com" to match
 * `destinationPolicy`'s default; a caller that built its policy with a
 * different host must pass the same one here, since (release-blocker fix)
 * the approved and actual hosts must now match too — literally here, since
 * this differential suite never sets up "ssh -G" resolution.
 */
function referenceDestinationAllows(url: string, owner: string, repo: string, host = "github.com"): boolean {
  const parsed = parseRemoteUrl(url);
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
  return (
    norm(parsed.owner) === norm(owner) &&
    !!parsed.owner &&
    norm(parsed.repo) === norm(repo) &&
    !!parsed.repo &&
    norm(parsed.host) === norm(host) &&
    !!parsed.host &&
    // A degenerate parse that leaves stray userinfo attached to the host
    // (e.g. "git@" for a URL with no actual host component) is not a
    // string any real "ssh -G" resolution would ever echo back as a
    // hostname — it fails to resolve at all, and the canonical-only
    // destination model (round-2 release-blocker fix) correctly reads
    // that as unprovable, never as an approved match.
    !parsed.host.includes("@")
  );
}

/** What the TypeScript reference says the strict route reason should be. */
function referenceRouteReason(url: string): "none" | "push-route-unverified" {
  const parsed = parseRemoteUrl(url);
  const generic = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
  const host = (parsed.host ?? "").trim().toLowerCase();
  const trusted = parsed.protocol === "ssh" && host.length > 0 && !generic.has(host) && host === "github-work";
  return trusted ? "none" : "push-route-unverified";
}

test("PART 9 — the shell evaluator and parseRemoteUrl() extract the same owner/repo for every URL in the corpus", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const failures = await mapWithRepos(repos, CORPUS, async (repo, testCase) => {
      // Probe with the owner/repo/host the URL is BUILT from, so "allowed"
      // means "both parsers extracted exactly acme/repo" at that host —
      // approving the URL's OWN host keeps this test isolated to
      // owner/repo parsing agreement, independent of the release-blocker
      // host-identity requirement (covered separately below).
      const ownHost = parseRemoteUrl(testCase.url).host || "github.com";
      await writeRawPolicy(repo, serializeShieldPolicy(destinationPolicy("acme", "repo", ownHost)));
      const shell = await runEvaluator(repo, ["push", "origin", testCase.url]);
      const expected = referenceDestinationAllows(testCase.url, "acme", "repo", ownHost);
      if (shell.allowed !== expected) {
        return {
          url: testCase.url,
          note: testCase.note,
          shellAllowed: shell.allowed,
          referenceAllowed: expected,
          referenceParse: parseRemoteUrl(testCase.url),
          stderr: shell.stderr.slice(0, 400),
        };
      }
      return undefined;
    });
    const bad = failures.filter(Boolean);
    assert.equal(bad.length, 0, `${bad.length}/${CORPUS.length} URLs parsed differently:\n${JSON.stringify(bad, null, 2)}`);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — the shell evaluator and the TypeScript reference classify protocol/host identically (strict route trust)", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const failures = await mapWithRepos(repos, CORPUS, async (repo, testCase) => {
      await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
      const shell = await runEvaluator(repo, ["push", "origin", testCase.url]);
      // An entirely empty remote URL never reaches URL parsing at all: the
      // hook contract requires one, so the evaluator reports
      // `inspection-failed` before parsing. That is deliberately MORE
      // informative than the TypeScript reference (which is only ever
      // handed a URL) and still fails closed, so it is not a drift.
      if (testCase.url === "") {
        return shell.reasonIds.includes("inspection-failed") && !shell.allowed
          ? undefined
          : { url: testCase.url, note: testCase.note, shellReasons: shell.reasonIds, expectedRoute: "inspection-failed" };
      }
      const expectedRoute = referenceRouteReason(testCase.url);
      const shellHasRouteReason = shell.reasonIds.includes("push-route-unverified") || shell.reasonIds.includes("push-route-mismatch");
      if (shellHasRouteReason !== (expectedRoute !== "none")) {
        return {
          url: testCase.url,
          note: testCase.note,
          shellReasons: shell.reasonIds,
          expectedRoute,
          referenceParse: parseRemoteUrl(testCase.url),
          stderr: shell.stderr.slice(0, 400),
        };
      }
      return undefined;
    });
    const bad = failures.filter(Boolean);
    assert.equal(bad.length, 0, `${bad.length}/${CORPUS.length} URLs classified differently:\n${JSON.stringify(bad, null, 2)}`);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — deliberately confusable URL pairs never resolve to the same approved destination", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const results = await mapWithRepos(repos, DESTINATION_MUST_DIFFER, async (repo, [a, b, why]) => {
      // Approve exactly what the FIRST url resolves to, so the first is
      // allowed by construction and the assertion is the strong one: the
      // second must then be refused. (Merely asserting "not both allowed"
      // would pass vacuously whenever neither matched.)
      const parsed = parseRemoteUrl(a);
      assert.ok(parsed.owner && parsed.repo, `fixture "${a}" must resolve to an owner and a repo`);
      // Approve "a"'s own host too, so a merely different HOST (which the
      // release-blocker fix also now enforces) can never be the reason "a"
      // itself is refused — the pairs here are specifically about
      // owner/repo confusability, not host.
      const ownHost = parsed.host || "github.com";
      await writeRawPolicy(repo, serializeShieldPolicy(destinationPolicy(parsed.owner as string, parsed.repo as string, ownHost)));
      return {
        a,
        b,
        why,
        first: await runEvaluator(repo, ["push", "origin", a]),
        second: await runEvaluator(repo, ["push", "origin", b]),
        referenceFirst: referenceDestinationAllows(a, parsed.owner as string, parsed.repo as string, ownHost),
        referenceSecond: referenceDestinationAllows(b, parsed.owner as string, parsed.repo as string, ownHost),
      };
    });
    for (const { a, b, why, first, second, referenceFirst, referenceSecond } of results) {
      assert.equal(first.allowed, true, `"${a}" was refused by its own approved destination: ${first.stderr.slice(0, 300)}`);
      assert.equal(second.allowed, false, `"${b}" matched the destination approved for "${a}" — ${why}`);
      assert.equal(referenceFirst, true, `TypeScript refused "${a}" against its own destination`);
      assert.equal(referenceSecond, false, `TypeScript collapsed "${b}" into "${a}" — ${why}`);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — a look-alike host is never read as the trusted SSH alias", { timeout: 600_000 }, async () => {
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const results = await mapWithRepos(repos, ROUTE_MUST_DIFFER, async (repo, [trusted, lookAlike, why]) => {
      await writeRawPolicy(repo, serializeShieldPolicy(routePolicy()));
      return {
        trusted,
        lookAlike,
        why,
        trustedResult: await runEvaluator(repo, ["push", "origin", trusted]),
        lookAlikeResult: await runEvaluator(repo, ["push", "origin", lookAlike]),
      };
    });
    for (const { trusted, lookAlike, why, trustedResult, lookAlikeResult } of results) {
      assert.ok(
        !trustedResult.reasonIds.includes("push-route-unverified"),
        `the genuinely trusted alias "${trusted}" was not accepted: ${trustedResult.stderr.slice(0, 300)}`,
      );
      assert.ok(
        lookAlikeResult.reasonIds.includes("push-route-unverified"),
        `"${lookAlike}" was accepted as a trusted route — ${why}`,
      );
      // And the TypeScript reference classifies the pair the same way.
      assert.equal(referenceRouteReason(trusted), "none", trusted);
      assert.equal(referenceRouteReason(lookAlike), "push-route-unverified", lookAlike);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — an unparseable or ambiguous URL always fails CLOSED, never allowed by default", { timeout: 600_000 }, async () => {
  const unparseable = CORPUS.filter((c) => {
    const parsed = parseRemoteUrl(c.url);
    return !parsed.owner || !parsed.repo;
  });
  assert.ok(unparseable.length >= 8, `expected the corpus to contain unparseable URLs, found ${unparseable.length}`);
  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const results = await mapWithRepos(repos, unparseable, async (repo, testCase) => {
      await writeRawPolicy(repo, serializeShieldPolicy(destinationPolicy("acme", "repo")));
      return { testCase, result: await runEvaluator(repo, ["push", "origin", testCase.url]) };
    });
    for (const { testCase, result } of results) {
      assert.equal(result.allowed, false, `"${testCase.url}" (${testCase.note}) was allowed despite yielding no owner/repo`);
      assert.ok(
        result.reasonIds.includes("push-destination-mismatch") || result.reasonIds.includes("inspection-failed"),
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
    await writeRawPolicy(repo, serializeShieldPolicy(destinationPolicy("acme", "repo")));
    const result = await runEvaluator(repo, ["push", "origin", "https://user:s3cr3t-token@github.com/other/elsewhere.git"]);
    assert.equal(result.allowed, false);
    assert.ok(!result.stderr.includes("s3cr3t-token"), `the block message leaked credentials:\n${result.stderr}`);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 9 — randomized URL sweep: shell and TypeScript agree on owner/repo extraction", { timeout: 900_000 }, async () => {
  const rng = rngFrom(SEED);
  const OWNERS = ["acme", "Acme", "acme-org", "a", "acme.co", "acme_1"];
  const REPOS = ["repo", "Repo", "repo.name", "repo-name", "r", "repo_v2"];
  const HOSTS = ["github.com", "github-work", "gitlab.com", "git.internal.example", "192.0.2.10"];
  const cases: string[] = Array.from({ length: fuzzCaseCount(400) }, () => {
    const owner = rng.pick(OWNERS);
    const repo = rng.pick(REPOS);
    const host = rng.pick(HOSTS);
    const suffix = rng.bool(0.6) ? ".git" : "";
    const leading = rng.bool(0.15) ? "/" : "";
    const trailing = rng.bool(0.15) ? "/" : "";
    const nest = rng.bool(0.2) ? "group/" : "";
    switch (rng.int(6)) {
      case 0:
        return `git@${host}:${leading}${nest}${owner}/${repo}${suffix}${trailing}`;
      case 1:
        return `ssh://git@${host}/${nest}${owner}/${repo}${suffix}${trailing}`;
      case 2:
        return `ssh://git@${host}:${rng.pick(["22", "443", "2222"])}/${nest}${owner}/${repo}${suffix}${trailing}`;
      case 3:
        return `https://${host}/${nest}${owner}/${repo}${suffix}${trailing}`;
      case 4:
        return `${host}:${nest}${owner}/${repo}${suffix}`;
      default:
        return `git://${host}/${nest}${owner}/${repo}${suffix}`;
    }
  });

  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const failures = await mapWithRepos(repos, cases, async (repo, url) => {
      const parsed = parseRemoteUrl(url);
      // Probe with exactly what TypeScript extracted (owner, repo, AND —
      // release-blocker fix — host); if the shell parser agrees the push is
      // allowed, if it disagrees anywhere it blocks.
      const owner = parsed.owner ?? "__none__";
      const repoName = parsed.repo ?? "__none__";
      const host = parsed.host || "github.com";
      await writeRawPolicy(repo, serializeShieldPolicy(destinationPolicy(owner, repoName, host)));
      const shell = await runEvaluator(repo, ["push", "origin", url]);
      const expected = !!parsed.owner && !!parsed.repo && !!parsed.host;
      if (shell.allowed !== expected) {
        return { url, parsed, shellAllowed: shell.allowed, expected, stderr: shell.stderr.slice(0, 300) };
      }
      return undefined;
    });
    const bad = failures.filter(Boolean);
    assert.equal(bad.length, 0, `${bad.length}/${cases.length} randomized URLs disagreed (seed ${SEED}):\n${JSON.stringify(bad.slice(0, 5), null, 2)}`);
  } finally {
    await destroyRepoPool(repos);
  }
});
