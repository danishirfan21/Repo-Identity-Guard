import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepoPool,
  destroyRepoPool,
  fuzzCaseCount,
  fuzzPoolSize,
  fuzzSeed,
  fuzzStride,
  mapWithRepos,
  rngFrom,
  runEvaluator,
  setConfiguredIdentity,
  setHeadBranch,
  writeRawPolicy,
} from "./fuzzHarness";
import { ShieldPolicy, parseShieldPolicy, serializeShieldPolicy } from "../shield/policy";

/**
 * PART 8 — adversarial fuzzing of the standalone evaluator's policy parser.
 *
 * The evaluator parses its policy with a recursive-descent JSON parser
 * written in POSIX awk (no jq, no Node, no Python — see the long comment in
 * `shield-evaluate.sh`). That parser is the one piece of Shield that faces
 * arbitrary bytes off disk, and its two historical failure modes were both
 * FAIL-OPEN: a compactly-formatted policy and a truncated policy each made
 * `enabledActions` come back empty, which the script read as "this policy
 * does not govern this action" and exited 0.
 *
 * ## The invariant under test
 *
 * > If the TypeScript validator says a policy is INVALID, the shell
 * > evaluator must NEVER allow an action from reading it more leniently.
 *
 * Note the asymmetry, which is deliberate and is what makes this a safety
 * property rather than a strict-equality check: the shell being *stricter*
 * than TypeScript is fine (it fails closed), the shell being *more
 * permissive* is a bug. Every generated case is therefore checked as
 * "TypeScript-invalid ⟹ shell blocks", plus, for valid policies,
 * "TypeScript-valid and would-allow ⟹ shell allows" so the parser cannot
 * pass this file by simply rejecting everything.
 */

const SEED = fuzzSeed(0x9011c4);

// A policy that is unambiguously valid AND unambiguously allow-producing
// for the repository state these tests set up, so any block observed for it
// is attributable to parsing rather than to policy content.
function baselinePolicy(): ShieldPolicy {
  return {
    policyVersion: 2,
    generatedAt: 1_700_000_000_000,
    matchedProfileId: "work",
    profileLabel: "Work",
    expectedGitName: "Danish Irfan",
    expectedGitEmail: "work@example.com",
    approvedRepositoryKey: "github.com/AcmeSoftware/acme-frontend",
    approvedPushDestination: { host: "github.com", owner: "AcmeSoftware", repo: "acme-frontend" },
    trustedSshHostAliases: ["github-work"],
    expectedGitHubLogin: undefined,
    strictPushSetup: false,
    protectedBranches: ["main"],
    expectedBranchPatterns: ["feature/*"],
    enabledActions: ["commit", "push"],
  };
}

const BASELINE_JSON = serializeShieldPolicy(baselinePolicy());

async function prepareRepoState(repo: Parameters<typeof setHeadBranch>[0]): Promise<void> {
  await setConfiguredIdentity(repo, "Danish Irfan", "work@example.com");
  await setHeadBranch(repo, "feature/login");
}

interface ParserCase {
  label: string;
  raw: string;
  /** When set, the case asserts this exact outcome instead of only the safety invariant. */
  expect?: "allow" | "block";
}

// ==================== VALID-shape generators ====================

