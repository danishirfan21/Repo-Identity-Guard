import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { InProgressOperation, RemoteProtocol, RepoFacts } from "../types";

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

export async function getStatusFacts(repoRoot: string): Promise<StatusFacts> {
  const status = await tryGit(repoRoot, ["status", "--porcelain=v2", "--branch"]);
  if (status === null) {
    return { hasChanges: false, hasConflicts: false };
  }
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

/** True when `--git-dir` and `--git-common-dir` differ, i.e. this is a linked worktree, not the main one. */
export function isLinkedWorktree(gitDir: string | null, gitCommonDir: string | null): boolean {
  if (!gitDir || !gitCommonDir) return false;
  return path.resolve(gitDir) !== path.resolve(gitCommonDir);
}

/** Returns null when unset/unknown (older Git or never configured) rather than defaulting either way. */
export async function getWorktreeConfigEnabled(repoRoot: string): Promise<boolean | null> {
  const value = await tryGit(repoRoot, ["config", "--get", "extensions.worktreeConfig"]);
  if (value === null) return null;
  return value.trim().toLowerCase() === "true";
}

export async function getOriginRemote(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["remote", "get-url", "origin"]);
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

/** Only allowed mutations: repo-local user.name/user.email. Never touches global config. */
export async function setLocalGitIdentity(
  repoRoot: string,
  name: string,
  email: string,
): Promise<void> {
  await runGit(repoRoot, ["config", "--local", "user.name", name]);
  await runGit(repoRoot, ["config", "--local", "user.email", email]);
}

export async function unsetLocalGitIdentity(repoRoot: string): Promise<void> {
  await tryGit(repoRoot, ["config", "--local", "--unset", "user.name"]);
  await tryGit(repoRoot, ["config", "--local", "--unset", "user.email"]);
}

export interface ParsedRemote {
  protocol: RemoteProtocol;
  host?: string;
  owner?: string;
  repo?: string;
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
      return { protocol, host: parsed.hostname, owner, repo };
    } catch {
      return { protocol: "unknown" };
    }
  }

  const scpLike = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpLike) {
    const host = scpLike[1];
    const segments = scpLike[2].replace(/^\/+|\/+$/g, "").split("/");
    const repo = segments.pop()?.replace(/\.git$/i, "");
    const owner = segments.pop();
    return { protocol: "ssh", host, owner, repo };
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
      authorIdent,
      committerIdent,
      localName,
      localEmail,
      globalName,
      globalEmail,
      gitDir,
      gitCommonDir,
      worktreeConfigEnabled,
    ] = await Promise.all([
      getCurrentBranch(repoRoot),
      isDetachedHead(repoRoot),
      getStatusFacts(repoRoot),
      getOriginRemote(repoRoot),
      getEffectiveAuthorIdent(repoRoot),
      getEffectiveCommitterIdent(repoRoot),
      getLocalGitUserName(repoRoot),
      getLocalGitUserEmail(repoRoot),
      getGlobalGitUserName(),
      getGlobalGitUserEmail(),
      getGitDir(repoRoot),
      getGitCommonDir(repoRoot),
      getWorktreeConfigEnabled(repoRoot),
    ]);

    const inProgressOperation = gitDir ? await detectInProgressOperation(gitDir) : undefined;

    const pushRemoteName = await getPushRemoteName(repoRoot, currentBranch);
    const pushRemoteUrl = pushRemoteName ? await getPushUrl(repoRoot, pushRemoteName) : null;
    const parsedPushRemote = pushRemoteUrl ? parseRemoteUrl(pushRemoteUrl) : undefined;

    const parsedRemote = remoteUrl ? parseRemoteUrl(remoteUrl) : undefined;

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

      effectiveGitName: authorIdent.name,
      effectiveGitEmail: authorIdent.email,
      effectiveCommitterName: committerIdent.name,
      effectiveCommitterEmail: committerIdent.email,
      localGitName: localName ?? undefined,
      localGitEmail: localEmail ?? undefined,
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
