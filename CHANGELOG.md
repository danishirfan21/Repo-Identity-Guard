# Changelog

## Unreleased

### Added

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
