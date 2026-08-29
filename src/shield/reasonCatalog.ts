import { Capability } from "../types";
import { ShieldReasonId } from "./types";

/**
 * Human-readable description and (where applicable) the capability each
 * {@link ShieldReasonId} corresponds to. Declared as `Record<ShieldReasonId,
 * …>` on purpose: adding a new `ShieldReasonId` without an entry here is a
 * TypeScript compile error, so the catalog can never silently drift out of
 * sync with the id union.
 */
export interface ShieldReasonDescriptor {
  /** Stable default wording. A hook or the sidebar may add specifics (e.g. the actual branch name) but should not contradict this. */
  description: string;
  /** The existing capability this reason corresponds to, when there is a direct one. */
  capability?: Capability;
}

export const SHIELD_REASON_CATALOG: Record<ShieldReasonId, ShieldReasonDescriptor> = {
  "profile-unresolved": {
    description: "This repository isn't matched to any configured profile, so there's no expected identity or policy to enforce.",
    capability: "commit_identity",
  },
  "profile-conflict": {
    description: "This repository's remote matches more than one configured profile (or origin/upstream imply different profiles), so which policy applies is ambiguous.",
    capability: "commit_identity",
  },
  "commit-identity-mismatch": {
    description: "The identity Git would use for this commit does not match the matched profile's expected name/email.",
    capability: "commit_identity",
  },
  "commit-identity-override": {
    description: "Git config matches the expected identity, but an environment variable or command-line override is superseding it for this commit.",
    capability: "commit_identity",
  },
  "protected-branch": {
    description: "The current branch is locally protected; this action isn't allowed directly on it.",
    capability: "branch_policy",
  },
  "detached-head": {
    description: "HEAD is detached; commits made here aren't tracked by any branch and are easy to lose.",
    capability: "branch_policy",
  },
  "repo-operation-in-progress": {
    description: "A merge, rebase, cherry-pick, or revert is already in progress; this action could interfere with it.",
    capability: "repo_operation_state",
  },
  "merge-conflicts": {
    description: "There are unresolved merge conflicts in the working tree.",
    capability: "repo_operation_state",
  },
  "push-destination-mismatch": {
    description: "A plain push from this branch would go to a destination that doesn't match the matched profile.",
    capability: "push_destination",
  },
  "push-route-unverified": {
    description: "The account or route that would authenticate this push cannot be trusted locally (HTTPS, an unrecognized protocol, a generic SSH host, or an SSH alias not explicitly trusted by the matched profile).",
    capability: "push_account",
  },
  "push-route-mismatch": {
    description: "The push route resolves to a route explicitly associated with a different profile than the one matched for this repository.",
    capability: "push_account",
  },
  "push-route-override": {
    description: "An SSH command override (GIT_SSH, GIT_SSH_COMMAND, core.sshCommand, or a command-scoped -c override) was detected at push time, so the route this push would actually use cannot be verified against the profile's trusted SSH host aliases, even if the URL's host would otherwise be trusted.",
    capability: "push_account",
  },
  "push-account-mismatch": {
    description: "This push's SSH route authenticated to GitHub successfully, but as a different account than the matched profile's expectedGitHubLogin — the route is trusted, but it belongs to the wrong person.",
    capability: "push_account",
  },
  "push-account-unverified": {
    description: "The matched profile expects a specific GitHub account (expectedGitHubLogin) for this route, but Shield could not confirm it live (verification wasn't attempted, the SSH config isn't strongly bound to one identity, the host key isn't already trusted, authentication was refused, the connection timed out, or the response couldn't be parsed).",
    capability: "push_account",
  },
  "policy-missing": {
    description: "Shield is enabled for this repository, but no policy file could be found where one was expected.",
  },
  "policy-corrupt": {
    description: "Shield's policy file exists but could not be parsed or failed validation.",
  },
  "inspection-failed": {
    description: "Git state could not be reliably read at evaluation time, so nothing here can be treated as confirmed.",
  },
};
