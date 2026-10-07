# Repo Identity Guard

Repo Identity Guard does exactly two things for the Git repositories you
open in VS Code:

1. **Identity lock.** You explicitly assign an identity (for example
   *Work* or *Personal*) to a repository. From then on, commits in that
   repository whose author or committer is not that identity are blocked —
   and, if the identity names a GitHub login, pushes that do not
   authenticate to GitHub as that account are blocked too. It is enforced
   by local Git hooks, so it applies in every terminal, Git GUI and AI
   coding agent, even with VS Code closed.
2. **Private notes.** A small plain-text notebook per repository, stored
   in VS Code's local extension storage — never in the repository, never
   committed, never synced, and never executed.

That is the whole product.

## What it deliberately does not do

- **It never touches a repository you have not assigned an identity to.**
  No hooks, no files, no Git config changes, no blocked commits or pushes.
  An unassigned repository behaves exactly as if the extension were not
  installed (apart from notes, if you write some).
- **It never assigns an identity for you.** There is no matching of
  repositories to identities by remote owner, organization, URL pattern,
  folder name, or "similar" repositories. Every lock is one explicit
  action by you, for one repository.
- It does not judge whether a repository is "safe", does not police
  branches, merges, rebases, dirty working trees or push destinations,
  does not generate context for AI tools, and does not run saved commands.
- It does not manage SSH keys, credentials, keychains, the GitHub CLI or
  your global Git config.
- It sends nothing anywhere: no telemetry, no analytics, no accounts. The
  only network connections it ever makes are the `ssh -T` account checks
  described below.

## Identities

