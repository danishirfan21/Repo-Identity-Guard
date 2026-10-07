import { IdentityConfigScope } from "../types";
import { setLocalGitIdentity } from "./gitService";

/**
 * The only Git config write Repo Identity Guard performs outside its own
 * identity-lock files: "Use Assigned Identity in Git Config" — setting this
 * repository's own `user.name`/`user.email` to the assigned identity, in
 * `--local` or `--worktree` per the caller's resolved scope (see
 * `resolveIdentityConfigScope`). Never touches global Git config, remotes,
 * SSH config, credential managers, and never runs push/reset/rebase/merge.
 */
export class SafeActionRunner {
  public async setLocalIdentity(repoRoot: string, name: string | undefined, email: string, scope: IdentityConfigScope = "local"): Promise<void> {
    const trimmedName = name?.trim();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      throw new Error("An email is required to set a local Git identity.");
    }
    await setLocalGitIdentity(repoRoot, trimmedName || undefined, trimmedEmail, scope);
  }
}
