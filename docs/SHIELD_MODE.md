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

**Push blocks when:**

| Condition | Reason id | Blocking regardless of `strictPushSetup`? |
| --- | --- | --- |
| No/invalid policy | `policy-missing` / `policy-corrupt` | Yes |
| Push owner (and repo, if known) doesn't match the approved destination | `push-destination-mismatch` | **Yes, always** |
| HTTPS, unrecognized protocol, a generic host (`github.com`/`gitlab.com`/`bitbucket.org`), or a custom SSH alias not listed in `trustedSshHostAliases` | `push-route-unverified` | No — only when `strictPushSetup` is true |

If the policy never recorded an approved destination at all (e.g. the repo
had no resolvable remote when the policy was generated), the destination
check is skipped rather than guessed at — no reason is reported for a
comparison that can't actually be made.

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

### What's next (not this phase)

- Writing the policy file at all (`fs` I/O on top of `src/shield/storage.ts`'s
  pure paths) — this phase's tests write policy files directly with
  `serializeShieldPolicy`, standing in for whatever future flow generates
  one from a real profile + live `RepoFacts`.
- Actual hook installation into `<git-common-dir>/hooks/`, including
  detecting and safely coexisting with (or clearly refusing to clobber) a
  pre-existing third-party hook manager.
- Per-ref push inspection (using the ref lines already accepted on stdin)
  for anything beyond destination/route — e.g. force-push detection, if a
  future phase decides that belongs in Shield.
- Closing the `profile-unresolved`/`profile-conflict`/`push-route-mismatch`
  gaps above, if a future design decides they're worth the added policy
  complexity.
- A "Shield Mode" section in Settings with an enable/disable toggle, once
  there is something real for it to toggle.

None of the above exists yet. This phase is the model those future phases
must conform to.
