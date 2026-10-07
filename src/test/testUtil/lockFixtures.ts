import * as path from "node:path";
import type { Identity } from "../../identity/types";
import { ShieldManager, ShieldOperationResult } from "../../shield/manager";
import { ShieldPolicy, buildShieldPolicy } from "../../shield/policy";

/**
 * Shared fixtures for the identity-lock enforcement tests: one canonical
 * identity, a policy builder, and a one-liner to install the lock with the
 * real ShieldManager + the real shipped evaluator.
 */

export const EVALUATOR_SOURCE = path.join(__dirname, "..", "..", "..", "resources", "shield", "shield-evaluate.sh");

/** The canonical "Work" identity used across the enforcement suites. Commit-only unless a test adds `expectedGitHubLogin`. */
export const WORK_IDENTITY: Identity = {
  id: "work",
  label: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  trustedSshHostAliases: ["github-work"],
};

/** Same identity, additionally requiring pushes to authenticate as GitHub user `danish-work`. */
export const WORK_IDENTITY_WITH_LOGIN: Identity = { ...WORK_IDENTITY, expectedGitHubLogin: "danish-work" };

export function identityWith(overrides: Partial<Identity>): Identity {
  return { ...WORK_IDENTITY, ...overrides };
}

export function testPolicy(identity: Identity = WORK_IDENTITY, overrides: Partial<ShieldPolicy> = {}): ShieldPolicy {
  return { ...buildShieldPolicy({ identity, lockId: "test-lock", assignedAt: 1_700_000_000_000, now: 1_700_000_000_000 }), ...overrides };
}

/** Installs the identity lock with the engine directly (no service layer). */
export function enableLock(
  manager: ShieldManager,
  repoDir: string,
  identity: Identity = WORK_IDENTITY,
  options: { chainForeignHooks?: boolean; requireComplete?: boolean; lockId?: string } = {},
): Promise<ShieldOperationResult> {
  return manager.enable(repoDir, EVALUATOR_SOURCE, {
    identity,
    lockId: options.lockId ?? "test-lock",
    assignedAt: 1_700_000_000_000,
    chainForeignHooks: options.chainForeignHooks,
    requireComplete: options.requireComplete,
  });
}

/** The machine-readable `KEY: value` lines of a block message's prelude, as a record. */
export function parseBlockPrelude(stderr: string): Record<string, string> {
  const lines = stderr.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === "REPO_IDENTITY_GUARD_BLOCK");
  const fields: Record<string, string> = {};
  if (start === -1) return fields;
  for (const line of lines.slice(start + 1)) {
    const match = /^([A-Z_]+): (.*)$/.exec(line);
    if (!match) break;
    fields[match[1]] = match[2];
  }
  return fields;
}
