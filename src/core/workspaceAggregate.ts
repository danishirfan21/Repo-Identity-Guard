import { RepositorySafetyState, SafetyLevel, WorkspaceSafetyState } from "../types";

/**
 * Rolls up per-repository {@link RepositorySafetyState}s into one workspace
 * verdict, using a conservative rule rather than a plain OR:
 *
 * - SAFE only when every detected in-scope repository has been checked and
 *   is SAFE.
 * - NOT SAFE when any repository has a blocking result, is unresolved, or
 *   could not be checked reliably (a failed inspection still produces an
 *   entry here — see `collectRepoFacts`/`computeStatus` — it is never
 *   silently dropped from the count).
 * - NOT CHECKED only when no repositories have been evaluated, or no Git
 *   repositories were detected in the workspace at all.
 *
 * This never synthesizes a cross-repo `CapabilityResult` — capability
 * results stay strictly scoped to the repository that produced them; this
 * function only derives a summary level from each repo's own `level`.
 */
export function computeWorkspaceSafetyState(repos: RepositorySafetyState[]): WorkspaceSafetyState {
  const safeCount = repos.filter((repo) => repo.summary.level === "safe").length;
  const notSafeCount = repos.filter((repo) => repo.summary.level === "not_safe").length;
  const uncheckedCount = repos.filter((repo) => repo.summary.level === "not_checked").length;

  let level: SafetyLevel;
  if (repos.length === 0) {
    level = "not_checked";
  } else if (safeCount === repos.length) {
    level = "safe";
  } else {
    level = "not_safe";
  }

  return { level, repos, safeCount, notSafeCount, uncheckedCount };
}
