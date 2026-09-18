# Changelog

## Unreleased

### Fixed — independent adversarial review: 7 correctness/security fixes

An independent review of the release branch found seven issues, all now
fixed with regression tests:

1. **Sidebar Push Destination trusted owner text on arbitrary hosts.**
   `checkPushDestination`'s owner-pattern branch (`expectedRemoteOwners`)
   matched on owner/repo text alone, so
   `git@evil.example:AcmeSoftware/backend.git` could read as a confirmed
   destination for a profile expecting owner "AcmeSoftware" — with only
   the (non-blocking under a relaxed profile) Push Account check standing
   in the way of an overall SAFE verdict. Owner-pattern matching is now
   host-aware: only a well-known generic host (github.com, gitlab.com,
   bitbucket.org) or a host the matched profile explicitly lists in
   `trustedSshHostAliases` is eligible. Exact-repository matching was
   already host-aware (its key is `host/owner/repo`) and is unaffected.
2. **Shield health/drift ignored host, and missing evidence compared
   equal.** `pushDestinationDrift` compared owner/repo only, so a push
   destination that moved to a different HOST while keeping the same
   owner/repo text read as unchanged — Shield stayed ACTIVE instead of
   DEGRADED. Also, a missing `currentPushDestination.repo` against an
   approved `repo` silently compared as "unchanged" rather than as drift.
   Both fixed: host is now part of the comparison, and missing evidence
   is drift, never a silent match — matching the fail-closed model the
   pre-push evaluator already uses.
3. **Enable Shield's hook-chaining choice couldn't actually be selected.**
   `renderShieldEnable()` reset the Chain/Leave radio choice to "leave" on
   every render — including the re-render its own change handler
   triggered immediately after selecting "chain". The UI displayed the
   Chain option but clicking it had no visible effect. Fixed by resetting
   the choice only when the confirmation screen is actually entered
   (`navigate("shieldEnable")`), not on every re-render.
4. **A generic Shield inspection failure could be mislabeled "requires Git
   2.31."** `!gitVersionSupported ? "unavailable" : inspection.state`
   conflated "Git version positively confirmed too old" with "Git version
   never determined" (e.g. `resolveGitContext` erroring for an unrelated
   reason) — both make `gitVersionSupported` false. A BROKEN inspection
   failure could therefore render as "SHIELD — UNAVAILABLE / requires Git
   2.31" even when Git's version was never the issue. Added
   `gitVersionKnownUnsupported` (true only when a version was actually
   parsed and found below the floor); the UI now only shows the fixed
   "unavailable" screen in that case, otherwise showing the real state.
5. **Webview messages and persisted settings were cast, not validated.**
   `message.profile as Profile`, `message.branches as string[]`, and the
   equivalent `.get<Profile[]>(...)` reads from `settings.json` assumed a
   shape neither a webview message nor a hand-edited/synced settings file
   is guaranteed to have. Added `src/validation.ts` (no external schema
   dependency) with runtime validators for every `Profile` field and for
   branch/string-array settings; malformed webview messages are now
   dropped rather than partially actioned, and malformed persisted
   settings are sanitized (bad array elements dropped, bad profiles
   skipped without taking the rest of the list down) rather than reaching
   a downstream `.map`/`.some` that would throw.
6. **Workspace Trust gating was inconsistent.** Repo Memory mutation
   (notes), saved-command mutation (add/remove), profile save/delete,
   protected-branch/preference saves, "Add Profile for This Repo," and
   "Assign This Repo to a Profile" (fork-conflict resolution) did not
   check Workspace Trust, unlike Fix Commit Identity and Shield
   enable/repair/disable, which already did. All mutating sidebar actions
   now consistently require a trusted workspace; read-only actions (view,
   copy-to-clipboard, rescan, select repo) remain available regardless.

### Fixed — Windows CI: test-harness PATH-casing bug (`spawn sh ENOENT`)

