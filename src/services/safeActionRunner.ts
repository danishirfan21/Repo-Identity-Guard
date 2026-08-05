import { IdentityConfigScope } from "../types";
import {
  setLocalGitIdentity,
  unsetLocalGitIdentity,
} from "./gitService";

/**
 * The only mutating Git actions Repo Identity Guard is allowed to perform:
 * setting or unsetting this repo's own `user.name`/`user.email`, to either
 * `--local` or `--worktree` per the caller's resolved scope (see
 * `resolveIdentityConfigScope`). Nothing here ever touches global Git
 * config, remotes, SSH config, credential managers, or runs
 * push/reset/rebase/merge/clean — those must always go through the user's
 * own terminal.
 */
export class SafeActionRunner {
  public async setLocalIdentity(
    repoRoot: string,
    name: string,
    email: string,
    scope: IdentityConfigScope = "local",
  ): Promise<void> {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail) {
      throw new Error("Name and email are required to set a local Git identity.");
    }
    await setLocalGitIdentity(repoRoot, trimmedName, trimmedEmail, scope);
  }

  public async unsetLocalIdentity(repoRoot: string, scope: IdentityConfigScope = "local"): Promise<void> {
    await unsetLocalGitIdentity(repoRoot, scope);
  }
}
