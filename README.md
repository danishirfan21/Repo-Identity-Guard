# Repo Identity Guard

**"Am I safe to work, commit, push, and let an AI agent run commands in this
repo right now?"**

Repo Identity Guard is a local-first VS Code sidebar for AI-assisted
developers ("vibe coders") using tools like Claude Code, Codex, Cursor,
Copilot, or Antigravity. It hides Git identity, SSH, and push-setup
complexity behind one plain-English answer:

- 🟢 **SAFE**
- 🔴 **NOT SAFE**
- ⚪ **NOT CHECKED** — only shown when the folder isn't a Git repo yet

If anything important is ambiguous, missing, or unverified, Repo Identity
Guard calls it **NOT SAFE** rather than guessing.

This is not a Git GUI, a terminal replacement, a compliance dashboard, a
GitHub account manager, a credential manager, or a cloud product. Everything
it knows lives on your machine.

## What it checks

Every scan evaluates six **capabilities**. Each one always produces exactly
one result — never zero, never more than one — so Review Details is always
a complete checklist, not just a list of problems:

| Capability | Question it answers |
| --- | --- |
| **Commit Identity** | Who will appear as the author *and* committer of commits? |
| **Push Destination** | Where would a plain `git push` actually go? |
| **Push Account** | Can the account that authenticates the push be trusted? |
| **Branch Policy** | Is the current branch safe for this repo? |
| **Repo State** | Is there an unfinished merge/rebase/conflict, or just ordinary uncommitted changes? |
| **Workspace Trust** | Is this VS Code workspace trusted to run commands in? |

Repo Memory is shown too, but as a separate **info note** — it's context
data, not a safety verdict, so it never affects the SAFE/NOT SAFE result.
Shield Mode is deliberately not one of these six capabilities and never
alters the SAFE/NOT SAFE verdict — the safety engine that computes it has
no way to know Shield's state, since Shield's lifecycle is per-repository
and lives on disk, independent of this scan. Shield's own state IS shown
separately, though: Main's "Shield — &lt;state&gt;" summary card, the
dedicated Shield sidebar screen it links to, and the Settings → Shield
card all reflect the real, current OFF / ACTIVE / DEGRADED / BROKEN /
UNAVAILABLE state (see [docs/SHIELD_MODE.md](docs/SHIELD_MODE.md)). An
earlier build instead shipped a hard-coded "Shield Mode is not built
yet — nothing is enforcing this automatically" note that was shown even in
repositories where Shield was installed and actively blocking pushes; it
has been removed.

Each capability result carries one of five states — **Confirmed**,
**Contradicted**, **Unverified**, **Warning**, or **Not applicable** — plus
a separate `blocksOverallSafety` flag. The two are intentionally not the
same thing: an unverified push account only blocks SAFE when its profile
requires strict push setup, while a contradicted result (like being on a
protected branch) always blocks. Review Details shows the full state per
capability; Main only ever shows the binary SAFE/NOT SAFE headline built
from whichever results actually block.

Commit identity is read from Git's *effective* author/committer identity
(`git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`), which reflects any
environment-variable overrides — not just `git config user.name/email`.
Author and committer are checked and reported separately, since they can
diverge (e.g. mid-rebase). This still reflects the environment checked at
scan time; an explicit command-line override can always change what
actually gets used for a given commit.

If the *configured* identity (worktree/local/global config) already
matches the profile but the effective identity doesn't, that can only mean
an environment variable (`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL`, etc.) or
a command-line override is winning — Repo Identity Guard reports this as
its own **"Commit identity overridden by the environment"** result, with
no config-writing action offered, since writing config again wouldn't fix
it. **Fix Commit Identity** itself checks its own outcome: it writes
config, rescans, and only reports success once the commit-identity
capability is actually confirmed — if the environment is still overriding
it afterward, it says so instead of claiming a fix that didn't take.

