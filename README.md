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

| Category | Question it answers |
| --- | --- |
| **Commit Identity** | Who will appear as the author of commits? |
| **Push Setup** | Is this repo clearly configured to push through the right account? |
| **Branch Safety** | Is the current branch safe for this repo? |
| **Agent Guard** | Is this repo safe for an AI coding agent to operate in right now? |
| **Repo Memory** | What repo-specific notes/commands should I not have to rediscover? |

Repo Identity Guard matches the open repo's `origin` remote owner (e.g. a
GitHub org or username) against **Profiles** you define (Work, Personal,
one per freelance client, one per employer — as many as you need) in
Settings. A repo with no matching profile is treated as **NOT SAFE** —
profile setup takes one click from Review Details. If a repo's owner
matches *more than one* profile (e.g. two clients' owner patterns
overlap), that's also **NOT SAFE** — "Multiple profiles match this repo" —
rather than silently guessing which identity to use. Saving a profile
whose owners overlap with an existing one warns you immediately, before it
ever shows up as an unsafe repo.

## Views

- **Main** — compact status, matched profile, issue count, next fix, one
  pinned memory note, and quick actions.
- **Review Details** — the full issue list in plain English (why it matters,
  what we expected, what we found), with raw Git facts tucked behind an
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
Memory always run in a visible integrated terminal — never silently.

**Shield Mode / Agent Guard hooks** are opt-in local Git hooks that would
block unsafe commits/pushes with a clear message. The toggle exists in
Settings today as a safety preference; the hooks themselves are not yet
installed automatically (see Limitations).

## Push setup language

- "Push setup is verified" / "Push setup is not verified"
- "Repo is not locked to Work identity"
- "Make Push Setup Safer"

A repo pushing over a generic host (`github.com` via HTTPS, or SSH without a
dedicated host alias) can't prove which account will authenticate. Whether
that's treated as **NOT SAFE** or just a warning depends on each profile's
**Strict push setup** setting (Settings → Profiles).

## Copy Context for AI

One click copies a privacy-safe summary for pasting into an AI agent's
context — repo name, matched profile, status, branch, open issues, and
pinned memory notes — plus a short list of rules for the agent (no
`git push`, don't touch `main`/`master`, ask before switching branches or
changing identity/remote/SSH/credential config). It never includes secrets,
tokens, `.env` values, SSH key contents, or raw Git config.

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
  "repoIdentityGuard.agentGuardEnabled": false
}
```

`expectedRemoteOwners` and `expectedBranchPatterns` support `*` wildcards
and are matched case-insensitively.

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

- Shield Mode / Agent Guard is a Settings preference and status-engine
  signal today; it does not yet install Git hooks. That is intentionally
  left as clean, opt-in-only architecture for a later pass.
- It does not switch GitHub CLI accounts, switch SSH keys, manage HTTPS
  credentials, or touch OS keychains/credential managers.
- It never runs `push`, `reset --hard`, `clean`, `rebase`, `merge`, or edits
  remotes/SSH config — those stay in your own terminal.
