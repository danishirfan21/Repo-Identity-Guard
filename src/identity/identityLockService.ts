import * as crypto from "node:crypto";
import { getCurrentBranch, getGitConfigValue, getOriginRemote, getPushRemoteName, getPushUrl } from "../services/gitService";
import { PREVIOUS_LOCK_ARTIFACT_VERSION } from "../shield/artifacts";
import { ShieldInspection, ShieldManager } from "../shield/manager";
import { SshRunner } from "../shield/sshEndpoint";
import { RepositoryRef, assignmentFromInspection, resolveRepository } from "./assignment";
import { pushEnforcementFor, validateIdentity } from "./identityConfig";
import { decideLegacyMigration } from "./legacyMigration";
import { PushAccountCheckResult, checkPushAccount } from "./pushAccountProbe";
import { Identity, RepoIdentityAssignment, RepoIdentityEnforcement, RepoIdentityState } from "./types";

/**
 * The identity lock — the product's first job — as one small service:
 * assign an identity to a repository, change it, unlock, inspect health,
 * repair. It owns the product semantics; the hardened on-disk mechanics
 * (hook coexistence and chaining, transactional install with rollback,
 * install record, tamper/version detection, fail-closed shims) are
 * delegated to `ShieldManager`, the enforcement engine formerly exposed as
 * "Shield Mode".
 *
 * Semantics:
 *  - Assigning an identity IS enabling enforcement. There is no separate
 *    "also protect this repository?" decision.
 *  - The invariant is binary: an UNASSIGNED repository is never
 *    restricted; an ASSIGNED repository always governs BOTH commit and
 *    push. An identity that is not enforcement-ready (no GitHub login, or
 *    no trusted SSH alias) can still be assigned — its commits are locked
 *    at once — but every push is blocked until it is completed, and the
 *    repository reports `needs_attention`, never `active`. There is no
 *    "assigned, but pushes are not checked" mode.
 *  - Assign/change is all-or-nothing (`requireComplete`): it either ends
 *    with a fully active lock for the requested identity, or with the
 *    repository exactly as it was before (refused before writing, or
 *    rolled back). A lock is never reported or persisted as assigned while
 *    its hooks are not installed.
 *  - Unlock removes every hook the lock owns (restoring chained hooks
 *    byte-for-byte) BEFORE removing the assignment record. If any owned
 *    hook cannot be removed, the record is kept and the repository keeps
 *    reporting "needs attention" — never "unassigned" while a lock hook
 *    could still block Git.
 *  - An unassigned repository is never touched, except to remove a
 *    legacy Shield installation that no explicit assignment can be proven
 *    for (see `migrateLegacy`).
 *
 * No `vscode` dependency: Workspace Trust gating and user confirmation are
 * the caller's job (extension.ts); everything here is exercised directly
 * against real temporary Git repositories by the test suite.
 */

export interface LockStatus {
  repo: RepositoryRef;
  assignment?: RepoIdentityAssignment;
  /** The UI projection of the assignment (identity snapshot as enforced). */
  assignmentView?: RepoIdentityState["assignment"];
  enforcement: RepoIdentityEnforcement;
  /** True when a legacy (pre-identity-lock) Shield installation is present and awaiting migration. */
  legacy: boolean;
  /** Internal engine inspection — for diagnostics and tests, not for UI binding. */
  inspection: ShieldInspection;
}

export interface LockOperationResult {
  ok: boolean;
  /** One user-facing sentence summarizing the outcome. */
  message: string;
  /** Additional detail lines (refusal reasons, warnings). */
  details: string[];
  /** The repository's status after the operation. */
  status?: LockStatus;
}

export type PreviousLockUpgradeOutcome =
  | { kind: "none" }
  | { kind: "upgraded"; identityLabel: string; message: string; status: LockStatus }
  | { kind: "failed"; message: string; details: string[]; status?: LockStatus };

export type LegacyMigrationOutcome =
  | { kind: "none" }
  | { kind: "migrated"; identityLabel: string; message: string; status: LockStatus }
  | { kind: "removed"; message: string; status: LockStatus }
  | { kind: "failed"; message: string; details: string[]; status?: LockStatus };

