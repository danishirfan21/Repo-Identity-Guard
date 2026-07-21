# Repo ID

Never commit with the wrong Git author identity.

Repo ID is a VS Code / Google Antigravity extension that helps you avoid
committing to a repository with the wrong Git author identity.

It checks the repository remote, evaluates the Git identity that would actually
be used for a commit, and gives you a clear Safe / Wrong / Local Needed /
Unknown signal in the status bar and Activity Bar sidebar.

> Product philosophy: global Git identity is a fallback. Local Git identity is
> safety.

## Why this matters

Developers often use one machine for personal, company, and client work. Git
does not automatically know which identity belongs to each repository.

It is easy to be in the correct GitHub account, open the correct repository,
and still create commits authored with the wrong `user.name` or `user.email`.

The important distinction:

- Switching GitHub CLI accounts does not necessarily change Git commit author
  identity.
- Switching SSH keys does not necessarily change Git commit author identity.
- Changing IDE account/session does not necessarily change Git commit author
  identity.

Repo ID focuses on the commit author identity Git will use locally.

```text
Repo ID checks:
  Git commit author
  user.name / user.email
  checked

Repo ID does not check:
  Repository access
  GitHub CLI / SSH / credentials
  not checked
```

## What Repo ID shows

Repo ID displays three Git identity layers:

- **Effective identity**: what Git will use if you commit in this repo now.
- **Repo-specific local identity**: `user.name` and `user.email` stored in this
  repo's `.git/config`.
- **Global fallback identity**: user-level Git config used when the repo has no
  local identity.

For v0.1, Repo ID never edits global Git config. It only writes repo-local Git
identity when you explicitly choose to set or fix it.

## States

- **Safe**: Git commits will use the expected author identity for this repo.
  This does not verify repository access, pull, push, or authentication.
- **Wrong Identity**: Git would commit with a name or email that does not match
  the repo's rule.
- **Local Needed**: the effective identity currently matches, but strict local
  mode requires this repo to pin the expected identity locally.
- **Unknown**: no matching rule was found, no origin remote exists, or the repo
  cannot be evaluated yet.
- **Not a Git Repo**: the current folder is not inside a Git repository.
- **Error**: Repo ID could not complete the scan.

## Sidebar and modal

Repo ID adds a compact Activity Bar panel named **Repo ID**. The sidebar shows:

- current safety state;
- effective, local, and global identities;
- repository remote/path;
- matched rule;
- actions for setting identity, adding rules, copying diagnostics, rescanning,
  opening settings, and viewing details.

When you choose **Set Local Identity** or **Fix Local Git Identity**, Repo ID
opens an in-sidebar confirmation modal. You can:

- set the matched rule identity exactly;
- edit name/email before saving a custom repo-local identity;
- reset the edit form back to the matched rule identity;
- cancel without changing anything.

All identity writes use:

```text
git config --local user.name ...
git config --local user.email ...
```

## Rules

Rules match normalized `origin` remotes. The first matching rule wins.

Example Settings JSON:

```json
{
  "repoIdentityGuard.rules": [
    {
      "match": "github.com/AcmeSoftware/*",
      "label": "Work",
      "name": "Danish Irfan",
      "email": "work@example.com"
    },
    {
      "match": "github.com/Danish-Irfan/*",
      "label": "Personal",
      "name": "Danish Irfan",
      "email": "personal@example.com"
    },
    {
      "match": "github-work/AcmeSoftware/*",
      "label": "Work SSH",
      "name": "Danish Irfan",
      "email": "work@example.com"
    }
  ]
}
```

Repo ID supports `*` wildcards and normalizes common remote formats:

- `https://github.com/org/repo.git` -> `github.com/org/repo`
- `git@github.com:org/repo.git` -> `github.com/org/repo`
- `git@github-work:org/repo.git` -> `github-work/org/repo`

## Strict local identity mode

By default, Repo ID evaluates the effective identity:

```json
{
  "repoIdentityGuard.requireLocalIdentity": false
}
```

That means a repo can be considered Safe because Git falls back to your global
identity.

If you want matched repositories to pin their own local identity, enable:

```json
{
  "repoIdentityGuard.requireLocalIdentity": true
}
```

With strict local identity enabled, Repo ID shows **Local Needed** when:

1. the effective identity matches the rule, but
2. repo-local `user.name` or `user.email` is missing or different.

This is intentionally softer than **Wrong Identity**. The repo is safe right
now, but it could become unsafe later if global Git config changes.

## Commands

- **Repo ID: Rescan**
- **Repo ID: Show Status**
- **Repo ID: Fix Local Git Identity**
- **Repo ID: Add Rule for Current Repo**
- **Repo ID: Copy Diagnostic Report**
- **Repo ID: Open Settings**

## Screenshots

Screenshots are not included yet for v0.1 packaging. Suggested screenshots:

- status sidebar showing Local Needed;
- Set Local Identity confirmation modal;
- Edit Local Identity modal;
- Wrong Identity state with action buttons.

## Run locally

```powershell
npm install
npm run compile
```

Then open this folder in VS Code or Antigravity and press `F5` to launch the
Extension Development Host.

See [TESTING.md](TESTING.md) for the manual scenario matrix.

## Package locally

```powershell
npx @vscode/vsce package
```

The packaged VSIX includes the compiled webview CSS at `media/sidebar.css`.

## Limitations in v0.1

Repo ID only checks Git commit author identity.

It does not switch or manage:

- switch GitHub CLI accounts;
- GitHub HTTPS credentials or tokens;
- SSH keys;
- Git Credential Manager entries;
- repository permissions;
- pull/push authentication;
- install Git hooks;
- change remotes;
- rewrite commits;
- authenticate users;
- edit global Git identity;
- provide a large dashboard.

If `git pull` or `git push` fails with "Repository not found", your commit
author identity may be correct, but your GitHub authentication may be using the
wrong account or credentials.

Authentication systems outside Repo ID v0.1 scope include:

- GitHub CLI;
- SSH keys;
- HTTPS credentials;
- Git Credential Manager.

Repo ID intentionally does not run account switching or credential commands in
v0.1.
