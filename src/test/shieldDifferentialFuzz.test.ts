import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import {
  FuzzRepo,
  Rng,
  createRepoPool,
  deletePolicy,
  destroyRepoPool,
  fuzzCaseCount,
  fuzzPoolSize,
  fuzzSeed,
  mapWithRepos,
  rngFrom,
  runEvaluator,
  setConfiguredIdentity,
  writeRawPolicy,
} from "./fuzzHarness";
import { CommitEvalFacts, PushEvalFacts, evaluateCommit, evaluatePush } from "../shield/evaluator";
import { ShieldPolicy, buildShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { makeFakeSshBin, withFakeSshOnPath } from "./testUtil/fakeSsh";

/**
 * PART 7 — differential fuzzing: TypeScript reference vs the shipped
 * POSIX-shell evaluator.
 *
 * `src/shield/evaluator.ts` is the readable spec; `resources/shield/
 * shield-evaluate.sh` is what actually runs at hook time. The interesting
 * failure mode is not "either is wrong" but "they have quietly drifted
 * apart", so this harness generates randomized-but-boundary-biased
 * policies and action facts, runs BOTH, and asserts they agree on
 * allow/block AND on the exact reason id.
 *
 * Push cases mostly use identities WITH an expected GitHub login (one with
 * no login blocks every push as `push-identity-not-configured` before the
 * route is even parsed, which would make the push sweep trivial — a
 * minority of cases still exercise that, so both sides must agree on it). The
 * live account probe is kept hermetic: a fake `ssh` on PATH resolves every
 * alias to a non-GitHub host, so whenever the shell reaches the probe it
 * stops at `route_not_github` without any network connection — and the
 * TypeScript side is given that same probe outcome. (Where PATH shadowing
 * does not reach the shell — Windows — a real `ssh -G` of these made-up
 * aliases also reports a non-GitHub hostname, yielding the same id.) The
 * live probe's full outcome matrix has dedicated coverage in
 * shieldAccountVerificationCrossPlatform.test.ts.
 *
 * Determinism: fixed default seed, printed on failure;
 * `SHIELD_FUZZ_SEED=<n>` reproduces, `SHIELD_FUZZ_CASES=<n>` resizes.
 */

const SEED = fuzzSeed(0x5417e1d);
const PUSH_CASES = fuzzCaseCount(900);
const COMMIT_CASES = fuzzCaseCount(500);

// ==================== generators (boundary-biased) ====================

const NAMES = ["Danish Irfan", "danish irfan", "DANISH IRFAN", "Someone Else", "  Danish Irfan", "D"];
const EMAILS = ["work@example.com", "WORK@EXAMPLE.COM", "Work@Example.Com", "personal@example.com", "work@example.co", "work+tag@example.com"];
const OWNERS = ["AcmeSoftware", "acmesoftware", "Acme"];
const REPOS = ["acme-frontend", "ACME-Frontend", "a"];
const HOSTS_SSH_ALIAS = ["github-work", "GitHub-Work", "github-work2", "github-personal", "gh-work"];

function randomPolicy(rng: Rng, withLogin: boolean): ShieldPolicy {
  return buildShieldPolicy({
    identity: {
      id: "work",
      label: rng.pick(["Work", "Personal", "Work / Acme"]),
      gitName: rng.bool(0.7) ? rng.pick(NAMES) : undefined,
      gitEmail: rng.pick(EMAILS),
      expectedGitHubLogin: withLogin ? rng.pick(["danish-work", "Danish-Work"]) : undefined,
      trustedSshHostAliases: rng.subset(HOSTS_SSH_ALIAS, 0.35),
    },
    lockId: "fuzz",
    assignedAt: 1_700_000_000_000,
    now: 1_700_000_000_000,
  });
}

/** Push URLs across every shape the evaluator must parse, weighted toward the ambiguous ones. */
function randomPushUrl(rng: Rng): string {
  const owner = rng.pick(OWNERS);
  const repo = rng.pick(REPOS);
  const alias = rng.pick([...HOSTS_SSH_ALIAS, "github.com", "gitlab.com", "bitbucket.org"]);
  const dotGit = rng.bool(0.6) ? ".git" : "";
  switch (rng.int(13)) {
    case 0:
      return `git@${alias}:${owner}/${repo}${dotGit}`;
    case 1:
      return `ssh://git@${alias}/${owner}/${repo}${dotGit}`;
    case 2:
      return `ssh://git@${alias}:2222/${owner}/${repo}${dotGit}`;
    case 3:
      return `ssh://git@ssh.github.com:443/${owner}/${repo}${dotGit}`;
    case 4:
      return `https://github.com/${owner}/${repo}${dotGit}`;
    case 5:
      return `https://user@github.com/${owner}/${repo}${dotGit}`;
    case 6:
      return `http://github.com/${owner}/${repo}${dotGit}`;
    case 7:
      return `git@${alias}:${owner}`;
    case 8:
      return `${alias}:${owner}/${repo}${dotGit}`;
    case 9:
      return `git://github.com/${owner}/${repo}${dotGit}`;
    case 10:
      return `ssh://${alias}/${owner}/${repo}${dotGit}`;
    case 11:
      return `://github.com/${owner}/${repo}`;
    default:
      return `git@${alias}:/${owner}/${repo}${dotGit}/`;
  }
}

const OVERRIDE_SETS: string[][] = [[], [], [], ["GIT_SSH"], ["GIT_SSH_COMMAND"], ["core.sshCommand"], ["GIT_SSH", "GIT_SSH_COMMAND"]];

// ==================== PART 7a: push ====================

interface PushCase {
  policy: ShieldPolicy;
  url: string;
  remoteName: string;
  overrides: string[];
}

function overrideEnv(env: NodeJS.ProcessEnv, overrides: string[]): NodeJS.ProcessEnv {
  const result = { ...env };
  if (overrides.includes("GIT_SSH")) result.GIT_SSH = "/usr/bin/ssh";
  if (overrides.includes("GIT_SSH_COMMAND")) result.GIT_SSH_COMMAND = "ssh -v";
  if (overrides.includes("core.sshCommand")) result.GIT_CONFIG_PARAMETERS = "'core.sshCommand'='ssh -q'";
  return result;
}

test("PART 7 — differential fuzz: push decisions match between the TypeScript reference and the shipped shell evaluator", { timeout: 600_000 }, async () => {
  const rng = rngFrom(SEED);
  const cases: PushCase[] = Array.from({ length: PUSH_CASES }, () => ({
    policy: randomPolicy(rng, rng.bool(0.85)),
    url: randomPushUrl(rng),
    remoteName: rng.pick(["origin", "upstream", "fork", ""]),
    overrides: rng.pick(OVERRIDE_SETS),
  }));

  const repos = await createRepoPool(fuzzPoolSize());
  const fakeSshBin = await makeFakeSshBin();
  try {
    const mismatches = await mapWithRepos(repos, cases, async (repo: FuzzRepo, testCase, index) => {
      await writeRawPolicy(repo, serializeShieldPolicy(testCase.policy));
      const env = overrideEnv({ ...withFakeSshOnPath(repo.env, fakeSshBin), FAKE_SSH_HOSTNAME: "not-github.example" }, testCase.overrides);
      const shell = await runEvaluator(repo, ["push", testCase.remoteName, testCase.url], { env });

      const facts: PushEvalFacts = {
        remoteName: testCase.remoteName,
        remoteUrl: testCase.url,
        sshCommandOverrides: testCase.overrides,
        githubAccountCheck: { kind: "route-not-github", hostname: "not-github.example", port: "22" },
      };
      const reference = evaluatePush(testCase.policy, facts);

      const shellIds = [...shell.reasonIds].sort();
      const referenceIds = reference.reasons.map((r) => r.id).sort();
      if (shell.allowed !== reference.allowed || JSON.stringify(shellIds) !== JSON.stringify(referenceIds)) {
        return {
          index,
          seed: SEED,
          url: testCase.url,
          overrides: testCase.overrides,
          policy: testCase.policy,
          shell: { allowed: shell.allowed, ids: shellIds, stderr: shell.stderr.slice(0, 600) },
          reference: { allowed: reference.allowed, ids: referenceIds },
        };
      }
      return undefined;
    });

    const failures = mismatches.filter(Boolean);
    assert.equal(
      failures.length,
      0,
      `${failures.length}/${PUSH_CASES} push cases disagreed (seed ${SEED}; reproduce with SHIELD_FUZZ_SEED=${SEED}).\n` + JSON.stringify(failures.slice(0, 3), null, 2),
    );
  } finally {
    await destroyRepoPool(repos);
    await fs.rm(fakeSshBin, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ==================== PART 7b: commit ====================

interface CommitCase {
  policy: ShieldPolicy;
  configuredName?: string;
  configuredEmail?: string;
  envAuthorName?: string;
  envAuthorEmail?: string;
  envCommitterName?: string;
  envCommitterEmail?: string;
}

test("PART 7 — differential fuzz: commit decisions match between the TypeScript reference and the shipped shell evaluator", { timeout: 600_000 }, async () => {
  const rng = rngFrom(SEED ^ 0x9e3779b9);
  const cases: CommitCase[] = Array.from({ length: COMMIT_CASES }, () => ({
    policy: randomPolicy(rng, rng.bool(0.3)),
    configuredName: rng.pick(NAMES).trim(),
    configuredEmail: rng.pick(EMAILS),
    // Environment overrides are the interesting boundary: they separate
    // `commit-identity-mismatch` from `commit-identity-override`.
    envAuthorName: rng.bool(0.35) ? rng.pick(NAMES).trim() : undefined,
    envAuthorEmail: rng.bool(0.35) ? rng.pick(EMAILS) : undefined,
    envCommitterName: rng.bool(0.25) ? rng.pick(NAMES).trim() : undefined,
    envCommitterEmail: rng.bool(0.25) ? rng.pick(EMAILS) : undefined,
  }));

  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const mismatches = await mapWithRepos(repos, cases, async (repo, testCase, index) => {
      await writeRawPolicy(repo, serializeShieldPolicy(testCase.policy));
      await setConfiguredIdentity(repo, testCase.configuredName, testCase.configuredEmail);

      const env = { ...repo.env };
      if (testCase.envAuthorName !== undefined) env.GIT_AUTHOR_NAME = testCase.envAuthorName;
      if (testCase.envAuthorEmail !== undefined) env.GIT_AUTHOR_EMAIL = testCase.envAuthorEmail;
      if (testCase.envCommitterName !== undefined) env.GIT_COMMITTER_NAME = testCase.envCommitterName;
      if (testCase.envCommitterEmail !== undefined) env.GIT_COMMITTER_EMAIL = testCase.envCommitterEmail;

      const shell = await runEvaluator(repo, ["commit"], { env });

      // Git's own identity resolution, which `git var` (what the shell
      // reads) implements: an explicit GIT_AUTHOR_*/GIT_COMMITTER_* wins,
      // otherwise the configured value.
      const facts: CommitEvalFacts = {
        effectiveAuthorName: testCase.envAuthorName ?? testCase.configuredName,
        effectiveAuthorEmail: testCase.envAuthorEmail ?? testCase.configuredEmail,
        effectiveCommitterName: testCase.envCommitterName ?? testCase.configuredName,
        effectiveCommitterEmail: testCase.envCommitterEmail ?? testCase.configuredEmail,
        configuredName: testCase.configuredName,
        configuredEmail: testCase.configuredEmail,
      };
      const reference = evaluateCommit(testCase.policy, facts);

      const shellIds = [...shell.reasonIds].sort();
      const referenceIds = reference.reasons.map((r) => r.id).sort();
      if (shell.allowed !== reference.allowed || JSON.stringify(shellIds) !== JSON.stringify(referenceIds)) {
        return {
          index,
          seed: SEED,
          testCase,
          shell: { allowed: shell.allowed, ids: shellIds, stderr: shell.stderr.slice(0, 600) },
          reference: { allowed: reference.allowed, ids: referenceIds },
        };
      }
      return undefined;
    });

    const failures = mismatches.filter(Boolean);
    assert.equal(
      failures.length,
      0,
      `${failures.length}/${COMMIT_CASES} commit cases disagreed (seed ${SEED}; reproduce with SHIELD_FUZZ_SEED=${SEED}).\n` + JSON.stringify(failures.slice(0, 3), null, 2),
    );
  } finally {
    await destroyRepoPool(repos);
  }
});

// ==================== a missing policy must always fail closed ====================

test("PART 7 — with the policy deleted mid-sweep, every generated action fails closed with policy-missing", async () => {
  const rng = rngFrom(SEED ^ 0x1234);
  const repos = await createRepoPool(Math.min(4, fuzzPoolSize()));
  try {
    const cases = Array.from({ length: 40 }, () => ({ action: rng.pick(["commit", "push"] as const), url: randomPushUrl(rng) }));
    const results = await mapWithRepos(repos, cases, async (repo, testCase) => {
      await deletePolicy(repo);
      return runEvaluator(repo, testCase.action === "commit" ? ["commit"] : ["push", "origin", testCase.url]);
    });
    for (const result of results) {
      assert.equal(result.allowed, false);
      assert.deepEqual(result.reasonIds, ["policy-missing"], result.stderr);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});
