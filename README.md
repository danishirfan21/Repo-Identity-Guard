# Repo Identity Guard

Never commit to work with your personal Git identity again.

Repo Identity Guard is a tiny VS Code-compatible safety check. It compares the
current repository's **local** Git `user.name` and `user.email` with a rule based
on the repository's `origin` remote.

## Configure identity rules

Open VS Code settings JSON and add:

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
    }
  ]
}
```

Rules support `*` wildcards. Common HTTPS and SSH-style remotes are normalized,
including SSH host aliases such as `github-work`.

The first matching rule wins.

## Use it

Open a Git repository and look at the left side of the status bar:

- `Repo ID: Work` means the local name and email match.
- `Repo ID: Wrong` means one or both local values differ.
- `Repo ID: Unknown` means the repo has no origin or no rule matched.

Click the status item to see the remote, current identity, expected identity,
and available actions. The fix action writes only:

```text
git config --local user.name ...
git config --local user.email ...
```

It never modifies global Git configuration.

## Run locally

1. Run `npm install`.
2. Run `npm run compile`.
3. Open this project in VS Code.
4. Press `F5` and choose **Run Repo Identity Guard** if prompted.
5. In the Extension Development Host, open a Git repository and configure a
   matching `repoIdentityGuard.rules` entry.

See [TESTING.md](TESTING.md) for the manual MVP checklist.

## MVP limitations

This version checks only the repository's local Git commit author identity. It
does not inspect or switch GitHub CLI accounts, SSH keys, HTTPS credentials, or
IDE account sessions. It does not install hooks, change remotes, touch commits,
push code, authenticate users, or provide a dashboard.
