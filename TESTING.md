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
| Environment override missed by config-only check | Set `GIT_AUTHOR_EMAIL` env var to a different address while `git config user.email` still shows the right one. | Still 🔴 NOT SAFE — confirms the check uses `git var GIT_AUTHOR_IDENT`, not just `git config`. Review Details shows **"Commit identity overridden by the environment"** (not "Wrong commit identity"), with no Fix Commit Identity button — config already matches, so there's nothing for it to write. |
| Fix Commit Identity can't out-fix an environment override | With the above env-override scenario still active, run **Fix Commit Identity** anyway (e.g. via the command palette). | Config gets written (harmlessly redundant), but after the rescan the result explains that config was updated and the identity is still overridden by the environment/command context — it does **not** say "Commit identity fixed" when the effective identity is still wrong. |
| Fix Commit Identity succeeds honestly | Set a genuinely wrong local identity (no env override), run **Fix Commit Identity**. | After the write and rescan, Commit Identity shows **Confirmed** and the success message appears — the message is based on the rescanned result, not just "the write didn't throw." |
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
| Worktree config on, single worktree | `git config extensions.worktreeConfig true` on a repo with only one worktree, try **Fix Commit Identity**. | Dialog says the change is written with `--worktree`, even though there's only one worktree; confirm with `git config --worktree user.email` that it landed in `config.worktree`. This matters because a pre-existing stale `config.worktree` value would otherwise keep overriding a `--local` fix. |
| Worktree config on, stale override reproduces the bug this fixes | Set `git config --worktree user.email wrong@example.com` directly, then set the *correct* email as effective identity some other way (e.g. env var) so Commit Identity briefly reads as fixed, then run Fix Commit Identity again. | Fix writes to `--worktree` (not `--local`), so the effective identity actually changes and stays changed — confirm `git var GIT_AUTHOR_IDENT` reflects it. |
| Linked worktree, per-worktree config off | `git worktree add ../wt-branch branch-name`, `extensions.worktreeConfig` unset/false, try **Fix Commit Identity** from the worktree. | Dialog says the change is shared across every worktree (not narrower) and is written with `--local`; confirm `git config --local user.email` in the *other* worktree also shows the new value. |
| Main worktree with others attached | From the *main* worktree (not a linked one) of a repo that has a linked worktree elsewhere, with worktree config off, try **Fix Commit Identity**. | Still shows the shared-scope warning — `isLinkedWorktree` being false for the main worktree must not suppress it; this is gated on worktree *count*, not on whether the current checkout happens to be linked. |
| Mutation confirmation names the repo | Trigger **Fix Commit Identity** in any repo. | Dialog text includes the repository name, its local path, and the matched profile — not just "this repo". |
| Strict local identity recognizes a worktree-scoped fix | Enable `repoIdentityGuard.requireLocalIdentity` and `extensions.worktreeConfig`; run **Fix Commit Identity** (writes `--worktree`). | Commit Identity shows **Confirmed**, not "Repo is not locked to `<Profile>` identity" — the strict check now reads `config.worktree` too, not just `--local`. |
| External `config.worktree` edit triggers a rescan | With worktree config on, run `git config --worktree user.email wrong@example.com` directly in a terminal. | The sidebar rescans within ~300ms and reflects the new (wrong) identity, the same way an external `git config --local` edit already did. |
| A failing `git status`/`git worktree list` surfaces as unresolved, not clean | (Developer scenario) Simulate `git status` or `git worktree list` failing for a repo (e.g. corrupt index). | That repo shows as NOT SAFE with "Could not fully inspect this repository" — never silently reported as a clean working tree or a single worktree. |
| Strict local identity | Enable `repoIdentityGuard.requireLocalIdentity`; unset local identity while global/effective still matches. | Non-blocking "Repo is not locked to `<Profile>` identity" (commit identity). |
| Non-Git folder | Open a plain folder with no `.git`. | ⚪ NOT CHECKED. |
| No pinned memory | Repo Memory has no pinned note. | Info-only "No pinned repo memory" (never blocks SAFE). |
| Shield Mode card | Open Settings. | A disabled "Shield Mode — Coming soon" card with no checkbox — never an interactive toggle. |
| Full checklist on a safe repo | All checks pass. | Review Details shows all 6 capabilities (Commit Identity, Push Destination, Push Account, Branch Policy, Repo State, Workspace Trust) with a **Confirmed** badge each — not just an empty "no issues" list. |
| Failed Git inspection | Simulate a Git command failure mid-scan (e.g. corrupt a ref temporarily). | 🔴 NOT SAFE; Repo State shows "Could not fully inspect this repository" as **Unverified** and blocking — never silently treated as clean. |
| Dependent capability shown as Not applicable | No profile resolves for this repo. | Push Destination, Push Account, and Branch Policy each show a **Not applicable** badge (dimmed) rather than being silently omitted, and don't carry a "Blocks Safety" tag. |
| Blocks Safety tag vs. state | HTTPS push with `strictPushSetup: false` vs. `true`, same repo. | Both show the **Unverified** badge on Push Account; only the `strictPushSetup: true` case also shows a **Blocks Safety** tag. |
| Multi-root, all safe | Open a workspace with two Git repos as separate folders, both matching profiles and passing every check. | Main shows the aggregate 🟢 SAFE badge, "2 safe, 0 not safe, 0 unchecked of 2 repos", and a repository list with both rows green. |
| Multi-root, one unresolved | Same as above, but one repo has no matching profile. | Aggregate badge is 🔴 NOT SAFE even though the other repo is individually SAFE — a safe repo never makes the workspace read green while another is unresolved. The unsafe repo's row shows its next-fix title. |
| Multi-root repo selection | In a multi-root workspace, click a row in the repository list. | Navigates to Review Details, which now shows a "Reviewing: `<repo name>`" header; **Fix Commit Identity** and Repo Memory now act on that repo, not whichever was previously selected. |
| Multi-root, duplicate folder | Add the same repo twice as separate workspace folders (e.g. via a symlink). | It appears once in the repository list, not twice. |
| Multi-root, linked worktree | Open a repo and its linked worktree (`git worktree add`) as two separate workspace folders. | Both appear as separate rows with independent status — a worktree on a different/protected branch can be NOT SAFE while the main worktree is SAFE. |
| Multi-root, non-repo folder | Add a plain (non-Git) folder to a multi-root workspace alongside a Git repo. | The non-Git folder doesn't appear in the repository list and doesn't affect the aggregate. |
| Copy Workspace Safety Summary | In a multi-root workspace with a mix of safe/unsafe repos, click **Copy Workspace Safety Summary**. | Preview tab shows one line per repo (name, SAFE/NOT SAFE, blocking reasons) — not each repo's full checklist or any Repo Memory notes. Also on the clipboard. |
| Non-selected repo goes stale-proof | In a multi-root workspace, select repo A (SAFE). In repo B (not selected/visible), switch to a protected branch or start a rebase directly in a terminal. | Within ~300ms of the change landing in `.git`, the workspace aggregate updates to NOT SAFE and repo B's row reflects it — without needing to click on repo B or manually rescan. |
| Status bar / click consistency | In a multi-root workspace with one repo SAFE (selected) and one NOT SAFE. | Status bar badge reads "Not Safe (…)"; clicking it shows a workspace-level message ("N of M repositories need attention"), never "Safe to work here" from the selected repo alone. |
| Status bar problem count includes unresolved repos | Make one repo's inspection fail (e.g. a repo with a Git binary/permission issue) while the rest are safe. | Status bar reads something like "Not Safe (1 unresolved)", not "Not Safe (0/N repos)" — unresolved repos count as problems too. |
| Working-tree edit nudges a rescan | In a multi-root workspace, edit and save a file in a non-selected repo so it now has uncommitted changes. | A rescan happens shortly after the save (via the save-document nudge), and the aggregate/repo list reflect the new dirty-tree warning without a manual rescan. |
| One repo's scan throws unexpectedly | (Developer scenario) Temporarily make one target's inspection throw an uncaught exception. | The other repos in the workspace still render normally in the repository list; only the failing repo shows as unresolved/NOT SAFE — the whole workspace scan must not reject and blank out every repo. |

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

