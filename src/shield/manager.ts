import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { canonicalRepoKey, resolveProfiles } from "../core/profileResolver";
import { getGitCommonDir, getGitDir, getHooksDir } from "../services/gitService";
import { Profile, RepoFacts } from "../types";
import {
  SHIELD_ARTIFACT_VERSION,
  buildPreCommitHookScript,
  buildPrePushHookScript,
  extractShieldArtifactVersion,
  isShieldOwnedArtifact,
} from "./artifacts";
import { ShieldPolicy, buildShieldPolicy, parseShieldPolicy, serializeShieldPolicy } from "./policy";
import { shieldEvaluatorScriptFilePath, shieldPolicyFilePath, shieldStorageDir } from "./storage";
import { ShieldAction, ShieldLifecycleState } from "./types";

/**
 * ShieldManager owns Shield's on-disk lifecycle: installing/removing/
 * repairing the pre-commit hook and the policy + evaluator copy it reads,
 * and reporting their current health. It does **not** evaluate Shield
 * decisions itself (that's `src/shield/evaluator.ts` and the shipped
 * `resources/shield/shield-evaluate.sh`, run standalone at hook time) and
 * it does **not** depend on `vscode` — every method here is exercised
 * directly against real temporary Git repositories in
 * `src/test/shieldManager.test.ts`, the same way the evaluator is.
 *
 * ## Mutation scope (never anything else)
 *
 * ShieldManager writes/deletes only:
 *  - `<gitCommonDir>/repo-identity-guard/*` — Shield's own namespaced
 *    subdirectory under this repo's Git metadata (policy, evaluator copy).
 *  - `<hooksDir>/pre-commit` and `<hooksDir>/pre-push` — resolved fresh via
 *    `git rev-parse --git-path hooks` (see `getHooksDir`), and each only
 *    ever written or deleted when that exact path is empty or already
 *    carries Shield's own ownership marker (see `src/shield/artifacts.ts`).
 *    A foreign hook already occupying either path is never overwritten and
 *    never deleted — the two hooks are evaluated and installed
 *    independently, so a foreign `pre-push` never blocks installing
 *    Shield's `pre-commit`, or vice versa.
 *
 * It never touches global Git config, SSH keys/config, credential
 * managers/helpers, GitHub credentials, or any tracked file in the
 * repository's working tree. It writes no repo-local Git config keys
 * either — empirically, the default hooks directory (whatever
 * `--git-path hooks` resolves to right now) is writable directly and
 * shared by every worktree already (see docs/SHIELD_MODE.md), so nothing
 * needed setting `core.hooksPath` itself to make installation work.
 *
 * ## Lifecycle state is always re-derived, never cached
 *
 * There is deliberately no separate "I successfully enabled Shield" flag
 * file. `inspect()` re-derives `off`/`active`/`degraded`/`broken` from
 * exactly what is on disk right now (policy present+valid, evaluator
 * copy present+owned, hook present+owned+at-the-currently-resolved-
 * hooksDir) every time it's called. This is what makes "partial
 * installation never reports ACTIVE" true by construction: if `enable()`
 * is interrupted after writing the policy but before the hook, the next
 * `inspect()` (or the hook itself, which fails open when its evaluator
 * copy is missing) sees exactly that partial state and reports
 * `degraded`, never a stale `active` left over from a flag no one
 * updated. The same re-derivation is what turns "someone redirected
 * `core.hooksPath` away from Shield's hooks directory" into an
 * automatically-detected `degraded`, with no bookkeeping of "where Shield
 * last installed to" required at all.
 */

export interface ShieldGitContext {
  repoRoot: string;
  gitDir: string;
  gitCommonDir: string;
  hooksDir: string;
}

export type ShieldArtifactOwnership = "shield" | "foreign" | "absent";

/** One of the two hook files Shield can install — see `HOOK_SPECS`. */
export type ShieldHookFileName = "pre-commit" | "pre-push";

