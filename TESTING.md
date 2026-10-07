# Testing

## Automated

```sh
npm ci
npm run compile
npm test
```

`npm test` compiles and runs every `out/test/*.test.js` with Node's test
runner (`scripts/run-tests.js`, one file at a time). Everything runs
against **real temporary Git repositories, the real Git binary and the real
shipped evaluator** (`resources/shield/shield-evaluate.sh`); SSH is always
a fake on `PATH` or an injected runner — the suite never contacts GitHub.
CI (`.github/workflows/ci.yml`) runs it on ubuntu-latest, macos-latest and
windows-latest.

What the main suites cover:

| Suite | Covers |
| --- | --- |
| `identityLockService.test.ts` | The product contract: unassigned repositories untouched and never blocked (commit and push); no implicit assignment from owners or legacy profiles; assignment is enforcement; linked worktrees share a lock, a clone does not; all-or-nothing assign/change; unlock restores chained hooks byte-for-byte and keeps the assignment when it cannot finish; drift and repair; legacy migration with synthetic AND real 0.2.0 artifacts (`src/test/fixtures/legacy-shield-v5`); passive status never runs `ssh`. |
| `identityLockOutput.test.ts` | Block prelude format, shell `reason_code` == `SHIELD_REASON_CATALOG`, no credential leakage, single-line prelude values, SSH option-injection refusal, on-demand push check parity. |
| `identityConfig.test.ts`, `legacyMigration.test.ts` | Identity validation and the conservative migration rule as pure units. |
| `memoryStoreCore.test.ts`, `memoryStore.test.ts` | Notes: CRUD, pin, search, exact-text copy, limits without truncation, saved-command → note migration (lossless, idempotent, worktree merge, never executed), export/import, concurrency. |
| `placeholderWebview.test.ts` | Placeholder sidebar in a fake DOM: no HTML parsing, drafts survive refreshes until acked, untrusted workspaces cannot reach lock actions; host-side message validation; per-repo wire state. |
| `shield*.test.ts`, `fuzzHarness.ts` | The hook engine: evaluator vs. TypeScript reference (differential and fuzz), policy parser fuzzing, SSH route/user/port canonicalization, account verification, transport overrides, hook chaining, worktrees, `core.hooksPath`, install transactions and rollback, lifecycle torture, hardening matrix (amend, merge, cherry-pick, env/`-c`/`--author` overrides, pushRemote/pushDefault/pushurl, force, deletion), documented bypasses, ShellCheck (when installed). |
| `gitHookMechanismResearch.test.ts` | Keeps the Phase 9 research conclusions in `docs/SHIELD_MODE.md` honest against the installed Git. |
| `vsixPackaging.test.ts` | Packages a real VSIX, checks its contents, and assigns/unlocks an identity from the extracted package. Skips (with the reason) only when `@vscode/vsce` cannot run. |

Also run before a release: `npm audit`, and `shellcheck -s sh
resources/shield/shield-evaluate.sh` (the suite runs ShellCheck itself when
it is on `PATH`).

## Manual (Extension Development Host)

Press `F5`, then in the new window:

| Scenario | Expected |
| --- | --- |
| Open a repository with no identity assigned. Commit and push with any identity. | Sidebar: "Not locked". Nothing is blocked; `.git/hooks` and `.git/repo-identity-guard` are unchanged. |
| Configure two identities in user settings. Assign *Work* via the sidebar. | Modal names the repository, the identity and what is enforced. After confirming: "Locked"; `pre-commit`, `pre-merge-commit`, `pre-push` exist. If Git config uses another email, you are offered "Use Assigned Identity in Git Config". |
| Commit with the wrong email (terminal, Git GUI, an AI agent, VS Code closed). | Blocked with the `REPO_IDENTITY_GUARD_BLOCK` prelude, `REASON: wrong_identity`. |
| `GIT_AUTHOR_EMAIL=other@x git commit …` while config is right. | `REASON: identity_override`. |
| Repository with an existing Husky / hand-written `pre-commit`. Assign. | Asked whether to keep (chain) it. Decline → nothing changes. Accept → the identity check runs first, then your hook; Unlock restores it exactly. |
| `git worktree add ../wt` then commit there with the wrong email. | Blocked (shared lock). A fresh `git clone` of the same remote is "Not locked". |
| Edit the assigned identity's email in settings. | "Needs attention" naming `gitEmail`; the old email is still enforced until **Repair Identity Lock**. |
| Delete `.git/hooks/pre-commit`. | "Needs attention"; Repair restores it. |
| **Change Assigned Identity** to *Personal*. | Lock rebuilt; *Work* commits now blocked. |
| **Unlock Current Repository**. | "Not locked"; hooks removed; notes kept. |
| Untrusted workspace (Restricted Mode). | Lock state visible; Assign/Change/Repair/Unlock refused with an explanation; notes fully usable. |
| Notes: add a multiline note, start another draft, switch files / let a refresh happen, then save. | Draft survives refreshes; cleared only after save. Copy puts the exact text on the clipboard. Search filters. Pin keeps one note on top. Export/Import round-trips. |
| Upgrade from 0.2.x: a repository with Shield enabled for a profile matched only by `expectedRemoteOwners`. | On first trusted open: Shield hooks removed (chained hook restored), "Not locked", one notification explaining why. |
| Upgrade from 0.2.x: Shield enabled for a profile that lists the repository in `exactRepos`. | Migrated to a lock for that identity; the old protected-branch rule no longer applies. |
| Upgrade from 0.2.x with saved commands. | Each appears as a note "label⏎command"; nothing runs. |

### Real GitHub account verification (manual only)

Requires two GitHub accounts with separate SSH keys:

```
Host github-work
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_work
  IdentitiesOnly yes
```

Run `ssh -T git@github-work` once yourself (accept and verify the host
key). Give the *Work* identity `"expectedGitHubLogin": "<work login>"` and
`"trustedSshHostAliases": ["github-work"]`, assign it to a repository whose
`origin` is `git@github-work:<owner>/<repo>.git`.

| Scenario | Expected |
| --- | --- |
| Push normally. | Allowed. **Check Identity Lock** reports the login as verified. |
| Remote via an alias for the personal key. | `REASON: push_route_unverified`, `DETAIL: untrusted_alias` (or, if that alias is listed, `wrong_push_account` naming both logins). |
| Remove `IdentitiesOnly yes`. | `push_account_unverified`, `DETAIL: identities_not_isolated`. |
| `ssh-keygen -R github.com`. | `push_account_unverified`, `DETAIL: host_key_unverified`; `known_hosts` is not modified. |
| Block outbound port 22. | `DETAIL: timeout` after about 5 s (`REPO_IDENTITY_GUARD_SHIELD_SSH_TIMEOUT`). |
| HTTPS remote. | `DETAIL: https`. |
| `GIT_SSH_COMMAND=…` set. | `REASON: push_route_override`. |
| `git push --no-verify`. | Allowed — documented bypass. |

### Windows spot-checks (manual)

CI proves the hooks and evaluator run under Git for Windows' `sh.exe`. By
hand: assign from VS Code, then commit/push from PowerShell, Git Bash and
cmd.exe (same results); confirm installed hooks have LF line endings and
actually fire; try with both Windows OpenSSH and Git for Windows' `ssh.exe`
first on `PATH` (an unexpected resolution must read as unverified, never as
a wrong-but-confident pass).
