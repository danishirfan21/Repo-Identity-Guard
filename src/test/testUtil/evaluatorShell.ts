import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);

/**
 * The proven mechanism for driving `resources/shield/shield-evaluate.sh`
 * identically on Windows as on ubuntu-latest/macos-latest, extracted from
 * `shieldAccountVerificationCrossPlatform.test.ts` (Phase 3 Windows-skip
 * reduction) so other suites whose tests are really about Shield's
 * evaluator — not about `git push`'s own real SSH transport, which Git
 * for Windows genuinely does not resolve through the caller's PATH — can
 * reuse it instead of skipping on win32.
 *
 * The key fact this exploits: `shield-evaluate.sh` runs `ssh -G`/`ssh -T`
 * itself, from a POSIX shell it is sourced into — a different program on
 * a different code path than `git push`'s own transport. On Windows that
 * POSIX shell (Git for Windows' bundled `sh`) needs its fake `ssh` bin
 * directory prepended using a POSIX path and a `:`-separated PATH, done
 * from INSIDE the shell itself (via `cygpath -u`) — a Windows-style PATH
 * assembled by Node before spawning `sh` is not sufficient, since `sh`'s
 * own internal PATH search operates on its POSIX view of the filesystem.
 */

/** Converts a Windows-style path to the POSIX path Git for Windows' bundled `sh` sees, via `cygpath -u`. A no-op (returns the input unchanged) on every other platform. */
export async function toGitForWindowsPath(windowsPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== "win32") return windowsPath;
  const { stdout } = await execFileAsync("sh", ["-c", 'cygpath -u -- "$1"', "cygpath", windowsPath], { env, encoding: "utf8" });
  const converted = stdout.trim();
  assert.notEqual(converted, "", `Git for Windows cygpath did not convert ${windowsPath}`);
  return converted;
}

/** Windows environments can carry `Path` rather than `PATH`; setting the wrong one silently does nothing. Collapses every differently-cased PATH key to one canonical `PATH` before prepending. */
export function withPath(env: NodeJS.ProcessEnv, prepend: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  let existing: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      existing = existing ?? value;
      continue;
    }
    result[key] = value;
  }
  result.PATH = `${prepend}${existing ? path.delimiter + existing : ""}`;
  return result;
}

export interface EvaluatorShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs an arbitrary shell command inside the SAME `sh` this project uses
 * to source the evaluator (Git for Windows' bundled one, on Windows) —
 * used for the Windows preflight sanity check (`command -v ssh; ssh -G
 * ...`) and as the low-level primitive `runEvaluatorScript` builds on.
 */
export function runInShell(
  cwd: string,
  env: NodeJS.ProcessEnv,
  shellCommand: string,
  args: string[] = [],
  stdin = "",
): Promise<EvaluatorShellResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "sh",
      ["-c", shellCommand, "shield-test-shell", ...args],
      { cwd, encoding: "utf8", env },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}

/**
 * Sources `shield-evaluate.sh` (rather than executing it via its shebang,
 * which on Windows would start a SECOND MSYS process that can reinterpret
 * PATH before `ssh` is resolved) inside a shell whose POSIX PATH has
 * already been made to see `fakeSshBinWindows` first — on every platform,
 * not just where PATH-shadowing happens to already work.
 */
export async function runEvaluatorScript(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  fakeSshBinWindows: string,
  scriptPathWindows: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  stdin = "",
): Promise<EvaluatorShellResult> {
  const fakeSshBinPosix = await toGitForWindowsPath(fakeSshBinWindows, baseEnv);
  const scriptPathPosix = await toGitForWindowsPath(scriptPathWindows, baseEnv);
  const env = {
    ...withPath(baseEnv, fakeSshBinWindows),
    ...extraEnv,
    FAKE_SSH_POSIX_DIR: fakeSshBinPosix,
    SHIELD_SCRIPT: scriptPathPosix,
  };
  return runInShell(cwd, env, 'PATH="$FAKE_SSH_POSIX_DIR:$PATH"; export PATH; . "$SHIELD_SCRIPT" "$@"', args, stdin);
}
