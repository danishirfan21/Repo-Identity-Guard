import { parseRemoteUrl } from "../services/gitService";
import { GitHubAccountVerificationOutcome } from "./githubSshVerification";
import { ShieldPolicy, ShieldPolicyValidationResult } from "./policy";
import { ShieldAction, ShieldDecision, ShieldReason, decisionFromReasons } from "./types";

/**
 * Pure reference implementation of the identity lock's decision logic.
 *
 * This is the **spec**, not the shipped hook runtime — the artifact Git
 * hooks actually invoke is `resources/shield/shield-evaluate.sh` (POSIX
 * shell + `git` only, no Node). This module exists so the decision
 * semantics can be unit tested exhaustively and fast, and cross-checked
 * against the shell script by the differential suites so the two never
 * silently drift apart.
 *
 * The lock answers exactly one question per action:
 *  - commit: is the EFFECTIVE author AND committer identity the assigned one?
 *  - push (always): does the identity have an expected GitHub login at all
 *    (no → blocked, `push-identity-not-configured`), can this push's route
 *    be shown to authenticate as that login, and does it?
 * Branch names, repository operation state (merge/rebase/conflicts) and
 * the push destination's owner/repo are deliberately never consulted.
 */

/** SSH/HTTPS hosts shared by many accounts — never accepted as a push route, even if listed as a trusted alias. */
const GENERIC_REMOTE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

// ==================== commit ====================

export interface CommitEvalFacts {
  /** Set only when Git inspection itself failed. When set, this is the only reason produced — nothing else can be trusted. */
  inspectionError?: string;

  effectiveAuthorName?: string;
  effectiveAuthorEmail?: string;
  effectiveCommitterName?: string;
  effectiveCommitterEmail?: string;

  /** `git config --worktree` ?? `--local` ?? `--global`, read fresh at action time. Only used to tell a config mismatch from an env/CLI override. */
  configuredName?: string;
  configuredEmail?: string;
}

function identityReasons(policy: ShieldPolicy, facts: CommitEvalFacts): ShieldReason[] {
  const nameMatches = (name?: string) => !policy.expectedGitName || normalize(name) === normalize(policy.expectedGitName);
  const emailMatches = (email?: string) => normalize(email) === normalize(policy.expectedGitEmail);

  const authorMismatch = !nameMatches(facts.effectiveAuthorName) || !emailMatches(facts.effectiveAuthorEmail);
  const committerMismatch = !nameMatches(facts.effectiveCommitterName) || !emailMatches(facts.effectiveCommitterEmail);

  if (!authorMismatch && !committerMismatch) {
    return [];
  }

  const who: string[] = [];
  if (authorMismatch) who.push(`author (${facts.effectiveAuthorName ?? "unknown"} <${facts.effectiveAuthorEmail ?? "unknown"}>)`);
  if (committerMismatch) who.push(`committer (${facts.effectiveCommitterName ?? "unknown"} <${facts.effectiveCommitterEmail ?? "unknown"}>)`);

  // If the *configured* identity already matches, an environment variable
  // or explicit --author/-c override is what's actually wrong, and writing
  // config again would not fix it.
  const configuredMatches = nameMatches(facts.configuredName) && emailMatches(facts.configuredEmail);

  if (configuredMatches) {
    return [
      {
        id: "commit-identity-override",
        message: `Git config for this repository already uses ${policy.identityLabel}, but this commit's ${who.join(" and ")} is overridden by the environment or a command-line option.`,
      },
    ];
  }

  return [
    {
      id: "commit-identity-mismatch",
      message: `This commit's ${who.join(" and ")} does not match the assigned identity ${policy.identityLabel} (expected ${policy.expectedGitEmail}).`,
    },
  ];
}

export function evaluateCommit(policy: ShieldPolicy, facts: CommitEvalFacts, now: number = Date.now()): ShieldDecision {
  if (facts.inspectionError) {
    return decisionFromReasons("commit", [{ id: "inspection-failed", message: `Git state could not be read: ${facts.inspectionError}` }], now);
  }
  return decisionFromReasons("commit", identityReasons(policy, facts), now);
}

// ==================== push ====================