export interface IdentityLockServiceOptions {
  /** Absolute path to the bundled `resources/shield/shield-evaluate.sh`. */
  evaluatorScriptSource: string;
  shield?: ShieldManager;
  now?: () => number;
  /** Lock-id generator — injectable for deterministic tests. */
  newLockId?: () => string;
}

const UNAVAILABLE_ENFORCEMENT = (reason: string): RepoIdentityEnforcement => ({
  state: "unavailable",
  reason,
  commitEnforced: false,
  push: "none",
  repairAvailable: false,
  unlockAvailable: false,
});

/**
 * True when the on-disk artifacts are a pre-identity-lock (legacy Shield)
 * installation rather than an identity lock (current, previous-version
 * awaiting upgrade, or damaged).
 */
export function isLegacyInstallation(inspection: ShieldInspection): boolean {
  if (inspection.policyValid || inspection.policyNeedsUpgrade) return false;
  if (inspection.legacyPolicy) return true;
  const oldHook = inspection.hooks.some((h) => h.ownership === "shield" && (h.version ?? 0) < PREVIOUS_LOCK_ARTIFACT_VERSION);
  const oldEvaluator = inspection.evaluatorOwned && (inspection.evaluatorVersion ?? 0) < PREVIOUS_LOCK_ARTIFACT_VERSION;
  // Artifacts from a pre-v6 (Shield Mode) build with no lock policy are a
  // legacy installation even when the legacy policy itself is missing or
  // unreadable — migration then simply removes them (nothing provable).
  // v6 artifacts belong to an identity lock (policy v3): never "legacy",
  // so a damaged one is never removed automatically.
  return oldHook || oldEvaluator;
}

/** The identity a lock policy snapshot records — exactly what the lock enforces, never the (possibly edited) live definition. */
export function identityFromSnapshot(snapshot: NonNullable<ShieldInspection["policySnapshot"]>): Identity {
  const identity: Identity = { id: snapshot.identityId, label: snapshot.identityLabel, gitEmail: snapshot.expectedGitEmail };
  if (snapshot.expectedGitName) identity.gitName = snapshot.expectedGitName;
  if (snapshot.expectedGitHubLogin) identity.expectedGitHubLogin = snapshot.expectedGitHubLogin;
  if (snapshot.trustedSshHostAliases.length > 0) identity.trustedSshHostAliases = [...snapshot.trustedSshHostAliases];
  return identity;
}

/**
 * The one sentence explaining why an assigned repository's pushes are all
 * blocked by an incomplete push requirement, or `undefined` when push is
 * `enforced`. Shared by status, assign and upgrade so the wording cannot
 * drift — and so it can never read as "pushes are allowed".
 */
export function pushRequirementProblem(snapshot: Pick<Identity, "label" | "gitEmail" | "expectedGitHubLogin" | "trustedSshHostAliases">): string | undefined {
  const push = pushEnforcementFor(snapshot);
  if (push === "needs_configuration") {
    const aliasNote = (snapshot.trustedSshHostAliases ?? []).length === 0 ? " It also needs a trusted SSH host alias to push through." : "";
    return `Commits are checked against ${snapshot.gitEmail}, but "${snapshot.label}" has no GitHub account configured for push verification, so every push from this repository is blocked. Configure the GitHub account (expectedGitHubLogin) for "${snapshot.label}" in Repo Identity Guard, then run Repair Identity Lock.${aliasNote}`;
  }
  if (push === "unverifiable") {
    return `"${snapshot.label}" expects the GitHub account "${snapshot.expectedGitHubLogin}" but lists no trusted SSH host alias, so no push from this repository can be verified — every push is blocked until an alias is added to the identity (then run Repair Identity Lock).`;
  }
  return undefined;
}

/**
 * Pure projection of an engine inspection (plus the live identity list)
 * onto the product's enforcement contract. Exported for tests.
 */
