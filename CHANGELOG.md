# Changelog

## 0.1.0

Ship-ready v0.1 release of Repo ID.

### Added

- Repo identity status bar for Safe, Wrong Identity, Local Needed, Unknown,
  Not a Git Repo, and Error states.
- Activity Bar sidebar with compact Stitch-style status, identity, repository,
  matched-rule, and action cards.
- Effective, repo-local, and global Git identity detection.
- Origin remote detection and normalization for HTTPS, SSH, and SSH host-alias
  remotes.
- User-configured identity rules via `repoIdentityGuard.rules`.
- Wildcard rule matching.
- Optional strict local identity mode via
  `repoIdentityGuard.requireLocalIdentity`.
- Local Needed state when effective identity is safe but repo-local identity is
  not pinned.
- Set Local Identity confirmation modal.
- Edit Local Identity modal for saving custom repo-local name/email.
- One-click repo-local identity fix.
- Add Rule for Current Repo command.
- Copy Diagnostic Report command.
- Rescan, Settings, and Details actions.
- Repo-local and global Git config watchers.
- First-run/no-rules onboarding actions.
- Local Tailwind webview CSS build included in the packaged extension.
- Clarified commit author identity scope versus repository authentication.
- Safe state sidebar polish: no misleading fix CTA when local identity is
  already pinned.
- Global fallback display polish when local identity is pinned and safe.
- Sidebar scope note explaining that repository access depends on GitHub auth,
  SSH keys, or stored credentials.

### Not included

- GitHub CLI account switching.
- SSH key switching.
- HTTPS credential management.
- Windows Credential Manager integration.
- Git hooks.
- Global Git identity editing.
- Commit rewriting.
- Push/authentication workflows.
