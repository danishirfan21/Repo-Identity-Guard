import type { MemoryNote } from "../types";

/**
 * A reusable identity definition — WHO the user wants to be in a locked
 * repository. Stored in the `repoIdentityGuard.identities` user setting
 * (application scope: never readable from a workspace's own
 * `.vscode/settings.json`). Never holds a secret: no token, key, password
 * or credential-helper data, only values that are already visible in Git
 * history or `~/.ssh/config`.
 */
export interface Identity {
  /** Stable unique id. Lock policies record it so a later settings edit can be detected as drift. */
  id: string;
  /** Short display label, e.g. "Work". */
  label: string;
  /** Expected Git author/committer name. When omitted, only the email is enforced. */
  gitName?: string;
  /** Expected Git author/committer email. Always enforced. */
  gitEmail: string;
  /**
   * The github.com username an SSH push must authenticate as (what
   * `ssh -T git@<alias>` reports). When set, every push from a repository
   * locked to this identity is verified live at push time; when omitted,
   * only commits are enforced.
   *
   * This is NOT the commit email, NOT the repository owner, and NOT the
   * SSH host alias.
   */
  expectedGitHubLogin?: string;
  /**
   * SSH host aliases (e.g. `github-work`, a `Host` entry in
   * `~/.ssh/config`) that are acceptable push routes for this identity.
   * Required for push verification: a push through any other route
   * (HTTPS, the generic `github.com` host, an unlisted alias) cannot be
   * bound to `expectedGitHubLogin` and is blocked. Listing an alias is not
   * itself proof of anything — the account is still verified live with
   * `ssh -T` on every push.
   */
  trustedSshHostAliases?: string[];
}

/**
 * An explicit mapping from one local repository to one identity.
 *
 * The durable record of an assignment is the lock policy installed in the
 * repository's own common Git directory
 * (`<git-common-dir>/repo-identity-guard/shield-policy.json`, policy v3) —
 * see `src/identity/assignment.ts` for why the assignment lives there and
 * not in extension storage. This interface is the read-side projection of
 * that record.
 */
export interface RepoIdentityAssignment {
  /** Canonical (realpath, case-normalized on Windows) git common directory — shared by every linked worktree of the repository. */
  repoKey: string;
  identityId: string;
  /** Epoch milliseconds the user (or a provable legacy migration) assigned this identity. */
  assignedAt: number;
}

/**
 * The product-level enforcement state of one repository — the only
 * lifecycle a UI needs. The enforcement engine's internal states
 * (off/active/degraded/broken) are deliberately not exposed.
 *
 * - `unassigned`: no identity is assigned and no lock artifacts exist —
 *   Repo Identity Guard does not interfere with Git at all here.
 * - `active`: assigned, and every hook/policy/evaluator artifact needed to
 *   enforce it is installed and intact.
 * - `needs_attention`: something is assigned or installed but is not in a
 *   fully trustworthy state (hooks missing or modified, identity edited
 *   since the lock was installed, a legacy installation awaiting
 *   migration, cleanup that could not finish, a push identity that cannot
 *   be verified, ...). `reason` explains it.
 * - `unavailable`: not a Git repository, or Git itself cannot support
 *   enforcement (version too old, repository unreadable).
 */
export type EnforcementState = "unassigned" | "active" | "needs_attention" | "unavailable";

/**
 * What the push side of a lock enforces:
 * - `enforced`: the identity has an expected GitHub login AND at least one
 *   trusted SSH alias, so every push is verified live.
 * - `not_configured`: the identity declares no GitHub login, so the lock
 *   makes no claim about push accounts (commits are still enforced).
 * - `unverifiable`: the identity declares a GitHub login but no trusted
 *   SSH alias, so no push can ever be verified — every push is blocked
 *   until the identity is completed.
 */
export type PushEnforcement = "enforced" | "not_configured" | "unverifiable";

export interface RepoIdentityEnforcement {
  state: EnforcementState;
  /** One human-readable sentence explaining a non-`active`/`unassigned` state. */
  reason?: string;
  /** Whether commits are being checked against the assigned identity right now. */
  commitEnforced: boolean;
  push: PushEnforcement | "none";
  /** True when "Repair Identity Lock" can be expected to restore `active`. */
  repairAvailable: boolean;
  /** True when lock artifacts (or a legacy Shield installation) exist that "Unlock" would remove. */
  unlockAvailable: boolean;
}

/**
 * The single per-repository state contract a UI binds to. Deliberately
 * small: no capabilities, no SAFE/NOT SAFE, no workspace aggregate, no
 * branch or repository-operation policy, no Shield internals.
 */
export interface RepoIdentityState {
  repositoryPresent: boolean;
  /** Canonical repository key (see {@link RepoIdentityAssignment.repoKey}); undefined when no repository is present. */
  repoKey?: string;
  repoName?: string;
  repoRoot?: string;
  assignment?: {
    identityId: string;
    identityLabel: string;
    gitName?: string;
    gitEmail: string;
    expectedGitHubLogin?: string;
    assignedAt: number;
    /** False when the identity this lock was built from no longer exists in settings (enforcement continues with the recorded snapshot). */
    identityStillDefined: boolean;
  };
  enforcement: RepoIdentityEnforcement;
  notes: MemoryNote[];
}
