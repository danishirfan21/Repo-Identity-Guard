import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSshEffectiveRoute } from "./githubSshVerification";

const execFileAsync = promisify(execFile);

/**
 * The canonical physical SSH endpoint Shield persists into a policy's
 * `approvedPushDestination` (at enable/repair time) and compares the
 * CURRENT route against (at push/health-check time) — see
 * docs/SHIELD_MODE.md's "canonical physical push endpoint" section for the
 * full writeup of why a literal alias-name comparison is not sufficient.
 */
export interface CanonicalSshEndpoint {
  /** The real host `ssh` will connect to — never the alias/literal host asked about. */
  host: string;
  /** Effective port, as a string (`ssh -G` always reports one; "22" when nothing set it). */
  port: string;
}

/**
 * Resolves the REAL endpoint `ssh` would connect to for a given host or
 * alias, via `ssh -G` — purely local (reads the effective `~/.ssh/config`,
 * opens no network connection) and never trusts the input string's own
 * name as evidence of where it goes.
 *
 * Returns `undefined` when `ssh` isn't on PATH, the call times out, or it
 * reports no hostname at all — every one of those is "unresolved," and
 * every caller of this function must treat that the same way: as evidence
 * that could not be gathered, never as a route that happens to be fine.
 *
 * Deliberately takes no way to run a caller-supplied command or shell
 * snippet: this spawns exactly `ssh -G <hostOrAlias>` via `execFile` (no
 * shell interpretation of `hostOrAlias`) and nothing else. It never
 * executes `GIT_SSH_COMMAND`/`core.sshCommand` to "discover" what they
 * would do — the presence of either makes the endpoint unprovable by
 * design (see the transport-override check in manager.ts/evaluator.ts),
 * never something this function tries to resolve around.
 */
export async function resolveCanonicalSshEndpoint(
  hostOrAlias: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; port?: string; user?: string } = {},
): Promise<CanonicalSshEndpoint | undefined> {
  const trimmed = hostOrAlias.trim();
  if (!trimmed) {
    return undefined;
  }
  // Matches shield-evaluate.sh's resolve_canonical_ssh_route exactly: `-p
  // <port>` is passed ONLY when the caller supplied an explicit port (from
  // the URL itself, e.g. `ssh://git@host:443/...`) — an absent port here
  // must ask `ssh -G` with no `-p` at all, the same "whatever this host's
  // effective config says" question the real push transport asks, never a
  // guessed default. Passing the two sides of a comparison through
  // DIFFERENT port semantics (one with an explicit `-p`, one without) is
  // exactly what let an unchanged approved SSH destination read as a port
  // mismatch — see docs/SHIELD_MODE.md's explicit-SSH-URL-port section.
  const user = options.user?.trim() || "git";
  const args = options.port ? ["-G", "-p", options.port, `${user}@${trimmed}`] : ["-G", `${user}@${trimmed}`];
  try {
    const { stdout } = await execFileAsync("ssh", args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5000,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const route = parseSshEffectiveRoute(stdout);
    if (!route) {
      return undefined;
    }
    return { host: route.hostname, port: route.port };
  } catch {
    return undefined;
  }
}
