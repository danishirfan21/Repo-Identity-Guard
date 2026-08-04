# Changelog

## Unreleased

### Added

- Exact-repository profile overrides: `Profile.exactRepos` canonicalizes a
  repo as `host/owner/repo` (wildcards allowed) and always takes precedence
  over `expectedRemoteOwners` — pins one specific repo to a profile
  regardless of its owner.
- Fork/upstream conflict detection: if a repo has an `upstream` remote
  whose owner unambiguously implies a *different* profile than `origin`'s
  owner does (e.g. a personal fork of a company repo), that's reported as
  NOT SAFE — "Origin and upstream imply different profiles" — instead of
  silently trusting `origin`. `upstream` is only ever used as evidence for
  this conflict, never as an automatic tiebreaker. **Assign This Repo**
  resolves it by writing an exact-repository override to the chosen
  profile.
- Push destination matching now also honors a profile's `exactRepos`
  override, not just `expectedRemoteOwners`.
- `findOverlappingProfiles` (the proactive save-time warning) now also
  checks for overlapping `exactRepos` entries, not just owner patterns.

- Support for multiple profiles matching one repo owner is now detected
  explicitly: a repo whose remote owner matches more than one profile (e.g.
  two freelance clients sharing an org, or a duplicated/overlapping owner
  pattern) is flagged as NOT SAFE with "Multiple profiles match this repo",
  instead of silently picking whichever profile happened to be listed
  first.
- Saving a profile (from Settings or "Add Profile for This Repo") now warns
  immediately if its expected remote owners overlap with an existing
  profile's, so the ambiguity can be caught before it ever shows up as an
  unsafe repo.
- Commit identity now reads Git's *effective* author and committer identity
  (`git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT`), not just
  `git config user.name/email` — this catches environment-variable
  overrides a plain config read would miss, and author/committer are
  checked and reported separately since they can diverge.
- Push setup is now two separate checks instead of one: **push
  destination** (does a plain `git push` actually go where the matched
  profile expects, resolved via `branch.<name>.pushRemote` →
  `remote.pushDefault` → `branch.<name>.remote` → `origin`, not just
  `origin`'s fetch URL) and **push account** (can we tell which account
  authenticates — HTTPS/generic-SSH stay "unverified," never "verified").
  An unresolved or mismatched push destination is always NOT SAFE,
  regardless of a profile's strict push setup setting.
- Agent Guard now checks repo operation state: an in-progress
  merge/rebase/cherry-pick/revert or unresolved conflicts is NOT SAFE
  (blocking); ordinary uncommitted changes are a non-blocking warning
  ("preserve existing changes"), so the tool isn't permanently red during
  normal development.
- Workspace Trust integration: read-only scanning still runs in an
  untrusted workspace (reported as NOT SAFE), but Fix Commit Identity and
  running saved commands are both blocked until the workspace is trusted.
- Linked Git worktrees now get a warning before Fix Commit Identity runs,
  noting whether the change affects only this worktree or every worktree
  attached to the repository (based on `extensions.worktreeConfig`).
- Copy Context for AI now always opens a preview tab of the exact text
  before/alongside copying to the clipboard, includes a "Checked:"
  timestamp, and no longer includes the pinned Repo Memory note unless you
  explicitly opt in via a new `repoIdentityGuard.includeMemoryInAiContext`
  setting (off by default).

### Changed

- **Shield Mode's toggle has been removed.** `repoIdentityGuard.agentGuardEnabled`
  no longer exists; Settings shows a disabled "Shield Mode — Coming soon"
  card instead, so nothing in the UI can be mistaken for active enforcement.
- "Protected branches" is now described everywhere as a **local branch
  policy** — Repo Identity Guard does not check or sync with GitHub's own
  branch protection settings.

## 0.2.0

Rebuilt as Repo Identity Guard: a full local-first safety sidebar instead of
a single identity-rule checker.

### Added

- Binary Safe / Not Safe / Not Checked status engine covering five
  categories: Commit Identity, Push Setup, Branch Safety, Agent Guard, and
  Repo Memory.
- Profiles (Work/Personal/etc.) matched by remote owner, with expected Git
  identity, expected branch patterns, and an optional strict push setup
  flag.
- Four sidebar views: Main, Review Details, Repo Memory, and Settings.
- Repo Memory: pinned notes, general notes, and saved commands (label,
  command, Run in terminal, Copy), stored locally and privately per repo
  (never written into the repo itself).
- Copy Context for AI: a privacy-safe text block summarizing repo, profile,
  status, branch, issues, pinned memory, and rules for the agent.
- Read-only detection of branch, detached HEAD, dirty state, and parsed
  remote protocol/host/owner/repo (HTTPS, SSH, and SSH host aliases).
- Branch safety checks: protected branches (default `main`/`master`),
  detached HEAD, and profile branch-pattern mismatches.
- Push setup checks distinguishing HTTPS/generic-SSH ambiguity from a
  dedicated SSH host alias, gated by each profile's strict push setup flag.
- Agent Guard preference (Shield Mode placeholder) and a "not safe for AI
  agent" signal whenever any other blocking issue is present.
- Safe local-only identity fixes (`git config --local` set/unset), run
  through a dedicated `SafeActionRunner` — global Git config is never
  touched.
- Unit tests for the status engine, profile resolver, and remote URL
  parser.

### Changed

- Renamed configuration from `repoIdentityGuard.rules` to
  `repoIdentityGuard.profiles` with a richer schema (see README).
- Status bar and sidebar rewritten around the new Safe/Not Safe model.

### Not included

- Shield Mode / Agent Guard Git hooks (architecture is in place; hooks are
  not installed yet — opt-in only, coming later).
- GitHub CLI account switching, SSH key switching, HTTPS credential
  management, OS keychain/credential manager integration.
- Automated `push`, `reset --hard`, `clean`, `rebase`, `merge`, or remote/SSH
  config changes.
- Publishing setup.

## 0.1.0

Initial core MVP of Repo ID (single Git identity rule checker). Superseded
by 0.2.0.