**What "effective identity" does and doesn't cover:** `git var
GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` runs in the VS Code extension
host's own process, so this reflects that process's environment at the
moment of the scan — nothing more. It is not a guarantee about every
process that might create a commit in this repo. A separate integrated
terminal tab, an external AI agent process, a shell profile sourced only
in interactive shells, or a future `git commit --author=...`/`-c
user.email=...` can each carry a different environment or an explicit
override that this scan never saw and couldn't have. Treat a Confirmed
result as "this is what the extension host would use right now," not as
a promise about every other place a commit could originate from.

Repo Identity Guard matches the open repo against **Profiles** you define
(Work, Personal, one per freelance client, one per employer — as many as
you need) in Settings, in this order:

1. **Exact-repository override** (`Profile.exactRepos`, canonicalized as
   `host/owner/repo`, e.g. `github.com/AcmeSoftware/secret-project`) —
   always wins outright when present. This is how you pin one specific
   repo to a profile regardless of its owner, e.g. to resolve a
   fork/upstream conflict (see below).
2. **Owner/org pattern** (`Profile.expectedRemoteOwners`) matched against
   the repo's `origin` remote.
3. **Unresolved** — treated as **NOT SAFE**, "Repo profile is unknown,"
   with a one-click **Add Profile for This Repo**.

If a repo's owner matches *more than one* profile at the same tier (e.g.
two clients' owner patterns overlap, or two profiles claim the same exact
repo), that's also **NOT SAFE** — "Multiple profiles match this repo" —
rather than silently picking one. Saving a profile whose owners or exact
repos overlap with an existing one warns you immediately, before it ever
shows up as an unsafe repo.

**Fork/upstream conflicts:** if the repo has an `upstream` remote (the
conventional name for the repo a fork was created from) and its owner
unambiguously implies a *different* profile than `origin`'s owner does —
e.g. your personal fork of a company repo — that's reported as **NOT
SAFE**, "Origin and upstream imply different profiles," rather than
silently trusting `origin`. `upstream` is only ever used as evidence for
this conflict check; it never wins a match by itself. **Assign This Repo**
resolves it by writing an exact-repository override to your chosen
profile.

## Multi-root workspaces

When a workspace has more than one Git repository open as separate folders
(or a repo plus a linked worktree), Repo Identity Guard evaluates each one
independently and rolls the results up conservatively, not with a plain OR:

- **SAFE** only when every detected repository has been checked and is SAFE.
- **NOT SAFE** when any repository is blocking, unresolved, or couldn't be
  checked reliably. A safe active repo never makes the workspace read green
  while another repo in the workspace is unresolved.
- **NOT CHECKED** only when no repositories have been evaluated, or none
  were detected.

Workspace folders that resolve to the same repo root are deduplicated;
linked worktrees always get their own entry, since branch and working-tree
state can differ between worktrees. A folder that isn't a Git repo is
excluded from the count entirely.

Capability results stay strictly scoped to the repository that produced
them — nothing here synthesizes a workspace-wide `CapabilityResult` by
mixing checks from different repos. The Main view shows an aggregate badge
and repo counts, followed by a repository list; each row selects that repo
for Review Details and for every mutating or executing action (Fix Commit
Identity, saved commands, Repo Memory) — there's always exactly one
selected repository, so no action ever runs against an ambiguous mix.
Single-repo workspaces look exactly as before; this extra UI only appears
once there's more than one repo to show.

**Copy Workspace Safety Summary** is a separate action from Copy Context
for AI: a compact per-repo SAFE/NOT SAFE line with blocking reasons and
restrictions for every repo in the workspace, not a combined dump of every
repo's full checklist or Repo Memory notes. Copy Context for AI still
describes only the currently selected repo, in full detail.

Every in-scope repo is watched for Git state changes (HEAD, config, index,
merge/conflict markers, rebase-in-progress), not only the currently
selected one — so a repo you're not looking at can't go unsafe without the
aggregate noticing. The status bar's own click action reflects the same
aggregate a multi-root badge shows; it never reports "safe" based on only
the selected repo while the badge itself reads Not Safe.

## Views

- **Main** — the SAFE / NOT SAFE / NOT CHECKED verdict is the single most
  prominent thing on screen, followed by repository / profile / branch
  identity, the one most important next action (with its fix as a primary
  button), a compact six-check grid, and secondary actions (Review
  Details, Repo Memory, Copy Context for AI). In a multi-root workspace,
  the dominant verdict shown here is always the workspace aggregate — a
  SAFE selected repository is never allowed to visually stand in for a
  NOT SAFE workspace — with the repository list underneath it so the
  unsafe repo is easy to find.
- **Review Details** — one card per capability, always in the fixed
  Commit Identity → Push Destination → Push Account → Branch Policy →
  Repo State → Workspace Trust order, each with its state badge, a
  "Blocks safety" indicator when applicable, Expected/Found, any agent
  restrictions, a suggested action, and raw Git facts tucked behind a
  collapsed "Technical Details" section.
- **Repo Memory** — pinned notes, general (multiline) notes, and saved
  commands (label + command + Run/Copy), stored locally and privately. See
  "Repo Memory" below for the full picture (editing, search, export/import,
  and exactly which repository a note belongs to).
- **Settings** — profiles as chip-based tabs with an owners/exact-repos/
  branch-pattern chip editor, a "Detect from current repo" prefill button,
  branch rules, safety preferences, and a Shield card showing the current
  lifecycle state with an "Open Shield" button to its own sidebar screen.
- **First-run onboarding** — shown automatically the first time you open
  Repo Identity Guard in a Git repository with no profiles configured yet.
  It shows the detected repository and your current effective Git
  identity, asks which profile (Personal/Work/Other) should use it and
  whether to scope that profile to this repository only (`exactRepos`) or
  every repository owned by the detected owner (`expectedRemoteOwners`),
  then creates the profile and rescans. There's no separate "have I
  onboarded" flag — it's shown whenever there are zero usable profiles and
  hidden the moment one exists.

### Theme support

The sidebar has no hardcoded colors. Every visual token it uses (surfaces,
borders, text, primary/error/warning accents) is a CSS custom property
derived from VS Code's own semantic theme variables (`--vscode-foreground`,
`--vscode-sideBar-background`, `--vscode-panel-border`,
`--vscode-button-background`, `--vscode-focusBorder`,
`--vscode-errorForeground`, `--vscode-editorWarning-foreground`, etc. — see
`src/webview/sidebar.css`), so it repaints correctly for dark, light, and
high-contrast themes with no separate light/dark CSS branches.

## Safe by design

Repo Identity Guard only ever runs read-only Git commands to inspect a repo,
with one exception: the **Fix Commit Identity** action, which is limited to

```text
git config --local user.name "<name>"
git config --local user.email "<email>"
git config --local --unset user.name
git config --local --unset user.email
```

It never modifies global Git config, remotes, SSH config, credential
managers, or keychains, and it never runs `push`, `push --force`,
`reset --hard`, `clean -fd`, `rebase`, or `merge`. Saved commands in Repo
Memory always run in a visible integrated terminal — never silently, and
never at all when the workspace isn't [trusted](#workspace-trust).

Fix Commit Identity resolves an explicit config scope before writing
anything, based only on whether `extensions.worktreeConfig` is on — not on
how many worktrees currently exist:

- Worktree config on → writes `git config --worktree`, even if this repo
  only has one worktree right now. That's necessary, not overcautious:
  when worktree config is enabled, Git reads `config.worktree` *after*
  the shared repo config and lets it override, so a stale value there
  would keep winning over a `--local` fix even with a single worktree.
- Worktree config off/unknown → writes `git config --local`. If more than
  one worktree is attached (checked via `git worktree list --porcelain`,
  not just whether the *current* one is linked — a main worktree can have
  others attached to it too), the confirmation dialog says plainly that
  this is shared across every worktree, not narrower.

The confirmation dialog always states which scope is about to be
written, and also names the repository and its local path alongside the
matched profile, so "this repo" is never ambiguous once more than one is
open in the same workspace. The strict "require identity to be locked
locally" preference (below) checks both scopes too, so it won't keep
reporting "not locked" after a worktree-scoped fix. Full per-worktree
config management isn't built — this is deliberately just an honest,
correctly-scoped mutation and warning before you confirm.

**Shield Mode** (local pre-commit, pre-merge-commit, AND pre-push Git
hooks that block unsafe commits and pushes — wrong identity, a protected
branch, detached HEAD, an in-progress merge/rebase, a push to a
destination or over a route that doesn't match what Shield approved for
this repo, or — for a strict GitHub SSH profile with `expectedGitHubLogin`
set — a route that authenticates live as the wrong GitHub account) is
opt-in — Shield checks safety either way, but only Shield actively blocks
unsafe operations. It has a dedicated sidebar screen (Main's "Shield —
<state>" summary, or Settings → Shield → "Open Shield") showing the real
OFF / ACTIVE / DEGRADED / BROKEN state per repository, an explicit Enable
Shield confirmation before anything is installed, and Check Health / Repair
Shield / Disable Shield actions — as well as the same `Repo Identity Guard:
Enable/Disable/Repair Shield` and `...: Check Shield Health` commands from
the Command Palette. Enforcement itself runs standalone (a POSIX shell
script Shield installs alongside both hooks) and works with VS Code
completely closed. A repository that already runs Husky, `pre-commit`, or
another hook manager is never silently overridden — by default Shield
simply won't install into an occupied hook slot (reported degraded), and
the Enable Shield screen shows the real choice up front: leave the
existing hook unchanged, or chain it (only offered when it's an executable
regular file Shield can preserve byte-for-byte and restore on disable — a
symlinked or non-executable hook is left completely untouched and reported
degraded with the reason, never converted into something Shield can
handle).

Shield's hooks **fail closed**: if a hook is installed but Shield's
evaluator is missing or unreadable, the commit or push is blocked with a
"broken Shield installation" message pointing at Repair Shield / Disable
Shield — never silently allowed. Disable Shield is correspondingly
complete: it removes every hook it owns (including at hooks directories a
later `core.hooksPath` change moved away from) *before* removing the
evaluator and policy, so a finished disable can never leave you blocked.

**Shield requires Git 2.31 or newer** — `git rev-parse --path-format`
(2.31) is what its hooks and evaluator use to find the repository, and
`pre-merge-commit` (2.24) is the only hook that covers a real merge
commit. On an older Git, Shield reports degraded and refuses to install
rather than claiming protection it cannot provide. This floor is
Shield-specific; the rest of the extension works against much older Git.

Full details — threat model, policy schema, worktree handling, the
evaluator, the installation lifecycle, hook coexistence, integrity
detection, and the Phase 8 correctness-hardening pass — are in
[docs/SHIELD_MODE.md](docs/SHIELD_MODE.md).

## Push setup: destination vs. account

Push safety is really two separate questions, and Repo Identity Guard
answers them separately instead of collapsing them into one claim:

- **Push destination** — where would a plain `git push` actually go? This
  follows Git's own resolution order (`branch.<name>.pushRemote` →
  `remote.pushDefault` → `branch.<name>.remote` → `origin`), not just
  `origin`'s fetch URL. If it resolves to an owner that doesn't match the
  matched profile (e.g. a branch's push remote points at an upstream fork),
  that's **NOT SAFE** — "Push destination does not match `<Profile>`". If it
  can't be resolved at all, that's **NOT SAFE** too — "Push destination is
  not verified" — regardless of any profile's strictness setting, because
  an unresolved destination isn't a judgment call.
- **Push account** — once the destination is confirmed, can we tell which
  *route* a push would authenticate through? HTTPS (credential manager), an
  unrecognized protocol, and a well-known generic SSH host (`github.com`,
  `gitlab.com`, `bitbucket.org`) are always reported as "Push account is
  unverified" — there's no configuration that upgrades those. A custom SSH
  host alias (e.g. `github-work`, from a `~/.ssh/config` `Host` entry) is
  **never** auto-trusted just for being non-generic: it only reads as a
  trusted route ("Push route trusted") when the *matched* profile
  explicitly lists it in `trustedSshHostAliases`. An alias trusted under a
  different profile (e.g. `github-personal` under Personal) still shows as
  unverified when evaluated against Work. Whether an unverified route is
  **NOT SAFE** or just a warning depends on the profile's **Strict push
  setup** setting. None of this is ever phrased as verifying the account —
  a trusted route is explicitly "not cryptographic proof of the remote
  account," only ever "trusted by profile configuration."

## Copy Context for AI

One click copies a summary for pasting into an AI agent's context, built
from the *same* capability results Review Details shows — not a separate,
independently-maintained rule list, so the two can't silently drift apart.
Each capability's state is translated into an operational section:

- **Contradictions** — capability results with positive evidence of a
  problem (wrong identity, wrong push destination, protected branch, etc.)
- **Unverified facts** — things that couldn't be checked (unknown profile,
  unresolved push destination, unverified push account)
- **Warnings** — non-blocking findings (uncommitted changes, identity only
  safe via global config)
- **Confirmed facts** — what passed
- **Rules for AI** — a fixed baseline (no `git push`, no changing Git
  identity/remotes/SSH/credentials) plus restrictions *derived* from this
  scan's specific findings (e.g. an in-progress rebase adds "don't switch
  branches" and "don't commit"; a protected branch adds "ask before
  committing here"), deduplicated when multiple findings imply the same
  restriction

`Not applicable` results are omitted entirely. Every finding that blocks
overall safety is guaranteed to show up here — as an issue or as a derived
restriction — checked by an automated test, not just by convention.

It never includes secrets, tokens, `.env` values, SSH key contents, or raw
Git config — the fields copied are an explicit allowlist, not a best-effort
filter. The exact text is always opened in a preview tab so you can check
it before pasting anywhere, in addition to being copied to the clipboard.
Your pinned Repo Memory note is **not** included by default — it's free
text you wrote for yourself and may contain sensitive info. Turn on
"Include pinned memory note in Copy Context for AI" in Settings if you want
it included.

## Repo Memory

A small, deliberately simple local notebook per repository — not Notion, not
a Markdown knowledge base, not a task manager, and not synced anywhere.

- **Where it lives.** Entirely in this VS Code install's own local, private
  extension storage (`ExtensionContext.globalState`) — never a file inside
  the repository, so a note can never be accidentally committed, pushed, or
  seen by anyone you share the repo with. It is **local to this machine and
  this VS Code profile/install**: notes don't follow you to another machine,
  another VS Code profile, or Settings Sync, unless you explicitly export
  and import them (see below).
- **Notes vs. saved commands — different scope.** A note is about the
  *repository*: every linked worktree of the same repo (`git worktree add`)
  shares the same notes, because they're the same repository regardless of
  which checkout happens to be open. A saved command is about the
  *checkout*: each worktree keeps its own saved commands, since the working
  directory layout and what actually makes sense to run can genuinely
  differ between worktrees of the same repo.
- **If a repository moves or is re-cloned.** Repo Memory keys off the
  repository's real, canonicalized location (resolving symlinks, and
  normalizing Windows path casing, the same way multi-root repository
  detection does) — a symlinked or differently-cased path to the SAME
  on-disk repo still finds its notes. Moving a repo to a genuinely
  different path, or cloning it fresh elsewhere, does **not** automatically
  carry notes over (there is no reliable way to prove two folders are "the
  same repository" from a remote URL alone without risking silently merging
  two unrelated clones that happen to share one) — use Export from the old
  location and Import into the new one instead.
- **Editing.** Every note supports Edit → change the text → Save, or
  Cancel to leave the stored note untouched. Editing preserves the note's
  id, its original created date, and its pinned state; it records an edited
  date only once the text has actually changed.
- **Multiline.** The note composer is a small multiline text box — line
  breaks are preserved everywhere a note appears (list, edit box, export,
  and the pinned note's Copy Context for AI preview). Plain text only, by
  design: no Markdown/HTML rendering.
- **Pinning.** At most one note per repository can be pinned at a time —
  pinning a different note automatically unpins the previous one. A pinned
  note is the only one ever eligible for Copy Context for AI, and even then
  only once you opt in (see above) — every other note, and every saved
  command, is never included there.
- **Search.** Once a repository has more than a couple of notes, a search
  box filters them by a case-insensitive substring match — entirely local
  to the webview (nothing is sent anywhere, and nothing is remembered
  between sessions).
- **Deleting.** Removing a note or saved command asks for a one-click
  confirmation first; pinning/unpinning never does, since it's harmless and
  instantly reversible.
- **Limits.** Notes and saved commands have generous but real size/count
  ceilings (4,000 characters per note, 200 notes per repository; 200
  characters / 2,000 characters / 200 saved commands per checkout) meant
  for genuine development notes, not unlimited free-form storage — a new
  add or edit that would go over a limit is rejected outright with a
  clear message, never silently truncated. These limits apply only to
  NEW adds and edits: a note or repository that already had more text or
  more entries than these limits before they existed keeps every
  character and every entry exactly as it was — nothing is retroactively
  trimmed. Saving an over-limit note unchanged (e.g. just opening and
  closing its editor) is always a harmless no-op; shrinking it back under
  the limit is a normal edit.
- **Export / Import.** Export writes the current repository's memory (or,
  from the same menu, every detected repository's memory) to a JSON file
  you choose the location for. Import reads a JSON file back in and always
  validates it first. If the file holds more than one repository's memory
  (an "Export all" file), Import asks you which ONE of those repositories
  to bring into the repository you currently have open — it never merges
  every repository in the file together automatically. Either way, Import
  then shows exactly what it's about to do (how many notes/commands,
  which ones already exist here) before touching anything, and never
  overwrites an existing note or command sharing an id unless you
  explicitly choose to; overwriting keeps this repository's own pinned
  decision rather than letting the import silently change it. An import
  containing a note/command over today's size limits is rejected outright
  with a clear message — never truncated to fit — and importing more
  entries than this repository's count limit allows is rejected the same
  way, changing nothing. A saved command coming from an import is inert
  data like any other field — it is never executed automatically.
- **Unsaved drafts.** A note you're typing or editing survives an
  unrelated background refresh (a file save, a branch switch, a routine
  rescan) without being wiped — it's only cleared once the extension has
  actually confirmed the save succeeded. If a save is rejected (e.g. over
  a length limit), your text and the open editor stay exactly as you left
  them so nothing you typed is lost.
- **Two windows, one profile.** Repo Memory's per-save-safety guarantees
  hold within a single VS Code window. If you have the *same* VS Code
  profile open in two windows at once and edit Repo Memory in both around
  the same moment, the version saved last can still overwrite the other —
  this is a limitation of `ExtensionContext.globalState`, the storage API
  VS Code extensions are given, which has no cross-window change
  notification or atomic compare-and-swap. Editing the same repository's
  memory from two windows at once isn't a supported workflow; if you do,
  treat Export as your safety net.

## Workspace Trust

Read-only scanning still runs in an untrusted workspace — you'll see an
honest NOT SAFE with "Workspace is not trusted" rather than nothing at all.
Viewing, searching, and exporting Repo Memory all keep working too, since
none of them change anything. But adding, editing, deleting, or pinning a
note; adding, deleting, or running a saved command; and importing Repo
Memory are all blocked until the workspace is trusted, since Repo Identity
Guard treats a memory mutation the same as any other write or execution in
that folder. The sidebar disables those specific controls (with a title
explaining why) rather than letting you click them and then fail.

## Privacy & Security

Repo Identity Guard sends nothing anywhere on its own: no telemetry, no
analytics, no "phone home" of any kind, and no network requests except the
ones YOU already make — the ordinary `git`/`ssh` connections a real push
makes, or Shield's local `ssh -G`/`ssh -T` route-verification probe (see
[docs/SHIELD_MODE.md](docs/SHIELD_MODE.md)'s Phase 5 section) would make
anyway. Everything it reads (Git config, remotes, SSH config, commit
identity) and everything it can write (`user.name`/`user.email` at
`--local`/`--worktree` scope, and Shield's own Git hooks when you enable
it) stays on your machine, in the repositories you point it at. Profiles,
protected branches, and preferences live in VS Code's own `settings.json`,
not a separate account or cloud store. Nothing here has been audited by a
third party — read the source, it's small enough to.

## Settings

Configure profiles, protected branches, and preferences either from the
Settings view in the sidebar, or directly in `settings.json`:

```json
{
  "repoIdentityGuard.profiles": [
    {
      "id": "work",
      "label": "Work",
      "gitName": "Jane Doe",
      "gitEmail": "jane@acme.com",
      "expectedRemoteOwners": ["AcmeSoftware"],
      "exactRepos": ["github.com/some-other-org/one-specific-repo"],
      "expectedBranchPatterns": ["feature/*", "fix/*"],
      "strictPushSetup": true,
      "trustedSshHostAliases": ["github-work"]
    },
    {
      "id": "personal",
      "label": "Personal",
      "gitEmail": "jane@example.com",
      "expectedRemoteOwners": ["jane-doe"],
      "trustedSshHostAliases": ["github-personal"]
    }
  ],
  "repoIdentityGuard.protectedBranches": ["main", "master"],
  "repoIdentityGuard.requireLocalIdentity": false,
  "repoIdentityGuard.includeMemoryInAiContext": false
}
```

`expectedRemoteOwners`, `exactRepos`, and `expectedBranchPatterns` all
support `*` wildcards and are matched case-insensitively. `exactRepos`
always takes precedence over `expectedRemoteOwners` for the same repo.
`trustedSshHostAliases` is matched case-insensitively but does **not**
support wildcards — it's an exact list of SSH host aliases (e.g. `Host`
entries from `~/.ssh/config`) this profile vouches for as push routes; a
custom alias not listed here always reads as unverified, even under a
strict-looking name, and an alias listed under a *different* profile never
carries over. `protectedBranches` is a **local** branch policy Repo
Identity Guard enforces on this machine — it is not synced with, and does
not check, GitHub's own branch protection settings.

## Commands

- **Repo Identity Guard: Rescan**
- **Repo Identity Guard: Show Status**
- **Repo Identity Guard: Fix Commit Identity**
- **Repo Identity Guard: Add Profile for Current Repo**
- **Repo Identity Guard: Copy Context for AI**
- **Repo Identity Guard: Copy Workspace Safety Summary**
- **Repo Identity Guard: Open Settings**

## Run locally

1. Run `npm install`.
2. Run `npm run compile`.
3. Open this project in VS Code or Antigravity.
4. Press `F5` to launch the Extension Development Host.
5. In that window, open a Git repository and open the **Repo Identity
   Guard** icon in the Activity Bar.

See [TESTING.md](TESTING.md) for the manual scenario matrix.

## Limitations in this build

- **Shield cannot see a clean cherry-pick or revert.** Git commits those
  (when there's no conflict to resolve) via an internal fast path that
  invokes no commit hook at all — not specific to Shield, and not fixable
  by any local hook. A conflicting cherry-pick/revert finalized via
  `--continue` runs a normal `git commit` and IS enforced. See
  docs/SHIELD_MODE.md's Phase 7 section.
- **`--no-verify` and a `core.hooksPath` override bypass Shield entirely.**
  This is Git's own documented hook-bypass mechanism, not a Shield defect
  — no client-side hook tool can prevent it. Shield's promise is blocking
  ordinary accidental unsafe operations, not containing a process acting
  with intent to bypass a local hook. Anything with arbitrary local shell
  access is likewise outside the boundary: it can rewrite Shield's own
  artifacts or shadow `git`/`ssh` on `PATH`.
- **Shield requires Git 2.31+.** Below that it reports degraded and
  refuses to install, rather than reporting active while enforcing
  nothing. Shield-specific; the rest of the extension is unaffected.
- **HTTPS remotes cannot have their account verified.** Strict
  `expectedGitHubLogin` verification relies on GitHub's SSH
  self-identification; there is no local equivalent over HTTPS, so such a
  route reads as unverified under a strict profile.
- **Fork detection is naming-convention-based, not verified.** The
  fork/upstream conflict check only looks for a remote literally named
  `upstream` — there's no reliable way to detect a fork relationship from
  Git alone. A fork set up with a differently-named remote won't trigger
  the conflict check.
- **Multi-root repo discovery starts with workspace folders.** Repos are
  found from `vscode.workspace.workspaceFolders` — Repo Identity Guard
  doesn't recursively crawl nested directories looking for `.git` folders
  that aren't themselves workspace folders (e.g. repos several levels deep
  inside one open folder, never added as their own workspace folder).
- **No cryptographic account verification, anywhere.** The ordinary
  sidebar safety check never makes a network call — "Push account is
  unverified" never upgrades to "verified" there, and SSH host aliases are
  trusted from your own profile configuration, not checked. Shield Mode's
  optional strict `expectedGitHubLogin` setting is the one exception that
  makes a real network call (`ssh -T` against the resolved host, at push
  time) to read back GitHub's own SSH login banner — but that is GitHub's
  self-reported username, not a cryptographic proof of identity; a
  malicious or compromised host could in principle answer with fabricated
  output. See docs/SHIELD_MODE.md's Phase 5 section for the exact
  boundary.
- **Worktree config isn't fully modeled.** Fixing identity on a linked
  worktree shows a warning about scope (this worktree vs. every worktree)
  based on `extensions.worktreeConfig`, but doesn't manage per-worktree
  config for you.
- It does not switch GitHub CLI accounts, switch SSH keys, manage HTTPS
  credentials, or touch OS keychains/credential managers.
- It never runs `push`, `reset --hard`, `clean`, `rebase`, `merge`, or edits
  remotes/SSH config — those stay in your own terminal.
