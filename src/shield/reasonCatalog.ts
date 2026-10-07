import { ShieldReasonId } from "./types";

/**
 * Human-readable description and the short machine code printed on the
 * `REASON:` line of a hook's block message (see `resources/shield/
 * shield-evaluate.sh`'s `report_block`). Declared as `Record<ShieldReasonId,
 * …>` on purpose: adding a new `ShieldReasonId` without an entry here is a
 * TypeScript compile error, so the catalog can never silently drift out of
 * sync with the id union. `src/test/identityLockOutput.test.ts` asserts the
 * shell evaluator prints exactly these codes.
 */
export interface ShieldReasonDescriptor {
  /** Stable default wording. A hook may add specifics but should not contradict this. */
  description: string;
  /** The short snake_case code printed after `REASON:` in the machine-readable block prelude. */
  code: string;
}

export const SHIELD_REASON_CATALOG: Record<ShieldReasonId, ShieldReasonDescriptor> = {
  "commit-identity-mismatch": {
    code: "wrong_identity",
    description: "The identity Git would record for this commit does not match the identity this repository is locked to.",
  },
  "commit-identity-override": {
    code: "identity_override",
    description:
      "Git config already matches the assigned identity, but an environment variable or command-line option (GIT_AUTHOR_*/GIT_COMMITTER_*, git -c user.email=..., --author) overrides it for this commit.",
  },
  "push-route-unverified": {
    code: "push_route_unverified",
    description:
      "The assigned identity expects a specific GitHub account, but this push's route cannot be verified as that account (HTTPS, an unrecognized protocol, a generic SSH host such as github.com, or an SSH alias the identity does not list as trusted).",
  },
  "push-route-override": {
    code: "push_route_override",
    description:
      "An SSH transport override (GIT_SSH, GIT_SSH_COMMAND, core.sshCommand, or a non-OpenSSH ssh.variant / GIT_SSH_VARIANT) is in effect, so the route this push would actually take cannot be shown to match the route Repo Identity Guard verifies.",
  },
  "push-account-mismatch": {
    code: "wrong_push_account",
    description: "This push's SSH route authenticated to GitHub as a different account than the assigned identity's expected GitHub login.",
  },
  "push-account-unverified": {
    code: "push_account_unverified",
    description:
      "The assigned identity expects a specific GitHub account, but Repo Identity Guard could not confirm which account this push authenticates as (IdentitiesOnly not set, route not GitHub, host key not trusted, authentication refused, timeout, or an unparseable response).",
  },
  "policy-missing": {
    code: "policy_missing",
    description: "Identity-lock hooks are installed in this repository, but the lock policy they need could not be found.",
  },
  "policy-corrupt": {
    code: "policy_corrupt",
    description: "The identity-lock policy exists but could not be parsed, failed validation, or is a legacy version this build does not enforce.",
  },
  "inspection-failed": {
    code: "inspection_failed",
    description: "Git state needed to check identity could not be reliably read at evaluation time.",
  },
};