Identities live in your **user** settings (`repoIdentityGuard.identities`;
a workspace's `.vscode/settings.json` can never define or change one). An
identity on its own does nothing.

```json
{
  "repoIdentityGuard.identities": [
    {
      "id": "work",
      "label": "Work",
      "gitName": "Jane Doe",
      "gitEmail": "jane@acme.example",
      "expectedGitHubLogin": "jane-acme",
      "trustedSshHostAliases": ["github-work"]
    },
    {
      "id": "personal",
      "label": "Personal",
      "gitEmail": "jane@example.com"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable unique id; a lock records it so later edits can be detected. |
| `label` | Display name. |
| `gitEmail` | Required. Commits whose author or committer email differs are blocked. |
| `gitName` | Optional. When set, the author/committer name must match too. |
| `expectedGitHubLogin` | Optional. When set, every push from a locked repository must authenticate to GitHub as this user. Omit it to lock commits only. |
| `trustedSshHostAliases` | The `~/.ssh/config` `Host` aliases (e.g. `github-work`) pushes for this identity must go through. Required for push checks: a login with no alias means every push is blocked. |

Invalid entries (bad email/login, control characters, aliases beginning
with `-`, duplicate ids) are rejected individually and shown in the
sidebar — never silently "fixed" into a weaker lock.

## Locking a repository

**Repo Identity Guard: Assign Identity to Current Repository** (or the
sidebar) asks which identity to use, shows exactly what will be enforced,
and asks you to confirm. Assigning is enforcing — there is no separate
"also protect it" switch.

- **All or nothing.** The lock either ends fully installed for the chosen
  identity, or the repository is left exactly as it was. It is never
  reported as locked while a hook it needs is missing.
- **Existing hooks are respected.** If the repository already has its own
  `pre-commit` / `pre-merge-commit` / `pre-push` hook (Husky, `pre-commit`,
  a hand-written script), you are asked whether to keep it: the identity
  check runs first, then your hook runs exactly as before, and it is
  restored byte-for-byte when you unlock. Decline and nothing is changed.
- **Worktrees share the lock; clones do not.** The lock lives in the
  repository's shared Git directory, so every linked worktree
  (`git worktree add`) is covered. A separate clone — even of the same
  remote — is a different repository and is not locked until you assign it.
- After assigning, if Git currently commits here as someone else, you are
  offered **Use Assigned Identity in Git Config** (writes `user.name` /
  `user.email` with `git config --local`, or `--worktree` when worktree
  config is enabled; global config is never touched).

**Change Assigned Identity** rebuilds the lock for another identity (same
all-or-nothing rule — a change that cannot complete leaves the previous
lock in place). **Unlock Current Repository** removes every hook the lock
installed (restoring your own hooks exactly) before removing the lock
record; if something cannot be removed, the repository keeps reporting the
lock instead of pretending it is gone. Your notes are kept either way.

Assign, change, repair and unlock change Git hooks, so they require
[Workspace Trust](#workspace-trust).

### What a lock checks

- **Commits** (`pre-commit` and `pre-merge-commit`): the *effective* author
  and committer — exactly what the commit will record, including
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `EMAIL` environment variables,
  `git -c user.email=…` and `--author`. When Git config is right but an
  override changes the result, the message says so.
- **Pushes** (`pre-push`, only when the identity has `expectedGitHubLogin`):
  the push must go over SSH through one of the identity's trusted aliases,
  with no `GIT_SSH` / `GIT_SSH_COMMAND` / `core.sshCommand` / non-OpenSSH
  `ssh.variant` override. The alias is resolved with `ssh -G` (it must
  really point at a GitHub SSH endpoint with `IdentitiesOnly yes`) and the
  account is checked live with
  `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes` against that exact
  route (same user, host and port the push uses). HTTPS pushes, the generic
  `git@github.com` host, unknown aliases and anything unverifiable are
  blocked — an unprovable push account is never assumed to be right. The
  repository the push goes to is not checked; only *who* it authenticates
  as.

Passive status refreshes never open a network connection. `ssh -T` runs
only on a real push, right after assigning an identity with a GitHub login,
and when you run **Check Identity Lock**.

### Block messages

Every block begins with a machine-readable prelude, followed by a plain
explanation and the next step:

```text
REPO_IDENTITY_GUARD_BLOCK
ACTION: commit
REASON: wrong_identity
REASON_ID: commit-identity-mismatch
IDENTITY: Work
EXPECTED_NAME: Jane Doe
EXPECTED_EMAIL: jane@acme.example
FOUND_NAME: Jane Doe
FOUND_EMAIL: jane@example.com
FOUND_ROLE: author,committer

Repo Identity Guard blocked this commit.
...
```

Push blocks carry `EXPECTED_GITHUB_LOGIN`, `FOUND_GITHUB_LOGIN` (the login
GitHub reported, or `unverified`), `DETAIL` (e.g. `https`,
`untrusted_alias`, `account_mismatch`, `timeout`), `REMOTE` and
`ROUTE_HOST`. `REASON` is one of `wrong_identity`, `identity_override`,
`push_route_unverified`, `push_route_override`, `wrong_push_account`,
`push_account_unverified`, `policy_missing`, `policy_corrupt`,
`inspection_failed`, or `internal_error`. Messages never contain
credentials, tokens or key material.

### Health, drift and repair

The sidebar and status bar show each repository's state: **Not locked**,
**Locked**, **Needs attention** (a hook was deleted or modified, the
identity was edited or removed in settings since the lock was installed,
a legacy installation is awaiting migration, cleanup could not finish...)
or **Unavailable** (the repository's Git state could not be read). Editing an
identity in settings never silently changes a lock: the lock keeps
enforcing what you assigned until you run **Repair Identity Lock**, which
re-installs it from the identity's current definition (and refuses, rather
than guessing, if that identity no longer exists).

### Honest limits (the threat model)

The lock exists to stop **accidents** — committing to a work repository
with your personal email, or pushing with the wrong GitHub account. It is
not a security boundary against someone, or some process, deliberately
getting around it:

- `git commit --no-verify` (or `-n`) and `git push --no-verify` skip Git
  hooks entirely. That is Git's own documented behavior; no local hook can
  prevent it.
- Changing `core.hooksPath`, or deleting the hook files, disables
  enforcement. The extension notices and reports **Needs attention**, but
  cannot undo a commit made in the meantime.
- Anything with arbitrary local shell access can rewrite the lock's files
  or shadow `git` / `ssh` on `PATH`.
- A clean (conflict-free) `git cherry-pick` / `git revert` commits without
  running any commit hook; a conflicting one finished with `--continue`
  is checked.
- The GitHub account check trusts GitHub's own SSH greeting over a host key
  already in your `known_hosts`; it is not a cryptographic proof of
  identity.
- Requires Git 2.31 or newer (assigning is refused on older Git rather
  than installing a lock that cannot enforce), and a POSIX `sh` (bundled
  with Git for Windows).

More detail: [docs/IDENTITY_LOCK.md](docs/IDENTITY_LOCK.md).

## Notes

- One note collection per repository, shared by its linked worktrees.
  Notes are keyed to the repository's real (canonicalized) location; a
  re-clone elsewhere starts empty — use Export / Import to move notes.
- Add, edit, delete, pin (one pinned note at a time, kept at the top),
  search, and **Copy** (puts the note's exact text on the clipboard).
  Plain text, multiline, no Markdown/HTML rendering.
- Limits for new notes: 4,000 characters per note, 200 notes per
  repository. Existing data over a limit is never truncated.
- **Export** / **Export all** write a JSON file you choose (labels are
  repository names, never local paths). **Import** validates the file,
  shows what it will do, imports one repository entry at a time, skips
  notes that already exist unless you choose to overwrite, and rejects
  over-limit content instead of truncating it.
- A draft you are typing survives background refreshes and is cleared only
  after the save succeeds.
- Two VS Code windows on the same profile editing notes at the same moment
  can still overwrite each other (a limitation of VS Code's `globalState`
  storage).
- Notes have no effect whatsoever on the identity lock, and nothing ever
  executes a note.

## Workspace Trust

In an untrusted workspace you can still see each repository's lock state
and use notes fully (they are local data that is never executed).
Assigning, changing, repairing and unlocking an identity — and migrating a
legacy installation — install or remove Git hooks, so they only run in a
trusted workspace.

## Upgrading from 0.2.x

Version 0.3.0 removes most of the earlier product (see
[CHANGELOG.md](CHANGELOG.md) for the full list). What happens to your data:

- **Profiles become identities** (once, only if you have no identities
  yet). Only who-you-are fields are kept; `expectedRemoteOwners`,
  `exactRepos`, `expectedBranchPatterns` and `strictPushSetup` are
  dropped and never become assignments. A profile's `expectedGitHubLogin`
  becomes enforced for pushes in any repository you lock to that identity.
- **Saved commands become notes**, losslessly: each becomes a note whose
  text is the command's label, a newline, and the command exactly as saved.
  Commands saved in different worktrees of one repository end up in that
  repository's notes. Nothing is ever run.
- **Shield Mode installations** (from 0.2.x) are migrated the first time
  the repository is opened in a trusted workspace. A repository becomes
  locked only if it was **explicitly** bound to one profile through a
  literal `exactRepos` entry *and* had Shield enabled for that profile;
  every other Shield installation (including every owner-pattern match) is
  removed, your own chained hooks are restored, and the repository ends up
  unassigned. Until then, the old Shield hooks keep enforcing the old
  Shield policy in that repository (they call the old evaluator installed
  next to them); run **Unlock Current Repository** to remove them
  explicitly at any time.
- Obsolete settings (`repoIdentityGuard.profiles`,
  `protectedBranches`, `requireLocalIdentity`, `includeMemoryInAiContext`)
  are ignored; you can delete them from `settings.json`.

## Commands

- Repo Identity Guard: Open
- Repo Identity Guard: Assign Identity to Current Repository
- Repo Identity Guard: Change Assigned Identity
- Repo Identity Guard: Unlock Current Repository
- Repo Identity Guard: Repair Identity Lock
- Repo Identity Guard: Check Identity Lock (verifies push account)
- Repo Identity Guard: Use Assigned Identity in Git Config
- Repo Identity Guard: Edit Identities

Command Palette commands act on the repository of the active editor (or
the sidebar's selected repository); sidebar buttons act on the repository
the sidebar shows.

## Status of the UI

The sidebar in this build is a deliberately minimal placeholder over the
new backend; a redesigned UI is in progress.

## Run locally

1. `npm install`
2. `npm run compile`
3. Open the folder in VS Code and press `F5`.

`npm test` runs the full suite (real temporary Git repositories, the real
shipped hook evaluator, no network). See [TESTING.md](TESTING.md).
