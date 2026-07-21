import {
  setLocalGitIdentity,
  unsetLocalGitIdentity,
} from "./gitService";

/**
 * The only mutating Git actions Repo Identity Guard is allowed to perform:
 * setting or unsetting *repo-local* user.name/user.email. Nothing here ever
 * touches global Git config, remotes, SSH config, credential managers, or
 * runs push/reset/rebase/merge/clean — those must always go through the
 * user's own terminal.
 */
export class SafeActionRunner {
  public async setLocalIdentity(repoRoot: string, name: string, email: string): Promise<void> {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail) {
      throw new Error("Name and email are required to set a local Git identity.");
    }
    await setLocalGitIdentity(repoRoot, trimmedName, trimmedEmail);
  }

  public async unsetLocalIdentity(repoRoot: string): Promise<void> {
    await unsetLocalGitIdentity(repoRoot);
  }
}