export interface PushEvalFacts {
  /** As passed to a real `pre-push` hook's argv: the remote's name and its literal URL, resolved fresh at push time. */
  remoteName: string;
  remoteUrl: string;
  /** Raw ref lines Git feeds a real `pre-push` hook on stdin — accepted for contract fidelity, never needed for an identity decision. */
  refLines?: string[];
  /**
   * Every SSH-transport override visible at push time, named for the
   * message; empty when there are none. Any of them makes the route a push
   * actually takes unprovable against the `ssh -G`/`ssh -T` probe:
   * `GIT_SSH`, `GIT_SSH_COMMAND`, the effective `core.sshCommand` (any
   * scope, including a command-scoped `-c`), and a non-OpenSSH effective
   * `ssh.variant`/`GIT_SSH_VARIANT`. See {@link resolveSshCommandOverrides}.
   */
  sshCommandOverrides: string[];
  /**
   * The live `ssh -T` account check, when one was actually run. Computed
   * outside this pure module (the shell's `verify_github_account`); absent
   * means "required but never attempted", which is treated as unverified,
   * never as a pass.
   */
  githubAccountCheck?: GitHubAccountVerificationOutcome;
}

/**
 * The read-only inputs that decide whether an ssh-protocol push's transport
 * can diverge from the one the `ssh -G`/`ssh -T` probe would take.
 */
export interface SshTransportEnvironment {
  /** `GIT_SSH` (a program path). */
  gitSsh?: string;
  /** `GIT_SSH_COMMAND` (a shell snippet — NEVER executed to "verify" it). */
  gitSshCommand?: string;
  /** `git config --get core.sshCommand`, any scope, including command-scoped `-c`. */
  coreSshCommand?: string;
  /** `GIT_SSH_VARIANT` (environment form; takes precedence over the config key). */
  gitSshVariant?: string;
  /** `git config --get ssh.variant`, any scope, including command-scoped `-c`. */
  sshVariantConfig?: string;
}

/** `ssh.variant` values that assert ordinary OpenSSH semantics — the exact conventions the probe uses, so not a divergence. */
const OPENSSH_EQUIVALENT_VARIANTS = new Set(["", "auto", "ssh"]);

/**
 * The names of every SSH-transport override in effect, in the same order
 * and spelling `resources/shield/shield-evaluate.sh` produces. Never
 * executes or interprets the *value* of `GIT_SSH_COMMAND`/`core.sshCommand`:
 * presence alone makes the route unprovable.
 */
export function resolveSshCommandOverrides(env: SshTransportEnvironment): string[] {
  const overrides: string[] = [];
  if (env.gitSsh) overrides.push("GIT_SSH");
  if (env.gitSshCommand) overrides.push("GIT_SSH_COMMAND");
  if (env.coreSshCommand) overrides.push("core.sshCommand");

  // GIT_SSH_VARIANT wins over ssh.variant (Git's own precedence), so the
  // EFFECTIVE value is judged.
  const source = env.gitSshVariant ? "GIT_SSH_VARIANT" : "ssh.variant";
  const effectiveVariant = (env.gitSshVariant || env.sshVariantConfig || "").trim();
  if (!OPENSSH_EQUIVALENT_VARIANTS.has(effectiveVariant.toLowerCase())) {
    overrides.push(`${source}=${effectiveVariant}`);
  }
  return overrides;
}

/**
 * Whether this push's route can carry account evidence at all: SSH, no
 * transport override, and a host that is one of the identity's explicitly
 * trusted aliases (never a generic shared host). Returns the blocking
 * reason when it can't.
 */
function routeReasons(policy: ShieldPolicy, protocol: string, host: string | undefined, sshUser: string | undefined, sshCommandOverrides: string[]): ShieldReason[] {
  const isGenericHost = !!host && GENERIC_REMOTE_HOSTS.has(normalize(host));

  if (protocol === "ssh" && sshCommandOverrides.length > 0) {
    return [
      {
        id: "push-route-override",
        message: `An SSH transport override (${sshCommandOverrides.join(", ")}) is in effect, so the route this push would actually use cannot be verified as ${policy.identityLabel}'s GitHub account.`,
      },
    ];
  }

  const trustedAliases = policy.trustedSshHostAliases.map(normalize);
  const isTrustedAlias = protocol === "ssh" && !!host && !isGenericHost && trustedAliases.includes(normalize(host));
  if (isTrustedAlias) {
    // Option-injection guard: an SSH user or host beginning with "-" would
    // be read by `ssh` as a command-line OPTION (e.g. "-oProxyCommand=..."),
    // not a destination, when the account probe runs. Such a route is never
    // handed to ssh at all. Mirrors the same guard in shield-evaluate.sh.
    if ((sshUser ?? "").startsWith("-") || (host ?? "").startsWith("-")) {
      return [
        {
          id: "push-route-unverified",
          message: 'This push\'s SSH user or host begins with "-", which ssh would read as a command-line option, so the route is never probed.',
        },
      ];
    }
    return [];
  }

  const message =
    protocol === "https"
      ? "This push is over HTTPS. The account that authenticates it cannot be verified locally."
      : protocol === "ssh" && isGenericHost
        ? `This push uses the generic SSH host "${host}", which authenticates with whichever key is used by default.`
        : protocol === "ssh"
          ? `This push uses SSH host alias "${host}", which ${policy.identityLabel} does not list as a trusted alias.`
          : "This push's protocol could not be determined, so the account that would authenticate it cannot be verified locally.";
  return [{ id: "push-route-unverified", message }];
}

