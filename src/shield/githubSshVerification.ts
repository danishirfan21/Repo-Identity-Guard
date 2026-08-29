/**
 * Verified GitHub SSH account binding (Shield Mode Phase 5).
 *
 * GitHub's SSH endpoint supports a well-known noninteractive self-test:
 *
 *   ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=<n> git@<host>
 *
 * which never opens a shell but replies with a short line naming the
 * account (or key identity) that authenticated. This module is the
 * carefully bounded, pure parsing/decision half of that check — it never
 * spawns `ssh` itself (see `resources/shield/shield-evaluate.sh`'s
 * `verify_github_account` shell function for the actual hook-time runtime
 * that does), so every response shape below can be unit tested exactly
 * against real captured GitHub output, with zero network access and zero
 * shell involved.
 *
 * What this module (and the shell function it mirrors) will NEVER do:
 *  - read private key contents, or any file under `~/.ssh` at all;
 *  - copy, move, or generate a key;
 *  - modify `~/.ssh/config`, `known_hosts`, or any other SSH configuration;
 *  - start, query, or otherwise touch `ssh-agent` state;
 *  - store a password or passphrase anywhere;
 *  - send anything anywhere except the single, ordinary SSH connection to
 *    the already-configured GitHub host the push itself would use.
 *
 * Scope: SSH only, and only GitHub's specific `ssh -T` self-identification
 * convention. HTTPS remotes remain entirely unverified under strict
 * account enforcement in this phase — see docs/SHIELD_MODE.md "Phase 5."
 */

export type GitHubAccountVerificationOutcome =
  /** GitHub confirmed a personal account login — the one case that can be compared against `expectedGitHubLogin`. */
  | { kind: "authenticated-user"; login: string }
  /**
   * GitHub confirmed authentication, but the identity it named is shaped
   * like a deploy key or GitHub App installation (`owner/repo`), never a
   * personal username. This can never be soundly compared to a
   * `expectedGitHubLogin` value, so it is always treated as unverifiable —
   * never silently matched, never silently mismatched.
   */
  | { kind: "authenticated-deploy-key"; identity: string }
  /** SSH connected but authentication itself was refused — no identity was ever established. */
  | { kind: "permission-denied" }
  /**
   * The host key for this route is not already trusted (not in
   * `known_hosts`, or it changed). Shield must never auto-accept an
   * unknown host key on the user's behalf — that is the exact blind trust
   * a strict Shield profile exists to avoid — so this always fails safe
   * and tells the user to verify the fingerprint manually.
   */
  | { kind: "host-key-unverified" }
  /** The connection did not complete within the configured timeout. */
  | { kind: "timeout" }
  /**
   * `ssh -G <alias>`'s effective configuration does not set
   * `IdentitiesOnly yes` for this route. Without it, ssh-agent may offer
   * whichever key it has loaded rather than the one this route is
   * configured for, so an authenticated identity — even a matching one —
   * cannot be said to be strongly bound to this specific route. This
   * check never contacts the network; it only reads local, already-public
   * SSH client configuration.
   */
  | { kind: "identities-not-isolated" }
  /**
   * `ssh -G <alias>`'s *effective* route does not actually lead to a
   * GitHub SSH endpoint (Phase 8 hardening).
   *
   * Without this check, "verified" rested entirely on a trusted alias
   * name plus a greeting that merely *looked* like GitHub's. An alias is
   * just a label in the user's own `~/.ssh/config`: nothing stops
   * `Host github-work` from resolving to `HostName evil.example`, and
   * nothing stops whatever answers there from replying `Hi octocat! You've
   * successfully authenticated...`. That would have satisfied every
   * pre-Phase-8 condition — trusted alias, `IdentitiesOnly yes`,
   * GitHub-shaped greeting — and Shield would have reported the account
   * verified. Resolving the alias to its real `HostName` first, and
   * refusing to treat a non-GitHub endpoint's self-report as a GitHub
   * account, closes that.
   */
  | { kind: "route-not-github"; hostname: string; port: string }
  /**
   * The effective route could not be resolved at all (`ssh -G` failed or
   * produced no `hostname` line), so the probe cannot be shown to
   * reproduce the route the real push would take. Never assumed to be
   * fine.
   */
  | { kind: "route-unresolvable" }
  /** Output that doesn't match any recognized GitHub SSH response shape. Never guessed at — treated the same as any other unverifiable outcome. */
  | { kind: "malformed"; raw: string };

/**
 * Parses the combined stdout+stderr of a noninteractive
 * `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=<n> <user>@<host>`
 * probe. This is the exact text-matching logic
 * `resources/shield/shield-evaluate.sh`'s `verify_github_account` shell
 * function mirrors (see that function's comments) — kept here too so it
 * can be exercised exhaustively, fast, and without a real `ssh` process at
 * all.
 *
 * Deliberately does **not** take an exit code parameter: GitHub's SSH
 * endpoint commonly exits 1 even on fully successful authentication (it
 * has no shell to hand back), so the process exit code is not a
 * pass/fail signal on its own — only the response text is. A caller must
 * not gate on exit code before calling this.
 */
