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

- A repo with no matching rule shows `Unknown`.
- A repo with no `origin` shows `Unknown`.
- A non-Git folder hides the status item.
- Changing `repoIdentityGuard.rules` triggers a rescan.
- Switching the active editor between repositories triggers a rescan.
