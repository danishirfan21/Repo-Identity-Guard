import { parseRemoteUrl } from "../services/gitService";
import { evaluatePush, resolveSshCommandOverrides, SshTransportEnvironment } from "../shield/evaluator";
import { GitHubAccountVerificationOutcome, isGitHubSshEndpoint, parseGitHubSshAuthOutput } from "../shield/githubSshVerification";
import { buildShieldPolicy } from "../shield/policy";
import { SshRunner, defaultSshRunner, resolveSshEffectiveRoute, sshTargetArgs } from "../shield/sshEndpoint";
import { ShieldReasonId } from "../shield/types";
import { Identity } from "./types";

/**
 * The explicit, on-demand push-account check ("Check Identity Lock", and
 * once at assignment time). It asks exactly the question the pre-push
 * hook asks on every real push — same route rules, same `ssh -G` +
 * `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes` probe, same
 * response parsing, and the SAME decision function (`evaluatePush`) —
 * so "the check said verified" and "the push was allowed" can never
 * disagree.
 *
 * Performance boundary: this makes a real network connection, so it is
 * NEVER run on passive refreshes (opening a repository, file-watcher
 * scans, sidebar renders). Only an explicit user action calls it.
 */

export type PushAccountCheckStatus =
  /** The route authenticated as the identity's expected GitHub login. */
  | "verified"
  /** The route authenticated as a different GitHub login. A real push would be blocked. */
  | "mismatch"
  /** The account could not be established. A real push would be blocked. */
  | "unverifiable"
  /** The identity has no GitHub login configured, so a real push is BLOCKED (`push-identity-not-configured`) — never allowed unchecked. */
  | "needs_configuration"
  /** There is no push remote to check. */
  | "no_push_remote";

export interface PushAccountCheckResult {
  status: PushAccountCheckStatus;
  /** The blocking reason id a real push would report, when it would be blocked. */
  reasonId?: ShieldReasonId;
  authenticatedLogin?: string;
  message: string;
}

export interface PushAccountProbeInput {
  identity: Identity;
  /** The URL a plain `git push` would use (pushurl honored). */
  pushRemoteUrl: string | undefined;
  /** Transport-override inputs, read fresh by the caller (env + `git config`). */
  transport: SshTransportEnvironment;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: SshRunner;
}

/** Runs the live probe over one route — the TypeScript twin of `verify_github_account` in shield-evaluate.sh. */
export async function probeGitHubAccount(
  host: string,
  options: { user?: string; port?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; runner?: SshRunner } = {},
): Promise<GitHubAccountVerificationOutcome> {
  const runner = options.runner ?? defaultSshRunner;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 8000;
  const route = await resolveSshEffectiveRoute(host, { ...options, runner, env, timeoutMs });
  if (!route) return { kind: "route-unresolvable" };
  if (!isGitHubSshEndpoint(route.hostname)) return { kind: "route-not-github", hostname: route.hostname, port: route.port };
  if (!route.identitiesOnly) return { kind: "identities-not-isolated" };

  const connectTimeoutSeconds = String(Math.max(1, Math.floor(timeoutMs / 1000) - 1));
  const result = await runner(
    ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `ConnectTimeout=${connectTimeoutSeconds}`, ...sshTargetArgs(host, options)],
    { env, timeoutMs },
  );
  if (result.timedOut) return { kind: "timeout" };
  // GitHub exits 1 even on fully successful authentication, so only the
  // response text is consulted, never the exit code.
  return parseGitHubSshAuthOutput(`${result.stdout}\n${result.stderr}`);
}

export async function checkPushAccount(input: PushAccountProbeInput): Promise<PushAccountCheckResult> {
  const { identity } = input;
  const policy = buildShieldPolicy({ identity, lockId: "probe", assignedAt: 0, now: 0 });
  if (!identity.expectedGitHubLogin) {
    // Same decision function as the hook: with no login, every push is
    // blocked whatever the remote — so this is reported as a block, never
    // as "nothing to check".
    const reason = evaluatePush(policy, { remoteName: "", remoteUrl: input.pushRemoteUrl ?? "", sshCommandOverrides: [] }).reasons[0];
    return { status: "needs_configuration", reasonId: reason.id, message: `A push from this repository would be blocked: ${reason.message}` };
  }
  if (!input.pushRemoteUrl) {
    return { status: "no_push_remote", message: "This repository has no push remote to check." };
  }

  const sshCommandOverrides = resolveSshCommandOverrides(input.transport);
  const base = { remoteName: "", remoteUrl: input.pushRemoteUrl, sshCommandOverrides };

  // Route first, exactly like the hook: an untrusted or overridden route is
  // blocked before any network connection is made.
  const routeOnly = evaluatePush(policy, base);
  const routeReason = routeOnly.reasons.find((r) => r.id === "push-route-unverified" || r.id === "push-route-override");
  if (routeReason) {
    return { status: "unverifiable", reasonId: routeReason.id, message: routeReason.message };
  }

  const parsed = parseRemoteUrl(input.pushRemoteUrl);
  const outcome = await probeGitHubAccount(parsed.host as string, {
    user: parsed.sshUser,
    port: parsed.port,
    env: input.env,
    timeoutMs: input.timeoutMs,
    runner: input.runner,
  });
  const decision = evaluatePush(policy, { ...base, githubAccountCheck: outcome });
  if (decision.allowed) {
    return {
      status: "verified",
      authenticatedLogin: outcome.kind === "authenticated-user" ? outcome.login : undefined,
      message: `Pushes from this repository authenticate as ${identity.expectedGitHubLogin}.`,
    };
  }
  const reason = decision.reasons[0];
  return {
    status: reason.id === "push-account-mismatch" ? "mismatch" : "unverifiable",
    reasonId: reason.id,
    authenticatedLogin: outcome.kind === "authenticated-user" ? outcome.login : undefined,
    message: reason.message,
  };
}
