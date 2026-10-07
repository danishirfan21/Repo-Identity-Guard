import { canonicalizeRepoPath, getGitCommonDir, getRepoRoot } from "../services/gitService";
import type { ShieldInspection } from "../shield/manager";
import { RepoIdentityAssignment } from "./types";

/**
 * Where an assignment lives, and what its key means.
 *
 * ## The record is the lock policy, inside the repository's own Git metadata
 *
 * An explicit assignment is persisted as the identity-lock policy (v3) at
 * `<git-common-dir>/repo-identity-guard/shield-policy.json` — the same
 * file the hooks read at commit/push time — rather than in VS Code
 * extension storage. That single choice is what makes the transaction
 * guarantees hold by construction:
 *
 *  - There is exactly ONE source of truth. "Assignment says unassigned
 *    but hooks still block" and "assignment says locked but hooks were
 *    never installed" are not two records drifting apart: the record and
 *    the enforcement input are the same file, written inside the
 *    enforcement engine's install transaction (rolled back on failure) and
 *    deleted only after every hook it owns was removed.
 *  - It is LOCAL to this repository installation: never synced by
 *    Settings Sync, never shared between two clones of the same remote,
 *    never keyed by remote owner/org. A fresh clone — even at the same
 *    path — has no policy, so an old assignment can never silently
 *    reactivate.
 *  - It is keyed by the canonical git common directory, so every linked
 *    worktree of a repository shares one assignment, and two spellings of
 *    the same path (symlink, Windows casing) cannot duplicate it.
 *  - It works across VS Code windows, profiles and installs, and is
 *    honored by the hooks with VS Code closed.
 *
 * What is NOT stored there: anything secret (see `ShieldPolicy`).
 */

export interface RepositoryRef {
  repoRoot: string;
  /** Canonical git common directory — the assignment key. */
  repoKey: string;
  gitCommonDir: string;
}

/**
 * Resolves the repository containing `startDir` and its assignment key,
 * or `undefined` when `startDir` is not inside a Git repository.
 */
export async function resolveRepository(startDir: string): Promise<RepositoryRef | undefined> {
  const repoRoot = await getRepoRoot(startDir).catch(() => null);
  if (!repoRoot) return undefined;
  const gitCommonDir = await getGitCommonDir(repoRoot).catch(() => null);
  if (!gitCommonDir) return undefined;
  return { repoRoot, gitCommonDir, repoKey: await canonicalizeRepoPath(gitCommonDir) };
}

/** The assignment recorded by a valid v3 lock policy, if any. */
export function assignmentFromInspection(repoKey: string, inspection: ShieldInspection): RepoIdentityAssignment | undefined {
  const snapshot = inspection.policySnapshot;
  if (!inspection.policyValid || !snapshot) return undefined;
  return { repoKey, identityId: snapshot.identityId, assignedAt: snapshot.assignedAt };
}
