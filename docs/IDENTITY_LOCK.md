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
- **Assignment is enforcement, and it is binary.** Assigning installs
  local Git hooks that block commits made with a different identity AND
  pushes that do not authenticate to GitHub as the identity's
  `expectedGitHubLogin`. An assigned repository always governs both
  actions; there is no "assigned, but pushes are not checked" mode. If the
  identity has no `expectedGitHubLogin` (or no trusted SSH alias), it can
  still be assigned — commits are locked at once — but **every push is
  blocked** until the identity is completed, and the repository reports
  `needs_attention`, never `active`.
- **An unassigned repository is never touched**: no files are written, no
  hooks installed, no Git config changed, nothing is blocked. The one
  exception is migration of a legacy 0.2.x Shield installation (see below),
  which only happens in a trusted workspace and ends either in an explicit,
  provable lock or in the removal of the legacy hooks. (Upgrading a lock
  from an earlier 0.3.0 build touches only repositories that are already
  assigned.)

## Identities: structurally valid vs. enforcement-ready

An identity (`src/identity/types.ts`) is **structurally valid** when it
has an `id`, `label` and `gitEmail` and every present field is well
formed (`validateIdentity`). That is all it takes to be stored, listed,
edited and assigned — an identity carried over from an earlier release
without a GitHub login is never rejected or deleted.

It is **enforcement-ready** (`EnforcementReadyIdentity`,
`isEnforcementReadyIdentity`) when it additionally has a non-empty
`expectedGitHubLogin` and at least one `trustedSshHostAliases` entry.
Only a lock built from an enforcement-ready identity can be `active`.
The GitHub login is never inferred — not from the commit email, the
remote URL or its owner, the SSH alias name, or Git config.
- Enforcement runs entirely in Git hooks and a POSIX `sh` script, so it
  works from any terminal, Git GUI or AI agent, with VS Code closed.

## Where the lock lives

All lock state is local to the repository's **git common directory**
(shared by every linked worktree):

| Path | Contents |
| --- | --- |
| `<git-common-dir>/repo-identity-guard/shield-policy.json` | The lock record (policy v4). The single source of truth for "is this repository assigned, and to whom". |
| `<git-common-dir>/repo-identity-guard/shield-evaluate.sh` | A copy of the bundled evaluator. Hooks run this copy, so they keep working when the extension is not running. |
| `<git-common-dir>/repo-identity-guard/installations.json` | Every hooks directory the lock has installed into (for complete cleanup after `core.hooksPath` changes). Paths and a timestamp only. |
| `<hooks-dir>/pre-commit`, `pre-merge-commit`, `pre-push` | Small hook shims carrying the ownership marker `repo-identity-guard-shield-artifact v7`. All three are installed for every lock (push is always governed). |
| `<hooks-dir>/<hook>.repo-identity-guard-original` | A pre-existing hook the user chose to keep (chained). |

Consequences: linked worktrees share one lock; a different clone of the
same remote is a different repository and starts unassigned; nothing is
synced between machines; deleting the repository deletes the lock. (The
file names keep their historical `shield` prefix so 0.2.x installations
can be recognized and migrated.)

### Policy v4

```json
{
  "policyVersion": 4,
  "lockId": "9f1c…",
  "assignedAt": 1760000000000,
  "generatedAt": 1760000000000,
  "identityId": "work",
  "identityLabel": "Work",
  "expectedGitName": "Jane Doe",
  "expectedGitEmail": "jane@acme.example",
  "expectedGitHubLogin": "jane-acme",
  "trustedSshHostAliases": ["github-work"]
}
```

Every v4 policy governs **both** commit and push; there is no per-action
field. `expectedGitHubLogin` may be absent (the identity is not complete
yet): that does not take push out of the lock, it makes the push
requirement incomplete, and the evaluator blocks every push as
`push-identity-not-configured`. An empty `trustedSshHostAliases` likewise
blocks every push (`push-route-unverified`). A v4 policy that carries an
`enforcedActions` field is `policy-corrupt`, so a hand edit can never take
push out of the lock.

`lockId`/`assignedAt` change only when a different identity is assigned
(re-assigning, repairing or upgrading the same assignment keeps them). The
TypeScript validator (`src/shield/policy.ts`) and the shell evaluator's
strict JSON reader validate the same schema; anything else — a v1/v2
(0.2.x) policy, a v3 policy from an earlier 0.3.0 build, a future version —
is `policy-corrupt` and blocks (fails closed) rather than being guessed at.