export function deriveEnforcement(inspection: ShieldInspection, identities: Identity[]): RepoIdentityEnforcement {
  if (!inspection.gitContext) {
    return UNAVAILABLE_ENFORCEMENT(inspection.reasons[0] ?? "This repository's Git state could not be read.");
  }
  const snapshot = inspection.policyValid || inspection.policyNeedsUpgrade ? inspection.policySnapshot : undefined;
  const ownedPreCommit = inspection.hooks.some((h) => h.fileName === "pre-commit" && h.ownership === "shield");
  const commitEnforced = ownedPreCommit && inspection.evaluatorOwned && !!snapshot;

  if (inspection.state === "off") {
    const stranded = inspection.hooks.find((h) => h.hasChainedOriginal && h.ownership !== "shield");
    if (stranded) {
      return {
        state: "needs_attention",
        reason: `A ${stranded.fileName} hook that Repo Identity Guard had chained could not be restored automatically because something else now occupies ${stranded.path}. Git is not restricted by Repo Identity Guard, but your original hook is preserved next to it with the suffix ".repo-identity-guard-original" — restore it by hand.`,
        commitEnforced: false,
        push: "none",
        repairAvailable: false,
        unlockAvailable: false,
      };
    }
    return { state: "unassigned", commitEnforced: false, push: "none", repairAvailable: false, unlockAvailable: false };
  }

  if (isLegacyInstallation(inspection)) {
    return {
      state: "needs_attention",
      reason:
        "This repository still has a legacy Repo Identity Guard \"Shield\" installation, which keeps enforcing the old Shield policy until it is migrated. Repair migrates it to an identity lock if an explicit binding can be proven, otherwise it is removed; Unlock removes it.",
      commitEnforced: false,
      push: "none",
      repairAvailable: true,
      unlockAvailable: true,
    };
  }

  if (!snapshot) {
    return {
      state: "needs_attention",
      reason: inspection.reasons[0] ?? "Identity-lock files are present but the lock record is missing or damaged.",
      commitEnforced: false,
      push: "none",
      repairAvailable: false,
      unlockAvailable: true,
    };
  }

  const recorded = identityFromSnapshot(snapshot);
  const push = pushEnforcementFor(recorded);
  const identityStillDefined = identities.some((identity) => identity.id === snapshot.identityId);

  if (inspection.policyNeedsUpgrade) {
    // A lock from an earlier version: its assignment stands, but it must be
    // upgraded before its push requirement is enforced the current way.
    // The upgrade works from the recorded snapshot, so it never depends on
    // the identity still existing in settings.
    const pushNote = pushRequirementProblem(recorded);
    return {
      state: "needs_attention",
      reason: `${inspection.reasons[0] ?? "This repository's identity lock was installed by an earlier version and must be upgraded."}${pushNote ? ` After the upgrade: ${pushNote}` : ""}`,
      commitEnforced,
      push,
      repairAvailable: !inspection.gitVersionKnownUnsupported,
      unlockAvailable: true,
    };
  }
  if (inspection.state !== "active") {
    return {
      state: "needs_attention",
      reason: inspection.reasons[0] ?? `The identity lock is ${inspection.state}.`,
      commitEnforced,
      push,
      repairAvailable: identityStillDefined && !inspection.gitVersionKnownUnsupported,
      unlockAvailable: true,
    };
  }
  // Fully installed — but a lock is only ACTIVE when it enforces BOTH
  // commit and push. An incomplete push requirement blocks every push and
  // keeps the repository in needs_attention, never "active".
  const pushProblem = pushRequirementProblem(recorded);
  if (push !== "enforced") {
    return {
      state: "needs_attention",
      reason: pushProblem,
      commitEnforced,
      push,
      repairAvailable: false,
      unlockAvailable: true,
    };
  }
  return { state: "active", commitEnforced, push, repairAvailable: false, unlockAvailable: true };
}

export class IdentityLockService {
  private readonly shield: ShieldManager;
  private readonly now: () => number;
  private readonly newLockId: () => string;

  public constructor(private readonly options: IdentityLockServiceOptions) {
    this.shield = options.shield ?? new ShieldManager();
    this.now = options.now ?? Date.now;
    this.newLockId = options.newLockId ?? (() => crypto.randomBytes(16).toString("hex"));
  }

  public resolveRepository(startDir: string): Promise<RepositoryRef | undefined> {
    return resolveRepository(startDir);
  }