/** Live account binding — only consulted once the route itself is trusted. Absence of a check result is unverified, never a pass. */
function accountReasons(policy: ShieldPolicy, facts: PushEvalFacts): ShieldReason[] {
  const expected = policy.expectedGitHubLogin as string;
  const unverified = (reason: string): ShieldReason[] => [{ id: "push-account-unverified", message: `Expected GitHub account: ${expected}. ${reason}` }];

  const check = facts.githubAccountCheck;
  if (!check) {
    return unverified("This push's SSH route was not checked against GitHub, so the authenticated account is unconfirmed.");
  }
  switch (check.kind) {
    case "authenticated-user":
      if (normalize(check.login) === normalize(expected)) return [];
      return [
        {
          id: "push-account-mismatch",
          message: `Expected GitHub account: ${expected}. Authenticated GitHub account: ${check.login}.`,
        },
      ];
    case "authenticated-deploy-key":
      return unverified(`This route authenticated using a deploy-key-style identity ("${check.identity}"), not a personal GitHub account.`);
    case "permission-denied":
      return unverified("SSH authentication to GitHub was refused (permission denied).");
    case "host-key-unverified":
      return unverified("This SSH host's key is not already trusted in known_hosts, so Repo Identity Guard refused to connect automatically.");
    case "timeout":
      return unverified("The SSH connection timed out while verifying the account.");
    case "identities-not-isolated":
      return unverified('This SSH route\'s effective configuration does not set "IdentitiesOnly yes", so ssh-agent could offer a different key.');
    case "route-not-github":
      return unverified(`This SSH route's effective destination is ${check.hostname}:${check.port}, which is not a GitHub SSH endpoint.`);
    case "route-unresolvable":
      return unverified('Could not resolve this SSH route\'s effective destination ("ssh -G" reported no hostname).');
    case "malformed":
      return unverified("SSH's response while verifying the account could not be parsed.");
  }
}

/**
 * The block an assigned repository's push gets while its identity has no
 * GitHub login: nothing can attribute the push to the assigned identity,
 * so it is refused — never waved through as "not checked". Exported so the
 * on-demand check reports exactly the hook's wording.
 */
export function pushIdentityNotConfiguredReason(identityLabel: string): ShieldReason {
  return {
    id: "push-identity-not-configured",
    message: `This repository is locked to "${identityLabel}", but that identity does not yet have a GitHub account configured for push verification, so every push is blocked. Configure the GitHub account for "${identityLabel}" in Repo Identity Guard, then retry.`,
  };
}

export function evaluatePush(policy: ShieldPolicy, facts: PushEvalFacts, now: number = Date.now()): ShieldDecision {
  // Push is always governed by an assigned repository's lock. No expected
  // GitHub login means the push requirement is INCOMPLETE — block, before
  // the route is even looked at (no route could make it verifiable).
  if (!policy.expectedGitHubLogin) {
    return decisionFromReasons("push", [pushIdentityNotConfiguredReason(policy.identityLabel)], now);
  }
  const parsed = parseRemoteUrl(facts.remoteUrl);
  const route = routeReasons(policy, parsed.protocol, parsed.host, parsed.sshUser, facts.sshCommandOverrides);
  if (route.length > 0) {
    return decisionFromReasons("push", route, now);
  }
  return decisionFromReasons("push", accountReasons(policy, facts), now);
}

/**
 * Produces a decision directly from a policy *load* result (missing,
 * invalid, or valid), so "there was no policy" and "the policy was
 * garbage" both collapse to a single fail-closed denial before any Git
 * state is evaluated.
 */
export function evaluateFromPolicyLoad(
  action: ShieldAction,
  policyLoad: { found: false } | ({ found: true } & ShieldPolicyValidationResult),
  facts: CommitEvalFacts | PushEvalFacts,
  now: number = Date.now(),
): ShieldDecision {
  if (!policyLoad.found) {
    return decisionFromReasons(action, [{ id: "policy-missing", message: "The identity lock is installed but no policy file was found." }], now);
  }
  if (!policyLoad.ok) {
    const detail = policyLoad.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    return decisionFromReasons(action, [{ id: "policy-corrupt", message: `The identity-lock policy is invalid: ${detail}` }], now);
  }
  return action === "commit"
    ? evaluateCommit(policyLoad.policy, facts as CommitEvalFacts, now)
    : evaluatePush(policyLoad.policy, facts as PushEvalFacts, now);
}
