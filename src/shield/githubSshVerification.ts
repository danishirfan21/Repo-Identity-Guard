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
  return sshDashGOutput
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === "identitiesonly yes");
}
