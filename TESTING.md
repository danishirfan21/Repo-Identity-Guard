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
| Fix Commit Identity postcondition check survives a concurrent watcher-triggered scan | Trigger **Fix Commit Identity** in a multi-root workspace at the same moment another repo's watcher fires a rescan (e.g. switch branches in another repo right as you confirm the dialog). | The success/warning message still reflects *this* repo's actual post-write state, not a stale result from a scan that got superseded by the concurrent one. |
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
| Trusted SSH host alias | Profile's `trustedSshHostAliases` includes `github-work`; push remote is `git@github-work:AcmeSoftware/repo.git`. | "Push route trusted" — **Confirmed** state, non-blocking; summary explicitly says this is not cryptographic proof of the remote account. |
| Untrusted-looking custom alias | Push remote is `git@github-work:AcmeSoftware/repo.git`, but the *matched* profile's `trustedSshHostAliases` is empty or doesn't include `github-work`. | "Push account is unverified" — a dedicated-looking alias name must **not** be auto-trusted just for being non-generic. Blocking iff `strictPushSetup: true`. |
| Alias trusted only under a different profile | `github-personal` is listed in Personal's `trustedSshHostAliases` but not Work's; the repo matches Work and pushes through `github-personal`. | "Push account is unverified" when evaluated against Work — an alias's trust never carries over from a profile that didn't match. |
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
| Shield Mode card | Open Settings. | A plain "Shield Mode" note saying it provides optional local Git-hook enforcement and that the controls are in the Command Palette. No checkbox, no toggle, and no claim that Shield does not exist. |
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
5. Confirm the "Shield" card shows the current lifecycle badge (OFF /
   ACTIVE / DEGRADED / BROKEN / UNAVAILABLE) and an "Open Shield" button
   that navigates to Shield's own sidebar screen (Enable/Disable/Repair/
   Check Health there) — no "coming soon"/"not built yet" wording, and no
   claim that Shield's only controls are the Command Palette (the
   equivalent Command Palette commands still exist and call the same code
   paths, but are not the only way in).

### Refresh behavior

Confirm status updates after:

- changing profiles, protected branches, or preferences in Settings;
- editing repo-local Git config with `git config --local`;
- editing global Git config with `git config --global`;
- switching the active editor between repositories;
- pinning/unpinning a Repo Memory note;
- granting Workspace Trust to a previously untrusted folder.

## Shield Mode Phase 5: verified GitHub SSH account binding (manual, real GitHub)

Everything above (and `src/test/shieldGitHubAccountBinding.test.ts`) uses
a mocked SSH transport by design — CI never contacts real GitHub. The
scenarios below are the only place this feature is meant to be exercised
against the real thing, and they require two real GitHub accounts (a
"work" and a "personal" one) each with their own SSH key, since that's
the exact situation Phase 5 exists for. Do this on a machine you don't
mind adding temporary SSH config/keys to, and remove them afterward if
they're just for this test.

### One-time setup