function validCases(): ParserCase[] {
  const policy = baselinePolicy();
  const cases: ParserCase[] = [
    { label: "pretty-printed (the exact shape serializeShieldPolicy emits)", raw: BASELINE_JSON, expect: "allow" },
    { label: "compact, no whitespace at all", raw: JSON.stringify(policy), expect: "allow" },
    { label: "everything on one line with arrays inline", raw: JSON.stringify(policy).replace(/,/g, ", "), expect: "allow" },
    { label: "absurd indentation", raw: JSON.stringify(policy, null, 8), expect: "allow" },
    { label: "tabs and CRLF throughout", raw: JSON.stringify(policy, null, "\t").replace(/\n/g, "\r\n"), expect: "allow" },
    { label: "leading and trailing whitespace around the document", raw: `\n\n  \t${JSON.stringify(policy)}  \n\t\n`, expect: "allow" },
    {
      label: "reordered keys",
      raw: JSON.stringify(Object.fromEntries(Object.entries(policy).reverse())),
      expect: "allow",
    },
    {
      label: "empty arrays everywhere they are allowed",
      raw: JSON.stringify({ ...policy, trustedSshHostAliases: [], protectedBranches: [], expectedBranchPatterns: [] }),
      expect: "allow",
    },
    {
      label: "large arrays (500 protected branches, none of them the current one)",
      raw: JSON.stringify({ ...policy, protectedBranches: Array.from({ length: 500 }, (_, i) => `br-${i}`) }),
      expect: "allow",
    },
    {
      label: "escaped quotes and backslashes inside profileLabel",
      raw: JSON.stringify({ ...policy, profileLabel: 'Work "quoted" \\ backslash' }),
      expect: "allow",
    },
    {
      label: "forward-slash escapes (legal JSON, unusual)",
      raw: JSON.stringify(policy).replace(/github\.com/g, "github.com").replace(/"github/g, '"github'),
      expect: "allow",
    },
    {
      label: "unicode escapes inside the supported ASCII trust boundary",
      raw: JSON.stringify(policy).replace('"Work"', '"\\u0057ork"'),
      expect: "allow",
    },
    {
      label: "non-ASCII unicode escape in profileLabel (materialized as '?', never a control character)",
      raw: JSON.stringify(policy).replace('"Work"', '"W\\u00f6rk"'),
      expect: "allow",
    },
    {
      label: "nested approvedPushDestination written compactly on one line",
      raw: JSON.stringify(policy).replace(
        /"approvedPushDestination":\{[^}]*\}/,
        '"approvedPushDestination":{"host":"github.com","owner":"AcmeSoftware","repo":"acme-frontend"}',
      ),
      expect: "allow",
    },
    {
      label: "approvedPushDestination pretty-printed while the rest is compact",
      raw: JSON.stringify(policy).replace(
        /"approvedPushDestination":\{[^}]*\}/,
        '"approvedPushDestination": {\n  "host" : "github.com" ,\n  "owner" : "AcmeSoftware" ,\n  "repo" : "acme-frontend"\n }',
      ),
      expect: "allow",
    },
    {
      label: "optional fields omitted entirely (approvedRepositoryKey, expectedGitName, approvedPushDestination)",
      raw: JSON.stringify({
        ...policy,
        approvedRepositoryKey: undefined,
        expectedGitName: undefined,
        approvedPushDestination: undefined,
      }),
      // Valid, but push then fails closed on the missing destination —
      // this case is run for COMMIT, where it must allow.
      expect: "allow",
    },
  ];
  return cases;
}

// ==================== INVALID-shape generators ====================

