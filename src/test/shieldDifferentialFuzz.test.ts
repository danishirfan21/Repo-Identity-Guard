import assert from "node:assert/strict";
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
  setHeadBranch,
  setHeadDetached,
  setInProgressMarker,
  writeRawPolicy,
  InProgressMarker,
} from "./fuzzHarness";
import { CommitEvalFacts, PushEvalFacts, evaluateCommit, evaluatePush } from "../shield/evaluator";
import { ShieldPolicy, serializeShieldPolicy } from "../shield/policy";
import { ShieldAction } from "../shield/types";

/**
 * PART 7 — differential fuzzing: TypeScript reference vs the shipped
 * POSIX-shell evaluator.
 *
 * `src/shield/evaluator.ts` is the readable spec; `resources/shield/
 * shield-evaluate.sh` is what actually runs at hook time. They are
 * maintained as two independent implementations of one set of semantics,
 * which means the interesting failure mode is not "either is wrong" but
 * "they have quietly drifted apart" — at which point every test written
 * against the TypeScript one stops saying anything about what a real
 * commit or push does.
 *
 * So this harness generates randomized-but-boundary-biased policies and
 * action facts, runs BOTH implementations on each, and asserts they agree
 * on allow/block AND on the exact set of stable reason ids. Network-SSH
 * account verification is deliberately excluded (no policy generated here
 * carries an `expectedGitHubLogin`): reaching it would make a real network
 * call, and it has its own dedicated, mocked coverage in
 * `shieldGitHubAccountBinding.test.ts`.
 *
 * Determinism: the seed is fixed by default and printed on failure; set
 * `SHIELD_FUZZ_SEED=<n>` to reproduce, `SHIELD_FUZZ_CASES=<n>` to sweep
 * harder, `SHIELD_FUZZ_WORKERS=<n>` to change parallelism. Generation is
 * biased hard toward boundaries (empty strings, case flips, `.git`
 * suffixes, missing owners, unusual ports, aliases that are one character
 * off a trusted one) rather than uniform noise, which finds nothing.
 */

const SEED = fuzzSeed(0x5417e1d);
const PUSH_CASES = fuzzCaseCount(900);
const COMMIT_CASES = fuzzCaseCount(500);

// ==================== generators (boundary-biased) ====================

const NAMES = ["Danish Irfan", "danish irfan", "DANISH IRFAN", "Someone Else", "  Danish Irfan", "D"];
const EMAILS = [
  "work@example.com",
  "WORK@EXAMPLE.COM",
  "Work@Example.Com",
  "personal@example.com",
  "work@example.co",
  "work+tag@example.com",
];
const OWNERS = ["AcmeSoftware", "acmesoftware", "ACMESOFTWARE", "AcmeSoftwar", "acme-software", "Acme"];
const REPOS = ["acme-frontend", "ACME-Frontend", "acme-frontend2", "acme_frontend", "a"];
const HOSTS_SSH_ALIAS = ["github-work", "GitHub-Work", "github-work2", "github-personal", "gh-work"];
const BRANCHES = ["main", "MAIN", "master", "feature/login", "mainline", "release/1.0", "main2"];
const PROTECTED_SETS: string[][] = [[], ["main"], ["main", "master"], ["MAIN"], ["feature/login"], ["main", "release/1.0"]];
const MARKERS: InProgressMarker[] = [undefined, undefined, "merge", "rebase-merge", "rebase-apply", "cherry-pick", "revert"];
const ACTION_SETS: ShieldAction[][] = [["commit", "push"], ["commit", "push"], ["commit"], ["push"], []];

function randomPolicy(rng: Rng): ShieldPolicy {
  const hasDestination = rng.bool(0.85);
  const hasRepoInDestination = hasDestination && rng.bool(0.8);
  return {
    policyVersion: 2,
    generatedAt: 1_700_000_000_000,
    matchedProfileId: "work",
    profileLabel: rng.pick(["Work", "Personal", "Work / Acme"]),
    expectedGitName: rng.bool(0.7) ? rng.pick(NAMES) : undefined,
    expectedGitEmail: rng.pick(EMAILS),
    approvedRepositoryKey: rng.bool(0.8) ? `github.com/${rng.pick(OWNERS)}/${rng.pick(REPOS)}` : undefined,
    approvedPushDestination: hasDestination
      ? {
          host: rng.bool(0.9) ? "github.com" : undefined,
          // A destination with no owner at all is the fail-closed boundary.
          owner: rng.bool(0.9) ? rng.pick(OWNERS) : undefined,
          repo: hasRepoInDestination ? rng.pick(REPOS) : undefined,
        }
      : undefined,
    trustedSshHostAliases: rng.subset(HOSTS_SSH_ALIAS, 0.35),
    expectedGitHubLogin: undefined, // never: would trigger a real network probe
    strictPushSetup: rng.bool(0.6),
    protectedBranches: rng.pick(PROTECTED_SETS),
    expectedBranchPatterns: rng.subset(["feature/*", "release/*"], 0.4),
    enabledActions: rng.pick(ACTION_SETS),
  };
}