1. Generate two SSH keys if you don't already have them, one per account:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_work -C "work"
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_personal -C "personal"
   ```
   Add each public key to the matching GitHub account (Settings → SSH and
   GPG keys) on github.com.
2. Add two aliased `Host` entries to `~/.ssh/config`:
   ```
   Host github-work
     HostName github.com
     User git
     IdentityFile ~/.ssh/id_ed25519_work
     IdentitiesOnly yes

   Host github-personal
     HostName github.com
     User git
     IdentityFile ~/.ssh/id_ed25519_personal
     IdentitiesOnly yes
   ```
3. Confirm both work *before* involving Shield at all:
   ```sh
   ssh -T git@github-work       # expect: Hi <work-username>! ...
   ssh -T git@github-personal   # expect: Hi <personal-username>! ...
   ```
   The first time you run each, you may be prompted to accept github.com's
   host key — accept it once, interactively, here (not through Shield).
4. Create (or reuse) a profile with `expectedGitHubLogin` set to your
   work account's actual GitHub username, `trustedSshHostAliases:
   ["github-work"]`, and `strictPushSetup: true`.
5. In a real repo cloned via `git@github-work:<owner>/<repo>.git`, run
   "Repo Identity Guard: Enable Shield" (or Repair, if already enabled).

### Scenarios

| Scenario | Setup | Expected |
| --- | --- | --- |
| Correct account | Push normally over `origin` (pointing at `github-work`). | Push succeeds; no Shield output. |
| Wrong account, same repo | Temporarily set `git remote set-url origin git@github-personal:<owner>/<repo>.git` (assuming your personal account also has access, or just watch it fail push-account-mismatch before it would even reach GitHub's own permission check) and push. | `PUSH BLOCKED` — `push-account-mismatch`, naming both the expected and the actually-authenticated login. |
| `IdentitiesOnly` removed | Comment out `IdentitiesOnly yes` under the `github-work` alias in `~/.ssh/config`, push. | `PUSH BLOCKED` — `push-account-unverified`, mentioning `IdentitiesOnly`. No network probe should even be attempted (you can confirm this by watching for a network delay — there shouldn't be one). Restore the config line afterward. |
| Unknown host key | Remove github.com's entry from `~/.ssh/known_hosts` (`ssh-keygen -R github.com`), push. | `PUSH BLOCKED` — `push-account-unverified`, telling you to verify the host key fingerprint manually. Confirm Shield did **not** silently add the host key itself — check `known_hosts` is still missing the entry afterward. Then verify manually (`ssh -T git@github-work`, accept the prompt) and push again to confirm it now passes. |
| ssh-agent has both keys loaded, alias correct | `ssh-add ~/.ssh/id_ed25519_personal` (loading the WRONG key into the agent) while `IdentitiesOnly yes` is still set on the alias, push. | Push still authenticates as the **work** account — `IdentitiesOnly yes` is exactly what prevents the agent's other loaded key from being offered. This is the scenario the `identities-not-isolated` check exists to make provable, not just hoped-for. |
| Network unreachable | Disconnect networking (or block outbound port 22 with a firewall rule) and push. | `PUSH BLOCKED` — `push-account-unverified` (timeout), within roughly `REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT` seconds (default 5) — the push should not hang indefinitely. |
| Non-strict profile | Set `strictPushSetup: false` on the profile (keep `expectedGitHubLogin` set), push from the wrong account. | Push succeeds — account verification never runs under a non-strict profile, by design. |
| `--no-verify` | Push from the wrong account with `git push --no-verify`. | Push succeeds — documented, expected bypass, not a Phase 5 gap. |
| HTTPS remote | Point `origin` at `https://github.com/<owner>/<repo>.git` instead, with the same strict profile and `expectedGitHubLogin` set. | `PUSH BLOCKED` — `push-route-unverified` (HTTPS message), not an account-specific reason. Confirms HTTPS never even reaches account verification in this phase. |

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

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run compile`, and
`npm test` on every PR and push to `main` — the automated result is
independently enforced on GitHub, not only self-reported.

## First-run onboarding

| Scenario | Setup | Expected |
| --- | --- | --- |
| No profiles, Git repo open | Remove all entries from `repoIdentityGuard.profiles`, open a folder that is a Git repo. | Onboarding view appears automatically instead of Main: repository found (canonical `host/owner/repo`, when a remote exists), current effective Git identity, profile-name choice (Personal/Work/Other), and scope choice (this repository only / repositories owned by `<owner>`). |
| No profiles, no remote configured | Same as above, but the repo has no `origin` remote. | Onboarding still appears; "Repository Found" explains there's no remote to detect, and "this repository only" scope is disabled since there's no canonical repo key to pin to yet. |
| No profiles, not a Git repo | Open a plain folder with no `.git`. | Onboarding does **not** appear — Main shows the ordinary NOT CHECKED state instead. |
| Create Profile & Check Repository | From onboarding, pick a profile name and scope, click the CTA. | A profile is saved via the same configuration path Settings uses (`repoIdentityGuard.profiles`), the repo rescans, and the view transitions immediately to the real Main view (SAFE/NOT SAFE per the new profile match). |
| Profiles already exist | Add at least one profile, reopen the sidebar. | Onboarding never appears — Main renders directly, even for a brand-new repo that doesn't match any profile yet (that repo instead shows "Repo profile is unknown" in the ordinary NOT SAFE flow). |

## Theme support

| Scenario | Setup | Expected |
| --- | --- | --- |
| Dark theme | Use a built-in dark theme (e.g. Dark+). | Sidebar matches the editor's dark palette; no washed-out or mismatched colors. |
| Light theme | Switch to a built-in light theme (e.g. Light+). | Sidebar repaints to light colors automatically — text stays legible, borders and status colors remain visible. No separate configuration needed. |
| High contrast | Switch to a high-contrast theme. | Borders and focus outlines remain visible; badges and the verdict banner stay legible. |
| Narrow widths | Resize the sidebar to roughly 240px, 280px, 320px, and 360px. | No horizontal scrollbar/overflow at any width; the verdict, next action, and primary buttons stay usable; long repo/profile/branch names truncate rather than overflow; secondary text wraps instead of clipping illegibly. |

## Extension Host / manual test matrix

The automated suite only covers pure logic (`core/`, most of `services/`)
— `extension.ts`, `statusBar.ts`, and the webview itself need a real
Extension Development Host (`F5`). Before a broader release, run through
this matrix there, beyond the scenario-by-scenario tables above:

- A Windows local repository (path separators, line endings, `git worktree`
  output parsing).
- Worktree config on/off, tried from both the main worktree and a linked
  one.
- A non-selected repo in a multi-root workspace changing state (branch
  switch, new conflict, identity edit) while another repo is selected.
- An environment override (`GIT_AUTHOR_EMAIL`, etc.) already present when
  VS Code itself starts, not just set mid-session.
- Workspace Trust disabled from a cold start.
- Remote SSH, WSL, and Dev Containers — where the extension host's own
  process environment (and thus `git var`'s effective identity) can differ
  from what a user expects based on their local shell.
- Saved-command execution and repository selection together — running a
  saved command in the repo you just switched to via the repository list,
  not the previously selected one.
- Watcher freshness during live branch switches, conflicts, and rebases
  started outside VS Code (a terminal, another tool) while the sidebar is
  open.

## Shield Mode: manual Windows matrix (Extension Host + Git Bash + PowerShell)

CI now runs the automated suite on `windows-latest` (see `.github/workflows/ci.yml`),
which proves the hook shims and evaluator run correctly under the `sh.exe`
Git for Windows puts on `PATH` there. It does **not** prove the Extension
Host / VS Code UI side behaves, or that a real user's shell of choice
(PowerShell, Git Bash, cmd.exe) sees consistent results. Run this matrix by
hand on a real Windows machine before calling Shield ready for anyone else
to use there:

| Scenario | Setup | Expected |
| --- | --- | --- |
| Enable Shield from VS Code, commit from PowerShell | Run "Enable Shield" from the Command Palette in a Windows VS Code window, then open a PowerShell terminal (integrated or external) in the same repo and run `git commit`. | Blocked/allowed exactly as the automated suite predicts; a block's message renders readably in PowerShell (no mangled line endings, no missing color/formatting causing unreadable output). |
| Enable Shield from VS Code, commit from Git Bash | Same as above but from a Git Bash terminal. | Same result as PowerShell — the hook itself doesn't know or care which shell invoked `git`; this is a regression check that nothing about hook installation assumed one shell's quoting/escaping. |
| Enable Shield from VS Code, commit from cmd.exe | Same, from `cmd.exe`. | Same result again. |
| Push from each of the three shells | Configure a strict profile with a trusted SSH alias (a real `~/.ssh/config` entry, or Windows's `%USERPROFILE%\.ssh\config`), push from PowerShell, Git Bash, and cmd.exe in turn. | Consistent allow/block across all three — push route/account evaluation must not depend on which shell launched `git push`. |
| Real GitHub SSH account verification, Windows OpenSSH vs. Git for Windows' bundled ssh | Set `expectedGitHubLogin` on a strict profile pointed at a real personal GitHub SSH alias (see the "Manual GitHub SSH account verification" scenarios below/in the Phase 5 section), once using Windows' built-in OpenSSH client (`ssh.exe` from `C:\Windows\System32\OpenSSH`) and once using the `ssh.exe` that ships with Git for Windows, whichever the ambient `PATH` picks up first. | Both resolve the same account for the same alias; if `PATH` ordering ever picks the "wrong" ssh, verify Shield reports `push-account-unverified` rather than a wrong-but-confident answer. |
| Line-ending sanity | Diff Shield's installed hook files (`.git/hooks/pre-commit`, `pre-merge-commit`, `pre-push`) as raw bytes after installing from a Windows VS Code session. | LF line endings throughout (no CRLF), even though the surrounding repo/workspace may have `core.autocrlf` set — a CRLF-mangled shebang line (`#!/bin/sh\r`) would silently break the hook on some `sh` builds. |
| Executable bit on NTFS | After "Enable Shield" on Windows, inspect the hook files' permissions. | Git for Windows' own `sh.exe` shim mechanism runs the hook regardless of NTFS's lack of a real POSIX executable bit — confirm the hook actually fires (it does not silently no-op) rather than assuming Unix permission semantics apply. |
| `core.hooksPath` / worktree scenarios on Windows | Repeat a couple of `shieldGitTopology.test.ts`/`shieldCoexistenceAndIntegrity.test.ts` scenarios (a linked worktree, a worktree-scoped `core.hooksPath`) by hand on Windows. | Same behavior as the automated Linux/macOS runs — this is a spot-check that Windows path handling (drive letters, backslashes in `git rev-parse --path-format=absolute` output) doesn't quietly break hook resolution. |
| Merge commit and cherry-pick on Windows | Reproduce the Phase 7 merge-commit fix (`pre-merge-commit`) and the documented clean-cherry-pick gap by hand. | Same results as the automated suite: a mismatched-identity merge is blocked; a clean cherry-pick is not (documented gap, not a Windows-specific difference). |
| Two SSH clients installed on Windows | With BOTH Windows' built-in OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`) and Git for Windows' bundled one on PATH in some order, enable Shield on an SSH-alias remote, then push. | Either it works normally, or a genuinely-unchanged destination is (safely) reported as changed/degraded — never silently allowed against the wrong resolved endpoint. See docs/SHIELD_MODE.md's "Windows: two SSH resolution paths" section for why this can happen and why it can only fail closed, never open. |

None of the above are automated — Windows CI proves the shell scripts
execute correctly under Git for Windows' `sh.exe`; it says nothing about
the Extension Host UI, VS Code's own terminal integration, or a real
user's day-to-day shell. Treat this table as a standing manual checklist
for future changes to Shield's Windows-facing code, not a one-time
verification.
