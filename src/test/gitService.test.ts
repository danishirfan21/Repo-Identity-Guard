import assert from "node:assert/strict";
import test from "node:test";
import {
  isLinkedWorktree,
  parseGitIdent,
  parseRemoteUrl,
  parseStatusPorcelain,
} from "../services/gitService";

test("parses HTTPS remote URLs", () => {
  const parsed = parseRemoteUrl("https://github.com/AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "https");
  assert.equal(parsed.host, "github.com");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("parses scp-like SSH remote URLs", () => {
  const parsed = parseRemoteUrl("git@github.com:AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.host, "github.com");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("parses SSH host-alias remote URLs", () => {
  const parsed = parseRemoteUrl("git@github-work:AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.host, "github-work");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("parses ssh:// URLs", () => {
  const parsed = parseRemoteUrl("ssh://git@github.com/AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.host, "github.com");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("returns unknown protocol for unparsable remotes", () => {
  const parsed = parseRemoteUrl("not a url at all");
  assert.equal(parsed.protocol, "unknown");
});

test("parseGitIdent parses `git var GIT_AUTHOR_IDENT` output", () => {
  const ident = parseGitIdent("Danish Irfan <work@example.com> 1785864080 +0000");
  assert.equal(ident.name, "Danish Irfan");
  assert.equal(ident.email, "work@example.com");
});

test("parseGitIdent handles names containing angle-bracket-adjacent characters", () => {
  const ident = parseGitIdent("Danish Irfan (Work) <work@example.com> 1785864080 -0700");
  assert.equal(ident.name, "Danish Irfan (Work)");
  assert.equal(ident.email, "work@example.com");
});

test("parseGitIdent returns empty on unrecognized input rather than throwing", () => {
  assert.deepEqual(parseGitIdent("garbage"), {});
});

test("parseStatusPorcelain detects ordinary changes without conflicts", () => {
  const status = "# branch.oid abc123\n# branch.head main\n1 .M N... 100644 100644 100644 abc abc file.ts\n";
  const facts = parseStatusPorcelain(status);
  assert.equal(facts.hasChanges, true);
  assert.equal(facts.hasConflicts, false);
});

test("parseStatusPorcelain detects unmerged conflict entries", () => {
  const status = "# branch.oid abc123\nu UU N... 100644 100644 100644 100644 aaa bbb ccc file.ts\n";
  const facts = parseStatusPorcelain(status);
  assert.equal(facts.hasChanges, true);
  assert.equal(facts.hasConflicts, true);
});

test("parseStatusPorcelain reports a clean tree as no changes", () => {
  const status = "# branch.oid abc123\n# branch.head main\n";
  const facts = parseStatusPorcelain(status);
  assert.equal(facts.hasChanges, false);
  assert.equal(facts.hasConflicts, false);
});

test("isLinkedWorktree compares git-dir against git-common-dir", () => {
  assert.equal(isLinkedWorktree("/repo/.git", "/repo/.git"), false);
  assert.equal(isLinkedWorktree("/repo/.git/worktrees/feature", "/repo/.git"), true);
  assert.equal(isLinkedWorktree(null, "/repo/.git"), false);
  assert.equal(isLinkedWorktree("/repo/.git", null), false);
});
