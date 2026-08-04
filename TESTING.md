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
| Wrong author identity | Profile matches; set local/global identity to a different name/email. | 🔴 NOT SAFE; "Wrong commit identity" in Review Details, "What we found" starts with "Author:"; **Fix Commit Identity** repairs it. |
| Wrong committer identity only | `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` env vars set to something else while `user.name`/`user.email` are correct. | 🔴 NOT SAFE; "Wrong commit identity", "What we found" shows "Committer:" only. |
| Environment override missed by config-only check | Set `GIT_AUTHOR_EMAIL` env var to a different address while `git config user.email` still shows the right one. | Still 🔴 NOT SAFE — confirms the check uses `git var GIT_AUTHOR_IDENT`, not just `git config`. |
| Unknown profile | No profile's `expectedRemoteOwners` or `exactRepos` matches this repo. | 🔴 NOT SAFE; "Repo profile is unknown"; Review Details offers **Add Profile for This Repo**. |
| Exact-repo override wins over owner pattern | Profile A's `expectedRemoteOwners` matches this repo's owner; Profile B has an `exactRepos` entry for this exact repo. | Profile B is matched, not Profile A — exact-repo always wins. |
| Fork/upstream conflict | Add an `upstream` remote whose owner matches a *different* profile than `origin`'s owner (e.g. personal fork of a company repo). | 🔴 NOT SAFE; "Origin and upstream imply different profiles"; Review Details offers **Assign This Repo**. |
| Resolve a fork conflict | From the conflict above, click **Assign This Repo** and pick one of the two profiles. | Confirm an `exactRepos` entry for this repo is added to the chosen profile in `settings.json`, and the repo now resolves to it (exact-repo tier) on rescan. |
| Upstream matches nothing, or matches the same profile as origin | Add an `upstream` remote with an unrelated owner, or the same owner as `origin`. | No conflict — normal owner-pattern resolution applies. |
| Push destination unresolved | Remove all remotes (`git remote remove origin`) and unset any `pushRemote`/`pushDefault`. | 🔴 NOT SAFE; "Push destination is not verified" — blocking even with `strictPushSetup: false`. |
| Push destination mismatch | Set `branch.<name>.pushRemote` (or add an `upstream` remote and point push there) to a remote owned by someone other than the matched profile. | 🔴 NOT SAFE; "Push destination does not match `<Profile>`". |
| HTTPS push, relaxed profile | `strictPushSetup: false`, push remote is `https://github.com/...`. | Still SAFE overall; "Push account is unverified" appears as a non-blocking warning. |
| HTTPS push, strict profile | `strictPushSetup: true`, push remote is `https://github.com/...`. | 🔴 NOT SAFE; "Push account is unverified" is blocking. |
| Generic SSH host, strict profile | `strictPushSetup: true`, push remote like `git@github.com:org/repo.git`. | 🔴 NOT SAFE; "Push account is unverified". |
| SSH host alias | Push remote like `git@github-work:AcmeSoftware/repo.git`. | No push-setup issue (treated as a trusted, dedicated host). |
| Protected branch | Check out `main` or `master`. | 🔴 NOT SAFE; "Working directly on main". |
| Detached HEAD | `git checkout <commit-sha>`. | 🔴 NOT SAFE; "Working in detached HEAD". |
| Branch pattern mismatch | Profile has `expectedBranchPatterns: ["feature/*"]`; check out `chore/x`. | Non-blocking "Branch does not match repo rules" warning. |
| Merge conflict | Start a merge that conflicts, leave it unresolved. | 🔴 NOT SAFE; "Unresolved merge conflicts". |
| Rebase in progress | `git rebase -i HEAD~2` and stop mid-rebase. | 🔴 NOT SAFE; "A rebase is in progress". |
| Ordinary uncommitted changes | Edit a tracked file, don't commit; no conflicts, no in-progress operation. | Still SAFE overall; non-blocking "Uncommitted changes present" warning ("preserve existing changes"). |
| Untrusted workspace | Open the folder, then disable Workspace Trust for it (`Workspaces: Manage Workspace Trust`). | 🔴 NOT SAFE; "Workspace is not trusted"; **Fix Commit Identity** and saved-command **Run** are both blocked with a clear message. |
| Linked worktree | `git worktree add ../wt-branch branch-name`, open that folder, try **Fix Commit Identity**. | Confirmation dialog includes an extra sentence about affecting this worktree only vs. every worktree, based on `extensions.worktreeConfig`. |
| Strict local identity | Enable `repoIdentityGuard.requireLocalIdentity`; unset local identity while global/effective still matches. | Non-blocking "Repo is not locked to `<Profile>` identity" (commit identity). |
| Non-Git folder | Open a plain folder with no `.git`. | ⚪ NOT CHECKED. |
| No pinned memory | Repo Memory has no pinned note. | Info-only "No pinned repo memory" (never blocks SAFE). |
| Shield Mode card | Open Settings. | A disabled "Shield Mode — Coming soon" card with no checkbox — never an interactive toggle. |

Remember: Repo Identity Guard does not verify pull/push access. If
`git pull` or `git push` fails with "Repository not found", check GitHub
authentication, SSH keys, HTTPS credentials, or your Git credential manager
outside Repo Identity Guard.

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

1. With no pinned note, click **Copy Context for AI** from the Main view.
   Confirm a preview tab opens with the exact text, and that it's also on
   the clipboard.
2. Confirm the preview includes: a "Checked:" timestamp, repo name, matched
   profile, status, branch, the open (non-info) issues, and a fixed "Rules
   for AI" section (no push, don't touch main/master, ask before switching
   branches, preserve existing uncommitted changes, don't change
   identity/remote/SSH/credentials).
3. Pin a memory note. With "Include pinned memory note in Copy Context for
   AI" **off** (default), confirm the preview shows a note explaining it
   was omitted, not the note text itself.
4. Turn the setting **on**, copy again, and confirm the pinned note text
   now appears under "User-approved pinned notes."
5. Confirm the output never includes secrets, tokens, `.env` values, SSH
   key contents, or raw Git config regardless of the setting.

### Settings

1. Open the Settings view. Add a profile with label, Git name/email,
   expected remote owners, expected branch patterns, and strict push setup.
2. Confirm it's saved to `repoIdentityGuard.profiles` in `settings.json`.
3. Edit the Local Branch Policy field; confirm it updates
   `repoIdentityGuard.protectedBranches`.
4. Toggle "Require identity to be locked locally" and "Include pinned
   memory note in Copy Context for AI"; confirm both persist to
   `settings.json` and trigger a rescan.
5. Confirm the "Shield Mode — Coming soon" card has no checkbox and cannot
   be interacted with.

### Refresh behavior

Confirm status updates after:

- changing profiles, protected branches, or preferences in Settings;
- editing repo-local Git config with `git config --local`;
- editing global Git config with `git config --global`;
- switching the active editor between repositories;
- pinning/unpinning a Repo Memory note;
- granting Workspace Trust to a previously untrusted folder.

## Automated checks

Run:

```powershell
npm run compile
npm test
```
