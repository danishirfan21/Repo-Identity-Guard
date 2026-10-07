# Identity lock — design and behavior

This document describes how the identity lock works as of version 0.3.0.
It replaces "Shield Mode": the hardened hook engine described in
[SHIELD_MODE.md](SHIELD_MODE.md) is still what enforces the lock (and
that document remains the record of how it was built and hardened), but
the product semantics are now much smaller. Where the two disagree, this
document describes current behavior.

## The contract

- A repository is either **unassigned** or **assigned to exactly one
  identity**. Assignment happens only through an explicit user action
  (Assign / Change Identity), never by matching remotes, owners, folder
  names or other repositories.
- **Assignment is enforcement.** Assigning installs local Git hooks that
  block commits made with a different identity — and, when the identity
  has `expectedGitHubLogin`, pushes that do not authenticate to GitHub as
  that login.
- **An unassigned repository is never touched**: no files are written, no
  hooks installed, no Git config changed, nothing is blocked. The one
  exception is migration of a legacy 0.2.x Shield installation (see below),
  which only happens in a trusted workspace and ends either in an explicit,
  provable lock or in the removal of the legacy hooks.
- Enforcement runs entirely in Git hooks and a POSIX `sh` script, so it
  works from any terminal, Git GUI or AI agent, with VS Code closed.

## Where the lock lives

All lock state is local to the repository's **git common directory**
(shared by every linked worktree):

| Path | Contents |
| --- | --- |
| `<git-common-dir>/repo-identity-guard/shield-policy.json` | The lock record (policy v3). The single source of truth for "is this repository assigned, and to whom". |
| `<git-common-dir>/repo-identity-guard/shield-evaluate.sh` | A copy of the bundled evaluator. Hooks run this copy, so they keep working when the extension is not running. |
| `<git-common-dir>/repo-identity-guard/installations.json` | Every hooks directory the lock has installed into (for complete cleanup after `core.hooksPath` changes). Paths and a timestamp only. |
| `<hooks-dir>/pre-commit`, `pre-merge-commit`, `pre-push` | Small hook shims carrying the ownership marker `repo-identity-guard-shield-artifact v6`. |
| `<hooks-dir>/<hook>.repo-identity-guard-original` | A pre-existing hook the user chose to keep (chained). |

Consequences: linked worktrees share one lock; a different clone of the
same remote is a different repository and starts unassigned; nothing is
synced between machines; deleting the repository deletes the lock. (The
file names keep their historical `shield` prefix so 0.2.x installations
can be recognized and migrated.)

### Policy v3

```json
{
  "policyVersion": 3,
  "lockId": "9f1c…",
  "assignedAt": 1760000000000,
  "generatedAt": 1760000000000,
  "identityId": "work",
  "identityLabel": "Work",
  "expectedGitName": "Jane Doe",
  "expectedGitEmail": "jane@acme.example",
  "expectedGitHubLogin": "jane-acme",
  "trustedSshHostAliases": ["github-work"],
  "enforcedActions": ["commit", "push"]
}
```

`enforcedActions` is derived, never chosen: always `commit`, plus `push`
exactly when `expectedGitHubLogin` is set. `lockId`/`assignedAt` change
only when a different identity is assigned (re-assigning or repairing the
same identity keeps them). The TypeScript validator
(`src/shield/policy.ts`) and the shell evaluator's strict JSON reader
validate the same schema; anything else — including a v1/v2 (0.2.x) policy
— is `policy-corrupt` and blocks (fails closed) rather than being guessed at.

## Hooks and the evaluator

- `pre-commit` and `pre-merge-commit` (a real `git merge` commit runs the
  latter, not the former) run `shield-evaluate.sh commit`.
- `pre-push` captures Git's ref lines into a private `mktemp` file (no
  predictable fallback path), runs `shield-evaluate.sh push <name> <url>`,
  and passes the same argv and stdin to a chained hook.
- Every shim **fails closed**: a missing or unreadable evaluator, or an
  evaluator that crashes without reaching a decision, blocks the operation
  with an `internal_error` block that points at Repair / Unlock.
- A chained original hook runs only after the identity check passed.
- An evaluator block (it always starts with `REPO_IDENTITY_GUARD_BLOCK`) is
  printed verbatim.

### Commit check

