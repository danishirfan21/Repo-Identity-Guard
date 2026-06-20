import assert from "node:assert/strict";
import test from "node:test";
import { evaluateIdentity, matchRule, normalizeRemoteUrl } from "../rules";
import { CurrentIdentity, IdentityRule } from "../types";

const workRule: IdentityRule = {
  match: "github.com/AcmeSoftware/*",
  label: "Work",
  name: "Danish Irfan",
  email: "work@example.com",
};

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

test("evaluates safe identity with case-insensitive email comparison", () => {
  const current: CurrentIdentity = {
    repoRoot: "C:/repo",
    remoteUrl: "https://github.com/AcmeSoftware/project.git",
    name: "Danish Irfan",
    email: "WORK@EXAMPLE.COM",
  };

  assert.equal(evaluateIdentity(current, [workRule]).state, "safe");
});

test("evaluates missing or mismatched local values as wrong", () => {
  const current: CurrentIdentity = {
    repoRoot: "C:/repo",
    remoteUrl: "https://github.com/AcmeSoftware/project.git",
    name: "Danish Irfan",
    email: null,
  };

  assert.equal(evaluateIdentity(current, [workRule]).state, "wrong");
});

test("evaluates unmatched remotes as unknown", () => {
  const current: CurrentIdentity = {
    repoRoot: "C:/repo",
    remoteUrl: "https://gitlab.com/example/project.git",
    name: null,
    email: null,
  };

  assert.equal(evaluateIdentity(current, [workRule]).state, "unknown");
});