Open **Review Details** and confirm it always shows all 6 capabilities, in
a fixed order (Commit Identity, Push Destination, Push Account, Branch
Policy, Repo State, Workspace Trust) — including ones that passed
("Confirmed") or don't apply ("Not applicable", shown dimmed) — not just a
filtered list of problems. Each card shows, in plain English:

- Capability label and state badge (Confirmed / Contradicted / Unverified
  / Warning / Not applicable)
- A **Blocks Safety** tag when (and only when) this specific result is
  the reason overall status is NOT SAFE
- Title
- Why it matters
- What we expected / what we found
- Any agent restrictions this finding implies
- A suggested action button
- An expandable **Technical Details** section with raw Git facts only

A separate "Other Notes" section below the checklist shows info notes
(Repo Memory reminder, Shield Mode) without a state badge.

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
   profile, status, branch, sections for Contradictions / Unverified facts
   / Warnings / Confirmed facts (whichever apply — `Not applicable` results
   never appear), and a "Rules for AI" section combining the fixed baseline
   (no push, don't change identity/remote/SSH/credentials) with any
   restrictions derived from this scan's findings (e.g. an in-progress
   rebase adds "don't switch branches").
3. With two findings that imply the same restriction (e.g. detached HEAD
   and an in-progress rebase, both implying "no commit"), confirm the
   restriction appears exactly once in the output, not duplicated.
4. Pin a memory note. With "Include pinned memory note in Copy Context for
   AI" **off** (default), confirm the preview shows a note explaining it
   was omitted, not the note text itself.
5. Turn the setting **on**, copy again, and confirm the pinned note text
   now appears under "User-approved pinned notes."
6. Confirm the output never includes secrets, tokens, `.env` values, SSH
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

`src/test/aiContext.test.ts` includes an automated invariant: for a range
of fixtures, every capability result with `blocksOverallSafety: true` must
be representable in the Copy Context model (as an issue entry or a derived
restriction). If a new blocking check is added to `statusEngine.ts` without
a corresponding Copy Context representation, that invariant test is the
one that should fail — extend its fixture list when adding new checks.
