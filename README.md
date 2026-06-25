# Repo ID

Never commit to work with your personal Git identity again.

Repo ID is a small VS Code/Antigravity extension that shows whether the
repository you have open would commit with the Git identity you expect.

It is built for developers who use one machine for personal, company, and
client work. In that setup it is easy to open the right repository while Git is
quietly using the wrong `user.name` or `user.email`.

## The problem

Git identity has several layers, and they are easy to mix up:

- Git commit author: `git config user.name` and `git config user.email`
- repo-local Git config: `.git/config`
- global Git config: your user-level Git config
- GitHub CLI account
- SSH key or host alias
- HTTPS credentials
- IDE account/session

The key insight: **switching GitHub CLI accounts does not change the Git commit
author identity.** You can be logged into the right GitHub account and still
create commits authored with the wrong name or email.

Repo ID focuses only on the Git commit author identity for v0.1.

## What Repo ID checks

Repo ID compares the current repo's `origin` remote against your configured
identity rules. If a rule matches, it checks whether Git would commit with the
expected name and email.

It shows three identity layers:

- **Effective identity**: what Git will actually use for commits in this repo.
- **Local identity**: values set in this repo's `.git/config`.
- **Global identity**: values set in your user-level Git config.

By default, safety is based on the effective identity because that is what Git
will use if you commit right now.

## Status bar states

- `Repo ID: Personal` / `Repo ID: Work`: effective identity matches the rule.
- `Repo ID: Wrong`: effective identity does not match the rule.
- `Repo ID: Local Needed`: effective identity matches, but strict local identity
  mode requires this repo to have local `user.name` and `user.email` set.
- `Repo ID: Unknown`: no origin remote exists or no rule matched.

Click the status item to open native VS Code actions. Repo ID also contributes a
compact Activity Bar webview with cards for the current status, repository,
matched rule, identities, and quick actions. Use **Details** to see a readable
Quick Pick with remote, effective/local/global identities, expected identity,
matched rule, and strict-local mode.

## Example configuration

Add rules in Settings JSON:

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

Rules support `*` wildcards. Repo ID normalizes common remote formats:

- `https://github.com/org/repo.git` → `github.com/org/repo`
- `git@github.com:org/repo.git` → `github.com/org/repo`
- `git@github-work:org/repo.git` → `github-work/org/repo`

The first matching rule wins.

## Strict local identity mode

By default:

```json
{
  "repoIdentityGuard.requireLocalIdentity": false
}
```

Repo ID checks the effective identity. This means a repo can be safe because Git
falls back to your global config.

If you want each matched repo to pin its own local identity, enable:

```json
{
  "repoIdentityGuard.requireLocalIdentity": true
}
```

When enabled, Repo ID shows `Repo ID: Local Needed` if:

1. the effective identity matches the expected rule, but
2. the repo-local `user.name` or `user.email` is missing or different.

This is a softer warning than `Wrong`. It means the repo is safe right now, but
could become unsafe later if your global Git config changes.

Choose **Set Local** / **Set Local Identity** to write only repo-local config:

```text
git config --local user.name ...
git config --local user.email ...
```

Repo ID never modifies global Git config.

## Usage flow

1. Open a Git repository.
2. If no rules exist, click `Repo ID: Unknown` and choose **Add Rule**.
3. Accept or edit the generated remote pattern, label, name, and email.
4. Watch the status bar:
   - safe label means Git would commit with the expected author;
   - `Wrong` means fix before committing;
   - `Local Needed` means strict local mode wants local config pinned.
5. Use **Details** for a readable explanation.
6. Use **Fix** / **Set Local** to write the expected identity to this repo only.
7. Use **Copy Diagnostic Report** when you need to debug or share the state.

Repo ID rescans when rules change, workspace/editor context changes, repo-local
`.git/config` changes, or global Git config changes.

## Commands

- **Repo ID: Rescan**
- **Repo ID: Show Status**
- **Repo ID: Fix Local Git Identity**
- **Repo ID: Add Rule for Current Repo**
- **Repo ID: Copy Diagnostic Report**
- **Repo ID: Open Settings**

## Activity Bar view

Repo ID adds a compact Activity Bar panel named **Repo ID**. The panel shows:

- a status card;
- repository card;
- matched rule card;
- effective/local/global identity card;
- action buttons for details, fix/set local identity, add rule, copy report,
  rescan, and settings;
- an in-sidebar confirmation modal before writing local Git identity.

## Run locally

1. Run `npm install`.
2. Run `npm run compile`.
3. Open this project in VS Code or Antigravity.
4. Press `F5`.
5. In the Extension Development Host, open a Git repository.

See [TESTING.md](TESTING.md) for the manual scenario matrix.

## Limitations in v0.1

Repo ID only checks Git commit author identity.

It does not:

- switch GitHub CLI accounts;
- switch SSH keys;
- inspect or change HTTPS credentials;
- use Windows Credential Manager;
- install Git hooks;
- change remotes;
- touch commits;
- push code;
- authenticate users;
- provide a large dashboard.
