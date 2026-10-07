/**
 * Shared low-level types. The identity-lock model (Identity,
 * RepoIdentityAssignment, RepoIdentityState) lives in
 * `src/identity/types.ts`.
 */

export type RemoteProtocol = "ssh" | "https" | "unknown";

export interface MemoryNote {
  id: string;
  /** Plain text, possibly multiline. Never executed, never interpreted. */
  text: string;
  /** Pinned notes are kept at the top of the list. Nothing else. */
  pinned: boolean;
  createdAt: number;
  /** Set only once the note's text has actually been edited — never by a plain add, and never by pin/unpin. */
  updatedAt?: number;
}

/** One repository's private notes. */
export interface RepoMemory {
  notes: MemoryNote[];
}

export function emptyRepoMemory(): RepoMemory {
  return { notes: [] };
}

/**
 * Which Git config file "Use Assigned Identity in Git Config" writes to.
 * `--local` writes the repo-level config shared by every worktree;
 * `--worktree` writes `config.worktree`, which is only actually
 * per-worktree when `extensions.worktreeConfig` is on — see
 * `resolveIdentityConfigScope`.
 */
export type IdentityConfigScope = "local" | "worktree";