export interface ShieldHookInspection {
  fileName: ShieldHookFileName;
  /** The Git action this hook file governs — used to decide whether its absence matters (only when `policy.enabledActions` includes this action). */
  action: ShieldAction;
  path: string;
  ownership: ShieldArtifactOwnership;
  version?: number;
}

export interface ShieldInspection {
  state: ShieldLifecycleState;
  /** Human-readable diagnostic lines explaining `state` — always empty when `state` is "active" with nothing to repair. */
  reasons: string[];
  gitContext?: ShieldGitContext;
  /** One entry per hook file Shield can install (`pre-commit`, `pre-push`), in that order — always present, even when `ownership` is `"absent"`. */
  hooks: ShieldHookInspection[];
  policyPath?: string;
  policyPresent: boolean;
  policyValid: boolean;
  policyProfileLabel?: string;
  evaluatorPath?: string;
  evaluatorPresent: boolean;
  evaluatorOwned: boolean;
  evaluatorVersion?: number;
}

export interface ShieldOperationResult {
  ok: boolean;
  inspection: ShieldInspection;
}

export interface ShieldEnableInput {
  facts: RepoFacts;
  profiles: Profile[];
  protectedBranches: string[];
  now?: number;
}

interface HookSpec {
  fileName: ShieldHookFileName;
  action: ShieldAction;
  build: () => string;
}

/** The hook files Shield can install, and which Git action each one governs — order here is the order `ShieldInspection.hooks` reports them in. */
const HOOK_SPECS: readonly HookSpec[] = [
  { fileName: "pre-commit", action: "commit", build: buildPreCommitHookScript },
  { fileName: "pre-push", action: "push", build: buildPrePushHookScript },
];

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes `content` to `filePath` via a temp-file-then-rename in the same
 * directory, so a process interruption mid-write can never leave a
 * truncated/partial file at the final path — the rename is atomic on the
 * same filesystem, which a same-directory temp file guarantees.
 */
async function writeFileAtomic(filePath: string, content: string, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await fs.writeFile(tempPath, content, mode !== undefined ? { mode } : undefined);
  await fs.rename(tempPath, filePath);
}

