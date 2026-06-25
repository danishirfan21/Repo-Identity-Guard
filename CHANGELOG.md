# Changelog

## 0.1.0

Initial core MVP of Repo ID.

### Added

- Repo root detection.
- `origin` remote detection and normalization.
- HTTPS, SSH, and SSH host-alias remote matching.
- User-configured identity rules via `repoIdentityGuard.rules`.
- Wildcard rule matching.
- Effective, local, and global Git identity detection.
- Status bar states for safe, wrong, unknown, and strict-local-needed identity.
- Native notification and Quick Pick details flow.
- One-click repo-local identity fix.
- Add Rule for Current Repo command.
- Optional strict local identity mode via
  `repoIdentityGuard.requireLocalIdentity`.
- Copy Diagnostic Report command.
- Repo-local and global Git config watchers.
- First-run/no-rules onboarding actions.

### Not included

- GitHub CLI account switching.
- SSH key switching.
- HTTPS credential management.
- Windows Credential Manager integration.
- Git hooks.
- Webview dashboard.
- Publishing setup.
