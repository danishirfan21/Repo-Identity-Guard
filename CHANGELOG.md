# Changelog

## Unreleased

### Added

- **Multi-root workspace support.** When a workspace has more than one Git
  repository (or a repo plus its linked worktree, opened as separate
  folders), Repo Identity Guard now evaluates every one of them
  independently and rolls the results up with a deliberately conservative
  rule — not a plain OR:
  - **SAFE** only when every detected repository has been checked and is
    SAFE.
  - **NOT SAFE** when any repository is blocking, unresolved, or couldn't
    be checked reliably — a safe active repo never makes the workspace
    read green while another repo in the same workspace is unresolved.
  - **NOT CHECKED** only when no repositories have been evaluated, or none
    were detected at all.
  This is computed by a new `computeWorkspaceSafetyState`, derived from an
  array of per-repo `RepositorySafetyState` — capability results stay
  strictly repo-scoped; nothing synthesizes a cross-repo
  `CapabilityResult`.
  - Workspace folders that resolve to the same repo root are deduplicated;
    linked worktrees always get their own entry, since their branch and
    working-tree state can differ from the main worktree.
  - A folder that isn't a Git repo is excluded from the count entirely —
    it never counts as "no repositories detected." A repo whose inspection
    fails partway (a Git command errors) now surfaces as its own blocking
    "Could not fully inspect this repository" result instead of silently
    falling through the other five checks with missing facts.
  - The Main view shows an aggregate badge and repo counts, followed by a
    repository list — each row has its own mini-status and selects that
    repo for Review Details and for every mutating/executing action (Fix
    Commit Identity, saved commands, Repo Memory). There is always exactly
    one selected repository; no action ever runs against an ambiguous
    mix. Review Details shows which repo is being reviewed whenever more
    than one is open. Single-repo workspaces are unchanged — no extra UI
    appears.
  - **Copy Workspace Safety Summary** is a new, separate action from Copy
    Context for AI: a compact per-repo SAFE/NOT SAFE line with blocking
    reasons and restrictions for every repo in the workspace — not a
    combined dump of every repo's full checklist or Repo Memory notes.
    Copy Context for AI is unchanged and still describes only the
    currently selected repo in full detail.
- **Fix Commit Identity now writes to the correct config scope for
  worktrees.** Previously the confirmation dialog could claim a change
  "affects only this worktree" while still running `git config --local`,
  which is repo-level config shared by every worktree — a contradiction
  between what was promised and what actually happened. It's now resolved
  explicitly via `resolveIdentityConfigScope`, based on `git worktree list
  --porcelain` (not just `isLinkedWorktree`, which only detects *this*
  worktree as linked and misses a *main* worktree that has others attached
  to it) and whether `extensions.worktreeConfig` is on:
  - More than one worktree + worktree config on → writes `git config
    --worktree`, and the dialog says so.
  - More than one worktree + worktree config off/unknown → still writes
    `git config --local`, but the dialog now says explicitly that the
    change is shared across every worktree, not narrower.
  - One worktree → ordinary `--local`, unambiguous either way.
  Every mutation confirmation also now names the repository and its local
  path alongside the profile, so "this repo" is never ambiguous once more
  than one is open.
- **Every repo in a multi-root workspace is now kept fresh, not just the
  selected one.** Previously only the selected repo's `.git/{config,HEAD}`
  was watched, so a non-selected repo could go unsafe (branch switch, new
  conflict, identity change) without the workspace aggregate ever
  refreshing — a stale green result. Watchers are now reconciled per repo
  (by canonical repo ID) after every scan, covering every in-scope repo's
  resolved `gitDir`/`gitCommonDir` — not a guessed `<repoRoot>/.git`, which
  is wrong for linked worktrees — for HEAD/config/index/merge-conflict
  markers and rebase-in-progress directories, debounced 300ms. A save
  anywhere in the workspace also nudges a rescan, as a lighter-weight
  partial mitigation for ordinary working-tree edits (still not a full
  recursive working-tree watch, which would be expensive across every
  repo — documented as a limitation).