async function deleteIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class ShieldManager {
  /** Resolves the repo-facing paths Shield operates on, fresh, every call — never cached across calls. */
  async resolveGitContext(repoRoot: string): Promise<ShieldGitContext> {
    const [gitDir, gitCommonDir, hooksDir] = await Promise.all([
      getGitDir(repoRoot),
      getGitCommonDir(repoRoot),
      getHooksDir(repoRoot),
    ]);
    if (!gitDir || !gitCommonDir || !hooksDir) {
      throw new Error(
        `Could not resolve this repository's Git directories (git-dir: ${gitDir ?? "?"}, git-common-dir: ${gitCommonDir ?? "?"}, hooks: ${hooksDir ?? "?"}).`,
      );
    }
    return { repoRoot, gitDir, gitCommonDir, hooksDir };
  }

  /** Read-only diagnostic snapshot — never writes anything. Safe to call as often as needed (health checks, sidebar polling, before/after every mutating call). */
  async inspect(repoRoot: string): Promise<ShieldInspection> {
    let gitContext: ShieldGitContext;
    try {
      gitContext = await this.resolveGitContext(repoRoot);
    } catch (error) {
      return {
        state: "broken",
        reasons: [`Could not inspect this repository's Git state: ${toMessage(error)}`],
        hooks: HOOK_SPECS.map((spec) => ({
          fileName: spec.fileName,
          action: spec.action,
          path: "",
          ownership: "absent" as ShieldArtifactOwnership,
        })),
        policyPresent: false,
        policyValid: false,
        evaluatorPresent: false,
        evaluatorOwned: false,
      };
    }

    const policyPath = shieldPolicyFilePath(gitContext.gitCommonDir);
    const evaluatorPath = shieldEvaluatorScriptFilePath(gitContext.gitCommonDir);

    const [policyRaw, evaluatorRaw, ...hookRaws] = await Promise.all([
      readFileIfExists(policyPath),
      readFileIfExists(evaluatorPath),
      ...HOOK_SPECS.map((spec) => readFileIfExists(path.join(gitContext.hooksDir, spec.fileName))),
    ]);

    const policyResult = policyRaw !== null ? parseShieldPolicy(policyRaw) : undefined;
    const evaluatorOwned = evaluatorRaw !== null && isShieldOwnedArtifact(evaluatorRaw);
    const evaluatorVersion = evaluatorOwned ? extractShieldArtifactVersion(evaluatorRaw as string) : undefined;

    const hooks: ShieldHookInspection[] = HOOK_SPECS.map((spec, i) => {
      const raw = hookRaws[i];
      const ownership: ShieldArtifactOwnership = raw === null ? "absent" : isShieldOwnedArtifact(raw) ? "shield" : "foreign";
      return {
        fileName: spec.fileName,
        action: spec.action,
        path: path.join(gitContext.hooksDir, spec.fileName),
        ownership,
        version: ownership === "shield" ? extractShieldArtifactVersion(raw as string) : undefined,
      };
    });

    const reasons: string[] = [];
    let state: ShieldLifecycleState;

    const anyShieldArtifactPresent =
      policyRaw !== null || evaluatorRaw !== null || hooks.some((h) => h.ownership === "shield");

    const foreignHooks = hooks.filter((h) => h.ownership === "foreign");
    // Only a hook whose action this policy actually governs matters for
    // "is Shield fully active" — a policy that (for whatever reason) only
    // enables "commit" must not report degraded over a missing pre-push
    // hook it never intended to install.
    const enabledActions = policyResult?.ok ? policyResult.policy.enabledActions : undefined;
    const missingGovernedHooks = hooks.filter(
      (h) => h.ownership === "absent" && (enabledActions ? enabledActions.includes(h.action) : true),
    );

    if (!anyShieldArtifactPresent) {
      state = "off";
    } else if (foreignHooks.length > 0) {
      state = "degraded";
      for (const hook of foreignHooks) {
        reasons.push(
          `A ${hook.fileName} hook already exists at ${hook.path} that Repo Identity Guard did not create. Shield will not overwrite or delete it — move it aside (or chain into it yourself), then run "Repair Shield".`,
        );
      }
    } else if (!policyResult) {
      state = "degraded";
      reasons.push('Shield artifacts are present but no policy file was found. Run "Repair Shield" or re-enable Shield.');
    } else if (!policyResult.ok) {
      state = "broken";
      reasons.push(
        `Shield's policy file is invalid: ${policyResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}.`,
      );
    } else if (!evaluatorOwned) {
      state = "degraded";
      reasons.push(
        'Shield\'s evaluator copy is missing or was modified outside Repo Identity Guard. Run "Repair Shield" to reinstall it.',
      );
    } else if (missingGovernedHooks.length > 0) {
      state = "degraded";
      for (const hook of missingGovernedHooks) {
        reasons.push(`Shield's ${hook.fileName} hook is missing. Run "Repair Shield" to reinstall it.`);
      }
    } else {
      state = "active";
      for (const hook of hooks) {
        if (hook.ownership === "shield" && (hook.version === undefined || hook.version < SHIELD_ARTIFACT_VERSION)) {
          reasons.push(`A newer Shield ${hook.fileName} hook is available. Run "Repair Shield" to update it.`);
        }
      }
      if (evaluatorVersion === undefined || evaluatorVersion < SHIELD_ARTIFACT_VERSION) {
        reasons.push('A newer Shield evaluator is available. Run "Repair Shield" to update it.');
      }
    }

    return {
      state,
      reasons,
      gitContext,
      hooks,
      policyPath,
      policyPresent: policyRaw !== null,
      policyValid: policyResult?.ok ?? false,
      policyProfileLabel: policyResult?.ok ? policyResult.policy.profileLabel : undefined,
      evaluatorPath,
      evaluatorPresent: evaluatorRaw !== null,
      evaluatorOwned,
      evaluatorVersion,
    };
  }

  /**
   * Builds the policy Shield would install for this repo right now, from
   * already-resolved facts/profiles/protectedBranches — the same
   * resolution the rest of the extension already uses (`resolveProfiles`),
   * so Shield's notion of "the matched profile" never diverges from what
   * the sidebar shows. Returns `undefined` (never throws) when there is no
   * single resolved profile to build a policy from — 0 matches
   * (`profile-unresolved`) or 2+/a fork conflict (`profile-conflict`) are
   * both "cannot enable Shield yet," not an error.
   */
  private buildPolicyForRepo(input: ShieldEnableInput): { policy: ShieldPolicy } | { error: "profile-unresolved" | "profile-conflict"; message: string } {
    const { facts, profiles, protectedBranches, now } = input;
    const resolution = resolveProfiles(facts, profiles);

    if (resolution.forkConflict) {
      return {
        error: "profile-conflict",
        message: `This repo's origin and upstream remotes imply two different profiles (${resolution.forkConflict.originProfile.label} vs ${resolution.forkConflict.upstreamProfile.label}). Resolve the conflict (Review Details > Resolve Conflict) before enabling Shield.`,
      };
    }
    if (resolution.matches.length === 0) {
      return {
        error: "profile-unresolved",
        message: "No profile matches this repository yet. Add one from Settings before enabling Shield.",
      };
    }
    if (resolution.matches.length > 1) {
      return {
        error: "profile-conflict",
        message: `${resolution.matches.length} profiles match this repository (${resolution.matches.map((p) => p.label).join(", ")}). Narrow their owner patterns before enabling Shield.`,
      };
    }

    const profile = resolution.matches[0];
    const approvedRepositoryKey = canonicalRepoKey(facts.remoteHost, facts.remoteOwner, facts.remoteRepo);
    const approvedPushDestination =
      facts.remoteOwner || facts.remoteHost || facts.remoteRepo
        ? { host: facts.remoteHost, owner: facts.remoteOwner, repo: facts.remoteRepo }
        : undefined;

    const policy = buildShieldPolicy({
      profile,
      approvedRepositoryKey,
      approvedPushDestination,
      protectedBranches,
      // Both actions are enforced as of Phase 4: enable()/repair() install
      // both the pre-commit and pre-push hook shims. Note that an absent
      // `approvedPushDestination` (no resolvable remote yet) still results
      // in "push" being enabled here — push evaluation's own destination
      // check fails CLOSED in that case (see evaluator.ts
      // destinationReasons), which is the intended conservative behavior,
      // not a gap to work around by leaving "push" out.
      enabledActions: ["commit", "push"],
      now,
    });
    return { policy };
  }

  /**
   * Installs (or repairs) Shield for this repo: writes the policy and a
   * fresh evaluator copy under this repo's git-common-dir, then installs
   * the pre-commit AND pre-push hook shims — each independently, and each
   * only into an empty hook slot or one Shield already owns. A foreign
   * hook already at either path is never touched; Shield still writes its
   * own policy/evaluator (harmless and inert without a hook to invoke
   * them) and reports `degraded` rather than pretending full enforcement
   * is active.
   *
   * `evaluatorScriptSource` is the absolute path to this extension's own
   * bundled `resources/shield/shield-evaluate.sh` — passed in rather than
   * resolved here so this class stays free of any `vscode`/extension-path
   * dependency and stays directly testable.
   */
  async enable(repoRoot: string, evaluatorScriptSource: string, input: ShieldEnableInput): Promise<ShieldOperationResult> {
    const gitContext = await this.resolveGitContext(repoRoot).catch((error) => {
      throw new Error(`Cannot enable Shield: ${toMessage(error)}`);
    });

    const built = this.buildPolicyForRepo(input);
    if ("error" in built) {
      const inspection = await this.inspect(repoRoot);
      return { ok: false, inspection: { ...inspection, reasons: [built.message, ...inspection.reasons] } };
    }

    const policyPath = shieldPolicyFilePath(gitContext.gitCommonDir);
    const evaluatorPath = shieldEvaluatorScriptFilePath(gitContext.gitCommonDir);

    // Ownership checks happen BEFORE any write, so a refused activation
    // never leaves a half-written hook behind.
    const hookWrites = await Promise.all(
      HOOK_SPECS.map(async (spec) => {
        const hookPath = path.join(gitContext.hooksDir, spec.fileName);
        const existing = await readFileIfExists(hookPath);
        const slotIsSafe = existing === null || isShieldOwnedArtifact(existing);
        return { spec, hookPath, slotIsSafe };
      }),
    );

    // Policy + evaluator are always (re)written: they're inert without a
    // wired hook, and rewriting them keeps Shield's recorded intent
    // current (matches ShieldPolicy's "intent, not cached status"
    // design) and self-heals a previously-corrupted copy of either.
    const evaluatorScript = await fs.readFile(evaluatorScriptSource, "utf8");
    await writeFileAtomic(policyPath, serializeShieldPolicy(built.policy));
    await writeFileAtomic(evaluatorPath, evaluatorScript, 0o755);

    for (const { spec, hookPath, slotIsSafe } of hookWrites) {
      if (slotIsSafe) {
        await writeFileAtomic(hookPath, spec.build(), 0o755);
      }
    }

    const inspection = await this.inspect(repoRoot);
    return { ok: inspection.state === "active", inspection };
  }

  /** Same mechanics as `enable` — exposed separately so callers/commands can frame it as "repair" (re-sync an already-enabled Shield after a profile edit, an extension update, or a previously-blocking foreign hook being cleared) without implying a fresh first-time activation. */
  async repair(repoRoot: string, evaluatorScriptSource: string, input: ShieldEnableInput): Promise<ShieldOperationResult> {
    return this.enable(repoRoot, evaluatorScriptSource, input);
  }

  /**
   * Removes only what Shield itself owns: its pre-commit AND pre-push
   * hooks (each re-verified as Shield's own immediately before deleting —
   * never a foreign hook, even one that appeared at that path after
   * Shield last installed), and its policy/evaluator copy under this
   * repo's git-common-dir. Never touches anything else. Safe to call when
   * Shield was never enabled, or is already partially/fully disabled
   * (every removal is a no-op if the file is already gone).
   */
  async disable(repoRoot: string): Promise<ShieldInspection> {
    const gitContext = await this.resolveGitContext(repoRoot);

    for (const spec of HOOK_SPECS) {
      const hookPath = path.join(gitContext.hooksDir, spec.fileName);
      const existingHook = await readFileIfExists(hookPath);
      if (existingHook !== null && isShieldOwnedArtifact(existingHook)) {
        await deleteIfExists(hookPath);
      }
    }

    const storageDir = shieldStorageDir(gitContext.gitCommonDir);
    await deleteIfExists(shieldPolicyFilePath(gitContext.gitCommonDir));
    await deleteIfExists(shieldEvaluatorScriptFilePath(gitContext.gitCommonDir));
    try {
      await fs.rmdir(storageDir);
    } catch {
      // Non-empty (unexpected extra file) or already gone — never force-remove
      // anything Shield didn't itself just delete above.
    }

    return this.inspect(repoRoot);
  }

  /** Convenience wrapper over `inspect()` for a quick "is Shield actually working here" answer (status bar, a health-check command) without the caller re-deriving it from `ShieldInspection.state` itself. */
  async healthCheck(repoRoot: string): Promise<{ healthy: boolean; state: ShieldLifecycleState; summary: string }> {
    const inspection = await this.inspect(repoRoot);
    const healthy = inspection.state === "active" && inspection.reasons.length === 0;
    const summary =
      inspection.state === "off"
        ? "Shield is off for this repository."
        : inspection.state === "active"
          ? healthy
            ? `Shield is active${inspection.policyProfileLabel ? ` (${inspection.policyProfileLabel})` : ""}.`
            : `Shield is active${inspection.policyProfileLabel ? ` (${inspection.policyProfileLabel})` : ""}, but an update is available: ${inspection.reasons.join(" ")}`
          : inspection.state === "degraded"
            ? `Shield is degraded: ${inspection.reasons.join(" ")}`
            : `Shield is broken: ${inspection.reasons.join(" ")}`;
    return { healthy, state: inspection.state, summary };
  }
}
