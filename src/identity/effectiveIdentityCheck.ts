import { ParsedIdent, getEffectiveAuthorIdent, getEffectiveCommitterIdent } from "../services/gitService";
import { Identity } from "./types";

/**
 * Passive, read-only inspection of the identity Git would ACTUALLY attach
 * to a commit made right now in this repository — the same "effective
 * identity" semantics the enforcement hook itself trusts (`git var
 * GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`, which already accounts for
 * `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL`/`EMAIL` environment overrides and
 * `-c`-style config layering), never merely `git config user.email` — see
 * `getEffectiveAuthorIdent`/`getEffectiveCommitterIdent` in
 * `src/services/gitService.ts`.
 *
 * This exists so the UI can show "Git is currently using: X / Expected: Y"
 * PASSIVELY, before any commit is attempted — today that mismatch is only
 * ever discovered at commit time by the hook, or right after an
 * assignment. Never mutates Git. Never guesses: a read failure is reported
 * as `inspectionFailed`, not silently treated as a match or a mismatch.
 *
 * Commit enforcement checks BOTH the author and the committer identity
 * (`src/shield/evaluator.ts` / the shipped hook): a UI adapter that only
 * looked at one of them could report "healthy" for a repository whose next
 * commit would in fact be blocked (e.g. `git commit --author=...`, or a
 * tool that sets only `GIT_COMMITTER_*`). So this checks both and reports
 * which one(s) violate the assigned identity.
 */

export interface EffectiveIdentityCheck {
  /** False only when a `git var` read itself failed (git missing, repository unreadable, ...) — see {@link EffectiveIdentityCheck.inspectionFailed}. */
  inspectionFailed: boolean;
  /** True when neither the author nor the committer identity violates the expected one. Always false when `inspectionFailed`. */
  matches: boolean;
  effectiveAuthor: ParsedIdent;
  effectiveCommitter: ParsedIdent;
  authorViolates: boolean;
  committerViolates: boolean;
  /** Which role(s) actually violate the expected identity — `undefined` when `matches` or `inspectionFailed`. */
  violatingRole?: "author" | "committer" | "both";
}

function normalizedEmail(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizedName(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * True when `effective` violates `expected`. The email is always checked
 * (it is always required on an `Identity`); the name is checked only when
 * the identity specifies one — exactly how commit enforcement itself
 * decides (an identity with no `gitName` constrains only the email).
 */
function violates(effective: ParsedIdent, expected: Pick<Identity, "gitEmail" | "gitName">): boolean {
  if (normalizedEmail(effective.email) !== normalizedEmail(expected.gitEmail)) return true;
  if (expected.gitName && normalizedName(effective.name) !== normalizedName(expected.gitName)) return true;
  return false;
}

/**
 * Runs the passive inspection for `repoRoot` against `expected` (the
 * assigned identity's recorded Git name/email). Never throws: a read
 * failure is reported via `inspectionFailed`, so a caller never has to
 * guess whether an exception means "matches" or "mismatch".
 */
export async function checkEffectiveIdentity(
  repoRoot: string,
  expected: Pick<Identity, "gitEmail" | "gitName">,
): Promise<EffectiveIdentityCheck> {
  let effectiveAuthor: ParsedIdent;
  let effectiveCommitter: ParsedIdent;
  try {
    [effectiveAuthor, effectiveCommitter] = await Promise.all([
      getEffectiveAuthorIdent(repoRoot),
      getEffectiveCommitterIdent(repoRoot),
    ]);
  } catch {
    return {
      inspectionFailed: true,
      matches: false,
      effectiveAuthor: {},
      effectiveCommitter: {},
      authorViolates: false,
      committerViolates: false,
    };
  }

  const authorViolates = violates(effectiveAuthor, expected);
  const committerViolates = violates(effectiveCommitter, expected);
  const violatingRole: EffectiveIdentityCheck["violatingRole"] =
    authorViolates && committerViolates ? "both" : authorViolates ? "author" : committerViolates ? "committer" : undefined;

  return {
    inspectionFailed: false,
    matches: !authorViolates && !committerViolates,
    effectiveAuthor,
    effectiveCommitter,
    authorViolates,
    committerViolates,
    violatingRole,
  };
}