/** Push URLs across every shape Shield must parse, weighted toward the ambiguous ones. */
function randomPushUrl(rng: Rng): string {
  const owner = rng.pick(OWNERS);
  const repo = rng.pick(REPOS);
  const alias = rng.pick([...HOSTS_SSH_ALIAS, "github.com", "gitlab.com", "bitbucket.org"]);
  const dotGit = rng.bool(0.6) ? ".git" : "";
  switch (rng.int(12)) {
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
      // Missing repository component — the "missing evidence is not a match" boundary.
      return `git@${alias}:${owner}`;
    case 8:
      // Nested namespace (GitLab style): owner is the LAST-BUT-ONE segment.
      return `git@${alias}:${owner}/group/${repo}${dotGit}`;
    case 9:
      return `git://github.com/${owner}/${repo}${dotGit}`;
    case 10:
      return `${alias}:${owner}/${repo}${dotGit}`;
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
  refLines: string[];
}

function overrideEnv(repo: FuzzRepo, overrides: string[]): NodeJS.ProcessEnv {
  const env = { ...repo.env };
  if (overrides.includes("GIT_SSH")) env.GIT_SSH = "/usr/bin/ssh";
  if (overrides.includes("GIT_SSH_COMMAND")) env.GIT_SSH_COMMAND = "ssh -v";
  if (overrides.includes("core.sshCommand")) env.GIT_CONFIG_PARAMETERS = "'core.sshCommand'='ssh -q'";
  return env;
}

test("PART 7 — differential fuzz: push decisions match between the TypeScript reference and the shipped shell evaluator", { timeout: 600_000 }, async () => {
  const rng = rngFrom(SEED);
  const cases: PushCase[] = Array.from({ length: PUSH_CASES }, () => ({
    policy: randomPolicy(rng),
    url: randomPushUrl(rng),
    remoteName: rng.pick(["origin", "upstream", "fork", ""]),
    overrides: rng.pick(OVERRIDE_SETS),
    refLines: rng.bool(0.5)
      ? [`refs/heads/main ${"a".repeat(40)} refs/heads/main ${"0".repeat(40)}`]
      : [],
  }));

  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const mismatches = await mapWithRepos(repos, cases, async (repo, testCase, index) => {
      await writeRawPolicy(repo, serializeShieldPolicy(testCase.policy));
      const shell = await runEvaluator(repo, ["push", testCase.remoteName, testCase.url], {
        stdin: testCase.refLines.map((l) => `${l}\n`).join(""),
        env: overrideEnv(repo, testCase.overrides),
      });

      const facts: PushEvalFacts = {
        remoteName: testCase.remoteName,
        remoteUrl: testCase.url,
        refLines: testCase.refLines,
        sshCommandOverrides: testCase.overrides,
      };
      const reference = evaluatePush(testCase.policy, facts);

      const shellIds = [...shell.reasonIds].sort();
      const referenceIds = reference.reasons.map((r) => r.id).sort();
      if (shell.allowed !== reference.allowed || JSON.stringify(shellIds) !== JSON.stringify(referenceIds)) {
        return {
          index,
          seed: SEED,
          url: testCase.url,
          remoteName: testCase.remoteName,
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
      `${failures.length}/${PUSH_CASES} push cases disagreed (seed ${SEED}; reproduce with SHIELD_FUZZ_SEED=${SEED}).\n` +
        JSON.stringify(failures.slice(0, 3), null, 2),
    );
  } finally {
    await destroyRepoPool(repos);
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
  branch?: string;
  detached: boolean;
  marker: InProgressMarker;
}

test("PART 7 — differential fuzz: commit decisions match between the TypeScript reference and the shipped shell evaluator", { timeout: 600_000 }, async () => {
  const rng = rngFrom(SEED ^ 0x9e3779b9);
  const cases: CommitCase[] = Array.from({ length: COMMIT_CASES }, () => {
    const configuredName = rng.pick(NAMES).trim();
    const configuredEmail = rng.pick(EMAILS);
    return {
      policy: randomPolicy(rng),
      configuredName,
      configuredEmail,
      // Environment overrides are the interesting boundary: they separate
      // `commit-identity-mismatch` from `commit-identity-override`.
      envAuthorName: rng.bool(0.35) ? rng.pick(NAMES).trim() : undefined,
      envAuthorEmail: rng.bool(0.35) ? rng.pick(EMAILS) : undefined,
      envCommitterName: rng.bool(0.25) ? rng.pick(NAMES).trim() : undefined,
      envCommitterEmail: rng.bool(0.25) ? rng.pick(EMAILS) : undefined,
      branch: rng.pick(BRANCHES),
      detached: rng.bool(0.15),
      marker: rng.pick(MARKERS),
    };
  });

  const repos = await createRepoPool(fuzzPoolSize());
  try {
    const mismatches = await mapWithRepos(repos, cases, async (repo, testCase, index) => {
      await writeRawPolicy(repo, serializeShieldPolicy(testCase.policy));
      await setConfiguredIdentity(repo, testCase.configuredName, testCase.configuredEmail);
      if (testCase.detached) await setHeadDetached(repo);
      else await setHeadBranch(repo, testCase.branch as string);
      await setInProgressMarker(repo, testCase.marker);

      const env = { ...repo.env };
      if (testCase.envAuthorName !== undefined) env.GIT_AUTHOR_NAME = testCase.envAuthorName;
      if (testCase.envAuthorEmail !== undefined) env.GIT_AUTHOR_EMAIL = testCase.envAuthorEmail;
      if (testCase.envCommitterName !== undefined) env.GIT_COMMITTER_NAME = testCase.envCommitterName;
      if (testCase.envCommitterEmail !== undefined) env.GIT_COMMITTER_EMAIL = testCase.envCommitterEmail;

      const shell = await runEvaluator(repo, ["commit"], { env });

      // Git's own identity resolution: an explicit GIT_AUTHOR_*/
      // GIT_COMMITTER_* wins, otherwise the configured value is used. This
      // mirrors `git var GIT_AUTHOR_IDENT`, which is exactly what the shell
      // evaluator reads.
      const facts: CommitEvalFacts = {
        effectiveAuthorName: testCase.envAuthorName ?? testCase.configuredName,
        effectiveAuthorEmail: testCase.envAuthorEmail ?? testCase.configuredEmail,
        effectiveCommitterName: testCase.envCommitterName ?? testCase.configuredName,
        effectiveCommitterEmail: testCase.envCommitterEmail ?? testCase.configuredEmail,
        configuredName: testCase.configuredName,
        configuredEmail: testCase.configuredEmail,
        isDetachedHead: testCase.detached,
        currentBranch: testCase.detached ? undefined : testCase.branch,
        inProgressOperation:
          testCase.marker === undefined
            ? undefined
            : testCase.marker === "merge"
              ? "merge"
              : testCase.marker === "cherry-pick"
                ? "cherry-pick"
                : testCase.marker === "revert"
                  ? "revert"
                  : "rebase",
        // Deliberately never generated: producing a real unresolved
        // conflict needs an actual conflicting index, which cannot be
        // faked by writing a marker file. Conflicts have dedicated
        // coverage in shieldEvaluatorScript.test.ts.
        hasMergeConflicts: false,
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
      `${failures.length}/${COMMIT_CASES} commit cases disagreed (seed ${SEED}; reproduce with SHIELD_FUZZ_SEED=${SEED}).\n` +
        JSON.stringify(failures.slice(0, 3), null, 2),
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
    const cases = Array.from({ length: 40 }, () => ({
      action: rng.pick(["commit", "push"] as const),
      url: randomPushUrl(rng),
    }));
    const results = await mapWithRepos(repos, cases, async (repo, testCase) => {
      await deletePolicy(repo);
      const args = testCase.action === "commit" ? ["commit"] : ["push", "origin", testCase.url];
      return runEvaluator(repo, args);
    });
    for (const result of results) {
      assert.equal(result.allowed, false);
      assert.deepEqual(result.reasonIds, ["policy-missing"], result.stderr);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});
