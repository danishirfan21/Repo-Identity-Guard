# Shield Mode: threat model and architecture

**Status: Phase 1 — architecture and threat model only.** No hooks are
installed by this phase, no toggle exists in the UI, and no Git mutation
happens as a result of anything in this document or the code that
accompanies it. Settings still shows Shield Mode as "Coming Soon," and that
remains true until a later phase actually installs hooks. This document
exists to fix the enforcement model *before* any code writes a hook to
disk, so that a later phase installs something already designed against a
threat model and Git-behavior reality, not against assumptions.

Phase 0 (see `feature/shield-mode` history) fixed a weakness in the Push
Account trust model that Shield enforcement would otherwise have inherited.
This phase does not touch that logic again — it defines what Shield *is*,
what it can and cannot promise, and where its data lives.

## What Shield Mode protects against

Shield Mode is a **safety net against accidental or ordinary unsafe Git
operations**, performed by:

- a human, typing `git commit` or `git push` directly;
- Claude Code, Codex, Cursor, Copilot, or any other AI coding agent running
  Git commands on the user's behalf;
- an integrated VS Code terminal;
- an external terminal, IDE, or Git GUI the user also has open;
- any other ordinary Git client operating normally.

The failure modes it's designed to catch are exactly the ones Repo Identity
Guard's existing capabilities already describe: committing with the wrong
identity, pushing to the wrong destination, committing directly on a
protected branch, committing mid-conflict, or pushing through a route the
matched profile doesn't trust. Shield's job is to make those mistakes
*impossible to make by accident*, not just visible after the fact in a
sidebar someone might not be looking at.

## What Shield Mode is explicitly **not**

**Shield Mode is not a security sandbox against a hostile process with
arbitrary shell access.** If something on the machine can run arbitrary
shell commands, it can also:

- run `git commit --no-verify` or `git push --no-verify` to skip Shield's
  hooks entirely;
- run `git config core.hooksPath /somewhere/else` (or the worktree-scoped
  equivalent — see below) to redirect Git away from Shield's hooks before
  ever invoking `git commit`/`git push`;
- delete or edit the hook files directly;
- delete or edit Shield's policy file directly;
- bypass Git entirely and push via the GitHub API, another Git
  implementation, or a raw `libgit2`/`git2` call that never invokes local
  hooks at all.

None of this is a bug in the design — it is a structural property of Git
hooks that no local, client-side mechanism can fully close. Shield Mode's
honest job is to raise the bar for an *ordinary, non-adversarial* mistake
(the overwhelming majority of real incidents: an agent that doesn't check
which repo it's in, a human on the wrong branch, a push remote that's
subtly wrong) — not to defend against a user or process that is
deliberately and knowingly trying to defeat it. Every UI Shield Mode ever
gets must say this plainly, the same way this document does, rather than
imply a stronger guarantee than Git's own hook model can provide.

This boundary is also why `--no-verify` is never something Shield tries to
detect and re-block after the fact, and never something the extension
should try to intercept, warn about with a modal, or otherwise fight — it
is Git's own sanctioned escape hatch, and Shield's degraded/broken states
(below) deliberately lean on it as the safety valve when Shield's own
mechanism misbehaves.

## `ShieldAction`

```ts
type ShieldAction = "commit" | "push";
```

A closed, explicit set. A future action (e.g. `force-push`, `branch-delete`)
would be a deliberate addition to this union, never inferred from an
arbitrary hook name or command line.

## Shield lifecycle states

Distinct from the SAFE / NOT SAFE / NOT CHECKED safety verdict — a repo can
be perfectly SAFE while Shield is `off`, and a repo can be NOT SAFE while
Shield is `active` and correctly blocking the operation that caused it.