function invalidCases(rng: ReturnType<typeof rngFrom>): ParserCase[] {
  const policy = baselinePolicy();
  const compact = JSON.stringify(policy);
  const cases: ParserCase[] = [];

  const add = (label: string, raw: string) => cases.push({ label, raw, expect: "block" });

  // --- duplicate keys, top-level and nested ---
  add("duplicate policyVersion", compact.replace('{"policyVersion":2', '{"policyVersion":2,"policyVersion":2'));
  add("duplicate policyVersion with DIFFERENT values", compact.replace('{"policyVersion":2', '{"policyVersion":999,"policyVersion":2'));
  add("duplicate expectedGitEmail with a different value", compact.replace('"expectedGitEmail"', '"expectedGitEmail":"attacker@example.com","expectedGitEmail"'));
  add("duplicate enabledActions", `${compact.slice(0, -1)},"enabledActions":[]}`);
  add(
    "duplicate owner INSIDE approvedPushDestination",
    compact.replace('"owner":"AcmeSoftware"', '"owner":"Attacker","owner":"AcmeSoftware"'),
  );

  // --- structural malformation ---
  add("trailing garbage after a complete document", `${compact}garbage`);
  add("trailing second JSON document", `${compact}${compact}`);
  add("trailing comma in an object", compact.replace(/\}$/, ',}'));
  add("trailing comma in an array", compact.replace('["commit","push"]', '["commit","push",]'));
  add("unterminated string", compact.replace('"Work"', '"Work'));
  add("unterminated object", compact.slice(0, -1));
  add("unterminated array", compact.replace('["commit","push"]', '["commit","push"'));
  add("bare value, not an object", '"just a string"');
  add("top-level array", `[${compact}]`);
  add("empty document", "");
  add("whitespace-only document", "   \n\t  ");
  add("JSON null", "null");
  add("not JSON at all", "policyVersion=1; enabledActions=commit,push");

  // --- string / escape malformation ---
  add("invalid escape sequence", compact.replace('"Work"', '"Wo\\qrk"'));
  add("truncated \\u escape", compact.replace('"Work"', '"Wo\\u12"'));
  add("non-hex \\u escape", compact.replace('"Work"', '"Wo\\uZZZZ"'));
  add("dangling backslash at end of string", compact.replace('"Work"', '"Work\\"'));
  add("raw newline inside a string", compact.replace('"Work"', '"Wo\nrk"'));
  add("raw tab inside a string", compact.replace('"Work"', '"Wo\trk"'));
  add("raw control character (0x01) inside a string", compact.replace('"Work"', '"Work"'));
  add("single-quoted string", compact.replace('"Work"', "'Work'"));
  add("unquoted key", compact.replace('"profileLabel"', "profileLabel"));

  // --- literal / number malformation ---
  add("capitalized True for strictPushSetup", compact.replace('"strictPushSetup":false', '"strictPushSetup":True'));
  add("bare word for strictPushSetup", compact.replace('"strictPushSetup":false', '"strictPushSetup":yes'));
  add("NULL literal in wrong case", compact.replace('"expectedGitName":"Danish Irfan"', '"expectedGitName":NULL'));
  add("leading-zero number", compact.replace('"policyVersion":2', '"policyVersion":02'));
  add("hex number", compact.replace('"policyVersion":2', '"policyVersion":0x2'));
  add("trailing-dot number", compact.replace('"generatedAt":1700000000000', '"generatedAt":1700000000000.'));
  add("plus-signed number", compact.replace('"policyVersion":2', '"policyVersion":+2'));
  add("Infinity", compact.replace('"generatedAt":1700000000000', '"generatedAt":Infinity'));
  add("NaN", compact.replace('"generatedAt":1700000000000', '"generatedAt":NaN'));

  // --- schema-invalid but JSON-valid ---
  add("wrong policyVersion", compact.replace('"policyVersion":2', '"policyVersion":1'));
  add("policyVersion as a string", compact.replace('"policyVersion":2', '"policyVersion":"2"'));
  add("strictPushSetup as a string", compact.replace('"strictPushSetup":false', '"strictPushSetup":"false"'));
  add("strictPushSetup as a number", compact.replace('"strictPushSetup":false', '"strictPushSetup":0'));
  add("strictPushSetup as null", compact.replace('"strictPushSetup":false', '"strictPushSetup":null'));
  add("enabledActions as a string", compact.replace('["commit","push"]', '"commit,push"'));
  add("enabledActions containing a non-action", compact.replace('["commit","push"]', '["commit","push","rebase"]'));
  add("enabledActions containing a number", compact.replace('["commit","push"]', '["commit",1]'));
  add("protectedBranches as an object", compact.replace('["main"]', '{"0":"main"}'));
  add("trustedSshHostAliases containing an object", compact.replace('["github-work"]', '[{"host":"github-work"}]'));
  add("approvedPushDestination as an array", compact.replace(/"approvedPushDestination":\{[^}]*\}/, '"approvedPushDestination":[]'));
  add("approvedPushDestination as a string", compact.replace(/"approvedPushDestination":\{[^}]*\}/, '"approvedPushDestination":"github.com/acme/x"'));
  add("approvedPushDestination.owner as a number", compact.replace('"owner":"AcmeSoftware"', '"owner":42'));
  add("expectedGitEmail as a number", compact.replace('"expectedGitEmail":"work@example.com"', '"expectedGitEmail":1'));
  add("expectedGitEmail empty", compact.replace('"expectedGitEmail":"work@example.com"', '"expectedGitEmail":""'));
  add("profileLabel empty", compact.replace('"profileLabel":"Work"', '"profileLabel":""'));

  // --- missing required fields ---
  for (const field of [
    "policyVersion",
    "generatedAt",
    "matchedProfileId",
    "profileLabel",
    "expectedGitEmail",
    "trustedSshHostAliases",
    "strictPushSetup",
    "protectedBranches",
    "expectedBranchPatterns",
    "enabledActions",
  ]) {
    const without = { ...(policy as unknown as Record<string, unknown>) };
    delete without[field];
    add(`missing required field: ${field}`, JSON.stringify(without));
  }

  // --- secret-shaped fields ---
  for (const secret of ["token", "accessToken", "password", "privateKey", "sshKey", "credentials", "secret"]) {
    add(`secret-shaped field present: ${secret}`, JSON.stringify({ ...policy, [secret]: "xyz" }));
  }
  add("secret-shaped field present but null", JSON.stringify({ ...policy, token: null }));

  // --- misleading nesting ---
  // NOTE: extra keys nested inside `approvedPushDestination` are legal
  // under BOTH validators (neither rejects unknown keys), so this is not an
  // "invalid" case — it is checked separately, in its own test below, for
  // the property that actually matters: a nested key must never be read as
  // if it were the top-level one. It stays in the corpus without an
  // `expect`, so only the safety invariant applies to it.
  cases.push({
    label: "nested object whose keys shadow top-level field names",
    raw: JSON.stringify({
      ...policy,
      approvedPushDestination: {
        host: "github.com",
        owner: "AcmeSoftware",
        repo: "acme-frontend",
        enabledActions: ["commit", "push"],
        strictPushSetup: true,
        expectedGitEmail: "attacker@example.com",
      },
    }),
  });
  add(
    "deeply nested junk plus a secret-shaped top-level field",
    JSON.stringify({ ...policy, junk: { a: { b: { c: { d: { e: [1, 2, { f: "g" }] } } } } }, token: "x" }),
  );
  cases.push({
    label: "deeply nested junk under an unexpected key (legal JSON, unknown key)",
    raw: JSON.stringify({ ...policy, junk: { a: { b: { c: { d: { e: [1, 2, { f: "g" }] } } } } } }),
  });

  // --- truncation sweep ---
  // Every byte position is checked for the pretty-printed form by default
  // (the shape an interrupted write actually produces) -- exhaustive
  // unless `SHIELD_FUZZ_CASES` asks for a smaller run, in which case
  // `fuzzStride` spreads a proportionally reduced sample across the same
  // byte range rather than silently making this sweep the one part of the
  // suite the env override doesn't reach. A representative stride is used
  // for the compact form unconditionally, so this stays affordable.
  const prettyStride = fuzzStride(BASELINE_JSON.length, 400);
  for (let i = 1; i < BASELINE_JSON.length; i += prettyStride) {
    cases.push({ label: `truncated at byte ${i} (pretty)`, raw: BASELINE_JSON.slice(0, i), expect: "block" });
  }
  for (let i = 1; i < compact.length; i += 7) {
    cases.push({ label: `truncated at byte ${i} (compact)`, raw: compact.slice(0, i), expect: "block" });
  }

  // --- random byte-level corruption of a valid policy ---
  const CORRUPTIONS = fuzzCaseCount(300);
  for (let i = 0; i < CORRUPTIONS; i++) {
    const source = rng.bool() ? BASELINE_JSON : compact;
    const at = rng.int(source.length);
    const mutated =
      rng.bool(0.34)
        ? source.slice(0, at) + source.slice(at + 1) // deletion
        : rng.bool(0.5)
          ? source.slice(0, at) + rng.pick(['"', "{", "}", "[", "]", ",", ":", "\\", " ", "\n", "x"]) + source.slice(at)
          : source.slice(0, at) + rng.pick(['"', "{", "}", "[", "]", ",", ":", "\\", "0", "z"]) + source.slice(at + 1);
    cases.push({ label: `random corruption #${i} at byte ${at}`, raw: mutated });
  }

  return cases;
}

