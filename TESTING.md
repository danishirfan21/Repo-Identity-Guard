# Manual testing

Run the extension in an Extension Development Host with `F5`, then open a test
Git repository. Open the **Repo Identity Guard** icon in the Activity Bar.

Useful read-only commands to set up scenarios:

```powershell
git remote get-url origin
git config user.name
git config user.email
git config --local user.name
git config --local user.email
git config --global user.name
git config --global user.email
git branch --show-current
```

## Scenario matrix

| Scenario | Setup | Expected |
| --- | --- | --- |
| Safe repo | Profile matches remote owner; effective identity, protocol, and branch all match. | Main view shows 🟢 SAFE. |
| Wrong commit identity | Profile matches; set local/global identity to a different name/email. | 🔴 NOT SAFE; "Wrong commit identity" in Review Details; **Fix Commit Identity** repairs it. |
| Unknown profile | No profile's `expectedRemoteOwners` matches this repo's remote owner. | 🔴 NOT SAFE; "Repo profile is unknown"; Review Details offers **Add Profile for This Repo**. |
| HTTPS push, relaxed profile | `strictPushSetup: false`, origin is `https://github.com/...`. | Still SAFE overall; "Push setup is not verified" appears as a non-blocking warning. |
| HTTPS push, strict profile | `strictPushSetup: true`, origin is `https://github.com/...`. | 🔴 NOT SAFE; "Push setup is not verified" is blocking. |
| Generic SSH host, strict profile | `strictPushSetup: true`, origin like `git@github.com:org/repo.git`. | 🔴 NOT SAFE; "Repo is not locked to `<Profile>` identity". |
| SSH host alias | Origin like `git@github-work:AcmeSoftware/repo.git`. | No push-setup issue (treated as a locked, dedicated host). |
| Protected branch | Check out `main` or `master`. | 🔴 NOT SAFE; "Working directly on main". |
| Detached HEAD | `git checkout <commit-sha>`. | 🔴 NOT SAFE; "Working in detached HEAD". |
| Branch pattern mismatch | Profile has `expectedBranchPatterns: ["feature/*"]`; check out `chore/x`. | Non-blocking "Branch does not match repo rules" warning. |
| Strict local identity | Enable `repoIdentityGuard.requireLocalIdentity`; unset local identity while global/effective still matches. | Non-blocking "Repo is not locked to `<Profile>` identity" (commit identity). |
| Non-Git folder | Open a plain folder with no `.git`. | ⚪ NOT CHECKED. |
| No pinned memory | Repo Memory has no pinned note. | Info-only "No pinned repo memory" (never blocks SAFE). |

## Detailed checks

### Fix Commit Identity

1. Add a profile matching the repo's remote owner.
2. Set a wrong local identity:

   ```powershell
   git config --local user.name "Wrong User"
   git config --local user.email "wrong@example.com"
   ```

3. Confirm Main view shows 🔴 NOT SAFE with "Wrong commit identity" as the
   next fix.
4. Click **Fix Setup** (or **Fix Commit Identity** in Review Details).
5. Confirm the modal, then verify:

   ```powershell
   git config --local user.name
   git config --local user.email
   ```

   match the profile, and that global config was left untouched.

### Review Details

Open **Review Details** and confirm each issue shows, in plain English:

- Title
- Why it matters
- What we expected / what we found
- A suggested action button
- An expandable **Technical Details** section with raw Git facts only

### Repo Memory

1. Add a note, pin it, confirm it shows as the Main view's pinned memory
   preview.
2. Add a second note; confirm pinning it un-pins the first (only one pinned
   note at a time).
3. Add a saved command (e.g. label "Start dev server", command `pnpm dev`).
4. Click **Run** — confirm it opens a visible integrated terminal and runs
   the command (never silently).
5. Click **Copy** — confirm the command text is on the clipboard.
6. Remove a note and a command; confirm they disappear.
7. Confirm notes/commands are **not** written into any file inside the repo
   (check `git status` stays clean).

### Copy Context for AI

Click **Copy Context for AI** from the Main view, paste the clipboard
contents, and confirm it includes:

- Repo name, matched profile, status, branch
- The open (non-info) issues
- Pinned memory notes
- A fixed "Rules for AI" section (no push, don't touch main/master, ask
  before switching branches, don't change identity/remote/SSH/credentials)

Confirm it does **not** include secrets, tokens, `.env` values, SSH key
contents, or raw Git config.

### Settings

1. Open the Settings view. Add a profile with label, Git name/email,
   expected remote owners, expected branch patterns, and strict push setup.
2. Confirm it's saved to `repoIdentityGuard.profiles` in `settings.json`.
3. Edit protected branches; confirm it updates
   `repoIdentityGuard.protectedBranches`.
4. Toggle "Require identity to be locked locally" and "Shield Mode"; confirm
   both persist and trigger a rescan.

### Refresh behavior

Confirm status updates after:

- changing profiles, protected branches, or preferences in Settings;
- editing repo-local Git config with `git config --local`;
- editing global Git config with `git config --global`;
- switching the active editor between repositories;
- pinning/unpinning a Repo Memory note.

## Automated checks

Run:

```powershell
npm run compile
npm test
```
