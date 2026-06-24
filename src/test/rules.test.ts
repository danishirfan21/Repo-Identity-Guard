import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExactRuleMatch,
  evaluateIdentity,
  matchRule,
  normalizeRemoteUrl,
} from "../rules";
import { CurrentIdentity, IdentityRule } from "../types";

const workRule: IdentityRule = {
  match: "github.com/AcmeSoftware/*",
  label: "Work",
  name: "Danish Irfan",
  email: "work@example.com",
};

function currentIdentity(
  overrides: Partial<CurrentIdentity> = {},
): CurrentIdentity {
  return {
    repoRoot: "C:/repo",
    remoteUrl: "https://github.com/AcmeSoftware/project.git",
    effectiveName: "Danish Irfan",
    effectiveEmail: "work@example.com",
    localName: "Danish Irfan",
    localEmail: "work@example.com",
    globalName: null,
    globalEmail: null,
    ...overrides,
  };
}

test("normalizes common HTTPS and SSH remote formats", () => {
  assert.equal(
    normalizeRemoteUrl(
      "https://github.com/AcmeSoftware/example-project.git",
    ),
    "github.com/AcmeSoftware/example-project",
  );
  assert.equal(
    normalizeRemoteUrl(
      "git@github.com:AcmeSoftware/example-project.git",
    ),
    "github.com/AcmeSoftware/example-project",
  );
  assert.equal(
    normalizeRemoteUrl(
      "git@github-work:AcmeSoftware/example-project.git",
    ),
    "github-work/AcmeSoftware/example-project",
  );
});

test("matches wildcard rules against normalized remotes", () => {
  assert.equal(
    matchRule(
      "git@github.com:AcmeSoftware/example-project.git",
      [workRule],
    ),
    workRule,
  );
  assert.equal(
    matchRule("https://github.com/Danish-Irfan/project.git", [workRule]),
    undefined,
  );
});

test("builds exact rule match from current remote", () => {
  assert.equal(
    buildExactRuleMatch("git@github.com:AcmeSoftware/example-project.git"),
    "github.com/AcmeSoftware/example-project",
  );
});

test("evaluates safe identity with case-insensitive email comparison", () => {
  const current = currentIdentity({ effectiveEmail: "WORK@EXAMPLE.COM" });

  assert.equal(evaluateIdentity(current, [workRule]).state, "safe");
});

test("evaluates effective identity instead of local identity", () => {
  const current = currentIdentity({
    effectiveName: "Danish Irfan",
    effectiveEmail: "work@example.com",
    localName: null,
    localEmail: null,
    globalName: "Danish Irfan",
    globalEmail: "work@example.com",
  });

  assert.equal(evaluateIdentity(current, [workRule]).state, "safe");
});

test("evaluates strict local mode as localNeeded when effective identity is safe but local identity is missing", () => {
  const current = currentIdentity({
    effectiveName: "Danish Irfan",
    effectiveEmail: "work@example.com",
    localName: null,
    localEmail: null,
    globalName: "Danish Irfan",
    globalEmail: "work@example.com",
  });

  const evaluation = evaluateIdentity(current, [workRule], {
    requireLocalIdentity: true,
  });

  assert.equal(evaluation.state, "localNeeded");
  assert.equal(evaluation.requireLocalIdentity, true);
});

test("evaluates strict local mode as localNeeded when local identity differs", () => {
  const current = currentIdentity({
    effectiveName: "Danish Irfan",
    effectiveEmail: "work@example.com",
    localName: "Wrong User",
    localEmail: "wrong@example.com",
  });

  assert.equal(
    evaluateIdentity(current, [workRule], { requireLocalIdentity: true }).state,
    "localNeeded",
  );
});

test("evaluates strict local mode as safe when effective and local identities match", () => {
  assert.equal(
    evaluateIdentity(currentIdentity(), [workRule], {
      requireLocalIdentity: true,
    }).state,
    "safe",
  );
});

test("evaluates missing or mismatched effective values as wrong", () => {
  const current = currentIdentity({ effectiveEmail: null });

  assert.equal(evaluateIdentity(current, [workRule]).state, "wrong");
});

test("evaluates unmatched remotes as unknown", () => {
  const current = currentIdentity({
    remoteUrl: "https://gitlab.com/example/project.git",
    effectiveName: null,
    effectiveEmail: null,
    localName: null,
    localEmail: null,
  });

  assert.equal(evaluateIdentity(current, [workRule]).state, "unknown");
});
