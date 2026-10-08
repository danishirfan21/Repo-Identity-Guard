import * as path from "node:path";

/**
 * Repo Identity Guard has no repository picker and no multi-repository
 * dashboard — it follows the ONE repository the developer is currently
 * working in (see FROZEN PRODUCT RULES). This module is the single,
 * reusable place that decides which known repository that is, replacing
 * what used to be two slightly-different copies of the same logic
 * (`commandTarget` / `commandTargetFrom` in `extension.ts`).
 *
 * Rule, in order:
 *  A. The active editor's file belongs to a known repository → use it.
 *  B. No active editor determines one, and exactly one repository is
 *     known → use it (nothing to disambiguate).
 *  C. Multiple repositories are known and the active editor doesn't pick
 *     one → prefer the previously-resolved repository (if it is still
 *     known), so switching to an unrelated file (a `.vscode/settings.json`,
 *     an output panel, a diff view) doesn't make the UI jump to a
 *     different repository than the one the user was just working in.
 *     Otherwise fall back to the first known repository, in whatever
 *     (deterministic) order the caller supplies — scan order, so repeated
 *     calls with the same inputs always agree.
 *  D. No repository is known at all → no current repository.
 *
 * Pure (no `vscode` import): the caller supplies the active editor's file
 * path (or leaves it out) and the repository list, so this is exercised
 * directly in unit tests without a real VS Code host.
 */

export interface CurrentRepoCandidate {
  /** Opaque id — in production, the canonical repository key/path. */
  id: string;
  /** Absolute filesystem root of this repository (working tree). */
  repoRoot: string;
}

export interface ResolveCurrentRepoInput {
  repos: readonly CurrentRepoCandidate[];
  /** Absolute filesystem path of the active editor's document, when it is a real file on disk. */
  activeFilePath?: string;
  /** The id this resolver (or its caller) last returned, for stable fallback — see rule C. */
  previousId?: string;
}

/** True when `candidate` is `root` itself or a path inside it. Pure string/path logic — no filesystem access. */
export function isSubpath(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Rule A: the known repository (if any) whose root contains `activeFilePath`. */
export function findRepoForActiveFile<T extends CurrentRepoCandidate>(repos: readonly T[], activeFilePath: string | undefined): T | undefined {
  if (!activeFilePath) return undefined;
  return repos.find((repo) => isSubpath(activeFilePath, repo.repoRoot));
}

/**
 * Resolves the id of the ONE repository the UI (sidebar or a Command
 * Palette command) should act on right now — see the rule above. Returns
 * `undefined` only when `repos` is empty (rule D).
 */
export function resolveCurrentRepoId(input: ResolveCurrentRepoInput): string | undefined {
  return resolveCurrentRepo(input)?.id;
}

/** Same as {@link resolveCurrentRepoId}, but returns the whole candidate (useful when the caller already has the full repo objects, not just ids). */
export function resolveCurrentRepo<T extends CurrentRepoCandidate>(input: { repos: readonly T[]; activeFilePath?: string; previousId?: string }): T | undefined {
  const { repos, activeFilePath, previousId } = input;
  if (repos.length === 0) return undefined;

  const activeMatch = findRepoForActiveFile(repos, activeFilePath);
  if (activeMatch) return activeMatch;

  if (repos.length === 1) return repos[0];

  if (previousId !== undefined) {
    const previous = repos.find((repo) => repo.id === previousId);
    if (previous) return previous;
  }

  return repos[0];
}
