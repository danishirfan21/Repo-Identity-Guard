# Manual testing

Run the extension in an Extension Development Host with `F5`, then open a test
Git repository.

Useful commands:

```powershell
git remote get-url origin
git config user.name
git config user.email
git config --local user.name
git config --local user.email
git config --global user.name
git config --global user.email
```

## Scenario matrix

| Scenario | Setup | Expected |
| --- | --- | --- |
| Safe personal repo | Rule matches personal remote; effective identity matches personal name/email. | Status shows `Repo ID: Personal` or configured label. |
| Wrong personal repo | Rule matches personal remote; set local name/email to work or wrong values. | Status shows `Repo ID: Wrong`; **Fix** writes expected local identity. |
| Safe company repo | Rule matches company remote; effective identity matches company name/email. | Status shows `Repo ID: Work` or configured label. |
| Wrong company repo | Rule matches company remote; set local name/email to personal or wrong values. | Status shows `Repo ID: Wrong`; warning says you may commit with wrong author. |
| Strict local identity: local needed | Enable `repoIdentityGuard.requireLocalIdentity`; unset local identity; make global/effective identity match the rule. | Status shows `Repo ID: Local Needed`; **Set Local** writes repo-local name/email. |
| No rule | Remove matching rules or set `repoIdentityGuard.rules` to `[]`. | Status shows `Repo ID: Unknown`; click shows **Add Rule**, **Settings**, **Rescan**. |
| No origin | Use a Git repo with no `origin` remote. | Status shows `Repo ID: Unknown`; details say the repo has no origin remote. |
| SSH alias remote | Set origin like `git@github-work:AcmeSoftware/example-project.git`; add rule `github-work/AcmeSoftware/*`. | Rule matches normalized SSH alias remote. |

## Safe-state release checks

When the effective identity and repo-local identity both match the rule:

- the sidebar status message should say commits will use the expected author
  identity;
- the large primary fix/set identity button should not appear;
- global identity mismatch should be shown as neutral fallback context, not a
  warning;
- **Copy Report**, **Rescan**, **Settings**, and **View Full Details** should
  remain available.

Remember: Repo ID does not verify pull/push access. If `git pull` or `git push`
fails with "Repository not found", check GitHub authentication, SSH keys, HTTPS
credentials, or Git Credential Manager outside Repo ID.

## Detailed checks

### Wrong identity fix

1. Add a rule matching the repo remote.
2. Set a wrong local identity:

   ```powershell
   git config --local user.name "Wrong User"
   git config --local user.email "wrong@example.com"
   ```

3. Confirm status shows `Repo ID: Wrong`.
4. Click the status item.
5. Choose **Fix** or open **Details** and choose **Fix Local Git Identity**.
6. Confirm the modal.
7. Verify local config changed:

   ```powershell
   git config --local user.name
   git config --local user.email
   ```

### Strict local identity

1. Enable:

   ```json
   "repoIdentityGuard.requireLocalIdentity": true
   ```

2. Make global/effective identity match the rule.
3. Unset local identity:

   ```powershell
   git config --local --unset user.name
   git config --local --unset user.email
   ```

4. Confirm status shows `Repo ID: Local Needed`.
5. Choose **Set Local**.
6. Confirm status returns to the safe label.

### Details Quick Pick

Click the status item, choose **Details**, and confirm rows are readable:

- Status
- Remote
- Effective identity
- Local identity
- Global identity
- Expected identity
- Matched rule
- Require local identity

Action rows should include:

- Fix Local Git Identity / Set Local Identity
- Add Rule for Current Repo
- Copy Diagnostic Report
- Rescan
- Open Settings

### Activity Bar panel

Confirm the left Activity Bar has a **Repo ID** icon. Open it and verify the
card-based sidebar shows:

- Status card
- Repository card
- Matched Rule card
- Identity card with Effective, Local, and Global sections
- Actions card with Details, Fix/Set Local, Add Rule, Copy Report, Rescan, and
  Settings
- custom confirmation modal for Fix/Set Local Identity

### Copy Diagnostic Report

Run **Repo ID: Copy Diagnostic Report** from the command palette or choose it in
the Details Quick Pick. Paste the clipboard contents and confirm it includes:

- repo root
- normalized remote
- raw remote
- status
- matched rule label and pattern
- effective name/email
- local name/email
- global name/email
- expected name/email
- `requireLocalIdentity`

### Add Rule for Current Repo

1. Empty `repoIdentityGuard.rules`.
2. Click `Repo ID: Unknown`.
3. Choose **Add Rule**.
4. Accept or edit the prompted match, label, name, and email.
5. Confirm the new rule appears in settings and the status rescans.

### Refresh behavior

Confirm status updates after:

- changing `repoIdentityGuard.rules`;
- changing `repoIdentityGuard.requireLocalIdentity`;
- editing repo-local Git config with `git config --local`;
- editing global Git config with `git config --global`;
- switching the active editor between repositories.

## Automated checks

Run:

```powershell
npm run compile
npm test
```
