import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    return (await runGit(cwd, ["rev-parse", "--show-toplevel"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getOriginRemote(repoRoot: string): Promise<string | null> {
  try {
    return (await runGit(repoRoot, ["remote", "get-url", "origin"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getLocalGitUserName(
  repoRoot: string,
): Promise<string | null> {
  try {
    return (await runGit(repoRoot, ["config", "--local", "user.name"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getLocalGitUserEmail(
  repoRoot: string,
): Promise<string | null> {
  try {
    return (await runGit(repoRoot, ["config", "--local", "user.email"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getEffectiveGitUserName(
  repoRoot: string,
): Promise<string | null> {
  try {
    return (await runGit(repoRoot, ["config", "user.name"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getEffectiveGitUserEmail(
  repoRoot: string,
): Promise<string | null> {
  try {
    return (await runGit(repoRoot, ["config", "user.email"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getGlobalGitUserName(): Promise<string | null> {
  try {
    return (await runGit(process.cwd(), ["config", "--global", "user.name"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function getGlobalGitUserEmail(): Promise<string | null> {
  try {
    return (await runGit(process.cwd(), ["config", "--global", "user.email"])) || null;
  } catch (error) {
    if (isExpectedMissingValue(error)) {
      return null;
    }
    throw error;
  }
}

export async function setLocalGitIdentity(
  repoRoot: string,
  name: string,
  email: string,
): Promise<void> {
  await runGit(repoRoot, ["config", "--local", "user.name", name]);
  await runGit(repoRoot, ["config", "--local", "user.email", email]);
}