  /**
   * Passive, read-only status — safe for every refresh. Never writes, never
   * opens a network connection (no `ssh`), and is cheap: a handful of
   * `git rev-parse`/`git config` reads plus small file reads.
   */
  public async getStatus(repo: RepositoryRef, identities: Identity[]): Promise<LockStatus> {
    const inspection = await this.shield.inspect(repo.repoRoot, {
      evaluatorScriptSource: this.options.evaluatorScriptSource,
      currentIdentities: identities,
    });
    const assignment = assignmentFromInspection(repo.repoKey, inspection);
    const snapshot = inspection.policySnapshot;
    return {
      repo,
      assignment,
      assignmentView:
        assignment && snapshot
          ? {
              identityId: snapshot.identityId,
              identityLabel: snapshot.identityLabel,
              gitName: snapshot.expectedGitName,
              gitEmail: snapshot.expectedGitEmail,
              expectedGitHubLogin: snapshot.expectedGitHubLogin,
              assignedAt: snapshot.assignedAt,
              identityStillDefined: identities.some((identity) => identity.id === snapshot.identityId),
            }
          : undefined,
      enforcement: deriveEnforcement(inspection, identities),
      legacy: isLegacyInstallation(inspection),
      inspection,
    };
  }

  /**
   * Assigns `identity` to the repository (or changes the assigned
   * identity), installing/re-installing enforcement as one all-or-nothing
   * operation. Re-assigning the SAME identity keeps the assignment's
   * `lockId`/`assignedAt` (it is a re-sync, not a new assignment).
   */
  public async assign(repo: RepositoryRef, identityInput: Identity, options: { chainForeignHooks?: boolean; identities?: Identity[] } = {}): Promise<LockOperationResult> {
    const validated = validateIdentity(identityInput);
    if (!validated.ok) {
      return { ok: false, message: "That identity is not valid, so nothing was changed.", details: validated.errors };
    }
    const identity = validated.identity;

    const before = await this.getStatus(repo, options.identities ?? [identity]);
    if (before.enforcement.state === "unavailable") {
      return { ok: false, message: "This repository cannot be locked right now.", details: [before.enforcement.reason ?? ""], status: before };
    }
    const sameAssignment =
      before.inspection.policySnapshot &&
      (before.inspection.policyValid || before.inspection.policyNeedsUpgrade) &&
      before.inspection.policySnapshot.identityId === identity.id;
    const lockId = sameAssignment ? (before.inspection.policySnapshot as { lockId: string }).lockId : this.newLockId();
    const assignedAt = sameAssignment ? (before.inspection.policySnapshot as { assignedAt: number }).assignedAt : this.now();

    let result;
    try {
      result = await this.shield.enable(repo.repoRoot, this.options.evaluatorScriptSource, {
        identity,
        lockId,
        assignedAt,
        now: this.now(),
        chainForeignHooks: options.chainForeignHooks === true,
        requireComplete: true,
      });
    } catch (error) {
      const status = await this.getStatus(repo, options.identities ?? [identity]).catch(() => undefined);
      return { ok: false, message: `Could not lock this repository: ${errorMessage(error)}`, details: [], status };
    }

    const status = await this.getStatus(repo, options.identities ?? [identity]);
    if (result.inspection.state !== "active" || !status.assignment || status.assignment.identityId !== identity.id) {
      return {
        ok: false,
        message: before.assignment
          ? `The repository was NOT changed to "${identity.label}"; its previous lock is unchanged.`
          : `The repository was NOT locked to "${identity.label}"; nothing was left installed.`,
        details: result.inspection.reasons,
        status,
      };
    }

    // Assigning an incomplete identity is allowed (commits are locked at
    // once), but its push requirement is incomplete: every push is BLOCKED
    // until it is completed, and the repository reports needs_attention.
    const details = [...(result.warnings ?? [])];
    const pushProblem = pushRequirementProblem(identity);
    if (pushProblem) details.push(pushProblem);
    return {
      ok: true,
      message: before.assignment && !sameAssignment
        ? `This repository is now locked to "${identity.label}" (was "${before.assignmentView?.identityLabel ?? before.assignment.identityId}").`
        : `This repository is locked to "${identity.label}".`,
      details,
      status,
    };
  }