A real windows-latest CI run of the Phase 1/B-E changes failed
`shieldEvaluatorScript.test.ts` and `shieldSshTransportEquivalence.test.ts`
with `spawn sh ENOENT`. Root cause: the shared test helper
`withFakeSshOnPath` (added this session to exercise the new destination
host canonicalization) read `env.PATH` directly, but Node's `process.env`
is a case-insensitive proxy on Windows — spreading it into a plain object
(`{ ...process.env }`, done by every caller) flattens that into whatever
literal casing Windows used (typically `Path`, not `PATH`). Reading
`env.PATH` on that plain object found nothing, so the fake-ssh bin
directory was written into a brand-new `PATH` key that existed ALONGSIDE
the untouched, differently-cased `Path` key — and the child process
picked the new one, which contained only the fake ssh directory, not the
real PATH `sh`/`git` live on. Fixed by collapsing every differently-cased
PATH key into one canonical `PATH` before prepending (the same fix
`shieldGitHubAccountBinding.test.ts`'s `normalizePathKey` and
`shieldPrePush.test.ts` already apply, for the identical reason) —
verified against a simulated Windows-shaped env object locally. This is a
test-harness fix only; no Shield production semantics changed, and the
release-blocker invariant (an unrelated host must never match an approved
destination on owner/repo text alone) is untouched.

### Changed — CI now builds with Node 22

`@vscode/vsce`'s own Azure DevOps PAT-auth dependency chain
(`@azure/*`) declares `"engines.node": ">=22.0.0"`; CI was pinned to
Node 20, which `npm ci` accepts with a warning rather than a hard
failure, but is exactly the "tooling needs a newer Node than CI
provides" mismatch. Bumped `actions/setup-node`'s `node-version` to 22
in `.github/workflows/ci.yml`. This does not raise the shipped
extension's own minimum VS Code version (`engines.vscode`, untouched) —
only what Node this workflow uses to build and test it.

### Fixed — Push Destination host bypass (release blocker)