`git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT` give the identity the
commit will actually record (environment variables, `git -c`, `--author`
included). Both must match `expectedGitEmail` (and `expectedGitName`, when
set), case-insensitively. If Git config already matches but the effective
identity does not, the block is `commit-identity-override` instead of
`commit-identity-mismatch`, because writing config again would not help.

### Push check (only with `expectedGitHubLogin`)

In order, stopping at the first failure:

1. **Route.** The push URL Git hands the hook (pushurl, pushRemote and
   pushDefault already resolved by Git) must be SSH, through a host that is
   one of the identity's `trustedSshHostAliases` — not HTTPS, not an
   unknown protocol, not a generic host (`github.com`, `gitlab.com`,
   `bitbucket.org`), not an unlisted alias. No `GIT_SSH`,
   `GIT_SSH_COMMAND`, `core.sshCommand`, or non-OpenSSH `ssh.variant` /
   `GIT_SSH_VARIANT` may be in effect. An SSH user or host beginning with
   `-` is refused (it would be read by `ssh` as an option).
2. **Effective route.** `ssh -G [-p port] [user@]alias` must report a GitHub
   SSH endpoint (`github.com`, `ssh.github.com`, `*.github.com` — not
   look-alikes) and `identitiesonly yes`. The same user and port the push
   uses are passed, so `Match user` / per-port configuration is honored.
3. **Account.** `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes
   -o ConnectTimeout=<n> [-p port] [user@]alias` must answer
   `Hi <expectedGitHubLogin>! You've successfully authenticated…`.
   Deploy-key greetings, permission denied, unknown host keys, timeouts
   (`REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT`, default 5 s) and unparseable
   output are all `push-account-unverified`; a different login is
   `push-account-mismatch`.

The repository/owner the push goes to is deliberately not checked.

The **Check Identity Lock** command runs the same decision function in
TypeScript (`src/identity/pushAccountProbe.ts` → `evaluatePush`) so "the
check said verified" and "the push was allowed" cannot disagree. Passive
status refreshes never run `ssh`.

### Block output

```text
REPO_IDENTITY_GUARD_BLOCK
ACTION: push
REASON: wrong_push_account
REASON_ID: push-account-mismatch
IDENTITY: Work
EXPECTED_GITHUB_LOGIN: jane-acme
FOUND_GITHUB_LOGIN: jane-personal
DETAIL: account_mismatch
REMOTE: origin
ROUTE_HOST: github-work

Repo Identity Guard blocked this push.
<explanation and next step>
```

| `REASON` | `REASON_ID` |
| --- | --- |
| `wrong_identity` | `commit-identity-mismatch` |
| `identity_override` | `commit-identity-override` |
| `push_route_unverified` | `push-route-unverified` |
| `push_route_override` | `push-route-override` |
| `wrong_push_account` | `push-account-mismatch` |
| `push_account_unverified` | `push-account-unverified` |
| `policy_missing` | `policy-missing` |
| `policy_corrupt` | `policy-corrupt` |
| `inspection_failed` | `inspection-failed` |
| `internal_error` | `internal-error` (hook shim only) |

Commit blocks add `EXPECTED_NAME` (when set), `EXPECTED_EMAIL`,
`FOUND_NAME`, `FOUND_EMAIL`, `FOUND_ROLE` (`author`, `committer` or
`author,committer`). Push `DETAIL` values: `https`, `generic_ssh_host`,
`untrusted_alias`, `unknown_protocol`, `ssh_transport_override`,
`malformed`, `route_unresolvable`, `route_not_github`,
`identities_not_isolated`, `host_key_unverified`, `permission_denied`,
`deploy_key`, `timeout`, `account_mismatch`. Every prelude value is
flattened to one line; credentials embedded in a remote URL are never
printed. `src/shield/reasonCatalog.ts` is the TypeScript source of truth
and a test asserts the shell's `reason_code` table matches it.

## Lifecycle

All lock mutations go through `IdentityLockService`
(`src/identity/identityLockService.ts`), serialized per repository by the
extension, and require Workspace Trust.

- **Assign / change** (`requireComplete`): a preflight refuses before
  writing anything if a hook slot the lock needs is occupied by a foreign
  hook (unless the user chose to chain it), a symlink, a non-executable
  file, or a stale chained-original sidecar; Git older than 2.31 is
  refused. Each file is written atomically (temporary file + rename), and
  if any step fails, every file written so far is rolled back to its
  previous bytes and mode (a rollback that cannot itself finish is
  reported, never hidden). Result: either an active lock for the requested
  identity, or the repository as it was before.
