import assert from "node:assert/strict";
import test from "node:test";
import { computeWorkspaceSafetyState, formatWorkspaceProblems, workspaceProblemCount } from "../core/workspaceAggregate";
import { RepositorySafetyState, StatusSummary } from "../types";

function repoState(id: string, level: StatusSummary["level"]): RepositorySafetyState {
  return {
    repoId: id,
    workspaceFolderName: id,
    summary: {
      level,
      capabilityResults: [],
      infoNotes: [],
      issueCount: 0,
      facts: { isGitRepo: level !== "not_checked" },
    },
  };
}

test("no repositories detected -> workspace is not_checked, not not_safe", () => {
  const result = computeWorkspaceSafetyState([]);
  assert.equal(result.level, "not_checked");
  assert.equal(result.safeCount, 0);
  assert.equal(result.notSafeCount, 0);
  assert.equal(result.uncheckedCount, 0);
});

test("every repo safe -> workspace is safe", () => {
  const result = computeWorkspaceSafetyState([repoState("a", "safe"), repoState("b", "safe")]);
  assert.equal(result.level, "safe");
  assert.equal(result.safeCount, 2);
});

test("one repo not_safe among safe repos -> workspace is not_safe (not a plain OR that would ignore it)", () => {
  const result = computeWorkspaceSafetyState([repoState("a", "safe"), repoState("b", "not_safe")]);
  assert.equal(result.level, "not_safe");
  assert.equal(result.notSafeCount, 1);
});

test("a safe active repo must not make the workspace green while another repo is unresolved/not_checked", () => {
  const result = computeWorkspaceSafetyState([repoState("a", "safe"), repoState("b", "not_checked")]);
  assert.equal(result.level, "not_safe");
  assert.equal(result.uncheckedCount, 1);
});

test("single safe repo -> workspace is safe (single-repo workspace behaves like before)", () => {
  const result = computeWorkspaceSafetyState([repoState("a", "safe")]);
  assert.equal(result.level, "safe");
});

test("workspaceProblemCount includes unresolved (not_checked) repos, not just not_safe ones", () => {
  const result = computeWorkspaceSafetyState([repoState("a", "not_safe"), repoState("b", "not_checked")]);
  // Regression check for the bug where a status bar built only from
  // notSafeCount could show "Not Safe (0/2 repos)" when the only problem
  // was an unresolved (not_checked) repo.
  assert.equal(workspaceProblemCount(result), 2);
});

test("formatWorkspaceProblems reports unsafe and unresolved counts separately", () => {
  const result = computeWorkspaceSafetyState([
    repoState("a", "not_safe"),
    repoState("b", "not_checked"),
    repoState("c", "safe"),
  ]);
  assert.equal(formatWorkspaceProblems(result), "1 unsafe · 1 unresolved");
});

test("formatWorkspaceProblems reports only unsafe when there are no unresolved repos", () => {
  const result = computeWorkspaceSafetyState([repoState("a", "not_safe"), repoState("b", "safe")]);
  assert.equal(formatWorkspaceProblems(result), "1 unsafe");
});
