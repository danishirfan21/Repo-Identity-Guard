# Manual testing

1. Open a Git repository in the Extension Development Host.
2. Add a `repoIdentityGuard.rules` setting that matches its origin remote.
3. In that repository, set an intentionally wrong local email:

   ```powershell
   git config --local user.email personal@example.com
   ```

4. Confirm the status bar shows `Repo ID: Wrong`.
5. Click the status bar item.
6. Choose **Fix local Git identity** and confirm the modal.
7. Verify the repository-local value:

   ```powershell
   git config --local user.email
   ```

8. Confirm the status bar now shows the rule label, such as `Repo ID: Work`.

Also check:

- The status details show effective, local, and global identity values.
- Clicking the status item shows a short notification. Choose **View Details**
  to open the readable Quick Pick details view.
- If local identity is unset but global identity matches the rule, the repo is
  treated as safe because Git's effective identity matches.
- Enable `repoIdentityGuard.requireLocalIdentity`, then unset local identity
  while global identity still matches. Confirm the status shows
  `Repo ID: Local Needed`, and **Set Local Identity** writes local config.
- **Repo Identity Guard: Copy Diagnostic Report** copies repo root, raw and
  normalized remote, status, matched rule, identity layers, expected identity,
  and the strict-local setting.
- Remove all `repoIdentityGuard.rules`, click the status item in a Git repo,
  and confirm the starter actions are **Add Rule**, **Settings**, and
  **Rescan**.
- **Repo Identity Guard: Add Rule for Current Repo** appends a new rule to
  `repoIdentityGuard.rules`.
- A repo with no matching rule shows `Unknown`.
- A repo with no `origin` shows `Unknown`.
- A non-Git folder hides the status item.
- Changing `repoIdentityGuard.rules` triggers a rescan.
- Switching the active editor between repositories triggers a rescan.