| State | Meaning | Hook behavior (once hooks exist) |
| --- | --- | --- |
| `off` | Shield is not enabled for this repository. No policy file exists, or the user has explicitly disabled it. This is the state for **every** repository today, since no phase has shipped hook installation yet. | No hook installed; nothing changes about how Git behaves. |
| `active` | Shield is enabled, its policy file is present and passes validation, and its hooks are confirmed to be the ones actually invoked (`core.hooksPath` — local or worktree-scoped — still points at Shield's hooks directory). | The hook re-reads Git state and the policy at the moment of the action and blocks/allows accordingly. |
| `degraded` | Shield is enabled/intended, but something means enforcement is not fully guaranteed even though the user believes it is — e.g. a pre-existing third-party hook (Husky, `pre-commit`, Lefthook, a repo-specific script) already occupies the hook slot and Shield could not safely chain into it; or `core.hooksPath` has been redirected away from Shield's hooks directory since Shield last checked; or the matched profile referenced by the policy no longer exists in configuration. | A later phase must decide, per condition, whether the hook can still partially enforce or must get out of the way — but the state itself must always be surfaced somewhere the user will see it (sidebar, not just a log line), because "degraded" specifically means *the user may believe they are protected and are not, fully*. |
| `broken` | Shield's own hook is present but cannot function correctly — its policy file is missing (`policy-missing`) or fails to parse/validate (`policy-corrupt`), or Git state could not be read at all (`inspection-failed`). | Documented default posture (see below): **fail closed with a clear, actionable message**, never a silent no-op — and always point at `--no-verify` as the documented, intentional way to get past a broken hook, rather than leaving the user stuck. |

**On fail-open vs. fail-closed for `broken`:** the default posture Shield
commits to is fail-closed with a loud, specific error — a hook that can't
determine anything about policy or Git state should block the action and
say exactly why (`policy-missing`, `policy-corrupt`, `inspection-failed`)
rather than silently let the action through as if Shield weren't installed
at all. A broken hook that silently no-ops is strictly worse than one that
never existed, because it gives false confidence. `--no-verify` remains the
sanctioned way past a broken hook, so fail-closed never becomes a hard
deadlock — it becomes an honest, visible speed bump with an escape hatch
the user already knows about (it's documented as a bypass above, not a
secret one).

## `ShieldReason` and `ShieldDecision`

```ts
type ShieldReasonId =
  | "profile-unresolved"
  | "profile-conflict"
  | "commit-identity-mismatch"
  | "commit-identity-override"
  | "protected-branch"
  | "detached-head"
  | "repo-operation-in-progress"
  | "merge-conflicts"
  | "push-destination-mismatch"
  | "push-route-unverified"
  | "push-route-mismatch"
  | "push-route-override" // Phase 4: an SSH command override makes the route unverifiable
  | "push-account-mismatch" // Phase 5: the route authenticated, but as the wrong GitHub account
  | "push-account-unverified" // Phase 5: expectedGitHubLogin is set, but the account couldn't be confirmed
  | "policy-missing"
  | "policy-corrupt"
  | "inspection-failed";

interface ShieldReason {
  id: ShieldReasonId;
  message: string;
  capability?: Capability; // links back to the existing six-capability vocabulary, when applicable
}

interface ShieldDecision {
  action: ShieldAction;
  allowed: boolean;
  reasons: ShieldReason[];
  evaluatedAt: number; // epoch ms
}
```

`ShieldReasonId` values are a **public, additive-only contract**: once
shipped, an id's meaning never changes, and a hook script, a log line, or
future telemetry keys off the id — never off `message`, which can be
reworded freely. See `src/shield/reasonCatalog.ts` for the canonical
description of each id (declared as `Record<ShieldReasonId, …>` so the
TypeScript compiler itself rejects a reason id added without a
description).

A `ShieldDecision` is deliberately produced by collecting *every*
applicable reason before deciding, not by returning on the first problem
found — a denial should always explain everything wrong at once, the same
principle Review Details already follows for the sidebar's six capability
cards.

### Decisions are never cached

**A `ShieldDecision` must be recomputed by re-reading Git state at the
moment of the action, inside the hook itself, every single time — never
reused from an earlier sidebar scan.** The sidebar's `StatusSummary` can be
minutes old by the time a commit actually happens: an agent can act long
after the extension's last scan, a human can switch branches between
opening the sidebar and typing `git commit`, another terminal can change
`user.email` mid-session. A `ShieldDecision` that guards a real,
irreversible Git operation cannot inherit that staleness. This is why
`ShieldDecision` carries its own `evaluatedAt` rather than referencing a
`StatusSummary` by id or timestamp — it is not a view onto a prior scan, it
is its own independent evaluation.

## `ShieldPolicy`: intent, not cached status

```ts
const SHIELD_POLICY_VERSION = 1;

interface ShieldPolicy {
  policyVersion: 1;
  generatedAt: number; // epoch ms

  matchedProfileId: string;
  profileLabel: string;

  expectedGitName?: string;
  expectedGitEmail: string;

  approvedRepositoryKey?: string; // canonical host/owner/repo, lowercased

  approvedPushDestination?: {
    host?: string;
    owner?: string;
    repo?: string;
  };

  trustedSshHostAliases: string[];
  strictPushSetup: boolean;

  protectedBranches: string[];
  expectedBranchPatterns: string[];

  enabledActions: ShieldAction[];
}
```

The critical property: **a policy describes what the user asked for, not
what the last scan found.** It is generated from `Profile` fields and
non-secret `RepoFacts` (a canonical repo key, a push destination's
host/owner/repo, branch lists) — never from a `CapabilityResult` or
`StatusSummary`. A policy doesn't say "this repo was SAFE as of 2 minutes
ago"; it says "here is the identity, destination, and branch policy this
repository's Work profile expects," which the hook then checks *live*
Git state against at action time. This is the same distinction Phase 0's
Push Account fix depends on structurally: intent (a profile's
`trustedSshHostAliases`) versus a point-in-time observation (what host the
current push happens to resolve to) are different things, and a policy is
squarely the former.

### What a policy contains, and why each field is non-secret

Every field is either already visible in `settings.json` (all `Profile`
fields) or is itself non-secret, publicly-visible-anyway Git-facts data (a
canonical `host/owner/repo` string, a branch name). Nothing in
`ShieldPolicy` could not already be read by anyone with ordinary read
access to the repository and its remote.

**Never in policy, ever:** access tokens, passwords, private SSH key
material or fingerprints, credential-helper output, `.env` contents, or
anything else that would let a policy file itself become a secret worth
protecting. `validateShieldPolicy` in `src/shield/policy.ts` enforces this
mechanically — a policy object carrying a `token`, `accessToken`,
`password`, `privateKey`, `sshKey`, `credentials`, or `secret` key fails
validation outright, so a policy accidentally built from the wrong source
object can never silently persist to disk.

`policyVersion` is checked strictly, not just parsed and ignored: a policy
written by a different version of Repo Identity Guard than the one reading
it is treated as `policy-corrupt` rather than guessed at. Shield exists to
stop silent drift elsewhere in the system; it cannot tolerate silent drift
in its own on-disk format.

## Empirical research: how Git actually behaves

Everything below was verified against a real `git` binary (Git 2.43) in
disposable temporary repositories, and is now pinned down as an automated
regression test in `src/test/shieldGitTopology.test.ts` — not just this
document's prose, so a future Git version change would be caught, not
silently invalidate the architecture decision below.

### Normal repository

```
$ git rev-parse --path-format=absolute --git-dir
/path/to/repo/.git
$ git rev-parse --path-format=absolute --git-common-dir
/path/to/repo/.git
```

`--git-dir` and `--git-common-dir` are identical when there are no linked
worktrees.

### Linked worktree

```
# from the main worktree
$ git rev-parse --path-format=absolute --git-dir
/path/to/repo/.git
$ git rev-parse --path-format=absolute --git-common-dir
/path/to/repo/.git

# from a linked worktree
$ git rev-parse --path-format=absolute --git-dir
/path/to/repo/.git/worktrees/<name>
$ git rev-parse --path-format=absolute --git-common-dir
/path/to/repo/.git          # <- same as the main worktree
```

`--git-dir` is unique per worktree (each linked worktree gets its own
`worktrees/<name>` administrative directory). **`--git-common-dir` is
identical from every worktree of the same repository — the main one and
every linked one.** This is the one stable, absolute, worktree-independent
anchor Git itself provides.

### Hooks are shared across all worktrees, by default

```
# from the main worktree
$ git rev-parse --path-format=absolute --git-path hooks
/path/to/repo/.git/hooks

# from a linked worktree, same repository
$ git rev-parse --path-format=absolute --git-path hooks
/path/to/repo/.git/hooks   # <- identical
```

Git has **exactly one hooks directory per repository by default**, derived
from the common dir, shared by every worktree. There is no supported
concept of "install this hook for only this worktree" in ordinary Git
usage — installing `pre-commit`/`pre-push` into that one shared directory
automatically covers the main worktree and every linked worktree that
exists now or is added later.

### `core.hooksPath`, repo-scoped, redirects hooks for every worktree

```
$ git config core.hooksPath custom-hooks     # repo-level (--local)
```

...changes hook resolution for the main worktree **and every linked
worktree**, since `--local` config lives in the shared `config` file under
the common dir.

### `core.hooksPath`, worktree-scoped, redirects hooks for ONE worktree only

Requires `extensions.worktreeConfig = true` (opt-in, and most repos do not
have this on):

```
$ git config extensions.worktreeConfig true
$ git config --worktree core.hooksPath /somewhere/else   # from inside one linked worktree
```

This redirects hook resolution **for that one linked worktree only** — the
main worktree and any other linked worktrees are unaffected. This is the
one place Git *does* offer something worktree-scoped for hooks — but it is
an opt-in escape hatch a user or another tool would set deliberately, not
a mechanism Shield should build its own per-worktree enablement UX on top
of. Building "Shield enabled only in this worktree" on the exact same knob
that already reads as "someone silently redirected hooks away" would be
confusing and undermines the very case Shield exists to guard.

### `--no-verify` bypasses a hook unconditionally

A `pre-commit` hook that exits non-zero blocks `git commit`; the identical
command with `--no-verify` succeeds regardless of what the hook would have
said. This is documented above as an explicit, permanent, by-design
boundary of what Shield can enforce.

## Architecture decision: enablement is per-repository, not per-worktree

**Decision: (A) Shield enablement applies to the entire underlying
repository, including every linked worktree — not (B) individual
worktrees.**

This is not a preference; it follows directly from the empirical findings
above:

1. Git provides exactly one hooks directory per repository by default,
   shared by every worktree. Installing Shield's hooks is inherently a
   repository-wide action — there is no Git-native way to install a hook
   that runs in one worktree but not another.
2. The only mechanism that *could* fragment hook behavior per worktree
   (worktree-scoped `core.hooksPath`) requires an opt-in Git feature most
   repos don't have enabled, and is documented above as a bypass vector,
   not a building block. Layering Shield's own "which worktrees are
   protected" state on top of the same knob used to silently defeat
   protection would make the two indistinguishable from a hook's point of
   view.
3. A repository's identity, expected push destination, and branch policy
   — the actual content of `ShieldPolicy` — are properties of the
   repository and the matched profile, not of any one working directory.
   Nothing about `expectedGitEmail` or `protectedBranches` differs between
   a main worktree and a linked one; scoping enablement per-worktree would
   let the *same* repository, same profile, and same policy be "protected"
   in one working directory and not another for no reason connected to
   anything the policy actually describes.

Practical consequence for a later phase: hook installation targets
`<git-common-dir>/hooks/{pre-commit,pre-push}` exactly once per repository.
A hook invoked from any worktree resolves its own current branch, working
tree state, and `--show-toplevel` locally (per-worktree, as it must — a
rebase in `wt-a` doesn't mean `wt-b` is mid-rebase), but resolves *policy*
from the one shared location described next.

## Storage decision

**Shield's policy lives at `<git-common-dir>/repo-identity-guard/shield-policy.json`**,
where `<git-common-dir>` is the absolute path from `git rev-parse
--path-format=absolute --git-common-dir`, resolved fresh at the point of
use (never cached from a previous resolution, since a repo's own dir
layout doesn't move but resolving from the *correct* worktree each time
matters).

This satisfies every requirement:

- **No tracked repo files.** Everything under `.git/` is Git's own internal
  state and is never itself tracked — nothing here can be accidentally
  committed or pushed.
- **No secrets.** Enforced both by convention (see "What a policy
  contains" above) and mechanically by `validateShieldPolicy`.
- **No dependence on VS Code being open.** It's a plain JSON file on disk;
  a hook is a plain shell/Node script invoked directly by `git`, with no
  extension host, IPC channel, or running VS Code process required to read
  it.
- **Safely discoverable from a Git hook.** Every Git hook already runs with
  a working directory inside some worktree of the repository, so
  `git rev-parse --path-format=absolute --git-common-dir` is always one
  subprocess call away — no environment variable, no configuration, no
  guessing a path relative to `$0`.
- **Compatible with worktrees.** This is the direct payoff of the
  architecture decision above: because `--git-common-dir` is identical
  from the main worktree and from every linked worktree
  (`shieldGitTopology.test.ts` proves this empirically), a single policy
  file automatically applies uniformly across all of them, with no
  per-worktree bookkeeping, no synchronization, and no risk of two
  worktrees of the same repository silently disagreeing about policy.

Shield's metadata is namespaced under its own `repo-identity-guard/`
subdirectory (rather than loose files directly under `.git/`) for two
reasons: it can never collide with a file name Git itself or another hook
manager (Husky, `pre-commit`, Lefthook) might use, and it makes Shield's
entire footprint trivially identifiable and removable — deleting one
directory fully uninstalls Shield's data, leaving no orphaned files
scattered through `.git/`.

`src/shield/storage.ts` implements only the pure path derivation
(`shieldStorageDir`, `shieldPolicyFilePath`) — no filesystem I/O. Actually
reading and writing the policy file, and actually installing hooks into
`<git-common-dir>/hooks/`, is explicitly out of scope for this phase.

## Threat boundary summary

| Actor / mechanism | Can Shield stop it? | Notes |
| --- | --- | --- |
| A human forgetting which repo/branch they're on | Yes (once hooks exist) | The core use case. |
| An AI agent running `git commit`/`git push` without checking context | Yes (once hooks exist) | Also the core use case — agents don't know to type `--no-verify` unless told to. |
| An ordinary Git GUI or another IDE's Git integration | Yes (once hooks exist) | Any client that invokes real `git commit`/`git push` goes through the same hooks. |
| A human or agent deliberately running `--no-verify` | **No** | Documented, sanctioned Git behavior; not something Shield tries to detect or re-block. |
| A process with arbitrary shell access setting `core.hooksPath` | **No** | Repo-level or worktree-scoped, both bypass Shield's hooks entirely; documented above. |
| A process editing or deleting the policy file or hook scripts directly | **No** | Filesystem write access to `.git/` is filesystem write access; Shield cannot defend against a process that already has it. |
| A push made via the GitHub API or a Git implementation that skips local hooks | **No** | Local hooks only run for local Git operations; this is a structural limitation of the mechanism, not a bug. |

## Phase 2: the standalone evaluator

**Status: implemented, not yet wired to a Git hook.** This phase builds the
thing a future hook will invoke — the actual decision logic — without
installing anything into `<git-common-dir>/hooks/` and without any Shield
UI. Settings still shows "Coming Soon."

### Evaluator runtime decision

**The evaluator's shipped runtime is a POSIX shell script,
`resources/shield/shield-evaluate.sh`, using only `git` plus the shell
utilities that ship alongside `git` on every platform it runs on (`sh`,
`awk`, `sed`, `grep`, `tr`).** No Node, no Python, no `jq`, no `gh`.

This isn't a default — it follows from the hard requirement that **Shield
enforcement must work when VS Code is completely closed**, and from being
told explicitly not to assume `node`/`python`/`jq`/`gh` on `PATH`:

- **Linux / macOS**: `/bin/sh` is part of the base OS; Git itself already
  requires a POSIX shell to run its own plumbing (`git-sh-setup`, various
  bundled scripts), so a hook written in POSIX `sh` needs nothing beyond
  what a working `git` install already implies.
- **Windows, via Git for Windows**: Git for Windows always executes hook
  scripts through the POSIX shell interpreter it bundles with its own
  installer (the MSYS2-based `sh.exe`/`bash.exe` that also ships `awk`,
  `sed`, and `grep`) — **not** `cmd.exe` or PowerShell, and regardless of
  what shell the user's own terminal happens to be. This is how every
  other shell-based Git hook (Husky, `pre-commit`, Lefthook, and Git's own
  sample hooks, which ship with a `#!/bin/sh` shebang) already works
  cross-platform without asking a Windows user to install anything extra.
  A hook that shells out to `resources/shield/shield-evaluate.sh` therefore
  runs on Windows the same way it runs everywhere else, using tooling Git
  for Windows already installed for its own use.

**Why not a self-contained helper binary (compiled Go/Rust, or a bundled
Node runtime)?** It would solve a problem this project doesn't have. The
three platforms above already guarantee a POSIX shell is available
wherever `git` itself is; a compiled binary would mean maintaining
per-platform (and per-architecture) build artifacts, code-signing concerns
on macOS/Windows, and a meaningfully larger `.vsix` — real, ongoing packaging
and release cost — to duplicate functionality `sh` already provides for
free. The instruction "do not introduce a runtime dependency merely because
development happens to use Node" cuts the same way against a bundled Node
binary: this codebase being TypeScript doesn't make Node the right choice
for an artifact whose entire job is to run when the TypeScript extension
that built it may not even be installed. If a future requirement genuinely
needs POSIX shell can't provide (real JSON schema validation, complex
per-ref push inspection at scale), that would be the moment to revisit this
decision — not preemptively now.

**A known, deliberate trade-off**: the shell script does lightweight
field-presence/version checks on the policy file (`policyVersion` must be
exactly `1`; `expectedGitEmail` must be present), not the full structural
JSON validation `validateShieldPolicy()` performs in TypeScript. Writing a
general-purpose JSON parser in portable POSIX shell is not a reasonable
scope for a hook script, and the policy file is always machine-generated
by `serializeShieldPolicy` (a stable, predictable `JSON.stringify(...,
null, 2)` layout — one scalar field per line, one array element per line)
that the shell script's `awk`-based line scanner is written against. A
hand-edited or otherwise unusually-shaped JSON file could in principle
slip past this lighter check; this is documented, not hidden.

### Interface

```
shield-evaluate.sh commit
shield-evaluate.sh push <remote-name> <remote-url>   [ref lines on stdin]
```

- **Exit 0** → allow the Git action. **Exit non-zero** → block it. This is
  the entire contract — nothing else about the process's behavior is part
  of the interface.
- A concise, human-readable reason is always written to **stderr**,
  prefixed with the stable machine-readable reason id(s) in brackets
  (e.g. `[protected-branch]`), never to stdout.
- The push interface matches Git's real `pre-push` hook contract exactly
  (`<remote-name>` and `<remote-url>` as argv, ref update lines on stdin)
  so wiring an actual hook in a later phase is a drop-in, not a redesign.
  Per-ref stdin inspection is accepted (drained, not left hanging) but not
  yet acted on in this phase — see "Push evaluation" below.

A pure TypeScript reference implementation of the same decision semantics
lives in `src/shield/evaluator.ts` (`evaluateCommit`, `evaluatePush`,
`evaluateFromPolicyLoad`). It is **not** what ships or runs at hook time —
its purpose is fast, exhaustive unit testing of the decision logic and a
single readable source of truth that the shell script is written against.
`src/test/shieldEvaluatorScript.test.ts` runs the *actual* shell script
against real temporary repositories and, for several scenarios, cross-checks
its verdict against the TypeScript evaluator fed equivalent facts, so the
two can't silently drift apart.

Both deliberately **do not call `computeStatus`**. That function mixes in
VS Code-specific concepts (Workspace Trust) that must never gate a
standalone hook decision, and it predicts a plain push from
`RepoFacts.pushRemoteUrl` computed by an earlier scan rather than
evaluating the actual remote/URL a real `pre-push` invocation provides.
Both problems would defeat the point of a standalone, action-time
evaluator. Where the underlying *rule* is identical to something
`statusEngine.ts`/`capabilityFactory.ts` already implements (generic SSH
hosts, wildcard-free trusted-alias matching, protected-branch exact
matching), the evaluator mirrors that rule faithfully — reusing
`parseRemoteUrl` directly in the TypeScript evaluator, and reimplementing
the same rule by hand in the shell script, since shell can't import a
TypeScript module — rather than reinventing new semantics.

### Commit evaluation: facts re-read at action time

Every fact below is re-read fresh by the evaluator itself, in the Git
action's own process/environment, at the moment of the action — never a
value cached from an earlier VS Code sidebar scan:

- effective author identity (`git var GIT_AUTHOR_IDENT`)
- effective committer identity (`git var GIT_COMMITTER_IDENT`)
- configured identity, `--worktree` ?? `--local` ?? `--global` (same
  precedence `RepoFacts` collection uses)
- current branch / detached HEAD (`git symbolic-ref -q --short HEAD`)
- in-progress merge/rebase/cherry-pick/revert (markers under the
  **current worktree's own** `--git-dir`, not the shared common dir —
  operation state is per-worktree, unlike the policy itself)
- unresolved merge conflicts (`git status --porcelain=v2`, `u` entries)

Because the evaluator runs *inside* the Git action's own invocation
(rather than being told about the environment secondhand by an extension
host), any `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/etc. environment
override or `-c user.email=...` passed on that exact command line is
already reflected in `git var`'s output — there's no separate step needed
to "detect" it.

**Commit blocks when:**

| Condition | Reason id |
| --- | --- |
| No policy file found | `policy-missing` |
| Policy file present but invalid/wrong version | `policy-corrupt` |
| Git state couldn't be read | `inspection-failed` |
| Effective identity wrong AND configured identity also wrong | `commit-identity-mismatch` |
| Effective identity wrong but configured identity is correct (environment/command-line override) | `commit-identity-override` |
| HEAD is detached | `detached-head` |
| Current branch is in `protectedBranches` | `protected-branch` |
| A merge/rebase/cherry-pick/revert is in progress | `repo-operation-in-progress` |
| Unresolved merge conflicts exist | `merge-conflicts` |

**Commit does NOT block on:**

- **Ordinary dirty working-tree state alone** (staged/unstaged/untracked
  changes, no conflicts, no in-progress operation) — this is normal
  mid-development state, exactly as `repoOperationDirtyResult` treats it
  as a non-blocking warning in the main engine.
- **Branch-pattern mismatch** (`expectedBranchPatterns`) — this is a
  non-blocking warning in the main engine
  (`branchPolicyPatternMismatchResult`), and this phase does not silently
  upgrade it into a hard Shield block. If a future phase wants Shield to
  treat pattern mismatches as blocking, that must be an explicit,
  documented architecture change with its own tests — not an incidental
  side effect of the evaluator's implementation.

**Not re-derived at hook time**: `profile-unresolved` and `profile-conflict`
exist as reason ids (Phase 1) but are not produced by this phase's
evaluator. A valid `ShieldPolicy` can only exist if a profile was already
resolved unambiguously at policy-*generation* time (by whatever future
phase writes the policy file from Settings/config) — the policy itself
carries exactly one matched profile's fields, not the full set of
configured profiles, wildcard owner patterns, or exact-repo overrides
needed to re-run full profile resolution. Re-deriving those ids at hook
time would mean either bundling substantially more (still non-secret, but
much larger and more complex) data into the policy, or re-implementing
`profileResolver.ts`'s wildcard/overlap logic a second time in POSIX shell.
Neither is justified by this phase's scope; a missing or invalid policy
already surfaces as `policy-missing`/`policy-corrupt`, which is the
closest honest signal available without that additional work.

### Push evaluation

The push evaluator's interface is built now, evaluated against real
action-time facts, with actual `pre-push` hook installation left for a
later phase (per the task's explicit scope for this phase). It accepts:

- **remote name** and **remote URL**, exactly as Git passes them to a real
  `pre-push` hook's argv — never `RepoFacts.pushRemoteUrl` predicted by an
  earlier sidebar scan, which could be stale or simply wrong for the
  specific push actually happening (a branch's `pushRemote` can differ
  from `origin`, `git push <url>` can target an arbitrary URL on the
  command line, etc.).
- **ref update lines on stdin**, matching the real hook contract
  (`<local-ref> <local-sha1> <remote-ref> <remote-sha1>` per line). This
  phase drains stdin (so a real hook invocation never hangs) but does not
  yet inspect individual ref updates — see "What's next" below.

**Destination matching is owner-based, not host-based.** A push through a
trusted SSH alias (`github-work`) has a literally different hostname than
the repo's canonical remote host (`github.com`) despite authenticating the
exact same account — comparing hosts would flag every alias-based push
(the very thing `trustedSshHostAliases` exists to allow) as a destination
mismatch. This mirrors `checkPushDestination` in `statusEngine.ts`
exactly, which also matches on owner/exact-repo-key, never on host alone.

**Push blocks when (updated by Phase 4 — see below for the override row and the fail-closed change to the "no approved destination" row):**

| Condition | Reason id | Blocking regardless of `strictPushSetup`? |
| --- | --- | --- |
| No/invalid policy | `policy-missing` / `policy-corrupt` | Yes |
| Push owner (and repo, if known) doesn't match the approved destination | `push-destination-mismatch` | **Yes, always** |
| HTTPS, unrecognized protocol, a generic host (`github.com`/`gitlab.com`/`bitbucket.org`), or a custom SSH alias not listed in `trustedSshHostAliases` | `push-route-unverified` | No — only when `strictPushSetup` is true |

~~If the policy never recorded an approved destination at all..., the
destination check is skipped rather than guessed at~~ — **this was
changed in Phase 4 to fail closed instead; see below.**

`push-route-mismatch` (an alias trusted only under a *different* profile
than the one matched here) is defined as a reason id but is **not**
produced by this phase's evaluator, for the same reason as
`profile-conflict` above: detecting it would require the policy to carry
other profiles' `trustedSshHostAliases` too, which the current
minimal-non-secret-policy design deliberately doesn't include. Left as a
named gap for a future phase to close deliberately, if it turns out to
matter in practice.

### Fail-closed behavior

Consistent with the Phase 1 lifecycle decision: **when Shield is enabled
for a repository but its policy can't be read, is invalid, or Git
inspection itself fails, the evaluator blocks the action** —
`policy-missing`, `policy-corrupt`, and `inspection-failed` are always
immediate, first-checked denials, before any other Git-state evaluation
even runs. A hook that can't determine anything meaningful must never
silently allow the action through as if Shield weren't installed; that
would be strictly worse than Shield not existing, because it manufactures
false confidence. `--no-verify` remains the sanctioned, already-documented
way past a hook in this state.

### What's next after Phase 2 (superseded below by Phase 3, except where noted)

- ~~Writing the policy file at all~~ — done in Phase 3 (`ShieldManager.enable`/`repair`).
- ~~Actual hook installation~~ — done in Phase 3 (pre-commit) and Phase 4 (pre-push).
- Per-ref push inspection (using the ref lines already accepted on stdin)
  for anything beyond destination/route — e.g. force-push detection, if a
  future phase decides that belongs in Shield. Still not implemented.
- Closing the `profile-unresolved`/`profile-conflict`/`push-route-mismatch`
  gaps above, if a future design decides they're worth the added policy
  complexity. Still open.
- A "Shield Mode" section in Settings/sidebar with an enable/disable
  toggle — Phase 3 added command-palette commands only, deliberately not a
  sidebar redesign; still open.

## Phase 3: installation lifecycle and pre-commit enforcement

Phase 3 makes Shield real: `ShieldManager` (`src/shield/manager.ts`)
installs, repairs, disables, inspects, and health-checks Shield for a
repository, and a generated pre-commit hook (`src/shield/artifacts.ts`)
wires the Phase 2 evaluator into an actual `git commit`. Four
command-palette commands (`Repo Identity Guard: Enable/Disable/Repair
Shield`, `...: Check Shield Health`) exercise this end to end without any
sidebar redesign.

### Mutation scope

`ShieldManager` writes and deletes only:

- `<git-common-dir>/repo-identity-guard/*` — Shield's own namespaced
  subdirectory under this repo's Git metadata (the policy file, and now
  also a copy of the evaluator script).
- `<hooksDir>/pre-commit`, where `hooksDir` is resolved fresh every time
  via `git rev-parse --path-format=absolute --git-path hooks` — never a
  guessed `.git/hooks` — and only when that exact path is empty or
  already carries Shield's own ownership marker.

It never sets `core.hooksPath` or any other repo-local Git config key:
empirically, the hooks directory `--git-path hooks` resolves to by
default is already writable directly and already shared by every worktree
(see "Hooks are shared across all worktrees, by default" above), so no
config write was needed to make installation work. It never touches
global Git config, SSH keys/config, credential managers/helpers, GitHub
credentials, or any tracked file in the working tree.

### Ownership and version markers, not a manifest file

Every file Shield writes (`pre-commit`, and the evaluator copy under
`repo-identity-guard/`) carries a `repo-identity-guard-shield-artifact vN`
comment marker (`src/shield/artifacts.ts`). This is deliberately the
*only* record of "Shield installed this" — there is no separate
`shield-manifest.json` tracking install state. `ShieldManager.inspect()`
re-derives `off`/`active`/`degraded`/`broken` from exactly what is on disk
right now:

| Condition | State |
| --- | --- |
| No Shield artifact anywhere (policy, evaluator copy, or an owned hook) | `off` |
| A `pre-commit` exists at the currently-resolved hooks path but has no Shield marker | `degraded` — never overwritten or deleted |
| Shield artifacts exist but the policy file is missing | `degraded` |
| Policy file exists but fails `validateShieldPolicy` | `broken` |
| Evaluator copy missing or unmarked | `degraded` |
| Owned hook missing (policy + evaluator present) | `degraded` |
| Policy valid, evaluator owned, hook owned, all at their current locations | `active` (plus a non-blocking "update available" reason if either artifact's embedded version is older than the current one) |

This has two consequences worth calling out:

- **A crash or interruption mid-`enable()` can never read back as
  `active`.** If the process dies after writing the policy but before the
  hook, the next `inspect()` sees exactly that — policy present, hook
  absent — and reports `degraded`. There is no cached "I finished
  installing" flag that could go stale relative to reality.
- **A later `core.hooksPath` redirect is caught for free.** If something
  changes `core.hooksPath` (repo- or worktree-scoped) after Shield
  installed, `inspect()` resolves `hooksDir` fresh via Git every time —
  it will simply stop finding Shield's owned hook at the new location and
  report `degraded`, with no need to remember "where did Shield install
  to last time." The old hook file left behind at the previous location
  is inert (nothing invokes it) and cleaned up the next time `disable()`
  runs from a context that still resolves there, or ignored otherwise —
  a known, acceptable trade-off given `core.hooksPath` itself is an
  already-documented full bypass (see the threat boundary table above).

### Existing-hook safety

`enable()`/`repair()` check hook-slot ownership *before* writing anything:
if `<hooksDir>/pre-commit` exists and does **not** carry Shield's marker,
activation is refused — Shield still writes its own policy and evaluator
copy (harmless and inert without a wired hook) but does not touch the
hook file, and `inspect()` reports `degraded` with a message naming the
exact path and telling the user to move the foreign hook aside and re-run
`Repair Shield`. `disable()` re-verifies ownership immediately before
deleting the hook file, so a hook that became foreign after Shield
installed it (replaced by something else in the meantime) is also never
deleted. More advanced coexistence (chaining into an existing hook
manager) is explicitly out of scope for this phase.

### The pre-commit hook

The installed hook (`buildPreCommitHookScript()` in
`src/shield/artifacts.ts`) contains no enforcement logic itself: it
resolves `git rev-parse --path-format=absolute --git-common-dir`, checks
for Shield's evaluator copy there, and — if present — runs it with
`commit` and relays a non-zero result as:

```
Repo Identity Guard Shield

COMMIT BLOCKED

Shield: [commit-identity-mismatch] Profile: Work
Expected: Danish Irfan <work@example.com>
Found: author Danish Irfan <personal@example.com>

Fix the repository identity or disable Shield for this repository.
```

If the evaluator copy is missing (a half-removed install), the hook
fails **open** (`exit 0`) rather than blocking an ordinary commit because
of Shield's own incomplete state — the same "never manufacture false
confidence, but also never manufacture a false block" posture as the
evaluator's own fail-closed behavior applies at a different layer (the
evaluator fails *closed* on a broken/missing *policy* once it's actually
running; the hook fails *open* on a missing *evaluator*, since at that
point there's no Shield installation left to trust either way, and the
existing behavior — no Shield hook at all — is the honest fallback).

Because the evaluator copy and the policy both live under the shared
git-common-dir (Phase 1's storage decision) and the hook itself is
installed once at whatever `--git-path hooks` resolves to (shared by
every worktree by default), one `enable()` call from any worktree
protects every worktree of that repository — confirmed end-to-end in
`shieldManager.test.ts`'s linked-worktree test, not just asserted.

### Empirical findings from this phase

- **`git commit --author="Name <email>"` IS visible to the pre-commit
  hook.** `git var GIT_AUTHOR_IDENT` (and the `GIT_AUTHOR_NAME`/
  `GIT_AUTHOR_EMAIL` environment variables Git sets for the hook's own
  process) reflect the `--author` override, confirmed against real Git
  2.43 both by hand and in an automated test. Shield blocks it exactly
  like an environment-variable override (`commit-identity-override`,
  since the repo's own config is untouched and still correct).
- **`git -c user.email=... commit` is also visible via the effective
  identity, but NOT via `git config --local`.** `-c` overrides show up in
  `git var GIT_AUTHOR_IDENT` (inherited by the hook through
  `GIT_CONFIG_PARAMETERS`), but an explicit `git config --local
  user.email` query — what the hook reads as "configured" — does not see
  it. This is exactly the override case, not the mismatch case, and
  matches how an environment-variable override behaves.
- **`git rebase --continue` does NOT invoke the pre-commit hook for the
  commit it creates internally**, confirmed against real Git 2.43: a
  pre-commit hook that unconditionally exits 1 does not stop
  `--continue` from completing successfully. This is a genuine,
  documented gap, not an oversight — Shield's `repo-operation-in-progress`
  reason still fires correctly for a *plain* `git commit` made while a
  rebase is in progress (e.g. conflict resolved and staged, `--continue`
  not yet run), which is the realistic path an ordinary `git commit`
  during a rebase actually takes, and is what
  `shieldManager.test.ts` exercises. A future phase considering a
  `post-rewrite`/`pre-rebase` hook, or accepting this as a known
  Shield boundary, should start from this finding rather than assuming
  `--continue` is covered.
- **A real `git commit` cannot reach the `merge-conflicts` reason at
  all**, because Git itself refuses to commit while unmerged files exist
  ("Committing is not possible because you have unmerged files") *before
  any hook runs* — confirmed in `shieldManager.test.ts`. Shield's
  `merge-conflicts` check is genuine defense-in-depth (exercised directly
  against `shield-evaluate.sh` in `shieldEvaluatorScript.test.ts`, and
  still correct to keep for e.g. a future hook context where Git's own
  guard doesn't apply), not something an end-to-end `git commit` test can
  observe.
- **`--no-verify` bypasses Shield's pre-commit hook entirely** — Git's
  own documented, unconditional escape hatch, exercised end-to-end in
  `shieldManager.test.ts`: a commit that would otherwise be blocked for a
  wrong identity succeeds under `--no-verify`. This is expected and was
  already documented as a permanent bypass in Phase 1; Phase 3 does not
  and cannot close it.

### What's next after Phase 3 (superseded below by Phase 4, except where noted)

- ~~A pre-push hook wired the same way~~ — done in Phase 4.
- Per-ref push inspection, the `profile-unresolved`/`profile-conflict`/
  `push-route-mismatch` gaps, and a Settings/sidebar Shield toggle — all
  still open, as listed above.
- Coexisting with a pre-existing third-party hook manager (Husky,
  `pre-commit`, Lefthook) instead of simply refusing to install
  alongside one.
- A `commit-msg` or `post-rewrite` hook, if a future design wants to catch
  `git rebase --continue`'s commits given the gap documented above.

## Phase 4: pre-push enforcement

Phase 4 wires the push evaluator into a real `pre-push` hook
(`buildPrePushHookScript()` in `src/shield/artifacts.ts`), installed and
managed by `ShieldManager` exactly like the pre-commit hook (independent
ownership check, independent foreign-hook safety, independent
active/degraded reporting per hook — see Phase 3's "Ownership and version
markers" table, now with a `pre-push` row alongside `pre-commit`).
`enable()`/`repair()` now set `policy.enabledActions = ["commit", "push"]`
unconditionally.

### The pre-push hook

Forwards Git's own pre-push argv (`$1` = remote name, `$2` = remote
location/URL — the actual resolved location Git is about to push to, not
a value read from `git remote -v`) and its own stdin (the real
`<local-ref> <local-sha1> <remote-ref> <remote-sha1>` lines) straight
through to the evaluator copy, unmodified. A blocked push prints:

```
Repo Identity Guard Shield

PUSH BLOCKED

Remote: origin
Destination: git@github-personal:acme/backend.git

Shield: [push-destination-mismatch] Profile: Work
Expected approved destination: github-work:AcmeSoftware/acme-frontend
Reason: Push destination changed since Shield approval (this push would go to acme/backend).

Fix the push destination/route or disable Shield for this repository.
```

Like the pre-commit hook, it fails **open** (`exit 0`) if the evaluator
copy is missing — a half-removed Shield install must never be the reason
an ordinary push is blocked.

### Push destination now fails closed (changed from Phase 2)

Phase 2 explicitly skipped the destination check when the policy held no
`approvedPushDestination` ("nothing to compare against, don't guess").
Phase 4 changes this deliberately: **an unresolved/absent approved
destination is now itself a `push-destination-mismatch`**, blocking the
push. Rationale, directly from the task that specified this phase:

> If Shield was enabled while push destination was
> `git@github-work:acme/backend.git` and the user/agent later changes the
> push URL to `git@github-personal:someone/backend.git`, the next push
> must be blocked until the Shield policy is deliberately refreshed. Any
> ambiguity should fail closed for an active Shield.

An absent approved destination is exactly this kind of ambiguity — it
means Shield cannot confirm *any* destination is compatible with what was
approved, which is a strictly more dangerous unknown than "the owner
doesn't match," not a lesser one. This also closes what would otherwise
be a loophole: a direct `git push <url>` to an ad hoc destination Shield
never had visibility into no longer sails through uncontested. This
change is unconditional (not gated by `strictPushSetup`), matching every
other destination-mismatch check.

### Route trust and profile-bound SSH aliases (unchanged model, now enforced)

Route trust still uses exactly the Phase 0 model: only an alias explicitly
listed in the *matched* profile's `trustedSshHostAliases` counts as
trusted; a custom-looking alias that was never listed is not trusted just
for not being one of the well-known generic hosts
(`github.com`/`gitlab.com`/`bitbucket.org`). Under a strict profile: HTTPS
blocks, a generic SSH host blocks, an unlisted alias blocks, a listed
trusted alias passes the route check. As always, "passes" means "this is
a route trust decision, not cryptographic proof of the GitHub account
behind it" — no message anywhere claims otherwise (swept by a dedicated
test in both `shieldEvaluator.test.ts` and `shieldPrePush.test.ts`).

### Action-time SSH overrides make a route unverifiable

`GIT_SSH`, `GIT_SSH_COMMAND`, and the *effective* `core.sshCommand` config
(any scope — worktree/local/global config, **and** a command-scoped `git
-c core.sshCommand=...`, which shows up identically to a persisted value
through a plain `git config --get core.sshCommand` query with no scope
restriction) can each redirect which program actually speaks SSH for a
push, regardless of what the URL's host claims. Any of them being set at
push time now produces `push-route-override` instead of the usual
alias-trust outcome — checked *before* alias trust, so an override can't
be masked by an otherwise-trusted-looking host. Like route-unverified,
this only blocks when `strictPushSetup` is true; it is specifically a
route-trust concern, not a destination concern.

This inspects only whether these three mechanisms are *set* — never their
contents, never SSH key material, never `~/.ssh/config`, and it makes no
network call. A documented, accepted limitation: it cannot detect an
attacker shadowing the literal `ssh` executable via `PATH` (git's default
SSH invocation, with none of the three overrides set, simply resolves
`ssh` via `PATH` like any other command) — `shieldPrePush.test.ts` itself
relies on exactly this technique to fake a working SSH transport for its
"should succeed" tests without a real SSH daemon, which is precisely why
it's called out here as a real, not merely theoretical, blind spot.

### Empirical findings from this phase

- **Git does not invoke the pre-push hook at all if the SSH transport
  fails outright.** An override pointed at a broken command (e.g.
  `/bin/false`) makes Git fail during connection/ref-advertisement with
  its own `fatal: Could not read from remote repository` — before the
  hook ever runs. To prove Shield's hook itself is what blocks an
  override (not Git's transport failing first), every override test in
  `shieldPrePush.test.ts` points the override at a transport that would
  actually have succeeded (see the `PATH`-shadowed fake `ssh` above),
  confirming the block is Shield's and that it prevented a push that
  otherwise would have gone through.
- **`file://` (and other generic `<scheme>://` URLs) were silently
  misparsed by the shell script before this phase.** The script's `case`
  statement only special-cased `https?://` and `ssh://`; anything else
  containing a colon fell through to the scp-like branch, so
  `file:///tmp/x/Owner/repo.git` was parsed as SSH host `"file"` — wrong,
  and inconsistent with the TypeScript reference (`parseRemoteUrl`, which
  correctly classifies any other `scheme://` as protocol "unknown" via
  `new URL(...)`). Fixed with a `*://*` case mirroring the TS behavior
  exactly (including the authority-less `file:///path` shape, where the
  host is empty) and cross-checked in `shieldEvaluatorScript.test.ts`.
  Found while building this phase's own test harness (a `file://` bare
  remote was the natural way to test a real, working, non-SSH transport)
  — a genuine pre-existing bug, not introduced by Phase 4.
- **A second real bug, also found via this phase's testing:** the pre-commit
  and pre-push hook shims strip the evaluator's own multi-reason summary
  line from their output via `grep -v '^Shield: BLOCKED'` — but
  `fail_immediately()` (used for `policy-missing`/`policy-corrupt`/
  `inspection-failed`) originally emitted `Shield: BLOCKED [id]: message`,
  which that same filter also matched and silently swallowed. A real
  `git push`/`git commit` against a missing or corrupt policy would print
  Shield's banner with an empty reason section. Fixed by changing
  `fail_immediately()`'s format to `Shield: [id] message` (matching
  `add_reason`'s per-line format, distinct from the one summary line the
  filter is meant to strip). Caught by `shieldPrePush.test.ts`'s
  missing/malformed-policy tests actually going through the real
  installed hook rather than invoking the evaluator script directly.
- **`git push --no-verify` bypasses Shield's pre-push hook entirely** —
  Git's own documented, unconditional escape hatch, exercised end-to-end
  in `shieldPrePush.test.ts`: a push to a destination that would
  otherwise be blocked succeeds under `--no-verify`, and the remote ref is
  updated. This is expected, already documented as a permanent bypass in
  Phase 1, and outside Shield's accidental-misuse threat model — Phase 4
  does not and cannot close it.

### What's next after Phase 4 (superseded below by Phase 5, except where noted)

- Per-ref push inspection (force-push detection, etc.) using the ref
  lines the hook already forwards but the evaluator doesn't yet inspect.
- The `profile-unresolved`/`profile-conflict`/`push-route-mismatch` gaps.
- A Settings/sidebar Shield toggle and status surface — still
  command-palette-only.
- Coexisting with a pre-existing third-party hook manager, for both hooks.
- Detecting a shadowed `ssh` executable on `PATH` — an accepted, disclosed
  limitation, carried forward unchanged into Phase 5 (see below).

## Phase 5: verified GitHub SSH account binding

Phase 4 gave strict Shield route **trust**: "this SSH alias is one you,
the user, vouched for." Phase 5 goes one step further for GitHub SSH
specifically: **verification** — "this SSH route currently authenticates
to the specific GitHub account this profile expects," checked live,
against the real GitHub endpoint, at push time.

This phase is deliberately GitHub-first and narrowly scoped. It does not
attempt to solve account verification for every Git host, and it does
not touch HTTPS at all.

### Three distinct concepts, never conflated

`Profile` gains one new field:

```ts
interface Profile {
  gitEmail: string; // Git commit author/committer email — local only, never authenticated
  expectedRemoteOwners?: string[]; // the GitHub REPOSITORY's owner/org — who the repo belongs to
  expectedGitHubLogin?: string; // the GitHub ACCOUNT this route should authenticate as — who is pushing
  // ...
}
```

These are three genuinely different facts, and Shield has always kept
them separate:

- **Git commit email** (`gitEmail`) — what identity Git writes into a
  commit. Purely local; nothing authenticates it. Checked by
  `evaluateCommit`, unrelated to pushing at all.
- **GitHub repository owner/org** (`expectedRemoteOwners`, and the
  push-destination's `owner`) — who the *repository* belongs to. Checked
  by `destinationReasons`, unrelated to who is doing the pushing.
- **GitHub authenticated username** (`expectedGitHubLogin`, new in this
  phase) — who the *SSH connection itself* proves to be, live, via
  GitHub's own SSH self-identification convention. This is the only one
  of the three that involves a network call or a claim about a real
  GitHub account.

A repo owned by `AcmeCorp` can still be pushed to by an SSH key
belonging to any GitHub account with write access; only
`expectedGitHubLogin` ties the push's *route* to one specific expected
login.

### Only for SSH, only under strict, only on an already-trusted route

Account verification is never attempted unless **all** of the following
hold:

1. `strictPushSetup` is true (route trust and account verification are
   both strict-only features — a relaxed profile never runs either).
2. `expectedGitHubLogin` is set on the matched profile. Leaving it unset
   means Shield makes no claim at all about who authenticated — Phase
   0-4's route-trust-only behavior, unchanged.
3. The push's route already resolved to a **trusted SSH alias** with
   **no SSH command override present** (`routeReasons` found nothing
   wrong). An untrusted host, a generic host, HTTPS, or an active
   `GIT_SSH`/`GIT_SSH_COMMAND`/`core.sshCommand` override already
   produces its own blocking reason (`push-route-unverified` /
   `push-route-override`) — account verification is never attempted on
   top of those, and never overrides or duplicates them.

HTTPS remotes remain entirely unverified under strict account
enforcement in this phase, by design — see "What's next" below.

### GitHub's SSH self-test, and its footgun

GitHub supports testing SSH authentication with a well-known
noninteractive command:

```sh
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=<n> git@<host>
```

which never opens a shell, but replies with a line naming the
authenticated identity — e.g. `Hi danish-work! You've successfully
authenticated, but GitHub does not provide shell access.` **GitHub's SSH
endpoint commonly exits with status 1 even on fully successful
authentication** (it genuinely has nothing to hand back), so the exit
code is never treated as a pass/fail signal by itself — only the
response text is. `parseGitHubSshAuthOutput` (`src/shield/
githubSshVerification.ts`) — the pure, exhaustively unit-tested reference
for the shell script's own `verify_github_account` text matching — takes
no exit-code parameter at all, by design, so a caller can't accidentally
gate on it.

`StrictHostKeyChecking=yes` means an unknown or changed host key makes
the connection **fail**, not silently (or interactively) succeed —
Shield must never auto-accept a host key on the user's behalf. When this
happens, the push is blocked as `push-account-unverified` with a message
telling the user to verify the host key fingerprint themselves (e.g. run
the SSH command once, interactively, outside Shield) and accept it —
Shield never does this for them.

### `IdentitiesOnly yes`: what makes a route "strongly bound"

Trusting an SSH alias's *host* is not the same as trusting *which key*
answers for it: without `IdentitiesOnly yes` in that alias's effective
configuration, `ssh-agent` may offer any key it has loaded, not
necessarily the one the alias's config file actually names. Before ever
attempting the network probe, Shield inspects `ssh -G <alias>`'s
effective configuration (a local, read-only check — no network call) and
requires an exact `identitiesonly yes` line. Absent that, the route is
left `push-account-unverified` with an explanation, and the network
probe is never even attempted — Shield does not invent certainty by
running a check that couldn't mean anything without this precondition.

### Never inventing certainty: every outcome that isn't a clean match blocks

`GitHubAccountVerificationOutcome` (`src/shield/githubSshVerification.ts`)
is a closed set, and every member other than a matching
`authenticated-user` results in `push-account-unverified` under strict
Shield — never a silent pass:

- **`authenticated-user`** — GitHub named a personal login. Compared
  case-insensitively against `expectedGitHubLogin`; a mismatch is
  `push-account-mismatch` (allowed only when it matches exactly).
- **`authenticated-deploy-key`** — GitHub named a deploy-key/App-
  installation identity, shaped `owner/repo` rather than a personal
  username. This can never be soundly compared to a personal
  `expectedGitHubLogin`, so it's always unverifiable — never guessed at
  either way.
- **`permission-denied`** — SSH connected but authentication itself was
  refused; no identity was ever established.
- **`host-key-unverified`** — see above.
- **`timeout`** — the connection didn't complete within
  `REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT` (default 5 seconds).
- **`identities-not-isolated`** — see `IdentitiesOnly` above.
- **`malformed`** — output that doesn't match any recognized GitHub
  response shape. Never pattern-matched loosely to force a verdict either
  way; preserved verbatim for a human to look at, not parsed further.

### The exact bounds `verify_github_account` honors

Matching the task's own constraints, byte for byte:

- Only ever invoked for an SSH-protocol push.
- Only ever invoked when explicitly required by a strict Shield profile
  with `expectedGitHubLogin` set — never unconditionally, never for a
  relaxed profile.
- Never reads private key contents, and never opens any file under
  `~/.ssh` at all.
- Never copies, moves, or generates a key.
- Never modifies `~/.ssh/config`, `known_hosts`, or any other SSH
  configuration.
- Never starts, queries, or otherwise touches `ssh-agent` state.
- Never stores a password or passphrase anywhere.
- The only network activity is the ordinary SSH connection
  (`ssh -G`, then `ssh -T`) the push itself would use anyway, to ask
  GitHub who it authenticated — nothing is sent anywhere else.

### The override rule still holds: verify once, push through the same route

Account verification is only meaningful if the actual `git push` that
follows uses the exact same SSH behavior that was verified. This is
already enforced structurally, not by extra bookkeeping:
`verify_github_account` is only ever reached from inside
`evaluate_push` after `SSH_OVERRIDES` has already been checked for
`GIT_SSH`/`GIT_SSH_COMMAND`/`core.sshCommand` (including a
command-scoped `-c core.sshCommand=...`) — any of those present already
produces `push-route-override` and short-circuits before account
verification is ever attempted. Shield never verifies one SSH command
and then lets Git push using a different one; it makes that structurally
impossible rather than merely likely.

### Empirical findings from this phase

- **Real captured GitHub SSH response shapes were used to build the
  parser** (`Hi <user>! You've successfully authenticated, but GitHub
  does not provide shell access.`, `Permission denied (publickey).`, the
  `StrictHostKeyChecking=yes` host-key-refusal message, `ssh`'s own
  `Connection timed out` phrasing) — every shape has a dedicated unit
  test in `src/test/githubSshVerification.test.ts`, none of which spawns
  `ssh` or touches a network.
- **A deploy-key/App-installation identity is genuinely a different data
  shape than a personal login**, not just an edge case to reject —
  GitHub literally names it `owner/repo` in the same response format a
  personal account uses. Comparing it against `expectedGitHubLogin` with
  ordinary string equality would occasionally produce a false negative
  that looks like a real mismatch instead of the "this can't be checked
  at all" verdict it actually is — hence its own `authenticated-
  deploy-key` outcome, never folded into `authenticated-user`.
- **CI tests mock the network entirely**, extending Phase 4's PATH-
  shadowed fake `ssh` technique: the same fake binary now also answers
  `ssh -G <alias>` and `ssh -T ... <user>@<alias>` with a response
  scripted per test via environment variables
  (`src/test/shieldGitHubAccountBinding.test.ts`), so the full real hook
  → real evaluator → real `ssh -G`/`ssh -T` → real (bare-repo) `git push`
  path is exercised end-to-end without ever contacting real GitHub.

### Limitations (documented, not hidden)

- **HTTPS remains entirely unverified** under strict account enforcement
  in this phase, regardless of `expectedGitHubLogin` — solving HTTPS
  credential-helper/token identity is explicitly out of scope here (see
  "What's next" below).
- **A shadowed `ssh` executable on `PATH`** is still invisible to Shield
  (carried forward from Phase 4, unchanged) — and now, additionally, one
  could in principle answer `ssh -G`/`ssh -T` with fabricated output
  convincing enough to pass verification. This is the same class of
  limitation as Phase 4's, not a new one Phase 5 introduces: anything
  that can shadow `ssh` on `PATH` already has equivalent control over the
  push itself.
- **Network latency/flakiness is a real, expected failure mode.** A
  strict profile with `expectedGitHubLogin` set means every push pays
  for a live SSH round-trip; a slow or unreachable network produces
  `timeout`/unverified, blocking legitimate pushes exactly as
  designed — this is a deliberate trade-off of this feature, not a bug.
- **No manual/on-demand "verify now" command yet.** The task allows
  account verification to run "when explicitly requested" as well as
  "when required by strict Shield"; only the latter is wired up in this
  phase (automatically, at push-hook time). A user-facing command to run
  the same check on demand — useful for diagnosing a `degraded`/blocked
  setup without attempting a real push — is left for a future phase.
- **No in-repo caching of a verification result.** Every strict push with
  `expectedGitHubLogin` set re-verifies from scratch — deliberately, per
  "decisions are never cached" (see above), but it does mean the network
  cost is paid every time, not amortized.

### What's next after Phase 5 (superseded below by Phase 6, except where noted)

- A manual/on-demand "Verify GitHub Account" command, independent of a
  real push.
- HTTPS account verification (e.g. via a credential helper or `gh api
  user`) — a different, larger problem deliberately deferred.
- Per-ref push inspection (force-push detection, etc.).
- The `profile-unresolved`/`profile-conflict`/`push-route-mismatch` gaps.
- A Settings/sidebar Shield toggle and status surface — still
  command-palette-only.
- Coexisting with a pre-existing third-party hook manager, for both
  hooks — resolved below.

## Phase 6: hook coexistence, worktree correctness, integrity, and recovery

Everything through Phase 5 assumed Shield was the only thing that would
ever want a `pre-commit`/`pre-push` hook. Phase 6 makes Shield safe to
enable in a repository that already runs Husky, `pre-commit`, lint-staged,
or a hand-written hook — without ever silently destroying or replacing
that tooling — and makes Shield's own health reporting catch the specific
ways an installation can drift or be tampered with over time.

### Research: does Git have a native multi-hook mechanism now?

Checked directly against the Git version this repository's dev/CI
environment actually runs (`git --version` → 2.43.0), including the
newest hook-related plumbing command:

```
$ git hook run -h
usage: git hook run [--ignore-missing] [--to-stdin=<path>] <hook-name> [-- <hook-args>]
```

`git hook run` (added in Git 2.36) still resolves and runs **exactly one
script** for a given hook name — the same single-file-per-`<hookname>`
model Git has always had, whether that file lives under `<git-dir>/hooks`
or wherever `core.hooksPath` points. There is no `hooks.d`-style
multi-script directory convention anywhere in core Git, in this version or
any later one at the time of writing. Conclusion: **there is no cleaner
native coexistence mechanism to fall back to** — chaining has to be
Shield's own responsibility, in the hook script itself, for every
supported Git version alike. This finding is why nothing in this phase is
gated behind a Git version check: there was no newer feature found that
would justify one.

Shield's minimum supported Git version is **2.9** (when `core.hooksPath`
— which `getHooksDir`'s `git rev-parse --git-path hooks` fundamentally
depends on for correct worktree/hooksPath resolution — was introduced).
Every other Git invocation Shield makes (`rev-parse`, `config`, `var`,
`symbolic-ref`, `status --porcelain=v2`, `worktree list`) predates that by
a wide margin. Nothing in Phase 6 raises this floor.

### Hook coexistence: chaining is explicit opt-in, never automatic

Default behavior (`chainForeignHooks` unset) is **completely unchanged**
from Phase 3/4/5: a foreign hook already occupying a slot Shield wants is
left untouched, byte-for-byte, and Shield simply doesn't install into
that slot (`degraded`, with a specific reason). This is still the
out-of-the-box behavior — nothing about coexistence is silent or
automatic.

Passing `chainForeignHooks: true` to `enable()`/`repair()` is how a user
deliberately opts into chaining. What actually happens:

1. The foreign hook's exact bytes and executable permission are moved to
   a sidecar file, `<hookPath>.repo-identity-guard-original`, in the same
   hooks directory.
2. Shield's own hook shim is installed at the original path.
3. At run time, Shield's hook shim evaluates its own policy **first**. If
   Shield blocks, the chained original is never invoked at all — a
   deliberate execution-order choice: Shield's check is cheap and local,
   and short-circuiting avoids running a foreign tool (a linter, a
   formatter that rewrites files) on an operation Shield was going to
   reject anyway.
4. If Shield allows the action, it hands off to the chained original hook
   with the exact same argv and stdin Git gave Shield's own hook, and the
   original's own exit code becomes the final result. A chained tool's
   own failure is never silently swallowed — the whole operation still
   fails when the original hook does.

For `pre-push` specifically, Git feeds the `<local-ref> <local-sha1>
<remote-ref> <remote-sha1>` lines on stdin exactly once, and both the
evaluator AND a chained original hook may need to read them — so the
wrapper captures stdin to a private temp file up front (falling back to a
PID-suffixed fixed path if `mktemp` itself is unavailable) and feeds that
same captured content to each consumer as an independent read, cleaned up
via a shell `trap ... EXIT`.

**Never guesses when it's unsafe to proceed:** if a sidecar already
exists at the exact path a new chain would use (a previous chain that was
never cleanly disabled, or something else wrote there), `enable()` fails
that hook's write closed — neither the existing sidecar nor the new
foreign hook is touched — rather than silently deciding which one to
keep.

**Repairing an already-chained hook is idempotent**: `enable()`/
`repair()` recognize a slot Shield already owns (marker present) and
never re-chain on top of it or disturb an existing sidecar.

### Restoring exactly on uninstall

`disable()` restores a chained original to its exact original path,
byte-for-byte, executable bit included, and removes the sidecar — the
precise reverse of chaining. This restoration is gated on the same
ownership check `disable()` already used before deleting a Shield-owned
hook in every earlier phase: it only ever fires when the CURRENT occupant
of the hook path is still Shield's own. If something else has since
overwritten that slot, the sidecar is left exactly where it is (never
deleted, never blindly restored over unrelated content) and `disable()`
reports it explicitly so the user can resolve it by hand.

### Surviving extension upgrades

Nothing about chaining depends on extension-install-path state: the
sidecar's location is a pure naming convention
(`SHIELD_CHAIN_ORIGINAL_SUFFIX`) shared between the hook-script template
(`artifacts.ts`) and `ShieldManager`, and the hook script looks it up via
`dirname "$0"` at run time — so an extension upgrade that regenerates the
hook shim (via "Repair Shield") keeps finding the exact same sidecar. The
hook shim's own content is identical whether or not a chain is active
(the `[ -f "$ORIGINAL_HOOK" ]` check simply finds nothing when there
isn't one) — there is deliberately only ever one script variant to keep
in sync with the artifact version, not two.

`SHIELD_ARTIFACT_VERSION` was bumped to **3** this phase (both hook shims'
content materially changed to add the chaining lookup; the evaluator's
version marker was bumped alongside it for consistency, though its own
enforcement logic is unchanged this phase) — an existing Phase 3/4/5
install correctly reports "a newer hook is available, repair to update"
until repaired.

### Worktree correctness

`getHooksDir` (via `git rev-parse --git-path hooks`) already accounted
for `core.hooksPath` at every scope before this phase — Phase 6 adds the
test matrix that proves it, plus one new diagnostic (`core.hooksPath`
drift detection, below). Verified directly against real repositories with
real linked worktrees:

| Scenario | Result |
| --- | --- |
| Main worktree only | `active` after `enable()`, as always. |
| A linked worktree, added AFTER `enable()` from the main worktree | Reports `active` immediately — no separate enable needed, since hooks (default) and policy/evaluator (always) live under the shared git-common-dir. |
| Multiple linked worktrees simultaneously | All report `active` from a single `enable()`. |
| `extensions.worktreeConfig` off (default) | `core.hooksPath` (if set at all) is repo-wide; every worktree resolves the same `hooksDir`. |
| `extensions.worktreeConfig` on, `core.hooksPath` set with `--worktree` scope in ONE linked worktree only | That worktree's `hooksDir` resolves to the alternate path — Shield correctly reports it NOT active there (hooks aren't installed at the new path), while the main worktree and any other linked worktrees, untouched by that scoped override, correctly stay `active`. Shield never claims a single global ACTIVE state that papers over one worktree actually being unprotected — `inspect()` is always called (and answers) per-repoRoot, i.e. per-worktree. |
| Shared git-common-dir | `policyPath`/`evaluatorPath` are asserted identical (same absolute string) from the main worktree and a linked one. |

The one gap this leaves, explicitly: Shield has no mechanism to
proactively warn "you enabled Shield here, but a linked worktree has its
own scoped `core.hooksPath` and isn't covered" — the affected worktree's
own `inspect()` correctly reports its own true state, but nothing
currently cross-checks worktrees against each other. See "What's next"
below.

### Integrity: what's detected, and what deliberately isn't auto-fixed

`ShieldInspection` gained three new pieces of state — `evaluatorModified`,
`hooksPathCustomized`, `policyProfileDrift`, `pushDestinationDrift` — and
per-hook `contentModified`/`hasChainedOriginal`. **None of these are ever
computed and then silently repaired.** `inspect()` remains, as in every
earlier phase, 100% read-only; turning `degraded`/`broken` back into
`active` always requires an explicit `enable()`/`repair()` call.

| Condition | Detected via | Resulting state |
| --- | --- | --- |
| Missing Shield hook | `ownership === "absent"` for a governed action | `degraded` |
| Modified Shield hook (marker kept, body hand-edited) | Exact content compared against `spec.build()` when `version === SHIELD_ARTIFACT_VERSION` | `degraded` (was previously indistinguishable from a healthy hook — a real gap this phase closes) |
| Missing evaluator | `evaluatorPresent === false` | `degraded` |
| Evaluator modified (marker kept) | Exact content compared against the caller-supplied `evaluatorScriptSource` — **opt-in**: `inspect()` never assumes a source path, so this check is skipped (never "unknown," always `false`) unless the caller passes it | `degraded` |
| Incompatible/outdated evaluator or hook version | `version !== SHIELD_ARTIFACT_VERSION` (older → "repair available"; newer → "incompatible, update the extension") — reclassified this phase from "active, but here's a note" to `degraded`, since an outdated/incompatible artifact is a real integrity gap, not just an FYI | `degraded` |
| Missing/corrupt policy | Unchanged from Phase 3 (`policyPresent`/`validateShieldPolicy`) | `degraded`/`broken` |
| Policy version mismatch | Unchanged — `validateShieldPolicy` rejects an unrecognized `policyVersion` outright | `broken` |
| `core.hooksPath` changed after activation | `getCoreHooksPathConfig` (new) surfaces the current value; combined with a governed hook being missing from the newly-resolved `hooksDir`, the reason names `core.hooksPath` specifically instead of a generic "hook is missing" | `degraded` |
| Foreign hook appeared after activation | Same `ownership` re-derivation `inspect()` always did — no new mechanism needed, just confirmed by a dedicated test this phase | `degraded` |
| Approved push destination changed | **Opt-in**: `ShieldInspectOptions.currentPushDestination`, compared owner/repo the same way the evaluator itself compares them | `degraded` |
| Account verification configuration changed (e.g. `expectedGitHubLogin` edited in Settings) | **Opt-in**: `ShieldInspectOptions.currentProfiles`, matched by `matchedProfileId`, compared field-by-field (`gitName`, `gitEmail`, `strictPushSetup`, `expectedGitHubLogin`, `trustedSshHostAliases`) against what's baked into the policy | `degraded` |

The two "opt-in" checks (`currentProfiles`, `currentPushDestination`) are
deliberately not run by a bare `inspect(repoRoot)` call: computing them
needs live data (the current profile list, a fresh remote scan) that only
a caller already holding it can supply cheaply — `inspect()` itself makes
no Git calls beyond what it already needed and never re-implements
profile resolution. A future sidebar/status-bar integration that already
has this data on hand can pass it through for the extra drift coverage;
until then, a periodic explicit "Check Shield Health" (already a command)
without these options still catches every non-drift condition above.

### Install/uninstall robustness

- **Atomic replacement**, unchanged mechanism from Phase 3
  (`writeFileAtomic`: write to a same-directory temp file, then rename) —
  verified this phase with a dedicated test asserting no stray `.tmp-*`
  file survives a normal `enable()`.
- **Interrupted/partial installs** are handled by construction, not by
  special-casing: `inspect()` re-derives state from whatever is actually
  on disk, so a process that died after writing only the policy file
  (before the evaluator or hooks) is reported `degraded` with the correct
  specific reason, and a subsequent `enable()`/`repair()` completes it —
  verified directly by manufacturing exactly that on-disk state and
  checking both the diagnosis and the repair.
- **`disable()` never deletes a file it doesn't recognize as its own**,
  even one sitting inside Shield's own storage subdirectory — verified by
  planting an unrelated file there and confirming both it and the
  now-non-empty storage directory survive `disable()`.
- **`disable()` is a safe, idempotent no-op** when Shield was never
  enabled, and when called twice in a row.

### Empirical findings from this phase

- **A Shield-owned hook could previously be hand-edited (keeping the
  marker comment) and Shield would report it as perfectly healthy** —
  ownership was checked (marker present → "shield," safe to over-
  write/delete) but content was never compared against what `enable()`
  would actually write. This is a real integrity gap the Phase 6 task
  explicitly called out ("modified Shield hook"), now closed by comparing
  exact content whenever the version matches what this build would
  produce.
- **An outdated evaluator/hook version was previously reported as
  `active`** (with an informational "repair available" note) rather than
  `degraded` — reclassified this phase, since "the enforcement running
  right now is not the enforcement Shield's current settings actually
  describe" is exactly what `degraded` means elsewhere in this same
  state machine.
- **`git hook run` (Git 2.36+) does not change the single-script-per-hook
  model at all** — confirmed by reading its own `-h` output rather than
  assuming from its name; this directly shaped the decision to implement
  chaining entirely in Shield's own hook shim rather than deferring to
  any native Git mechanism.

### Limitations (documented, not hidden)

- **No cross-worktree warning.** Each worktree's `inspect()` correctly
  reports its own true state, but Shield doesn't proactively flag "a
  sibling worktree has its own scoped `core.hooksPath` and isn't
  covered" — a user has to check each worktree themselves (or the
  sidebar would need to, in a future phase where it operates across
  worktrees at all).
- **Chaining is not wired into any command yet.** `chainForeignHooks` is
  a real, tested `ShieldManager` capability; the "Enable Shield"/"Repair
  Shield" commands don't yet ask the user whether to use it (no UI
  changes in this phase, per its own scope) — see "What's next."
- **The two opt-in drift checks require a caller-supplied snapshot.**
  Nothing currently calls `inspect()` with `currentProfiles`/
  `currentPushDestination` outside tests — wiring that into "Check Shield
  Health" (so it always sees live data) is a small, deliberately deferred
  follow-up.
- **A hook that isn't executable is neither auto-fixed nor specially
  diagnosed.** `contentModified` is a pure string comparison; a
  permissions-only change (e.g. `chmod -x` on Shield's own hook) isn't
  distinguished from "everything's fine" by `inspect()` today — Git
  itself would simply stop invoking a non-executable hook silently
  (matching ordinary Git behavior for any hook, not a Shield-specific
  gap).

### What's next (not this phase)

- Wiring `chainForeignHooks` into the "Enable Shield" command (a prompt:
  "A pre-commit hook already exists — chain it or leave Shield
  degraded?").
- Wiring the two opt-in drift checks into "Check Shield Health" with live
  data, so drift is caught without a caller having to know to ask.
- A cross-worktree health view.
- A manual/on-demand "Verify GitHub Account" command, independent of a
  real push.
- HTTPS account verification.
- Per-ref push inspection (force-push detection, etc.).
- The `profile-unresolved`/`profile-conflict`/`push-route-mismatch` gaps.
- A Settings/sidebar Shield toggle and status surface — still
  command-palette-only.

## Phase 7: hardening and abuse matrix

Phase 6 made Shield safe to install alongside other tooling and honest
about its own health. Phase 7 does not add capability — it goes looking
for ways the existing implementation fails, under a real CI matrix across
all three desktop OSes, and reports what it found without dressing up a
known local-hook limitation as something Shield can fix.

### CI now actually runs on all three platforms

`.github/workflows/ci.yml` runs `npm ci`, `npm run compile`, `npm test` as
a matrix over `ubuntu-latest`, `windows-latest`, `macos-latest`
(`fail-fast: false`, so one platform's failure doesn't hide the others).
Before this phase, "cross-platform" meant "the TypeScript compiles" —
that claim is retired. `shield-evaluate.sh` and the two/three hook shims
are POSIX shell; on `windows-latest` they run under the `sh.exe` Git for
Windows ships and puts on `PATH`, which is also what a real Windows user's
Git installation provides — the same interpreter, not an emulation layer
this project added. See the CI run for the actual current pass/fail per OS
(reported alongside the commit SHA below, not restated here since it can
move after this file is written).

### Confirmed core bug, fixed this phase: merge commits used the wrong hook

Empirically confirmed (not assumed) against Git 2.43: `git merge --no-ff`
invokes the **`pre-merge-commit`** hook for the resulting merge commit, not
`pre-commit`. Shield through Phase 6 only ever installed `pre-commit`, so
a real non-fast-forward merge with a mismatched identity sailed straight
through with no enforcement at all — confirmed with a hook that logs to a
file: it was never invoked for a merge, while an ordinary commit invoked
it every time.

Fixed by adding `pre-merge-commit` as a third entry in `HOOK_SPECS`
(`src/shield/manager.ts`), governing the same `"commit"` action, reusing
`buildPreCommitHookScript()` verbatim — identical enforcement logic, no
new evaluator action, no policy schema change. `inspect()`/`enable()`/
`disable()`/`repair()` all iterate `HOOK_SPECS` generically already, so no
other code path needed to change to pick up the third hook. One real bug
this surfaced in the process: `buildPreCommitHookScript()`'s chained-hook
lookup was hardcoded to `.../pre-commit.repo-identity-guard-original`
regardless of what file the script was actually installed as — installing
the same script body as `pre-merge-commit` would have looked for the
wrong sidecar. Fixed by deriving the sidecar path from `$0` (the hook's
own invocation path, which Git always sets correctly) instead of a
hardcoded name — `buildPrePushHookScript()` didn't have this bug since
push only ever has the one hook name.

### Confirmed core gap, NOT fixable by any hook: a clean cherry-pick or revert

Also empirically confirmed: a **non-conflicting** `git cherry-pick` (or
`git revert`) commits via an internal fast path that invokes no commit
hook at all — not `pre-commit`, not `pre-merge-commit`, nothing. A hook
that logs unconditionally proved this directly: it fired for a plain
commit and for a *conflicting* cherry-pick's `--continue` (which
internally runs an ordinary `git commit`), but never fired for a clean
cherry-pick. There is no hook name Git offers for this path — this sits
in the same category as `--no-verify` and a `core.hooksPath` override:
Git's own documented behavior, not something a local pre-commit-family
hook can intercept, regardless of which tool installed it. Documented
here and exercised as an explicit "KNOWN GAP" test
(`shieldHardeningMatrix.test.ts`) precisely so it's never mistaken for an
oversight later.

### Internal evaluator failure vs. a policy block

Through Phase 6, `shield-evaluate.sh` crashing outright (a bug, a missing
`git` on `PATH`, a corrupted copy) and a deliberate policy denial produced
the *same* "COMMIT/PUSH BLOCKED" framing at the hook shim — both failed
closed (correct), but a real Shield bug looked identical to "you did
something wrong" (not correct; the task explicitly calls for these to be
distinguishable).

Fixed in `buildPreCommitHookScript()`/`buildPrePushHookScript()`: every
reason the evaluator produces via `add_reason`/`fail_immediately` carries
a `Shield: [id] ...` line. The hook shim now branches on whether the
captured evaluator output contains that marker at all:

- **Present** → ordinary policy framing, unchanged from Phase 6 ("COMMIT
  BLOCKED" / "PUSH BLOCKED", reason ids and messages, a next step).
- **Absent** → "COMMIT/PUSH BLOCKED (Shield internal error)", the raw
  evaluator output, and a next step that points at re-running the
  evaluator directly and reporting a bug — explicitly *not* framed as "fix
  your commit."

Both branches still `exit "$CODE"` — fail-closed is unconditional; only
the human-facing framing differs. `SHIELD_ARTIFACT_VERSION` bumped 3 → 4
for this hook-shim content change. Exercised directly by
crashing a real evaluator copy with an unbound-variable reference (no
`add_reason` ever runs) and confirming the distinct framing, alongside a
control test proving an ordinary policy block still reads as one.

### Commit/push abuse matrix

Every case the phase's task description asked for is now covered by a
real-repository, real-`git`-binary test — the small number not already
covered as of Phase 6 were added in `src/test/shieldHardeningMatrix.test.ts`:
wrong `user.name` alone, wrong author-only/committer-only (env-based),
`GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` alone, `git -c user.name=...`,
`--amend`, a real non-fast-forward merge, both cherry-pick outcomes,
hand-corrupted policy blocking a real commit (not just the standalone
script test), a deleted evaluator failing open, a hand-tampered hook
actually running its tamper (and still being caught by `inspect()`),
`branch.pushRemote`, `remote.pushDefault`, `remote.pushurl`, force push,
ref deletion, and a missing policy at push time producing a concise
reason rather than a raw error. Every other requested case (wrong
`user.email`, env overrides, `--author=`, protected branch, detached HEAD,
linked worktree, worktree-specific identity, generic/approved/wrong SSH
alias, expected/wrong GitHub login, `GIT_SSH`/`GIT_SSH_COMMAND`/
`core.sshCommand`, SSH verification failure modes, offline/timeout parsing,
corrupt policy, a corrupted evaluator copy at push time, multiple refs)
was already covered by Phases 3-6's suites and re-verified as part of this
phase's full-suite runs rather than duplicated.

### Known bypasses (demonstrated, not "fixed")

Explicitly exercised and documented, per this phase's own instruction not
to paper over them:

- `git commit --no-verify` and `git push --no-verify` skip Shield
  entirely, even with a maximally wrong identity or an unapproved
  destination. This is Git's own hook-bypass mechanism; no local hook,
  from any tool, can prevent it.
- Setting `core.hooksPath` to an empty directory after Shield is active
  disables enforcement immediately for the next commit — Shield's
  `inspect()` does detect the resulting divergence after the fact (Phase
  6's `hooksPathCustomized` / missing-governed-hook reasons), but nothing
  forces a re-inspect before the next commit, and nothing here can
  retroactively stop a commit that already happened.
- The clean cherry-pick/revert fast path above.

Shield's promise, restated once more because this phase is largely about
its boundary: **blocks ordinary accidental unsafe Git operations.** It
does not, and architecturally cannot, contain a process or user acting
with intent to bypass a client-side hook.

### Measured latency

From `shieldHardeningMatrix.test.ts`'s `[perf]`-tagged console output
(a real temporary repo, on the CI/dev sandbox's own hardware — treat these
as "same order of magnitude," not portable absolute numbers):

| Path | Added latency |
| --- | --- |
| Commit (pre-commit hook, identity + branch + repo-state checks) | tens of milliseconds |
| Push, route-only strict mode (no `expectedGitHubLogin`) | roughly one hook-shim + one evaluator subprocess spawn, same order as commit |
| Push, strict GitHub SSH account verification (mocked `ssh`) | adds one `ssh -G` and one `ssh -T` subprocess spawn on top of route-only — against a *real* GitHub endpoint this is dominated by network round-trip time, not by anything Shield itself does |

None of these approach "a coffee break" on a local repository. The one
case that legitimately can take longer is real account verification
against an unreachable/slow SSH host — bounded by
`REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT` (`ssh -T`'s own
`-o ConnectTimeout=`, default 5 seconds, user-configurable), verified
structurally (the flag is always present in the shipped script) rather
than via a live network call in CI, per the same "never contact real
GitHub in automated tests" rule Phase 5 established.

### Failure message shape

Every block already stated (since Phase 3/4): the action blocked
("COMMIT BLOCKED"/"PUSH BLOCKED"), the profile, the expected identity/
destination/account, what was actually found, a concise machine-readable
reason id, and a next corrective step ("Fix the repository identity or
disable Shield for this repository." / "Fix the push destination/route or
disable Shield for this repository.") — verified directly this phase with
an assertion checking for all six elements in one place and confirming no
stack-trace-shaped text ever appears for an ordinary policy rejection. The
internal-error branch above is the one addition: a distinct shape for the
one case that was previously indistinguishable from a policy decision.

### What's next (not this phase)

- Everything listed at the end of the Phase 6 section, still open.
- `git revert`'s non-conflicting fast path is architecturally identical to
  cherry-pick's and was not separately re-verified line-by-line, but there
  is no reason to expect different behavior from the same Git commit
  machinery.
- A real (non-mocked) live-network latency measurement against GitHub,
  for a human to run manually per `TESTING.md`'s new Windows/macOS/Linux
  Shield matrix — never automated, to keep CI network-free.
