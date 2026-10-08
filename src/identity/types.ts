import type { MemoryNote } from "../types";

/**
 * A reusable identity definition — WHO the user wants to be in a locked
 * repository. Stored in the `repoIdentityGuard.identities` user setting
 * (application scope: never readable from a workspace's own
 * `.vscode/settings.json`). Never holds a secret: no token, key, password
 * or credential-helper data, only values that are already visible in Git
 * history or `~/.ssh/config`.
 *
 * This type is a STRUCTURALLY VALID identity: it can be stored, listed,
 * edited and assigned while still incomplete. Whether it can enforce BOTH
 * halves of a lock is a separate question — see
 * {@link EnforcementReadyIdentity} and `pushEnforcementFor()` in
 * `./identityConfig`. An incomplete identity is never rejected, deleted or
 * "completed" by guessing: a missing field stays missing until the user
 * fills it in, and every push from a repository locked to it is blocked
 * meanwhile.
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
   * `ssh -T git@<alias>` reports). REQUIRED for an enforcement-ready
   * identity: every push from a repository locked to this identity is
   * verified live at push time, and while it is missing every such push
   * is BLOCKED (`push-identity-not-configured`) — never let through
   * unchecked.
   *
   * Optional in this type only so an incomplete identity (e.g. one carried
   * over from an earlier release, where it was optional) stays storable
   * and editable. It is never inferred: not from the commit email, the
   * repository owner, the remote URL, the SSH host alias, or Git config.
   * It is NOT the commit email, NOT the repository owner, and NOT the SSH
   * host alias.
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
 * An identity complete enough to enforce a lock in full: commits are
 * checked against `gitEmail`/`gitName`, and pushes are verified live as
 * `expectedGitHubLogin` over one of `trustedSshHostAliases`. Only a lock
 * built from an enforcement-ready identity can ever report `active`.
 */
export type EnforcementReadyIdentity = Identity & {
  expectedGitHubLogin: string;
  trustedSshHostAliases: [string, ...string[]];
};

/**
 * An explicit mapping from one local repository to one identity.
 *
 * The durable record of an assignment is the lock policy installed in the
 * repository's own common Git directory
 * (`<git-common-dir>/repo-identity-guard/shield-policy.json`, policy v4) —
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
 * - `active`: assigned, every hook/policy/evaluator artifact needed to
 *   enforce it is installed and intact, AND the identity is complete
 *   enough to enforce both commits and pushes (`push` is `enforced`).
 * - `needs_attention`: something is assigned or installed but is not in a
 *   fully trustworthy state (hooks missing or modified, identity edited
 *   since the lock was installed, a legacy installation awaiting
 *   migration, a lock from an earlier version awaiting upgrade, cleanup
 *   that could not finish, no GitHub login configured for push
 *   verification, no trusted SSH alias, ...). `reason` explains it.
 * - `unavailable`: not a Git repository, or Git itself cannot support
 *   enforcement (version too old, repository unreadable).
 */
export type EnforcementState = "unassigned" | "active" | "needs_attention" | "unavailable";

/**
 * The push requirement of an assigned repository. Push is ALWAYS governed
 * once a repository is assigned — there is deliberately no value meaning
 * "push is outside this lock" or "push is unconfigured, therefore
 * allowed":
 *
 * - `enforced`: the identity has an expected GitHub login AND at least one
 *   trusted SSH alias, so every push is verified live (the expected account
 *   is allowed; a different account or an unverifiable route is blocked).
 * - `needs_configuration`: the identity has no GitHub login configured, so
 *   no push can be attributed to an account — EVERY push is blocked
 *   (`push-identity-not-configured`) until a login is configured.
 * - `unverifiable`: the identity has a GitHub login but no trusted SSH
 *   alias, so no push route can be verified — EVERY push is blocked
 *   (`push-route-unverified`) until an alias is added.
 *
 * Every value other than `enforced` keeps an assigned repository in
 * `needs_attention`, never `active`.
 */
export type PushEnforcement = "enforced" | "needs_configuration" | "unverifiable";

export const PUSH_ENFORCEMENT_VALUES: readonly PushEnforcement[] = ["enforced", "needs_configuration", "unverifiable"];

export interface RepoIdentityEnforcement {
  state: EnforcementState;
  /** One human-readable sentence explaining a non-`active`/`unassigned` state. */
  reason?: string;
  /** Whether commits are being checked against the assigned identity right now. */
  commitEnforced: boolean;
  /**
   * The assigned repository's push requirement (see {@link PushEnforcement});
   * `"none"` only when nothing is assigned or the assignment record cannot
   * be read. `state` is `active` only when this is `enforced`.
   */
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
