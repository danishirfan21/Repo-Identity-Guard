import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { IdentityConfigScope, InProgressOperation, RemoteProtocol, RepoFacts } from "../types";

const execFileAsync = promisify(execFile);

interface GitError extends Error {
  code?: string | number;
  stderr?: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });

  return stdout.trim();
}

function isExpectedMissingValue(error: unknown): boolean {
  const gitError = error as GitError;
  return gitError.code === 1 || gitError.code === 2 || gitError.code === 128;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(cwd: string): Promise<string | null> {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * Canonicalizes a filesystem path for use as a stable repository-identity
 * key — realpath (resolves symlinks; on Windows also normalizes a path to
 * the casing NTFS actually stores, so two differently-cased references to
 * the same folder produce the SAME output) plus an explicit lowercase pass
 * on Windows as a defensive fallback for when realpath can't run at all
 * (the path was deleted, or a permission error) — a raw string comparison
 * must never treat two casings of an existing Windows path as different
 * repositories. Falls back to the input path unchanged (case preserved)
 * when even that fails, rather than throwing: an unresolvable path is
 * still a valid (if less deduplicated) identity, never a hard error.
 *
 * Shared by multi-root repository deduplication (`extension.ts`) and Repo
 * Memory's repository-identity keys (`src/storage/memoryStore.ts`) — both
 * need the exact same notion of "is this the same repo/checkout as that
 * one," and a Windows-casing or symlink difference must not silently split
 * one repository's identity in either place.
 */
export async function canonicalizeRepoPath(pathToCanonicalize: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(pathToCanonicalize);
  } catch {
    resolved = pathToCanonicalize;
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The raw `git --version` line (e.g. `git version 2.43.0`), or null when
 * `git` could not be run at all. Parsing/comparison lives in
 * `src/shield/gitVersion.ts` so it stays pure and testable; this function
 * only performs the invocation.
 *
 * Deliberately not repo-scoped: the Git binary's version is a property of
 * the machine, not the repository. `cwd` only affects which `git` a
 * directory-scoped PATH would resolve, which is not a case worth
 * modelling — it takes the repo root purely so it can share `tryGit`'s
 * error handling.
 */
export async function getGitVersionRaw(cwd: string): Promise<string | null> {
  return tryGit(cwd, ["--version"]);
}

export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["branch", "--show-current"]);
}

export async function isDetachedHead(repoRoot: string): Promise<boolean> {
  const branch = await tryGit(repoRoot, ["symbolic-ref", "-q", "HEAD"]);
  return branch === null;
}

export interface StatusFacts {
  hasChanges: boolean;
  hasConflicts: boolean;
}

/** Parses `status --porcelain=v2 --branch` output. `u ` entries are unmerged (conflicted). */
export function parseStatusPorcelain(status: string): StatusFacts {
  let hasChanges = false;
  let hasConflicts = false;

  for (const line of status.split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    hasChanges = true;
    if (line.startsWith("u ")) {
      hasConflicts = true;
    }
  }

  return { hasChanges, hasConflicts };
}

/**
 * Deliberately uses `runGit`, not `tryGit`: unlike `config --get` or
 * `remote get-url` (where a nonzero exit is a normal "value doesn't
 * exist"), `git status` failing means something is actually wrong with the
 * repo. Swallowing that as "missing" would report a clean working tree
 * when the truth is unknown — a failing status must surface as an
 * inspection failure, not a false "safe."
 */
export async function getStatusFacts(repoRoot: string): Promise<StatusFacts> {
  const status = await runGit(repoRoot, ["status", "--porcelain=v2", "--branch"]);
  return parseStatusPorcelain(status);
}

/**
 * Detects an unfinished merge/rebase/cherry-pick/revert by checking for the
 * marker files Git itself uses — these live per-worktree in `--git-dir`, not
 * the shared `--git-common-dir`.
 */
export async function detectInProgressOperation(gitDir: string): Promise<InProgressOperation | undefined> {
  if (await pathExists(path.join(gitDir, "MERGE_HEAD"))) return "merge";
  if (await pathExists(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (await pathExists(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  if (await pathExists(path.join(gitDir, "rebase-merge"))) return "rebase";
  if (await pathExists(path.join(gitDir, "rebase-apply"))) return "rebase";
  return undefined;
}

async function resolveGitPath(repoRoot: string, args: string[]): Promise<string | null> {
  const raw = await tryGit(repoRoot, args);
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

export async function getGitDir(repoRoot: string): Promise<string | null> {
  return resolveGitPath(repoRoot, ["rev-parse", "--git-dir"]);
}

export async function getGitCommonDir(repoRoot: string): Promise<string | null> {
  return resolveGitPath(repoRoot, ["rev-parse", "--git-common-dir"]);
}

/**
 * The hooks directory Git will actually look in for `pre-commit`/`pre-push`
 * etc. right now, from this worktree — via `git rev-parse --git-path
 * hooks`, never a guessed `<repoRoot>/.git/hooks`. This is the one call
 * that already accounts for everything Shield's hook installation must
 * respect: a repo-level `core.hooksPath` (shared by every worktree) or a
 * worktree-scoped one (`extensions.worktreeConfig` + `git config
 * --worktree core.hooksPath`, affecting only this worktree) both change
 * this answer, exactly the way they change where Git itself resolves
 * hooks from. See docs/SHIELD_MODE.md "Hooks are shared across all
 * worktrees, by default" / "core.hooksPath" sections for the empirical
 * basis.
 */
export async function getHooksDir(repoRoot: string): Promise<string | null> {
  return resolveGitPath(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
}

/** True when `--git-dir` and `--git-common-dir` differ, i.e. this is a linked worktree, not the main one. */
export function isLinkedWorktree(gitDir: string | null, gitCommonDir: string | null): boolean {
  if (!gitDir || !gitCommonDir) return false;
  return path.resolve(gitDir) !== path.resolve(gitCommonDir);
}

/**
 * The effective `core.hooksPath` value (any scope: worktree, local,
 * global, or system), or `null` when unset — i.e. Git is using its
 * built-in `<git-dir>/hooks`. Used by Shield (Phase 6) purely for
 * diagnostics: when a governed hook is unexpectedly missing, knowing
 * whether `core.hooksPath` has been pointed elsewhere (by Shield's own
 * install, by Husky, or by hand) turns a generic "hook is missing"
 * message into a specific, actionable one. Never used to decide *where*
 * to install — `getHooksDir` (via `git rev-parse --git-path hooks`)
 * remains the single source of truth for that.
 */
export async function getCoreHooksPathConfig(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--get", "core.hooksPath"]);
}

/**
 * Reads any single-valued `git config --get <key>` at this repo's
 * effective scope (worktree/local/global/system, in Git's own precedence
 * order) — the general-purpose form `getCoreHooksPathConfig` and friends
 * are thin, key-specific wrappers around. Used by Shield's SSH
 * transport-override detection (`core.sshCommand`, `ssh.variant`), which
 * has no reason to duplicate this. Never writes, never reads a key's
 * VALUE for anything beyond presence/comparison — see the callers for
 * why (a command override's value is deliberately never executed).
 */
export async function getGitConfigValue(repoRoot: string, key: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--get", key]);
}

/** Returns null when unset/unknown (older Git or never configured) rather than defaulting either way. */
export async function getWorktreeConfigEnabled(repoRoot: string): Promise<boolean | null> {
  const value = await tryGit(repoRoot, ["config", "--get", "extensions.worktreeConfig"]);
  if (value === null) return null;
  return value.trim().toLowerCase() === "true";
}

/**
 * How many worktrees (main + linked) are attached to this repository, via
 * `git worktree list --porcelain`. A repo can have other worktrees attached
 * while itself being the main one (`isLinkedWorktree` false) — that alone
 * doesn't mean a config write here is safely worktree-scoped.
 *
 * Uses `runGit`, not `tryGit`: a failing `worktree list` must surface as an
 * inspection failure, not silently collapse to "1 worktree" — that would
 * hide a real error behind an unremarkable-looking default.
 */
export async function getWorktreeCount(repoRoot: string): Promise<number> {
  const output = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const count = output.split("\n").filter((line) => line.startsWith("worktree ")).length;
  return count > 0 ? count : 1;
}

/**
 * Whether `Fix Commit Identity` should write to `--local` or `--worktree`.
 * This depends only on whether `extensions.worktreeConfig` is on — *not*
 * on how many worktrees currently exist. When it's on, Git reads
 * `config.worktree` *after* the shared repo config and lets it override,
 * even with only one worktree attached right now: if that file already
 * holds a stale value, writing the fix to `--local` would succeed as a
 * command while leaving the effective identity wrong. Worktree count only
 * affects how the confirmation message explains the blast radius — see
 * the caller's warning text — never whether `--worktree` is used.
 */
export function resolveIdentityConfigScope(worktreeConfigEnabled: boolean | null | undefined): IdentityConfigScope {
  return worktreeConfigEnabled === true ? "worktree" : "local";
}

export async function getOriginRemote(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["remote", "get-url", "origin"]);
}

/**
 * The `upstream` remote, if one exists — the conventional name for the repo
 * a fork was created from. This is purely a naming convention (there's no
 * reliable way to detect a fork relationship from Git alone), so callers
 * must treat it as evidence to cross-check against `origin`, never as an
 * automatic profile winner.
 */
export async function getUpstreamRemote(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["remote", "get-url", "upstream"]);
}

/**
 * Resolves which remote a plain `git push` would actually use, following
 * Git's own precedence: `branch.<name>.pushRemote`, then
 * `remote.pushDefault`, then `branch.<name>.remote`, then `origin` if it
 * exists. Returns null when none of these resolve to anything — that's an
 * ambiguous/unresolved push destination, not a safe default.
 */
export async function getPushRemoteName(repoRoot: string, branch: string | null): Promise<string | null> {
  if (branch) {
    const branchPushRemote = await tryGit(repoRoot, ["config", "--get", `branch.${branch}.pushRemote`]);
    if (branchPushRemote) return branchPushRemote;
  }

  const pushDefault = await tryGit(repoRoot, ["config", "--get", "remote.pushDefault"]);
  if (pushDefault) return pushDefault;

  if (branch) {
    const branchRemote = await tryGit(repoRoot, ["config", "--get", `branch.${branch}.remote`]);
    if (branchRemote) return branchRemote;
  }

  const originUrl = await getOriginRemote(repoRoot);
  return originUrl ? "origin" : null;
}

/** The push URL for a remote — respects a configured `pushurl` when it differs from the fetch URL. */
export async function getPushUrl(repoRoot: string, remoteName: string): Promise<string | null> {
  return tryGit(repoRoot, ["remote", "get-url", "--push", remoteName]);
}

export async function getLocalGitUserName(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--local", "user.name"]);
}

export async function getLocalGitUserEmail(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--local", "user.email"]);
}

/**
 * The worktree-scoped value, if any (`config.worktree`, only actually
 * distinct from `--local` when `extensions.worktreeConfig` is on — Git
 * itself falls back to treating `--worktree` as `--local` otherwise, so
 * this is safe to query unconditionally). Needed because Fix Commit
 * Identity may have written here instead of `--local` — see
 * `resolveIdentityConfigScope` — and a strict "is this locked outside
 * global config" check must recognize either.
 */
export async function getWorktreeGitUserName(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--worktree", "user.name"]);
}

export async function getWorktreeGitUserEmail(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--worktree", "user.email"]);
}

export async function getGlobalGitUserName(): Promise<string | null> {
  return tryGit(process.cwd(), ["config", "--global", "user.name"]);
}

export async function getGlobalGitUserEmail(): Promise<string | null> {
  return tryGit(process.cwd(), ["config", "--global", "user.email"]);
}

export interface ParsedIdent {
  name?: string;
  email?: string;
}

/**
 * Parses the `Name <email> <timestamp> <tz>` line emitted by
 * `git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT`.
 */
export function parseGitIdent(raw: string): ParsedIdent {
  const match = raw.match(/^(.*)\s<([^>]*)>\s+\d+\s+[+-]\d{4}\s*$/);
  if (!match) {
    return {};
  }
  const name = match[1].trim();
  const email = match[2].trim();
  return { name: name || undefined, email: email || undefined };
}

/**
 * The identity Git would actually attach to a new commit right now,
 * including any `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` environment overrides
 * that a plain `git config user.name` read would miss.
 *
 * Scope of this guarantee: `git var` runs as a child process of the VS
 * Code extension host, so this reflects *that process's* environment at
 * the moment of the call — not every process that could create a commit
 * in this repo. A separate integrated terminal, an external agent
 * process, a shell profile sourced only interactively, or an explicit
 * `git commit --author=...`/`-c user.email=...` can each see a different
 * environment or override this scan never observed. Do not read a
 * "confirmed" result here as a guarantee about every future commit.
 */
export async function getEffectiveAuthorIdent(repoRoot: string): Promise<ParsedIdent> {
  const raw = await tryGit(repoRoot, ["var", "GIT_AUTHOR_IDENT"]);
  return raw ? parseGitIdent(raw) : {};
}

/** Same as {@link getEffectiveAuthorIdent} but for the committer identity, which can diverge from the author. */
export async function getEffectiveCommitterIdent(repoRoot: string): Promise<ParsedIdent> {
  const raw = await tryGit(repoRoot, ["var", "GIT_COMMITTER_IDENT"]);
  return raw ? parseGitIdent(raw) : {};
}

/**
 * Only allowed mutations: this repo's own `user.name`/`user.email`, written
 * to either `--local` or `--worktree` per `scope` — see
 * `resolveIdentityConfigScope`. Never touches global config, and never
 * writes `--worktree` unless the caller has confirmed
 * `extensions.worktreeConfig` actually makes that scope per-worktree.
 */
export async function setLocalGitIdentity(
  repoRoot: string,
  name: string,
  email: string,
  scope: IdentityConfigScope = "local",
): Promise<void> {
  const flag = scope === "worktree" ? "--worktree" : "--local";
  await runGit(repoRoot, ["config", flag, "user.name", name]);
  await runGit(repoRoot, ["config", flag, "user.email", email]);
}

export async function unsetLocalGitIdentity(repoRoot: string, scope: IdentityConfigScope = "local"): Promise<void> {
  const flag = scope === "worktree" ? "--worktree" : "--local";
  await tryGit(repoRoot, ["config", flag, "--unset", "user.name"]);
  await tryGit(repoRoot, ["config", flag, "--unset", "user.email"]);
}

export interface ParsedRemote {
  protocol: RemoteProtocol;
  host?: string;
  owner?: string;
  repo?: string;
  /**
   * Explicit SSH port, e.g. "443" in `ssh://git@ssh.github.com:443/...` —
   * set ONLY when the URL itself carries one. Only the `ssh://` URL form
   * can: in the scp-like `host:path` shape everything after the colon is
   * the PATH, never a port (Git's own rule). An absent port here means
   * "whatever this host/alias's effective ssh config says," never "22" —
   * canonicalizing without it must ask `ssh -G` with no `-p` at all, the
   * same way an absent port here means for `git`/the real push transport.
   * Mirrors shield-evaluate.sh's `URL_PORT`; kept 1:1 by
   * shieldRemoteUrlDifferential.test.ts.
   */
  port?: string;
  /**
   * The SSH connection user, e.g. "git" in `git@github-work:owner/repo.git`
   * — undefined when the URL/alias doesn't specify one. NEVER defaulted to
   * "git" here: an absent user means OpenSSH itself determines the
   * effective one (its own default, or a config-driven `User` directive,
   * possibly `Match user`-sensitive) exactly the way the real push
   * transport would — canonicalizing against an invented "git" would ask
   * a DIFFERENT question than the one the actual push answers whenever
   * that resolution is user-sensitive. Only set for `protocol === "ssh"`.
   * Mirrors shield-evaluate.sh's `SSH_USER`; kept 1:1 by
   * shieldRemoteUrlDifferential.test.ts.
   */
  sshUser?: string;
}

/**
 * Parses a normalized owner/repo out of common SSH, SSH-alias, and HTTPS
 * remote URL shapes. Returns "unknown" protocol/parts rather than throwing
 * so a malformed remote never blocks the rest of the scan.
 */
export function parseRemoteUrl(remoteUrl: string): ParsedRemote {
  const trimmed = remoteUrl.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const protocol: RemoteProtocol =
        parsed.protocol === "https:" || parsed.protocol === "http:"
          ? "https"
          : parsed.protocol === "ssh:"
            ? "ssh"
            : "unknown";
      const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
      const repo = segments.pop()?.replace(/\.git$/i, "");
      const owner = segments.pop();
      if (protocol !== "ssh") {
        return { protocol, host: parsed.hostname, owner, repo };
      }
      return {
        protocol,
        host: parsed.hostname,
        owner,
        repo,
        port: parsed.port || undefined,
        sshUser: parsed.username || undefined,
      };
    } catch {
      return { protocol: "unknown" };
    }
  }

  const scpLike = trimmed.match(/^(?:([^@/\s]+)@)?([^:/\s]+):(.+)$/);
  if (scpLike) {
    const host = scpLike[2];
    const segments = scpLike[3].replace(/^\/+|\/+$/g, "").split("/");
    const repo = segments.pop()?.replace(/\.git$/i, "");
    const owner = segments.pop();
    return { protocol: "ssh", host, owner, repo, sshUser: scpLike[1] || undefined };
  }

  return { protocol: "unknown" };
}

function getRepoNameFromRoot(repoRoot: string): string {
  return path.basename(repoRoot);
}

export async function collectRepoFacts(cwd: string | undefined): Promise<RepoFacts> {
  if (!cwd) {
    return { isGitRepo: false };
  }

  let repoRoot: string | null;
  try {
    repoRoot = await getRepoRoot(cwd);
  } catch (error) {
    return { isGitRepo: false, gitError: getErrorMessage(error) };
  }

  if (!repoRoot) {
    return { isGitRepo: false };
  }

  try {
    const [
      currentBranch,
      detached,
      statusFacts,
      remoteUrl,
      upstreamUrl,
      authorIdent,
      committerIdent,
      localName,
      localEmail,
      worktreeName,
      worktreeEmail,
      globalName,
      globalEmail,
      gitDir,
      gitCommonDir,
      worktreeConfigEnabled,
      worktreeCount,
    ] = await Promise.all([
      getCurrentBranch(repoRoot),
      isDetachedHead(repoRoot),
      getStatusFacts(repoRoot),
      getOriginRemote(repoRoot),
      getUpstreamRemote(repoRoot),
      getEffectiveAuthorIdent(repoRoot),
      getEffectiveCommitterIdent(repoRoot),
      getLocalGitUserName(repoRoot),
      getLocalGitUserEmail(repoRoot),
      getWorktreeGitUserName(repoRoot),
      getWorktreeGitUserEmail(repoRoot),
      getGlobalGitUserName(),
      getGlobalGitUserEmail(),
      getGitDir(repoRoot),
      getGitCommonDir(repoRoot),
      getWorktreeConfigEnabled(repoRoot),
      getWorktreeCount(repoRoot),
    ]);

    const inProgressOperation = gitDir ? await detectInProgressOperation(gitDir) : undefined;

    const pushRemoteName = await getPushRemoteName(repoRoot, currentBranch);
    const pushRemoteUrl = pushRemoteName ? await getPushUrl(repoRoot, pushRemoteName) : null;
    const parsedPushRemote = pushRemoteUrl ? parseRemoteUrl(pushRemoteUrl) : undefined;

    const parsedRemote = remoteUrl ? parseRemoteUrl(remoteUrl) : undefined;
    const parsedUpstream = upstreamUrl ? parseRemoteUrl(upstreamUrl) : undefined;

    return {
      isGitRepo: true,
      repoRoot,
      repoName: getRepoNameFromRoot(repoRoot),
      currentBranch: currentBranch ?? undefined,
      isDetachedHead: detached,
      hasUncommittedChanges: statusFacts.hasChanges,
      hasMergeConflicts: statusFacts.hasConflicts,
      inProgressOperation,
      isLinkedWorktree: isLinkedWorktree(gitDir, gitCommonDir),
      worktreeConfigEnabled: worktreeConfigEnabled ?? undefined,
      worktreeCount,
      gitDir: gitDir ?? undefined,
      gitCommonDir: gitCommonDir ?? undefined,

      effectiveGitName: authorIdent.name,
      effectiveGitEmail: authorIdent.email,
      effectiveCommitterName: committerIdent.name,
      effectiveCommitterEmail: committerIdent.email,
      localGitName: localName ?? undefined,
      localGitEmail: localEmail ?? undefined,
      worktreeGitName: worktreeName ?? undefined,
      worktreeGitEmail: worktreeEmail ?? undefined,
      globalGitName: globalName ?? undefined,
      globalGitEmail: globalEmail ?? undefined,

      originRemoteUrl: remoteUrl ?? undefined,
      remoteProtocol: parsedRemote?.protocol,
      remoteHost: parsedRemote?.host,
      remoteOwner: parsedRemote?.owner,
      remoteRepo: parsedRemote?.repo,

      pushRemoteName: pushRemoteName ?? undefined,
      pushRemoteUrl: pushRemoteUrl ?? undefined,
      pushRemoteProtocol: parsedPushRemote?.protocol,
      pushRemoteHost: parsedPushRemote?.host,
      pushRemoteOwner: parsedPushRemote?.owner,
      pushRemoteRepo: parsedPushRemote?.repo,
      pushRemotePort: parsedPushRemote?.port,
      pushRemoteUser: parsedPushRemote?.sshUser,

      upstreamRemoteUrl: upstreamUrl ?? undefined,
      upstreamHost: parsedUpstream?.host,
      upstreamOwner: parsedUpstream?.owner,
      upstreamRepo: parsedUpstream?.repo,
    };
  } catch (error) {
    return {
      isGitRepo: true,
      repoRoot,
      repoName: getRepoNameFromRoot(repoRoot),
      gitError: getErrorMessage(error),
    };
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