  /**
   * Re-installs the CURRENT assignment from the identity's live
   * definition — applies identity edits, restores tampered/missing hooks,
   * and upgrades outdated artifacts. Refuses (changing nothing) when the
   * assigned identity no longer exists or the lock record is unreadable:
   * repair never guesses which identity to enforce.
   */
  public async repair(repo: RepositoryRef, identities: Identity[], options: { chainForeignHooks?: boolean } = {}): Promise<LockOperationResult> {
    const status = await this.getStatus(repo, identities);
    if (status.legacy) {
      return { ok: false, message: "This repository has a legacy Shield installation; it is migrated (not repaired).", details: [], status };
    }
    const snapshot = status.inspection.policyValid || status.inspection.policyNeedsUpgrade ? status.inspection.policySnapshot : undefined;
    if (!snapshot) {
      if (status.enforcement.state === "unassigned") {
        return { ok: false, message: "This repository has no identity assigned, so there is nothing to repair.", details: [], status };
      }
      return {
        ok: false,
        message: "The lock record for this repository is missing or damaged, so the assigned identity is unknown. Assign an identity again (this replaces the lock) or unlock the repository.",
        details: status.inspection.reasons,
        status,
      };
    }
    const identity = identities.find((candidate) => candidate.id === snapshot.identityId);
    if (!identity && status.inspection.policyNeedsUpgrade) {
      // An earlier-version lock whose identity is gone from settings is
      // still upgraded — from the recorded snapshot, so exactly what it
      // enforced keeps being enforced (with push now fail-closed).
      return this.assign(repo, identityFromSnapshot(snapshot), { chainForeignHooks: options.chainForeignHooks, identities });
    }
    if (!identity) {
      return {
        ok: false,
        message: `The assigned identity "${snapshot.identityLabel}" (${snapshot.identityId}) no longer exists in settings. Assign another identity or unlock the repository.`,
        details: [],
        status,
      };
    }
    return this.assign(repo, identity, { chainForeignHooks: options.chainForeignHooks, identities });
  }

  /**
   * Removes the lock: every owned hook (chained hooks restored exactly),
   * then the evaluator, then the assignment record. Reports failure — and
   * keeps the repository assigned — whenever anything the lock owns could
   * not be removed.
   */
  public async unlock(repo: RepositoryRef, identities: Identity[] = []): Promise<LockOperationResult> {
    const before = await this.getStatus(repo, identities);
    if (before.enforcement.state === "unavailable") {
      return { ok: false, message: "This repository cannot be read right now; nothing was changed.", details: [before.enforcement.reason ?? ""], status: before };
    }
    if (before.inspection.state === "off" && !before.legacy) {
      return { ok: true, message: "This repository is not locked.", details: [], status: before };
    }

    let reasons: string[];
    try {
      reasons = (await this.shield.disable(repo.repoRoot)).reasons;
    } catch (error) {
      const status = await this.getStatus(repo, identities).catch(() => undefined);
      return {
        ok: false,
        message: `Unlock could not finish (${errorMessage(error)}). The repository is still locked; nothing claims otherwise.`,
        details: [],
        status,
      };
    }
    const status = await this.getStatus(repo, identities);
    if (status.inspection.state !== "off") {
      return {
        ok: false,
        message: "Unlock is incomplete: some identity-lock files could not be removed, so this repository still reports a lock that needs attention.",
        details: reasons,
        status,
      };
    }
    return {
      ok: true,
      message: before.assignmentView
        ? `This repository is no longer locked to "${before.assignmentView.identityLabel}". Git is unrestricted here again.`
        : "The legacy Repo Identity Guard installation was removed. Git is unrestricted here again.",
      details: reasons,
      status,
    };
  }

  /**
   * Upgrades an identity lock written by an earlier version (policy v3,
   * artifacts v6) in place, if one is present — a no-op (`kind: "none"`)
   * for every other repository, so it is safe and idempotent to call on
   * every scan of a trusted workspace.
   *
   * The assignment is KEPT: the lock is re-installed from its own recorded
   * snapshot (same identity values, `lockId` and `assignedAt` — never the
   * live settings, which may have been edited; drift is then reported as
   * usual). Commit enforcement is unchanged. Push becomes fail-closed: a
   * lock whose identity had no GitHub login (a v3 "commit-only" lock) now
   * blocks every push until a login is configured, and reports
   * needs_attention. Nothing is unlocked, and no login is ever guessed.
   *
   * All-or-nothing like `assign`: if the upgrade cannot complete (e.g. a
   * foreign hook now occupies a slot the lock needs, and chaining was not
   * requested), the previous installation is left exactly as it was and
   * keeps reporting needs_attention.
   */
  public async upgradePreviousLock(repo: RepositoryRef, input: { identities: Identity[]; chainForeignHooks?: boolean }): Promise<PreviousLockUpgradeOutcome> {
    const status = await this.getStatus(repo, input.identities);
    const snapshot = status.inspection.policySnapshot;
    if (!status.inspection.policyNeedsUpgrade || !snapshot) return { kind: "none" };

    const recorded = identityFromSnapshot(snapshot);
    const upgraded = await this.assign(repo, recorded, { identities: input.identities, chainForeignHooks: input.chainForeignHooks });
    if (!upgraded.ok || !upgraded.status) {
      return {
        kind: "failed",
        message: `This repository's identity lock for "${recorded.label}" (from an earlier version of Repo Identity Guard) could not be upgraded, so it was left exactly as it was and needs attention: ${upgraded.message}`,
        details: upgraded.details,
        status: upgraded.status,
      };
    }
    const pushProblem = pushRequirementProblem(recorded);
    return {
      kind: "upgraded",
      identityLabel: recorded.label,
      message: `This repository's identity lock for "${recorded.label}" was upgraded; it is still assigned and commits are still checked.${pushProblem ? ` ${pushProblem}` : ""}`,
      status: upgraded.status,
    };
  }