v3 (earlier 0.3.0 builds) had an `enforcedActions` list that omitted
`push` whenever the identity had no GitHub login, so such a "commit-only"
lock let every push through unchecked. See
[Upgrading v3 locks](#upgrading-v3-locks-from-earlier-030-builds).

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

### Push check (always)

In order, stopping at the first failure:

0. **Push identity configured.** The policy must carry an
   `expectedGitHubLogin`. If it does not, the push is blocked as
   `push-identity-not-configured` before the route is even parsed — no
   route could make it verifiable, and `ssh` is never run.
1. **Route.** The push URL Git hands the hook (pushurl, pushRemote and
   pushDefault already resolved by Git) must be SSH, through a host that is
   one of the identity's `trustedSshHostAliases` — not HTTPS, not an
   unknown protocol, not a generic host (`github.com`, `gitlab.com`,
   `bitbucket.org`), not an unlisted alias. No `GIT_SSH`,
   `GIT_SSH_COMMAND`, `core.sshCommand`, or non-OpenSSH `ssh.variant` /
   `GIT_SSH_VARIANT` may be in effect. An SSH user or host beginning with
   `-` is refused (it would be read by `ssh` as an option). With no trusted
   alias configured at all, every push is refused here, and the message
   explains how to add one.
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
check said verified" and "the push was allowed" cannot disagree; for an
identity with no login it reports `needs_configuration` (a block), never
"nothing to check". Passive status refreshes never run `ssh`.

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

An identity with no GitHub login configured:

```text
REPO_IDENTITY_GUARD_BLOCK
ACTION: push
REASON: push_identity_not_configured
REASON_ID: push-identity-not-configured
IDENTITY: Work
EXPECTED_GITHUB_LOGIN: (not configured)
DETAIL: github_login_not_configured
REMOTE: origin

Repo Identity Guard blocked this push.

This repository is locked to "Work", but that identity does not yet have
a GitHub account configured for push verification, so this push cannot be
attributed to the assigned identity.

What to do: configure the GitHub account for "Work" in Repo Identity Guard
(its expectedGitHubLogin, plus a trusted SSH host alias whose key belongs to that
account), then retry the push. Commits are still checked as usual.

Do not bypass this check (for example with --no-verify): ...
```

| `REASON` | `REASON_ID` |
| --- | --- |
| `wrong_identity` | `commit-identity-mismatch` |
| `identity_override` | `commit-identity-override` |
| `push_identity_not_configured` | `push-identity-not-configured` |
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
`author,committer`). Push `DETAIL` values: `github_login_not_configured`,
`https`, `generic_ssh_host`,
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
  reported, never hidden). Result: either a fully installed lock for the
  requested identity, or the repository as it was before. Every hook slot
  is needed (push is always governed), including for an identity with no
  GitHub login. Assigning an identity that is not enforcement-ready
  succeeds, with a warning that every push is blocked until it is
  completed; the repository then reports `needs_attention`.
- **Unlock**: removes every owned hook — at the current hooks directory and
  every directory in `installations.json` — restoring chained originals
  byte-for-byte, *then* the evaluator, then the policy and record. If an
  owned hook cannot be removed, the policy and evaluator are kept and the
  repository keeps reporting the lock ("unlock incomplete"), so it is never
  shown as unassigned while a lock hook can still fire. An interrupted
  unlock can only over-enforce, never leave a hook pointing at nothing.
- **Repair**: re-installs the current assignment from the identity's live
  definition. Refuses when the identity no longer exists or the record is
  unreadable — it never guesses which identity to enforce. (A v3 lock
  awaiting upgrade is the exception: it is upgraded from its own recorded
  snapshot even if the identity is gone.) A foreign hook in a slot the
  lock needs is chained only after the user agrees.
- **Status** (`getStatus`): read-only, no network. Maps the engine
  inspection to `unassigned | active | needs_attention | unavailable`, with
  `commitEnforced`, `push`, `repairAvailable`, `unlockAvailable` and a
  one-sentence reason. `push` is the push requirement of the assignment:
  `enforced` (login + trusted alias: pushes verified live),
  `needs_configuration` (no GitHub login: every push blocked),
  `unverifiable` (login but no trusted alias: every push blocked), or
  `none` (nothing assigned). There is no value meaning "push is not
  checked". `active` requires an intact installation AND `push:
  "enforced"`. `needs_attention` covers: an identity without a GitHub
  login or trusted alias, missing/modified/outdated hooks or evaluator, a
  foreign hook in any hook slot, a moved `core.hooksPath`, identity drift
  (the identity was edited or removed in settings), an incomplete unlock,
  a v3 lock awaiting upgrade, and legacy installations.

## Upgrading v3 locks from earlier 0.3.0 builds

A v3 policy is a real, explicit assignment, so it is never treated as a
legacy Shield installation and never removed. Inspection reports it as
assigned (`policyNeedsUpgrade`), `needs_attention`, with repair available.
In a trusted workspace the scan upgrades it automatically
(`IdentityLockService.upgradePreviousLock`); **Repair Identity Lock** does
the same on demand.

- The lock is re-installed (policy v4, artifacts v7) from the v3 policy's
  own recorded snapshot — not from the live settings, which may have been
  edited (any difference then shows up as drift). `identityId`,
  `lockId` and `assignedAt` are kept: it is the same assignment.
- Commit enforcement is unchanged.
- A v3 "commit-only" lock (no `expectedGitHubLogin`) becomes a v4 lock
  with an incomplete push requirement: **every push is blocked**
  (`push-identity-not-configured`) and the repository reports
  `needs_attention` until a login is added to the identity and the lock is
  repaired. No login is ever filled in automatically.
- The upgrade is all-or-nothing like an assignment. A v3 commit-only lock
  could have left a foreign `pre-push` hook in place; the automatic
  upgrade never chains it, so it is refused and the v3 installation is
  left exactly as it was (still `needs_attention`); **Repair** asks whether
  to chain the hook and then completes the upgrade.
- Until a repository is upgraded, its v6 hooks keep running the v6
  evaluator copy installed next to them, i.e. they keep behaving like the
  earlier build. A v7 evaluator never enforces a v3 policy (it fails
  closed).

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
for pushes — and a migrated profile without one blocks every push until
one is added.

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
  blocked from every assigned repository.
- Enforcement lives in the hooks and evaluator copy installed in each
  repository, so a repository keeps the behavior of the build that last
  installed its lock until it is upgraded (opened in a trusted workspace,
  or repaired). In particular, a v3 "commit-only" lock from an earlier
  0.3.0 build keeps letting pushes through until it is upgraded.

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
