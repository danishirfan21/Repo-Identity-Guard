import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { RemoteProtocol, RepoFacts } from "../types";

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

export async function hasUncommittedChanges(repoRoot: string): Promise<boolean> {
  const status = await tryGit(repoRoot, ["status", "--porcelain=v2", "--branch"]);
  if (status === null) {
    return false;
  }
  return status
    .split("\n")
    .some((line) => line.length > 0 && !line.startsWith("#"));
}

export async function getOriginRemote(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["remote", "get-url", "origin"]);
}

export async function getLocalGitUserName(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--local", "user.name"]);
}

export async function getLocalGitUserEmail(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "--local", "user.email"]);
}

export async function getEffectiveGitUserName(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "user.name"]);
}

export async function getEffectiveGitUserEmail(repoRoot: string): Promise<string | null> {
  return tryGit(repoRoot, ["config", "user.email"]);
}

export async function getGlobalGitUserName(): Promise<string | null> {
  return tryGit(process.cwd(), ["config", "--global", "user.name"]);
}

export async function getGlobalGitUserEmail(): Promise<string | null> {
  return tryGit(process.cwd(), ["config", "--global", "user.email"]);
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
      dirty,
      remoteUrl,
      effectiveName,
      effectiveEmail,
      localName,
      localEmail,
      globalName,
      globalEmail,
    ] = await Promise.all([
      getCurrentBranch(repoRoot),
      isDetachedHead(repoRoot),
      hasUncommittedChanges(repoRoot),
      getOriginRemote(repoRoot),
      getEffectiveGitUserName(repoRoot),
      getEffectiveGitUserEmail(repoRoot),
      getLocalGitUserName(repoRoot),
      getLocalGitUserEmail(repoRoot),
      getGlobalGitUserName(),
      getGlobalGitUserEmail(),
    ]);

    const parsedRemote = remoteUrl ? parseRemoteUrl(remoteUrl) : undefined;

    return {
      isGitRepo: true,
      repoRoot,
      repoName: getRepoNameFromRoot(repoRoot),
      currentBranch: currentBranch ?? undefined,
      isDetachedHead: detached,
      hasUncommittedChanges: dirty,
      effectiveGitName: effectiveName ?? undefined,
      effectiveGitEmail: effectiveEmail ?? undefined,
      localGitName: localName ?? undefined,
      localGitEmail: localEmail ?? undefined,
      globalGitName: globalName ?? undefined,
      globalGitEmail: globalEmail ?? undefined,
      originRemoteUrl: remoteUrl ?? undefined,
      remoteProtocol: parsedRemote?.protocol,
      remoteHost: parsedRemote?.host,
      remoteOwner: parsedRemote?.owner,
      remoteRepo: parsedRemote?.repo,
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