  /**
   * Migrates a legacy Shield installation, if one is present: into an
   * identity lock when an explicit binding is provable, otherwise by
   * removing it (see `legacyMigration.ts`). A no-op (`kind: "none"`) for
   * every other repository, so it is safe — and idempotent — to call on
   * every scan of a trusted workspace.
   */
  public async migrateLegacy(repo: RepositoryRef, input: { legacyProfiles: unknown; identities: Identity[] }): Promise<LegacyMigrationOutcome> {
    const status = await this.getStatus(repo, input.identities);
    if (!status.legacy) return { kind: "none" };

    const originRemoteUrl = (await getOriginRemote(repo.repoRoot).catch(() => null)) ?? undefined;
    const decision = decideLegacyMigration({
      legacyPolicy: status.inspection.legacyPolicy,
      originRemoteUrl,
      legacyProfiles: input.legacyProfiles,
      identities: input.identities,
    });

    if (decision.kind === "assign") {
      const assigned = await this.assign(repo, decision.identity, { identities: input.identities });
      if (assigned.ok && assigned.status) {
        return { kind: "migrated", identityLabel: decision.identity.label, message: decision.reason, status: assigned.status };
      }
      return {
        kind: "failed",
        message: `This repository's legacy Shield installation could not be migrated to an identity lock for "${decision.identity.label}": ${assigned.message}`,
        details: assigned.details,
        status: assigned.status,
      };
    }

    const removed = await this.unlock(repo, input.identities);
    if (removed.ok && removed.status) {
      return { kind: "removed", message: decision.reason, status: removed.status };
    }
    return { kind: "failed", message: `The legacy Shield installation could not be removed: ${removed.message}`, details: removed.details, status: removed.status };
  }

  /**
   * Explicit, on-demand push-account verification for the assigned (or a
   * given) identity — makes a real `ssh` connection, so never call it on a
   * passive refresh.
   */
  public async checkPushAccount(
    repo: RepositoryRef,
    identity: Identity,
    options: { env?: NodeJS.ProcessEnv; runner?: SshRunner; timeoutMs?: number } = {},
  ): Promise<PushAccountCheckResult> {
    const env = options.env ?? process.env;
    const branch = await getCurrentBranch(repo.repoRoot).catch(() => null);
    const remoteName = await getPushRemoteName(repo.repoRoot, branch).catch(() => null);
    const pushRemoteUrl = remoteName ? ((await getPushUrl(repo.repoRoot, remoteName).catch(() => null)) ?? undefined) : undefined;
    const [coreSshCommand, sshVariantConfig] = await Promise.all([
      getGitConfigValue(repo.repoRoot, "core.sshCommand").catch(() => null),
      getGitConfigValue(repo.repoRoot, "ssh.variant").catch(() => null),
    ]);
    return checkPushAccount({
      identity,
      pushRemoteUrl,
      transport: {
        gitSsh: env.GIT_SSH,
        gitSshCommand: env.GIT_SSH_COMMAND,
        coreSshCommand: coreSshCommand ?? undefined,
        gitSshVariant: env.GIT_SSH_VARIANT,
        sshVariantConfig: sshVariantConfig ?? undefined,
      },
      env,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
