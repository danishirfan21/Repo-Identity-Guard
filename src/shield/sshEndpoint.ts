import { execFile } from "node:child_process";
import { SshEffectiveRoute, parseSshEffectiveRoute } from "./githubSshVerification";

/**
 * Runs `ssh` with an exact argv (never through a shell) and reports what
 * happened. Injectable so tests can substitute a deterministic in-process
 * fake instead of shadowing a fake `ssh` binary onto PATH — which Windows'
 * process spawning does not resolve the way a POSIX shell does (see
 * docs/SHIELD_MODE.md's Windows evaluator-testing notes). Production code
 * always uses {@link defaultSshRunner}.
 */
export type SshRunner = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; timedOut: boolean; spawnFailed: boolean }>;

export const defaultSshRunner: SshRunner = (args, options) =>
  new Promise((resolve) => {
    execFile(
      "ssh",
      args,
      { encoding: "utf8", timeout: options.timeoutMs, windowsHide: true, env: options.env, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: !!err && (err.killed === true || err.signal === "SIGTERM"),
          spawnFailed: !!err && typeof err.code === "string",
        });
      },
    );
  });

/**
 * The exact `ssh` target and port arguments for a route, built with the
 * same rules `shield-evaluate.sh`'s `verify_github_account` uses:
 *
 *  - an explicit URL port is passed as `-p <port>` and ONLY then — an
 *    absent port must ask OpenSSH "whatever this host's effective config
 *    says", never a guessed 22;
 *  - an explicit URL user becomes `<user>@<host>`; an absent one leaves the
 *    target BARE so OpenSSH itself determines the effective user (its own
 *    default or a `User`/`Match user` directive) exactly as the real push
 *    transport would — never an invented "git".
 */
export function sshTargetArgs(hostOrAlias: string, options: { port?: string; user?: string } = {}): string[] {
  const host = hostOrAlias.trim();
  const user = options.user?.trim();
  const target = user ? `${user}@${host}` : host;
  return options.port ? ["-p", options.port, target] : [target];
}

/**
 * Resolves the effective route `ssh` itself would use for a host or alias,
 * via `ssh -G` — purely local (reads the effective client configuration,
 * opens no network connection, reads no key material) and never trusting
 * the alias's own name as evidence of where it goes.
 *
 * Returns `undefined` when `ssh` is unavailable, times out, or reports no
 * hostname — every caller must treat that as "unresolved" (fail closed),
 * never as a route that happens to be fine. Never executes
 * `GIT_SSH_COMMAND`/`core.sshCommand`: the presence of either makes a
 * route unprovable by design (see `resolveSshCommandOverrides`), never
 * something to resolve around.
 */
export async function resolveSshEffectiveRoute(
  hostOrAlias: string,
  options: { port?: string; user?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; runner?: SshRunner } = {},
): Promise<SshEffectiveRoute | undefined> {
  if (!hostOrAlias.trim()) return undefined;
  const runner = options.runner ?? defaultSshRunner;
  const result = await runner(["-G", ...sshTargetArgs(hostOrAlias, options)], {
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 5000,
  });
  if (result.timedOut || result.spawnFailed) return undefined;
  return parseSshEffectiveRoute(result.stdout);
}