- **Unlock**: removes every owned hook — at the current hooks directory and
  every directory in `installations.json` — restoring chained originals
  byte-for-byte, *then* the evaluator, then the policy and record. If an
  owned hook cannot be removed, the policy and evaluator are kept and the
  repository keeps reporting the lock ("unlock incomplete"), so it is never
  shown as unassigned while a lock hook can still fire. An interrupted
  unlock can only over-enforce, never leave a hook pointing at nothing.
- **Repair**: re-installs the current assignment from the identity's live
  definition. Refuses when the identity no longer exists or the record is
  unreadable — it never guesses which identity to enforce.
- **Status** (`getStatus`): read-only, no network. Maps the engine
  inspection to `unassigned | active | needs_attention | unavailable`, with
  `commitEnforced`, `push` (`enforced | not_configured | unverifiable |
  none`), `repairAvailable`, `unlockAvailable` and a one-sentence reason.
  `needs_attention` covers: missing/modified/outdated hooks or evaluator,
  a foreign hook in a governed slot, a moved `core.hooksPath`, identity
  drift (the identity was edited or removed in settings), a login with no
  trusted alias, an incomplete unlock, and legacy installations.

## Migration from 0.2.x

Runs once per repository, in trusted workspaces only, when the scan finds a
legacy installation (a v1/v2 policy and/or owned artifacts older than v6).
The decision (`src/identity/legacyMigration.ts`) is deliberately narrow:

- **Migrated to a lock** only if *all* hold: the legacy policy names the
  profile it was enabled for and the repository it approved; the current
  `origin` canonicalizes to that same `host/owner/repo`; exactly one legacy
  profile lists that repository as a **literal** (wildcard-free)
  `exactRepos` entry, and it is the profile Shield was enabled for; that
  profile converts into a valid identity.
- **Removed** otherwise — including every `expectedRemoteOwners` match,
  wildcard `exactRepos`, a changed origin, an unreadable policy, ambiguous
  bindings. Chained user hooks are restored; the repository ends up
  unassigned.

Idempotent: once migrated or removed there is nothing legacy left to act
on. Until a legacy repository is opened in a trusted workspace, its 0.2.x
hooks keep running the 0.2.x evaluator installed next to them, i.e. they
keep enforcing the old Shield policy. Note that a profile's
`expectedGitHubLogin` was only enforced by Shield under certain
conditions; after migration (or any new assignment) it is always enforced
for pushes.

Saved commands are migrated into notes (see the README); legacy profiles
become identities (once, user settings only). Neither ever creates an
assignment.

## Threat model and limits

The lock prevents **accidental** use of the wrong identity. It does not
defend against a person or process that intends to get around it — that is
outside the threat model, and no client-side hook can provide it:

- `--no-verify` / `-n` on commit and `--no-verify` on push skip hooks.
- Pointing `core.hooksPath` elsewhere, or deleting the hooks, disables
  enforcement (reported afterwards as needs attention). In particular, a
  worktree-specific `core.hooksPath` (with `extensions.worktreeConfig`) can
  leave one linked worktree unenforced; that worktree reports needs
  attention when opened.
- Anything with arbitrary local shell access can edit the lock's files or
  shadow `git`/`ssh` on `PATH`.
- Clean `cherry-pick`/`revert` commits run no commit hook.
- The account check relies on GitHub's SSH greeting over a host key already
  present in `known_hosts` — not a cryptographic proof of identity.
- HTTPS pushes cannot be account-verified locally and are therefore
  blocked for identities with a GitHub login.

## Security notes

- Identities are read only from user (global) settings and validated
  (no control characters, no `<`/`>` in name/email, GitHub-login syntax,
  aliases without whitespace, `@`, `/`, `\` or a leading `-`).
- The webview inserts all data as text (no `innerHTML`), uses a strict CSP
  with a random nonce, and every message is validated on the host side;
  lock actions re-check Workspace Trust and ask for confirmation.
- Notes are inert text: never executed, never shell-interpreted, never
  added to block messages; copying puts the exact stored text on the
  clipboard.
- No secrets are read or stored: no key material, no tokens, no credential
  helpers. `ssh -G` only reads effective client configuration.
