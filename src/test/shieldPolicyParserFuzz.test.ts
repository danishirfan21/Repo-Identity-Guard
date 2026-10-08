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
import { WORK_IDENTITY, testPolicy } from "./testUtil/lockFixtures";

/**
 * PART 8 — adversarial fuzzing of the standalone evaluator's policy parser.
 *
 * The evaluator parses its policy with a recursive-descent JSON parser
 * written in POSIX awk (no jq, no Node, no Python — see the long comment in
 * `shield-evaluate.sh`). That parser is the one piece of the identity lock
 * that faces arbitrary bytes off disk, and its two historical failure
 * modes were both FAIL-OPEN: a compactly-formatted policy and a truncated
 * policy each made the actions array come back empty, which the script
 * read as "this policy does not govern this action" and exited 0.
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
  return testPolicy(WORK_IDENTITY);
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
      label: "empty trustedSshHostAliases (allowed)",
      raw: JSON.stringify({ ...policy, trustedSshHostAliases: [] }),
      expect: "allow",
    },
    {
      label: "large arrays (500 trusted aliases)",
      raw: JSON.stringify({ ...policy, trustedSshHostAliases: Array.from({ length: 500 }, (_, i) => `alias-${i}`) }),
      expect: "allow",
    },
    {
      label: "escaped quotes and backslashes inside identityLabel",
      raw: JSON.stringify({ ...policy, identityLabel: 'Work "quoted" \\ backslash' }),
      expect: "allow",
    },
    {
      label: "forward-slash escapes (legal JSON, unusual)",
      raw: JSON.stringify(policy).replace(/"github-work"/g, '"github\\/work"'),
      expect: "allow",
    },
    {
      label: "unicode escapes inside the supported ASCII trust boundary",
      raw: JSON.stringify(policy).replace('"Work"', '"\\u0057ork"'),
      expect: "allow",
    },
    {
      label: "non-ASCII unicode escape in identityLabel (materialized as '?', never a control character)",
      raw: JSON.stringify(policy).replace('"Work"', '"W\\u00f6rk"'),
      expect: "allow",
    },
    {
      label: "optional field omitted entirely (expectedGitName)",
      raw: JSON.stringify({ ...policy, expectedGitName: undefined }),
      expect: "allow",
    },
    {
      label: "an unknown extra object (legal JSON, ignored by both validators)",
      raw: JSON.stringify({ ...policy, extra: { a: [1, { b: "c" }] } }),
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

  // --- duplicate keys ---
  add("duplicate policyVersion", compact.replace('{"policyVersion":4', '{"policyVersion":4,"policyVersion":4'));
  add("duplicate policyVersion with DIFFERENT values", compact.replace('{"policyVersion":4', '{"policyVersion":999,"policyVersion":4'));
  add("duplicate expectedGitEmail with a different value", compact.replace('"expectedGitEmail"', '"expectedGitEmail":"attacker@example.com","expectedGitEmail"'));
  add("duplicate trustedSshHostAliases", `${compact.slice(0, -1)},"trustedSshHostAliases":["github-work"]}`);
  add("duplicate key inside a nested unknown object", compact.replace(/\}$/, ',"extra":{"k":1,"k":2}}'));

  // --- structural malformation ---
  add("trailing garbage after a complete document", `${compact}garbage`);
  add("trailing second JSON document", `${compact}${compact}`);
  add("trailing comma in an object", compact.replace(/\}$/, ",}"));
  add("trailing comma in an array", compact.replace('["github-work"]', '["github-work",]'));
  add("unterminated string", compact.replace('"Work"', '"Work'));
  add("unterminated object", compact.slice(0, -1));
  add("unterminated array", compact.replace('["github-work"]', '["github-work"'));
  add("bare value, not an object", '"just a string"');
  add("top-level array", `[${compact}]`);
  add("empty document", "");
  add("whitespace-only document", "   \n\t  ");
  add("JSON null", "null");
  add("not JSON at all", "policyVersion=3; enforcedActions=commit");

  // --- string / escape malformation ---
  add("invalid escape sequence", compact.replace('"Work"', '"Wo\\qrk"'));
  add("truncated \\u escape", compact.replace('"Work"', '"Wo\\u12"'));
  add("non-hex \\u escape", compact.replace('"Work"', '"Wo\\uZZZZ"'));
  add("dangling backslash at end of string", compact.replace('"Work"', '"Work\\"'));
  add("raw newline inside a string", compact.replace('"Work"', '"Wo\nrk"'));
  add("raw tab inside a string", compact.replace('"Work"', '"Wo\trk"'));
  add("raw control character (0x01) inside a string", compact.replace('"Work"', '"Wo\u0001rk"'));
  add("single-quoted string", compact.replace('"Work"', "'Work'"));
  add("unquoted key", compact.replace('"identityLabel"', "identityLabel"));

  // --- literal / number malformation ---
  add("capitalized True literal", compact.replace('"expectedGitName":"Danish Irfan"', '"expectedGitName":True'));
  add("bare word literal", compact.replace('"expectedGitName":"Danish Irfan"', '"expectedGitName":yes'));
  add("NULL literal in wrong case", compact.replace('"expectedGitName":"Danish Irfan"', '"expectedGitName":NULL'));
  add("leading-zero number", compact.replace('"policyVersion":4', '"policyVersion":04'));
  add("hex number", compact.replace('"policyVersion":4', '"policyVersion":0x4'));
  add("trailing-dot number", compact.replace('"generatedAt":1700000000000', '"generatedAt":1700000000000.'));
  add("plus-signed number", compact.replace('"policyVersion":4', '"policyVersion":+4'));
  add("Infinity", compact.replace('"generatedAt":1700000000000', '"generatedAt":Infinity'));
  add("NaN", compact.replace('"generatedAt":1700000000000', '"generatedAt":NaN'));

  // --- schema-invalid but JSON-valid ---
  add("legacy policyVersion 2", compact.replace('"policyVersion":4', '"policyVersion":2'));
  add("previous identity-lock policyVersion 3", compact.replace('"policyVersion":4', '"policyVersion":3'));
  add(
    "a complete, well-formed v3 commit-only policy (awaiting upgrade, never enforced as-is)",
    `${compact.replace('"policyVersion":4', '"policyVersion":3').slice(0, -1)},"enforcedActions":["commit"]}`,
  );
  add("future policyVersion", compact.replace('"policyVersion":4', '"policyVersion":5'));
  add("policyVersion as a string", compact.replace('"policyVersion":4', '"policyVersion":"4"'));
  // v4 has no per-action list: one in ANY shape is corruption (so nobody
  // can believe editing it takes push out of an assigned repository's lock).
  for (const actions of ['["commit"]', '["commit","push"]', "[]", '"commit"', '["push"]', "null", '["commit","rebase"]']) {
    add(`enforcedActions present: ${actions}`, `${compact.slice(0, -1)},"enforcedActions":${actions}}`);
  }
  add("expectedGitHubLogin as a number", compact.replace('"identityLabel":"Work"', '"identityLabel":"Work","expectedGitHubLogin":7'));
  add("trustedSshHostAliases as an object", compact.replace('["github-work"]', '{"0":"github-work"}'));
  add("trustedSshHostAliases containing an object", compact.replace('["github-work"]', '[{"host":"github-work"}]'));
  add("expectedGitEmail as a number", compact.replace('"expectedGitEmail":"work@example.com"', '"expectedGitEmail":1'));
  add("expectedGitEmail empty", compact.replace('"expectedGitEmail":"work@example.com"', '"expectedGitEmail":""'));
  add("identityLabel empty", compact.replace('"identityLabel":"Work"', '"identityLabel":""'));
  add("lockId empty", compact.replace('"lockId":"test-lock"', '"lockId":""'));
  add("assignedAt as a string", compact.replace('"assignedAt":1700000000000', '"assignedAt":"1700000000000"'));
  add("expectedGitName as null", compact.replace('"expectedGitName":"Danish Irfan"', '"expectedGitName":null'));

  // --- missing required fields ---
  for (const field of [
    "policyVersion",
    "lockId",
    "assignedAt",
    "generatedAt",
    "identityId",
    "identityLabel",
    "expectedGitEmail",
    "trustedSshHostAliases",
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
  // Extra keys under an unknown object are legal under BOTH validators, so
  // this stays in the corpus without an `expect` (only the safety
  // invariant applies). The property that matters — a nested key is never
  // read as the top-level one — has its own test below.
  cases.push({
    label: "nested object whose keys shadow top-level field names",
    raw: JSON.stringify({ ...policy, extra: { enforcedActions: [], expectedGitEmail: "attacker@example.com", policyVersion: 3 } }),
  });
  add(
    "deeply nested junk plus a secret-shaped top-level field",
    JSON.stringify({ ...policy, junk: { a: { b: { c: { d: { e: [1, 2, { f: "g" }] } } } } }, token: "x" }),
  );

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
    `${compact.slice(0, -1)},"enforcedActions":["commit"]}`,
    compact.replace('"policyVersion":4', '"policyVersion":3'),
    compact.replace('"policyVersion":4', '"policyVersion":4,"policyVersion":4'),
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
    // Top level: a lock expecting work@example.com with NO GitHub login
    // (so every push is blocked). The nested object claims a different
    // email, a GitHub login, and no actions at all. Path lookups are exact,
    // so none of it may have any effect.
    await writeRawPolicy(
      repo,
      JSON.stringify({
        ...baselinePolicy(),
        extra: {
          expectedGitEmail: "attacker@example.com",
          expectedGitHubLogin: "attacker",
          trustedSshHostAliases: [],
          enforcedActions: [],
        },
      }),
    );
    const commit = await runEvaluator(repo, ["commit"]);
    assert.equal(commit.allowed, true, commit.stderr);
    // And the nested login must not be read as the top-level one: the push
    // is still blocked for having NO configured login (not checked against
    // "attacker" over some route).
    const push = await runEvaluator(repo, ["push", "origin", "https://github.com/AcmeSoftware/acme-frontend.git"]);
    assert.equal(push.allowed, false, push.stderr);
    assert.deepEqual(push.reasonIds, ["push-identity-not-configured"]);
    // While a wrong identity is still blocked by the TOP-LEVEL expectation.
    await setConfiguredIdentity(repo, "Danish Irfan", "attacker@example.com");
    const wrong = await runEvaluator(repo, ["commit"]);
    assert.deepEqual(wrong.reasonIds, ["commit-identity-mismatch"]);
  } finally {
    await destroyRepoPool(repos);
  }
});

test("PART 8 — an enforcedActions field (v3's per-action list) in a v4 policy is corruption in EVERY shape — never a way to take push out of the lock", async () => {
  const repos = await createRepoPool(1);
  const repo = repos[0];
  try {
    await prepareRepoState(repo);
    for (const actions of [["commit"], ["commit", "push"], ["commit", "push", "rebase"], ["fetch"], ["Commit"], ["commit", ""], ["push", "push "], [], ["push"]]) {
      const raw = JSON.stringify({ ...baselinePolicy(), enforcedActions: actions });
      await writeRawPolicy(repo, raw);
      const result = await runEvaluator(repo, ["commit"]);
      assert.equal(result.allowed, false, `enforcedActions ${JSON.stringify(actions)} was allowed`);
      assert.deepEqual(result.reasonIds, ["policy-corrupt"]);
      // The TypeScript validator agrees, which is the whole point.
      assert.equal(parseShieldPolicy(raw).ok, false, JSON.stringify(actions));
    }
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