Shield's push-destination check matched a push's owner/repo text alone,
never its host — so a push to an entirely different, attacker-chosen host
(e.g. `evil.example`) sharing an approved destination's owner/repo string
was reported "destination confirmed," with only the (non-blocking under
`strictPushSetup: false`) push-account/route check standing in the way.
Fixed by requiring canonical host identity too — a literal match needs no
resolution, and an SSH alias is accepted only once `ssh -G` (never the
alias's name) has actually resolved it to the approved host — independent
of `strictPushSetup`, in both the TypeScript reference evaluator and the
shipped shell evaluator. Also fixed in passing: a bracketed IPv6 host was
truncated at its first internal colon by the shell evaluator's host
parser, and three `grep -qx` membership checks treated their argument as a
regex instead of a literal string.

### Added — Shield sidebar UI

Shield went from Command-Palette-only to a real, reachable sidebar
feature: a live "Shield — <state>" summary on Main (View/Enable/Review/
Repair depending on the real per-repository state), a dedicated Shield
screen for OFF/ACTIVE/DEGRADED/BROKEN/UNAVAILABLE (Git too old), an
Enable Shield confirmation explaining what it can block and what it does
not do, and the foreign-hook coexistence decision (leave unchanged, or
chain when it's safely chainable) surfaced up front instead of only being
reachable as an internal parameter. Settings now shows the selected
repo's real Shield state with an "Open Shield" link, replacing the old
"Full sidebar controls are not yet available" placeholder. Every field
shown comes directly from `ShieldManager`'s own inspection — nothing is
inferred from repository safety, and multi-root workspaces show Shield
state per repository, never one workspace-wide value.

### Fixed — Shield pre-manual-test hardening (Phase 9)

Every item below was reproduced empirically before being fixed, and each
has a regression test that fails against the previous behavior. Six of
them were found by new differential/fuzz harnesses that run the shipped
POSIX-shell evaluator and the TypeScript reference implementation against
the same generated cases and require them to agree.

- **Installing Shield without being able to record where is now refused.**
  With Shield's installation record un-writable, `enable()` installed all
  three fail-closed hook shims, reported ACTIVE, and left nothing naming
  the directory those hooks live in. Move `core.hooksPath` afterwards and
  Disable Shield could no longer reach them; move it back and they were
  live again with no evaluator beside them — blocking every commit and
  push with no Shield left to repair or disable. Enable/repair are now a
  transaction (prepare → persist lifecycle metadata → install → verify →
  commit): the record is written first as a superset, a failure to persist
  it aborts before anything is installed or moved, and every artifact
  write rolls back in reverse order on a later failure.

- **Shield no longer reports ACTIVE when its installation record is
  corrupt or missing.** A corrupt record reads as *absent* by design, and
  absent meant "nowhere else to look" — so the one state the record exists
  to prevent, live hooks nothing is tracking, was the one state Shield
  could not report. Now DEGRADED, with enforcement still running, cleared
  by Repair Shield.

- **The policy parser accepted two classes of corrupt policy that the
  extension rejects — and both failed OPEN.** Raw control characters
  (U+0001–U+001F, DEL) inside a JSON string were accepted, and
  `enabledActions` was never checked against the known action set, so a
  policy naming an action this build cannot enforce (e.g. from a newer
  version) was honoured as if it named only the ones it knows. Both are
  now `policy-corrupt`, which fails closed.

- **The remote-URL parser accepted two hostless/scheme-less shapes and
  approved the wrong destination.** `:owner/repo.git` and
  `://github.com/owner/repo.git` both parsed to a real owner and repo in
  the shell evaluator — and so satisfied an approved push destination —
  while the extension parses both as unparseable and blocks. Host
  matching and scheme detection now mirror the TypeScript parser exactly.

- **A remote URL written in upper case blocked a legitimate push.** The
  `.git` suffix was stripped case-sensitively in the evaluator and
  case-insensitively in the extension, so `git@GITHUB.COM:ACME/REPO.GIT`
  read as repository `REPO.GIT` and Shield reported the destination had
  "changed since Shield approval".

- **A stray space in a profile's expected Git name blocked every commit.**
  The evaluator compared identities without trimming whitespace while the
  extension trimmed, producing a baffling `Expected:   Danish Irfan /
  Found: Danish Irfan`.

- **A diverging SSH transport is now detected.** `ssh.variant` /
  `GIT_SSH_VARIANT` change how Git drives the SSH program even with no
  `GIT_SSH`/`GIT_SSH_COMMAND`/`core.sshCommand` override, so a push could
  travel a PuTTY/plink-style transport while Shield's verification probe
  used OpenSSH syntax. A non-OpenSSH effective variant now makes the route
  unverifiable, exactly like a command override. `auto` and `ssh` are not
  overrides, so ordinary setups are unaffected.

- **Two filesystem robustness bugs.** A plain file occupying a path
  component made `inspect()` throw ENOTDIR straight out of `enable()`, so
  such a repository could not even be diagnosed; and a failed atomic write
  left its temp file stranded where `disable()`'s deliberately non-forcing
  cleanup could never remove it.

### Changed — Shield is no longer described as unbuilt

- Removed the static "Shield Mode is not built yet — nothing is enforcing
  this automatically" safety note. It was shown in **every** repository,
  including ones where Shield was installed and actively blocking pushes.
  The safety engine now makes no claim about Shield at all; Shield's real,
  per-repository state comes from Check Shield Health.
- Replaced the disabled "Coming soon" Settings panel with plain copy
  pointing at the Command Palette commands. No dashboard was built.
- README, TESTING.md and docs/SHIELD_MODE.md updated; the phase-by-phase
  history in docs/SHIELD_MODE.md is retained but explicitly labelled as
  superseded, under a new CURRENT STATUS header.
- The documented threat boundary is unchanged and now enforced by a test:
  `--no-verify`, a deliberate `core.hooksPath` override, and arbitrary
  local shell access all bypass Shield, and nothing in the product claims
  otherwise.

### Added

- `expectedGitHubLogin` is now documented in the settings schema and
  editable in the Settings profile editor, instead of requiring a
  hand-edited `settings.json`. Its copy spells out that it is not the
  commit email, not the repository owner/org, and not the SSH host alias.
- `exactRepos` is now documented in the settings schema.
- ShellCheck (POSIX `sh` mode) runs in CI and over every generated hook in
  the test suite.

### Fixed — Shield core correctness hardening

Every item below was reproduced against a real repository before being
fixed, and each has a regression test that fails against the previous
behavior. Full write-ups, including the exact reproductions, are in
[docs/SHIELD_MODE.md](docs/SHIELD_MODE.md) under "Phase 8".

- **Shield's hooks fail closed on a broken installation.** Both hook shims
  exited 0 when `git rev-parse --git-common-dir` failed or when Shield's
  evaluator copy was missing. With Shield reported ACTIVE, deleting one
  file (`<gitCommonDir>/repo-identity-guard/shield-evaluate.sh`) let a
  commit with a deliberately mismatched identity through silently — a
  one-command, no-privileges bypass of the whole feature. A hook that is
  installed but cannot reach its evaluator is now a *broken installation*:
  the operation is blocked and framed as a Shield internal error pointing
  at Repair Shield / Disable Shield, never as a verdict about the user's
  commit or push. (Generated hook contents changed;
  `SHIELD_ARTIFACT_VERSION` is now 5.)

- **Disable Shield is now complete, which is what makes fail-closed safe.**
  `disable()` removes every hook it can prove it owns *before* deleting
  the evaluator and policy, so an interrupted disable can only ever
  over-enforce, never permanently block. It also reaches hooks directories
  Shield installed into previously, via a new durable installation record
  — see the next item.

- **Orphaned hooks after a `core.hooksPath` change.** Shield kept no
  record of where it installed. Reproduced: enable with hooks directory A,
  point `core.hooksPath` at B, disable — Shield's hooks stayed in A
  forever and became live again the moment `core.hooksPath` pointed back.
  Shield now keeps a minimal, non-secret, atomically written installation
  record under Git metadata (never the working tree, shared correctly
  across worktrees). It is never authoritative: every path it names is
  re-verified as Shield-owned before being touched, so a tampered record
  can only send Shield somewhere useless. Health now reports orphans;
  enable/repair consolidate; disable cleans every recorded location.

- **The approved push destination came from the wrong remote.** Shield's
  `approvedPushDestination` was built from origin's *fetch* facts, so any
  repository using `branch.<name>.pushRemote`, `remote.pushDefault`,
  `remote.<name>.pushurl`, or a non-origin `branch.<name>.remote` had
  Shield approving a destination nobody pushes to. It is now built from
  the actual plain-push destination. The repository's canonical identity
  (`approvedRepositoryKey`) deliberately still tracks origin — the two are
  different facts and were being conflated.

- **The sidebar could call a push destination "confirmed" when it wasn't.**
  A profile listing `exactRepos` but no `expectedRemoteOwners` confirmed
  *any* destination whatsoever, and an unparseable owner also read as
  confirmed. The rule is now stated once and shared: an unconstrained
  profile makes no claim; otherwise the destination must positively match
  an exact-repo or owner pattern, and missing evidence is never a match.
  Owner-level matching is deliberately retained so forks and mirrors under
  a trusted owner keep working. Documented so the sidebar and Shield can
  never contradict each other about a destination.

- **Enable/Repair Shield built durable policy from possibly-stale UI
  facts.** Both commands used the shared scan snapshot a background
  watcher can overwrite. They now re-collect repository facts, re-resolve
  the profile, and re-resolve the push destination immediately before
  writing the policy.

- **Check Shield Health performed no integrity checks.** All three of
  `inspect()`'s drift checks are opt-in, and the command supplied none —
  so a Shield with a hand-edited evaluator (markers intact), a profile
  edited after enable, or a moved push destination reported a confident
  "Shield is active." The command now supplies all three from live state.
  `inspect()` remains strictly read-only and never self-repairs.

- **Foreign hooks could be destroyed or made un-runnable by chaining.** A
  binary hook was read as UTF-8 and written back with U+FFFD replacement
  characters; a symlinked hook was flattened into a regular-file copy; a
  non-executable hook was chained anyway, so every commit died with a bare
  `exec: ...: Permission denied`. Chaining is now limited to executable
  regular files, preserved byte-for-byte with their mode; every other file
  type is left completely untouched and reported degraded with a precise
  explanation.

- **Predictable pre-push temp file removed.** When `mktemp` failed, the
  pre-push shim fell back to a guessable `...prepush-stdin.$$` path in a
  shared temp directory and truncated it — a symlink/pre-creation hazard
  that also exposed the pushed ref lines. It now fails closed as a Shield
  internal error and creates nothing.

- **Strict account verification did not check where the SSH alias
  actually goes.** A trusted alias name plus `IdentitiesOnly yes` plus a
  GitHub-shaped greeting counted as verified, even though an alias can
  resolve anywhere and any host can produce that greeting. Verification
  now resolves the effective route with `ssh -G` first and requires a real
  GitHub SSH endpoint; an explicit port in an `ssh://` remote (previously
  dropped) is carried through so the probe travels the same route the push
  would. Read-only throughout: no key contents read, no SSH config
  written, `StrictHostKeyChecking` unchanged.

- **A push URL that produced no repository name satisfied a policy that
  named one.** Missing evidence is no longer a match, in both the
  TypeScript reference evaluator and the shell evaluator (kept 1:1).

- **The standalone evaluator's policy parsing could fail open.** Two
  reproduced holes let a corrupt policy allow the action outright: arrays
  packed onto a single line, and a truncated policy file. Two more
  silently weakened enforcement (a one-line nested object, and any
  non-`true` `strictPushSetup` reading as non-strict). Replaced with a
  strict recursive-descent JSON parser in POSIX awk — no jq, Node, or
  Python dependency added — that rejects truncation, trailing content,
  bad escapes, raw control characters, invalid numbers, and duplicate
  keys, and validates the schema field-for-field against the TypeScript
  validator. Corruption now fails closed. The exact remaining trust
  boundary is documented in the script and in docs/SHIELD_MODE.md.

### Changed

- **Shield now requires Git 2.31 or newer.** The docs previously claimed
  2.9. Shield's hooks and evaluator depend on `git rev-parse
  --path-format` (Git 2.31), and merge-commit coverage depends on the
  `pre-merge-commit` hook (Git 2.24). Below the floor Shield reports
  degraded with the missing coverage named and refuses to install, rather
  than reporting ACTIVE while enforcing nothing. This is Shield-specific
  and does not change the extension's VS Code engine requirement or affect
  any non-Shield feature.


### Added

- **CI**: a GitHub Actions workflow (`.github/workflows/ci.yml`) runs
  `npm ci`, `npm run compile`, and `npm test` on every PR and push to
  `main`, so the test-suite result is independently enforced on GitHub
  rather than only self-reported.

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
- **Fix Commit Identity is now outcome-based, and a pure environment
  override is reported honestly instead of offered a config fix that
  can't help.** Commit identity is read from Git's *effective*
  author/committer identity (`git var`), which already reflects
  `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL`-style environment overrides —
  but every mismatch previously still offered **Fix Commit Identity**,
  which only ever writes Git config. If an environment variable is
  overriding an otherwise-correct config, that fix could write the right
  config, report "Commit identity fixed," and the repo would remain NOT
  SAFE because the environment override still wins.
  - `checkCommitIdentity` now separately checks the *configured* identity
    (worktree/local/global config, no environment involved). If it
    already matches the profile but the effective identity doesn't, this
    is reported as a distinct **"Commit identity overridden by the
    environment"** result — still blocking, but with no
    `suggestedActionCommand`, since no config write fixes it. The ordinary
    **"Wrong commit identity"** result (offering Fix Commit Identity) is
    reserved for when the configured identity itself doesn't match.
  - **Fix Commit Identity** itself is now outcome-based: it writes config,
    rescans, and only reports success if the commit-identity capability is
    then actually `confirmed`. If it's still not, it explains that config
    was updated but the effective identity is still overridden by the
    environment or a command-line option — instead of reporting success
    based only on the write not throwing.
  - That postcondition check no longer reads the shared, mutable
    `latestSummary` after `scan()` — a watcher-triggered scan (possibly
    fired by the very config write it's checking) could supersede
    `scan()`'s own sequence guard and return without publishing, which
    would risk reading stale state and reporting a false "still
    overridden" warning. It now re-collects and re-computes just that
    repo's status directly for the check, independent of any concurrent
    scan, then still calls `scan()` afterward to refresh the shared
    sidebar/workspace state.
- **Documented the effective-identity boundary explicitly.** `git var
  GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` runs as a child process of the
  VS Code extension host, so a "Confirmed" commit-identity result only
  ever reflects that process's environment at scan time — never a
  guarantee about every process that could create a commit in this repo
  (a separate integrated terminal, an external AI agent process, a shell
  profile sourced only interactively, or an explicit `git commit
  --author=...`/`-c user.email=...`). Called out in `README.md`, in
  `getEffectiveAuthorIdent`'s doc comment, and in the Commit Identity
  Confirmed result's own text.
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
  no longer exists; Settings showed a disabled "Shield Mode — Coming soon"
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