- **The status bar's click can no longer contradict its own badge.** In a
  multi-root workspace, clicking the status bar now shows the workspace
  verdict (`workspaceState`) — "N of M repositories need attention" — not
  just the selected repo's status, which could previously read "Safe to
  work here" while the badge itself showed "Not Safe (1/2 repos)". The
  status bar's multi-root problem count also now includes unresolved
  (`not_checked`) repos, not only blocking ones — `formatWorkspaceProblems`
  fixes a bug where it could otherwise show "Not Safe (0/2 repos)" when
  the only problem was an unresolved repo.
- Per-repo scanning during aggregation is now isolated with
  `Promise.allSettled` plus a per-target try/catch, converting any
  unexpected failure into that repo's own inspection-failed result instead
  of risking the whole workspace scan rejecting and hiding every repo.
- **`resolveIdentityConfigScope` no longer depends on worktree count.**
  When `extensions.worktreeConfig` is on, Git reads `config.worktree`
  *after* the shared repo config and lets it override — even with only
  one worktree attached right now. Gating the scope on worktree count
  (the previous behavior) meant a stale `config.worktree` value could
  survive a "successful" `--local` fix, so the command would report
  success while the effective identity stayed wrong. Scope now depends
  only on whether worktree config is enabled; worktree count still shapes
  the confirmation dialog's wording, never which flag gets used.
- **Strict local-identity mode (`requireLocalIdentity`) now recognizes a
  worktree-scoped override, not just `--local`.** Previously, after Fix
  Commit Identity wrote to `--worktree`, this check kept reporting "not
  locked" because it only ever read `git config --local`. It now reads
  `git config --worktree` too (safe to query unconditionally — Git treats
  `--worktree` as `--local` when worktree config isn't enabled) and
  prefers whichever scope actually holds an explicit value, surfaced in
  the result's technical details.
- Watcher reconciliation now also watches `config.worktree`, so an
  external `git config --worktree user.email ...` triggers a rescan the
  same way an external `--local` edit already did.
- **`git status` and `git worktree list` failures are no longer treated
  as "nothing to report."** They previously shared the same
  exit-code-1/2/128-means-missing handling as `config --get`/`remote
  get-url`, where a nonzero exit is a normal "value doesn't exist." For
  `status` and `worktree list`, a nonzero exit means something is actually
  wrong — silently downgrading that to "clean tree" or "1 worktree" could
  hide a real error behind a falsely reassuring default. Both now use
  `runGit` directly so a genuine failure propagates and surfaces as the
  repo's own inspection-failed capability result, per the existing
  conservative philosophy.
- **New capability-based result model**, replacing the old flat
  blocking/warning/info `Issue` list. Every scan now evaluates exactly six
  capabilities (Commit Identity, Push Destination, Push Account, Branch
  Policy, Repo State, Workspace Trust) and each produces exactly one
  `CapabilityResult`, always — never omitted when things are fine. Each
  result carries:
  - a `state`: `confirmed` / `contradicted` / `unverified` / `warning` /
    `not_applicable`
  - an independent `blocksOverallSafety` boolean — deliberately not
    derived from `state` alone (e.g. an unverified push account only
    blocks when its profile requires strict push setup, but the state is
    "unverified" either way)
  - optional `agentRestrictions`, derived from the specific finding (e.g.
    an in-progress rebase implies "don't switch branches" + "don't
    commit")
  Repo Memory and Shield Mode are now separate `InfoNote`s, not
  `CapabilityResult`s — they're context data and feature-availability
  metadata, not safety verdicts, and never affect the overall SAFE/NOT
  SAFE result.
- **Review Details now shows the full checklist**, not just problems —
  every capability appears with its state, including "Confirmed" and "Not
  applicable" results, so you can see what passed, not only what failed.
- **Copy Context for AI is now rendered from the same capability results**
  Review Details shows, translated into Confirmed facts / Contradictions /
  Unverified facts / Warnings / Derived agent restrictions, instead of
  maintaining a separate parallel issue/rule list. Derived restrictions
  are deduplicated when multiple findings imply the same restriction (e.g.
  detached HEAD and an in-progress rebase both imply "no commit").
  `not_applicable` results are omitted entirely.
- New automated invariant test: every capability result with
  `blocksOverallSafety: true` is verified to appear in the Copy Context
  model, either as an issue entry or a derived restriction — not just by
  convention.
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
