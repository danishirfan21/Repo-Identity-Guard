import * as path from "node:path";

/**
 * Where Shield-owned metadata lives, given the repository's *common* git
 * directory (i.e. the output of `git rev-parse --path-format=absolute
 * --git-common-dir`, resolved from any worktree). See docs/SHIELD_MODE.md
 * "Storage decision" for the empirical reasoning: git-common-dir is the one
 * location that is
 *
 *  - the same absolute path from the main worktree and from every linked
 *    worktree of the same repository (confirmed empirically — see
 *    shieldGitTopology.test.ts),
 *  - never a tracked file (everything under `.git/` is Git's own internal
 *    state; nothing here is ever committed),
 *  - readable by a plain Git hook with no VS Code process, extension host,
 *    or network access involved, and
 *  - the same directory Git itself already uses for `hooks/` by default —
 *    so Shield's metadata sits right next to the mechanism that reads it.
 *
 * This module only derives *paths* — it performs no filesystem I/O itself,
 * so it stays pure and unit-testable without touching disk.
 */

const SHIELD_DIR_NAME = "repo-identity-guard";
const SHIELD_POLICY_FILE_NAME = "shield-policy.json";
const SHIELD_EVALUATOR_FILE_NAME = "shield-evaluate.sh";

/**
 * `<gitCommonDir>/repo-identity-guard` — Shield's own subdirectory inside
 * the shared git directory. Kept in its own namespaced subdirectory (never
 * loose files directly under `.git/`) so Shield's presence is unambiguous
 * and trivially removable, and so it can never collide with a file name
 * Git or another tool (Husky, pre-commit, lefthook, …) might use.
 *
 * @param gitCommonDirAbsolute Absolute path from `git rev-parse
 *   --path-format=absolute --git-common-dir`. Passing a relative or
 *   cwd-dependent path defeats the whole point of this being
 *   worktree-portable — callers must resolve to an absolute path first.
 */
export function shieldStorageDir(gitCommonDirAbsolute: string): string {
  if (!path.isAbsolute(gitCommonDirAbsolute)) {
    throw new Error(
      `shieldStorageDir requires an absolute git-common-dir path, got: ${gitCommonDirAbsolute}. ` +
        `Resolve it with "git rev-parse --path-format=absolute --git-common-dir" first.`,
    );
  }
  return path.join(gitCommonDirAbsolute, SHIELD_DIR_NAME);
}

/** `<gitCommonDir>/repo-identity-guard/shield-policy.json` — see {@link shieldStorageDir}. */
export function shieldPolicyFilePath(gitCommonDirAbsolute: string): string {
  return path.join(shieldStorageDir(gitCommonDirAbsolute), SHIELD_POLICY_FILE_NAME);
}

/**
 * `<gitCommonDir>/repo-identity-guard/shield-evaluate.sh` — Shield's own
 * copy of the standalone evaluator, installed alongside the policy it
 * reads. Copying it here (rather than having the hook reach back into the
 * extension's own install directory) keeps enforcement working even if
 * the extension is later updated, moved, or uninstalled while Shield
 * remains enabled, and keeps it worktree-portable for the same reason the
 * policy file is: this path is identical from every worktree of the
 * repository.
 */
export function shieldEvaluatorScriptFilePath(gitCommonDirAbsolute: string): string {
  return path.join(shieldStorageDir(gitCommonDirAbsolute), SHIELD_EVALUATOR_FILE_NAME);
}