export function parseGitHubSshAuthOutput(output: string): GitHubAccountVerificationOutcome {
  if (/successfully authenticated/i.test(output)) {
    const match = output.match(/Hi ([^!]+)!/);
    const identity = match ? match[1].trim() : "";
    if (!identity) {
      return { kind: "malformed", raw: output };
    }
    if (identity.includes("/")) {
      return { kind: "authenticated-deploy-key", identity };
    }
    return { kind: "authenticated-user", login: identity };
  }

  if (/permission denied/i.test(output)) {
    return { kind: "permission-denied" };
  }

  if (
    /host key verification failed/i.test(output) ||
    /no .*host key is known/i.test(output) ||
    /know the (ecdsa|ed25519|rsa|dsa) key fingerprint/i.test(output)
  ) {
    return { kind: "host-key-unverified" };
  }

  if (/timed out/i.test(output)) {
    return { kind: "timeout" };
  }

  return { kind: "malformed", raw: output };
}

/**
 * True when `ssh -G <alias>`'s effective-configuration output (one
 * lowercased `key value` pair per line, exactly as `ssh -G` emits it) sets
 * `IdentitiesOnly yes`. Read-only: this never mutates SSH configuration,
 * it only inspects the effective config `ssh` itself would already use.
 */
export function sshConfigHasIdentitiesOnly(sshDashGOutput: string): boolean {
  return sshConfigValue(sshDashGOutput, "identitiesonly") === "yes";
}

/**
 * The effective route `ssh` itself would use for an alias, as reported by
 * `ssh -G [-p <port>] <user>@<alias>`.
 *
 * `ssh -G` prints the fully-resolved configuration — every `Host`/`Match`
 * block already applied — as lowercase `keyword value` lines. That makes
 * it the only local, read-only way to answer "where does this alias
 * actually go?" without guessing at `~/.ssh/config` parsing rules
 * (`Include`, `Match exec`, per-user vs system config, command-line
 * overrides) that Shield has no business reimplementing.
 */
export interface SshEffectiveRoute {
  /** The real host `ssh` will connect to — NOT the alias. Empty when `ssh -G` did not report one. */
  hostname: string;
  /** Effective port, as a string (`ssh -G` always prints one; "22" when nothing set it). */
  port: string;
  /** Effective login user for the SSH connection (`git` for a normal GitHub route). */
  user: string;
  /** Whether `IdentitiesOnly yes` is in effect for this route. */
  identitiesOnly: boolean;
}

function sshConfigValue(sshDashGOutput: string, keyword: string): string | undefined {
  for (const line of sshDashGOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const spaceAt = trimmed.search(/\s/);
    if (spaceAt < 0) continue;
    if (trimmed.slice(0, spaceAt).toLowerCase() !== keyword) continue;
    return trimmed.slice(spaceAt + 1).trim().toLowerCase();
  }
  return undefined;
}

/**
 * Parses `ssh -G`'s effective-configuration output. Purely textual and
 * read-only: it never spawns `ssh`, never reads a key, and never writes
 * SSH configuration. Returns `undefined` when the output carries no
 * `hostname` line at all, which is what `ssh -G` failing (or being handed
 * something it could not resolve) looks like — treated as "route
 * unresolvable", never as a route that happens to be fine.
 */
export function parseSshEffectiveRoute(sshDashGOutput: string): SshEffectiveRoute | undefined {
  const hostname = sshConfigValue(sshDashGOutput, "hostname");
  if (!hostname) return undefined;
  return {
    hostname,
    port: sshConfigValue(sshDashGOutput, "port") ?? "22",
    user: sshConfigValue(sshDashGOutput, "user") ?? "",
    identitiesOnly: sshConfigValue(sshDashGOutput, "identitiesonly") === "yes",
  };
}

/**
 * The hostnames GitHub's own SSH Git endpoint answers on. `ssh.github.com`
 * is GitHub's documented port-443 alternative endpoint, and
 * `<something>.github.com` covers the same family; anything else — an IP
 * literal, a look-alike domain, a corporate proxy, a GitHub Enterprise
 * Server install — is NOT github.com and therefore cannot be the source
 * of a github.com account identity.
 *
 * Deliberately conservative rather than clever: `expectedGitHubLogin` is
 * specifically a github.com username (see `Profile.expectedGitHubLogin`),
 * so a route to a GitHub Enterprise Server host must read as unverified
 * rather than have its usernames silently compared against github.com's
 * namespace. Widening this would need an explicit, separate profile field
 * naming the Enterprise host.
 */
export function isGitHubSshEndpoint(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host === "github.com" || host === "ssh.github.com" || host.endsWith(".github.com");
}
