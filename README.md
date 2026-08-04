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

Repo Memory and Shield Mode are shown too, but as separate **info notes** —
they're context data and feature-availability metadata, not safety
verdicts, so they never affect the SAFE/NOT SAFE result.

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

## Views

- **Main** — compact status, matched profile, issue count, next fix, one
  pinned memory note, and quick actions.
- **Review Details** — the full six-capability checklist in plain English
  (why it matters, what we expected, what we found, and any agent
  restrictions that follow from it), with raw Git facts tucked behind an
  expandable "Technical Details" section.
- **Repo Memory** — pinned notes, general notes, and saved commands (label +
  command + Run/Copy), stored locally and privately.
- **Settings** — profiles, branch rules, and safety preferences.

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

Fixing commit identity on a repo that's a linked Git worktree shows an
extra warning first: depending on whether `extensions.worktreeConfig` is
on for that repo, the change may affect only this worktree or every
worktree attached to it. Full per-worktree config management isn't built —
this is deliberately just an honest warning before you confirm.

**Shield Mode** (local Git hooks that would block unsafe commits/pushes) is
not built yet. There is no toggle for it — a disabled "Coming soon" card in
Settings makes that explicit, rather than showing a switch that looks live
but does nothing (see Limitations).

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
  account will actually authenticate? HTTPS (credential manager) and a
  generic SSH host (`github.com` with no dedicated alias) can't be
  confirmed locally, so they're reported as "Push account is unverified."
  Whether that's **NOT SAFE** or just a warning depends on the profile's
  **Strict push setup** setting. This is never phrased as verifying the
  account — only ever "trusted from your profile configuration."

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

## Workspace Trust

Read-only scanning still runs in an untrusted workspace — you'll see an
honest NOT SAFE with "Workspace is not trusted" rather than nothing at all.
But **Fix Commit Identity** and running a saved command are both blocked
until the workspace is trusted, since both execute something in that
folder.

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
      "strictPushSetup": true
    },
    {
      "id": "personal",
      "label": "Personal",
      "gitEmail": "jane@example.com",
      "expectedRemoteOwners": ["jane-doe"]
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
`protectedBranches` is a **local** branch policy Repo Identity Guard
enforces on this machine — it is not synced with, and does not check,
GitHub's own branch protection settings.

## Commands

- **Repo Identity Guard: Rescan**
- **Repo Identity Guard: Show Status**
- **Repo Identity Guard: Fix Commit Identity**
- **Repo Identity Guard: Add Profile for Current Repo**
- **Repo Identity Guard: Copy Context for AI**
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

- **Shield Mode is not built.** No Git hooks are installed, and there is no
  toggle that could be mistaken for one — just a disabled "Coming soon"
  card. That's intentionally left as clean, opt-in-only architecture for a
  later pass.
- **Fork detection is naming-convention-based, not verified.** The
  fork/upstream conflict check only looks for a remote literally named
  `upstream` — there's no reliable way to detect a fork relationship from
  Git alone. A fork set up with a differently-named remote won't trigger
  the conflict check.
- **Single active repo per window.** A multi-root workspace with more than
  one Git repository only reflects whichever repo the active editor (or
  first workspace folder) belongs to — it doesn't yet aggregate status
  across every repo in the workspace.
- **No cryptographic account verification.** "Push account is unverified"
  never upgrades to "verified" — Repo Identity Guard doesn't make network
  calls (e.g. an SSH test connection) to confirm which account a key or
  credential belongs to. SSH host aliases are trusted from your own profile
  configuration, not cryptographically checked.
- **Worktree config isn't fully modeled.** Fixing identity on a linked
  worktree shows a warning about scope (this worktree vs. every worktree)
  based on `extensions.worktreeConfig`, but doesn't manage per-worktree
  config for you.
- It does not switch GitHub CLI accounts, switch SSH keys, manage HTTPS
  credentials, or touch OS keychains/credential managers.
- It never runs `push`, `reset --hard`, `clean`, `rebase`, `merge`, or edits
  remotes/SSH config — those stay in your own terminal.