// ==================== the differential run ====================

test("PART 8 — the shell policy parser never allows an action from a policy the TypeScript validator rejects", { timeout: 900_000 }, async () => {
  const rng = rngFrom(SEED);
  const cases = [...validCases(), ...invalidCases(rng)];

  const repos = await createRepoPool(fuzzPoolSize());
  try {
    for (const repo of repos) await prepareRepoState(repo);

    const failures = await mapWithRepos(repos, cases, async (repo, testCase) => {
      await writeRawPolicy(repo, testCase.raw);
      // COMMIT is the action used throughout: it needs no remote URL and
      // no network, so any allow/block observed is attributable to parsing.
      const shell = await runEvaluator(repo, ["commit"]);
      const reference = parseShieldPolicy(testCase.raw);

      // ---- THE safety invariant ----
      if (!reference.ok && shell.allowed) {
        return {
          label: testCase.label,
          why: "TypeScript rejected this policy but the shell evaluator ALLOWED the commit",
          referenceErrors: reference.errors,
          raw: testCase.raw.slice(0, 400),
        };
      }
      // ---- and its counterpart, so "reject everything" cannot pass ----
      if (testCase.expect === "allow" && !shell.allowed) {
        return {
          label: testCase.label,
          why: "a valid, allow-producing policy was blocked by the shell evaluator",
          stderr: shell.stderr.slice(0, 400),
          raw: testCase.raw.slice(0, 400),
        };
      }
      if (testCase.expect === "allow" && !reference.ok) {
        return { label: testCase.label, why: "case marked valid was rejected by the TypeScript validator", referenceErrors: reference.errors };
      }
      if (testCase.expect === "block" && shell.allowed) {
        return { label: testCase.label, why: "case marked invalid was ALLOWED by the shell evaluator", raw: testCase.raw.slice(0, 400) };
      }
      // Every block must be attributable: a corrupt policy has to say so
      // with a stable reason id, never crash with a bare shell error.
      if (!shell.allowed && shell.reasonIds.length === 0) {
        return { label: testCase.label, why: "blocked with no structured reason id (evaluator crashed rather than deciding)", stderr: shell.stderr.slice(0, 400) };
      }
      return undefined;
    });

    const bad = failures.filter(Boolean);
    assert.equal(
      bad.length,
      0,
      `${bad.length}/${cases.length} policy-parser cases failed (seed ${SEED}).\n${JSON.stringify(bad.slice(0, 5), null, 2)}`,
    );
    // Sanity: the corpus is actually large and actually contains both
    // kinds -- but only at full, unscaled depth. `SHIELD_FUZZ_CASES`
    // (see fuzzStride) deliberately shrinks this corpus on slower CI
    // legs; a fixed absolute floor would fight that on purpose, not
    // guard against an accidental regression.
    const minCorpus = process.env.SHIELD_FUZZ_CASES ? 20 : 500;
    assert.ok(cases.length > minCorpus, `corpus too small: ${cases.length}`);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 8 — every rejected policy is reported as policy-corrupt specifically, not as some other blocking reason", async () => {
  const compact = JSON.stringify(baselinePolicy());
  const cases: string[] = [
    `${compact}trailing`,
    compact.slice(0, 40),
    compact.replace('"strictPushSetup":false', '"strictPushSetup":"no"'),
    compact.replace('"policyVersion":2', '"policyVersion":2,"policyVersion":2'),
    JSON.stringify({ ...baselinePolicy(), token: "x" }),
    "not json",
  ];
  const repos = await createRepoPool(Math.min(4, fuzzPoolSize()));
  try {
    for (const repo of repos) await prepareRepoState(repo);
    const results = await mapWithRepos(repos, cases, async (repo, raw) => {
      await writeRawPolicy(repo, raw);
      return { raw, result: await runEvaluator(repo, ["commit"]) };
    });
    for (const { raw, result } of results) {
      assert.equal(result.allowed, false, raw.slice(0, 80));
      assert.deepEqual(result.reasonIds, ["policy-corrupt"], `${raw.slice(0, 80)} -> ${result.stderr.slice(0, 200)}`);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 8 — a nested key that shadows a top-level field name is never read as the top-level one", async () => {
  const repos = await createRepoPool(1);
  const repo = repos[0];
  try {
    await prepareRepoState(repo);
    // Top level says NOT strict and expects work@example.com; the nested
    // object says strict and expects someone else. Path lookups are exact,
    // so the nested values must have no effect whatsoever.
    await writeRawPolicy(
      repo,
      JSON.stringify({
        ...baselinePolicy(),
        approvedPushDestination: {
          host: "github.com",
          // canonicalHost: literal HTTPS host below needs no "ssh -G"
          // resolution (this file has no fake-ssh transport set up — its
          // whole point is nested-key isolation, not SSH canonicalization,
          // which has its own dedicated coverage elsewhere).
          canonicalHost: "github.com",
          owner: "AcmeSoftware",
          repo: "acme-frontend",
          strictPushSetup: true,
          expectedGitEmail: "attacker@example.com",
          expectedGitHubLogin: "attacker",
          trustedSshHostAliases: [],
          protectedBranches: ["feature/login"],
          enabledActions: [],
        },
      }),
    );
    // The identity actually configured is work@example.com and the branch is
    // feature/login. If ANY nested value leaked into a top-level read the
    // commit would be blocked (wrong expected email, or a protected branch),
    // or enforcement would be skipped entirely (empty enabledActions).
    const commit = await runEvaluator(repo, ["commit"]);
    assert.equal(commit.allowed, true, commit.stderr);

    // And on the push side, the nested `strictPushSetup: true` must not turn
    // a non-strict policy strict: an unverifiable HTTPS route is allowed
    // here precisely because the TOP-LEVEL policy is not strict.
    const push = await runEvaluator(repo, ["push", "origin", "https://github.com/AcmeSoftware/acme-frontend.git"]);
    assert.equal(push.allowed, true, push.stderr);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 8 — an enabledActions array naming an action this build cannot enforce is corruption, not a subset", async () => {
  const repos = await createRepoPool(1);
  const repo = repos[0];
  try {
    await prepareRepoState(repo);
    for (const actions of [["commit", "push", "rebase"], ["fetch"], ["Commit"], ["commit", ""], ["push", "push "]]) {
      await writeRawPolicy(repo, JSON.stringify({ ...baselinePolicy(), enabledActions: actions }));
      const result = await runEvaluator(repo, ["commit"]);
      assert.equal(result.allowed, false, `enabledActions ${JSON.stringify(actions)} was allowed`);
      assert.deepEqual(result.reasonIds, ["policy-corrupt"]);
      // The TypeScript validator agrees, which is the whole point.
      assert.equal(parseShieldPolicy(JSON.stringify({ ...baselinePolicy(), enabledActions: actions })).ok, false);
    }
    // An empty list stays legal in both: it simply governs nothing.
    await writeRawPolicy(repo, JSON.stringify({ ...baselinePolicy(), enabledActions: [] }));
    assert.equal((await runEvaluator(repo, ["commit"])).allowed, true);
    assert.equal(parseShieldPolicy(JSON.stringify({ ...baselinePolicy(), enabledActions: [] })).ok, true);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 8 — every raw control character inside a policy string is rejected, not just newline/tab/CR", async () => {
  const repos = await createRepoPool(1);
  const repo = repos[0];
  try {
    await prepareRepoState(repo);
    const compact = JSON.stringify(baselinePolicy());
    for (let code = 0; code < 0x20; code++) {
      const raw = compact.replace('"Work"', `"Wo${String.fromCharCode(code)}rk"`);
      await writeRawPolicy(repo, raw);
      const result = await runEvaluator(repo, ["commit"]);
      assert.equal(result.allowed, false, `raw control character U+${code.toString(16).padStart(4, "0")} was accepted`);
      assert.deepEqual(result.reasonIds, ["policy-corrupt"]);
      // JSON.parse rejects each of these too — that agreement is the invariant.
      assert.equal(parseShieldPolicy(raw).ok, false);
    }
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 8 — the parser needs no jq, node, python, perl or ruby: the shipped evaluator never invokes one", async () => {
  const source = await (await import("node:fs")).promises.readFile(
    (await import("node:path")).join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh"),
    "utf8",
  );
  // Strip comments before scanning, so prose mentioning "no jq, no Node"
  // does not read as a dependency.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  for (const forbidden of ["jq", "node", "python", "python3", "perl", "ruby"]) {
    assert.doesNotMatch(
      code,
      new RegExp(`(^|[;|&(\\s])${forbidden}[\\s]`, "m"),
      `the evaluator appears to invoke "${forbidden}" — hook-time enforcement must depend only on git + POSIX sh utilities`,
    );
  }
});
