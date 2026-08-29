import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { canonicalRepoKey, resolveProfiles } from "../core/profileResolver";
import { getCoreHooksPathConfig, getGitCommonDir, getGitDir, getHooksDir } from "../services/gitService";
import { Profile, RepoFacts } from "../types";
import {
  SHIELD_ARTIFACT_VERSION,
  SHIELD_CHAIN_ORIGINAL_SUFFIX,
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
 * repairing the pre-commit and pre-push hooks and the policy + evaluator
 * copy they read, and reporting their current health. It does **not**
 * evaluate Shield decisions itself (that's `src/shield/evaluator.ts` and
 * the shipped `resources/shield/shield-evaluate.sh`, run standalone at
 * hook time) and it does **not** depend on `vscode` — every method here is
 * exercised directly against real temporary Git repositories in
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
 *    never deleted UNLESS the caller explicitly opts into
 *    `chainForeignHooks` (Phase 6 — see "Hook coexistence" below); the two
 *    hooks are evaluated and installed independently either way, so a
 *    foreign `pre-push` never blocks installing Shield's `pre-commit`, or
 *    vice versa.
 *  - `<hooksDir>/pre-commit.repo-identity-guard-original` and
 *    `<hooksDir>/pre-push.repo-identity-guard-original` — the exact
 *    original bytes (and executable bit) of a foreign hook Shield moved
 *    aside to make room for its own, written/restored ONLY as part of
 *    `chainForeignHooks` (see below).
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
 * exactly what is on disk right now (policy present+valid+fresh, evaluator
 * copy present+owned+unmodified, hooks present+owned+unmodified+at-the-
 * currently-resolved-hooksDir) every time it's called. This is what makes
 * "partial installation never reports ACTIVE" true by construction: if
 * `enable()` is interrupted after writing the policy but before the hook,
 * the next `inspect()` (or the hook itself, which fails open when its
 * evaluator copy is missing) sees exactly that partial state and reports
 * `degraded`, never a stale `active` left over from a flag no one updated.
 * The same re-derivation is what turns "someone redirected `core.hooksPath`
 * away from Shield's hooks directory" into an automatically-detected
 * `degraded`, with no bookkeeping of "where Shield last installed to"
 * required at all.
 *
 * `inspect()` never writes anything, ever — including when it detects
 * tampering, drift, or an outdated version. Turning `degraded`/`broken`
 * back into `active` always requires an explicit call to `enable()`/
 * `repair()` (an explicit user action), never happens as a side effect of
 * merely checking status. See "Integrity (Phase 6)" below.
 *
 * ## Hook coexistence (Phase 6)
 *
 * A repository that already runs Husky, `pre-commit`, lint-staged, or a
 * hand-written hook must never have that tooling silently destroyed or
 * replaced. By default (`chainForeignHooks` unset/false), a foreign hook
 * already occupying a slot Shield wants is left completely untouched and
 * Shield simply doesn't install into that slot (reported `degraded`,
 * exactly as in Phase 3/4) — nothing changes here from earlier phases.
 *
 * Passing `chainForeignHooks: true` to `enable()`/`repair()` is an
 * explicit, deliberate opt-in (never automatic, never silent) to
 * *chaining*: the foreign hook's exact original bytes and executable
 * permission are moved to a sidecar file (see
 * `SHIELD_CHAIN_ORIGINAL_SUFFIX`) next to where it was, and Shield's own
 * hook is installed in its place. At run time, Shield's hook shim
 * evaluates its own policy FIRST — a deliberate execution-order choice:
 * Shield's check is cheap, local, and meant to be the first thing a user
 * sees, and short-circuiting before a foreign tool's (possibly slow,
 * possibly side-effecting, e.g. lint-staged rewriting files) hook avoids
 * wasted work on an operation Shield would reject anyway. Only if Shield
 * allows the action does it hand off to the chained original hook, with
 * the exact same argv and stdin Git gave it, and the original's own exit
 * code becomes the final result — a chained tool's own failure is never
 * silently swallowed.
 *
 * Native Git has no built-in mechanism for running more than one script
 * per hook name — not in any currently-supported version, including the
 * newest (`git hook run`, added in Git 2.36, still resolves and runs
 * exactly one script per hook name; there is no `hooks.d`-style multi-
 * script convention in core Git). This was verified empirically against
 * the Git version in this repository's CI/dev environment (see
 * docs/SHIELD_MODE.md "Phase 6" for the exact command and output) before
 * deciding to implement chaining as Shield's own wrapper rather than
 * relying on a native feature that doesn't exist. Shield's minimum
 * supported Git version remains **2.9** (when `core.hooksPath` — which
 * `getHooksDir` fundamentally depends on — was introduced); nothing in
 * this phase raises that floor.
 *
 * `disable()` (and a repair that later removes Shield) restores a chained
 * original exactly: the sidecar is moved back over the hook path, byte-
 * for-byte, and deleted from its sidecar location — never left behind,
 * never restored over content that isn't Shield's own (that would risk
 * clobbering something that appeared at that path after Shield's install;
 * see `disable()`'s own comment for the exact, conservative rule it
 * follows).
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
  /**
   * True when this Shield-owned hook's on-disk content doesn't exactly
   * match what `enable()` would write for the CURRENT `version` — i.e. it
   * still carries Shield's marker (so `ownership` is `"shield"`, not
   * `"foreign"`), but something (a hand edit, a partial write, disk
   * corruption) changed its body. Always `false` when `ownership` isn't
   * `"shield"`, or when `version` doesn't equal `SHIELD_ARTIFACT_VERSION`
   * (an outdated version is reported via `version` alone — "modified"
   * specifically means "this exact version's expected content differs").
   */
  contentModified: boolean;
  /** True when a sidecar `<fileName>.repo-identity-guard-original` file exists next to this hook — i.e. Shield is (or was) chaining a foreign hook here. */
  hasChainedOriginal: boolean;
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
  /** True when the evaluator's on-disk content doesn't match `evaluatorScriptSource`'s content — only ever computed when `inspect()` was given that path (see `ShieldInspectOptions`); `false`, never "unknown," when it wasn't. */
  evaluatorModified: boolean;
  /** True when `core.hooksPath` (any scope) is set to something other than Git's built-in default — informational context for why a governed hook might be missing from the resolved `hooksDir`, never itself a reason to block anything. */
  hooksPathCustomized: boolean;
  /** True when the matched profile's live definition (by id, from `ShieldInspectOptions.currentProfiles`) differs from what's baked into the persisted policy — e.g. `expectedGitHubLogin`, `trustedSshHostAliases`, or `strictPushSetup` edited in Settings without repairing Shield. Always `false` when `currentProfiles` wasn't supplied. */
  policyProfileDrift: boolean;
  /** True when `ShieldInspectOptions.currentPushDestination` differs (by owner/repo, same comparison the evaluator itself uses) from the policy's `approvedPushDestination` — i.e. the repository's actual remote has moved since Shield was last enabled/repaired. Always `false` when `currentPushDestination` wasn't supplied. */
  pushDestinationDrift: boolean;
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
  /**
   * Explicit, never-default opt-in (Phase 6) to chain a foreign hook
   * already occupying a slot Shield wants, instead of leaving that slot
   * alone. See the class-level "Hook coexistence" doc comment for exactly
   * what this does and doesn't do. Defaults to `false` — omitting this
   * reproduces Phase 3/4/5 behavior exactly: a foreign hook is never
   * touched.
   */
  chainForeignHooks?: boolean;
}

export interface ShieldInspectOptions {
  /**
   * Absolute path to this extension's own bundled
   * `resources/shield/shield-evaluate.sh`. When supplied, `inspect()`
   * compares it byte-for-byte against the installed evaluator copy to
   * populate `evaluatorModified` — a modified-but-still-"shield"-owned
   * evaluator (marker intact, body hand-edited) would otherwise be
   * indistinguishable from a genuine one. Omit to skip this check
   * (`evaluatorModified` is then always `false`, not "unknown").
   */
  evaluatorScriptSource?: string;
  /**
   * The caller's current, live profile list (e.g. fresh from Settings) —
   * when supplied, `inspect()` looks up the profile matching the policy's
   * `matchedProfileId` and compares its identity/policy-relevant fields
   * against what's persisted, populating `policyProfileDrift`. Omit to
   * skip this check.
   */
  currentProfiles?: Profile[];
  /**
   * The repository's current, freshly-resolved push destination (e.g.
   * from a fresh `RepoFacts` scan) — when supplied, compared against the
   * policy's `approvedPushDestination` to populate `pushDestinationDrift`.
   * Omit to skip this check.
   */
  currentPushDestination?: { host?: string; owner?: string; repo?: string };
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

function chainedOriginalPath(hookPath: string): string {
  return `${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`;
}

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

async function modeOf(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode;
  } catch {
    return undefined;
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

/** Fields of a matched profile that a persisted policy bakes in — compared for drift by `policyProfileDrift`. Order given here is the order drift is reported in. */
const PROFILE_DRIFT_FIELDS = ["gitName", "gitEmail", "strictPushSetup", "expectedGitHubLogin"] as const;

function normalizeAliasList(aliases: string[] | undefined): string {
  return [...(aliases ?? [])].map((a) => a.trim().toLowerCase()).sort().join(",");
}

function normalizeOwnerRepo(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
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
  async inspect(repoRoot: string, options: ShieldInspectOptions = {}): Promise<ShieldInspection> {
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
          contentModified: false,
          hasChainedOriginal: false,
        })),
        policyPresent: false,
        policyValid: false,
        evaluatorPresent: false,
        evaluatorOwned: false,
        evaluatorModified: false,
        hooksPathCustomized: false,
        policyProfileDrift: false,
        pushDestinationDrift: false,
      };
    }

    const policyPath = shieldPolicyFilePath(gitContext.gitCommonDir);
    const evaluatorPath = shieldEvaluatorScriptFilePath(gitContext.gitCommonDir);

    const [policyRaw, evaluatorRaw, coreHooksPath, ...hookRaws] = await Promise.all([
      readFileIfExists(policyPath),
      readFileIfExists(evaluatorPath),
      getCoreHooksPathConfig(repoRoot),
      ...HOOK_SPECS.map((spec) => readFileIfExists(path.join(gitContext.hooksDir, spec.fileName))),
    ]);
    const chainedRaws = await Promise.all(
      HOOK_SPECS.map((spec) => readFileIfExists(chainedOriginalPath(path.join(gitContext.hooksDir, spec.fileName)))),
    );

    const policyResult = policyRaw !== null ? parseShieldPolicy(policyRaw) : undefined;
    const evaluatorOwned = evaluatorRaw !== null && isShieldOwnedArtifact(evaluatorRaw);
    const evaluatorVersion = evaluatorOwned ? extractShieldArtifactVersion(evaluatorRaw as string) : undefined;
    const evaluatorSource = options.evaluatorScriptSource
      ? await readFileIfExists(options.evaluatorScriptSource).catch(() => null)
      : null;
    const evaluatorModified =
      evaluatorOwned && evaluatorSource !== null && evaluatorVersion === SHIELD_ARTIFACT_VERSION && evaluatorRaw !== evaluatorSource;

    const hooks: ShieldHookInspection[] = HOOK_SPECS.map((spec, i) => {
      const raw = hookRaws[i];
      const ownership: ShieldArtifactOwnership = raw === null ? "absent" : isShieldOwnedArtifact(raw) ? "shield" : "foreign";
      const version = ownership === "shield" ? extractShieldArtifactVersion(raw as string) : undefined;
      const contentModified = ownership === "shield" && version === SHIELD_ARTIFACT_VERSION && raw !== spec.build();
      return {
        fileName: spec.fileName,
        action: spec.action,
        path: path.join(gitContext.hooksDir, spec.fileName),
        ownership,
        version,
        contentModified,
        hasChainedOriginal: chainedRaws[i] !== null,
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
    const outdatedOrIncompatibleHooks = hooks.filter(
      (h) => h.ownership === "shield" && (h.version === undefined || h.version !== SHIELD_ARTIFACT_VERSION),
    );
    const modifiedHooks = hooks.filter((h) => h.contentModified);

    let policyProfileDrift = false;
    const profileDriftDetails: string[] = [];
    if (policyResult?.ok && options.currentProfiles) {
      const policy = policyResult.policy;
      const liveProfile = options.currentProfiles.find((p) => p.id === policy.matchedProfileId);
      if (!liveProfile) {
        policyProfileDrift = true;
        profileDriftDetails.push(`the matched profile ("${policy.matchedProfileId}") no longer exists in current settings`);
      } else {
        for (const field of PROFILE_DRIFT_FIELDS) {
          const liveValue = liveProfile[field];
          const policyValue = field === "gitName" ? policy.expectedGitName : field === "gitEmail" ? policy.expectedGitEmail : field === "strictPushSetup" ? policy.strictPushSetup : policy.expectedGitHubLogin;
          if (JSON.stringify(liveValue ?? null) !== JSON.stringify(policyValue ?? null)) {
            policyProfileDrift = true;
            profileDriftDetails.push(field);
          }
        }
        if (normalizeAliasList(liveProfile.trustedSshHostAliases) !== normalizeAliasList(policy.trustedSshHostAliases)) {
          policyProfileDrift = true;
          profileDriftDetails.push("trustedSshHostAliases");
        }
      }
    }

    let pushDestinationDrift = false;
    if (policyResult?.ok && options.currentPushDestination) {
      const approved = policyResult.policy.approvedPushDestination;
      const current = options.currentPushDestination;
      const ownerChanged = normalizeOwnerRepo(approved?.owner) !== normalizeOwnerRepo(current.owner);
      const repoChanged =
        !!approved?.repo && !!current.repo && normalizeOwnerRepo(approved.repo) !== normalizeOwnerRepo(current.repo);
      pushDestinationDrift = ownerChanged || repoChanged;
    }

    const hooksPathCustomized = !!coreHooksPath;
    const hooksPathNote = hooksPathCustomized
      ? ` ("core.hooksPath" is currently set to "${coreHooksPath}" — if that was changed after Shield was enabled, this is why.)`
      : "";

    if (!anyShieldArtifactPresent) {
      state = "off";
    } else if (foreignHooks.length > 0) {
      state = "degraded";
      for (const hook of foreignHooks) {
        reasons.push(
          `A ${hook.fileName} hook already exists at ${hook.path} that Repo Identity Guard did not create. Shield will not overwrite or delete it — move it aside yourself, enable Shield with hook chaining, or run "Repair Shield" after resolving it.`,
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
    } else if (evaluatorModified) {
      state = "degraded";
      reasons.push('Shield\'s evaluator copy has been modified outside Repo Identity Guard. Run "Repair Shield" to restore it.');
    } else if (evaluatorVersion === undefined || evaluatorVersion !== SHIELD_ARTIFACT_VERSION) {
      state = "degraded";
      reasons.push(
        evaluatorVersion !== undefined && evaluatorVersion > SHIELD_ARTIFACT_VERSION
          ? `Shield's evaluator copy is a newer version (v${evaluatorVersion}) than this build of the extension recognizes (v${SHIELD_ARTIFACT_VERSION}). Update the extension, then run "Repair Shield."`
          : 'A newer Shield evaluator is available. Run "Repair Shield" to update it.',
      );
    } else if (missingGovernedHooks.length > 0) {
      state = "degraded";
      for (const hook of missingGovernedHooks) {
        reasons.push(`Shield's ${hook.fileName} hook is missing. Run "Repair Shield" to reinstall it.${hooksPathNote}`);
      }
    } else if (modifiedHooks.length > 0) {
      state = "degraded";
      for (const hook of modifiedHooks) {
        reasons.push(`Shield's ${hook.fileName} hook has been modified outside Repo Identity Guard. Run "Repair Shield" to restore it.`);
      }
    } else if (outdatedOrIncompatibleHooks.length > 0) {
      state = "degraded";
      for (const hook of outdatedOrIncompatibleHooks) {
        reasons.push(
          hook.version !== undefined && hook.version > SHIELD_ARTIFACT_VERSION
            ? `Shield's ${hook.fileName} hook is a newer version (v${hook.version}) than this build of the extension recognizes (v${SHIELD_ARTIFACT_VERSION}). Update the extension, then run "Repair Shield."`
            : `A newer Shield ${hook.fileName} hook is available. Run "Repair Shield" to update it.`,
        );
      }
    } else if (policyProfileDrift) {
      state = "degraded";
      reasons.push(
        `The matched profile's live settings no longer match what Shield last approved (${profileDriftDetails.join(", ")}). Run "Repair Shield" to re-sync.`,
      );
    } else if (pushDestinationDrift) {
      state = "degraded";
      reasons.push(
        `This repository's current push destination no longer matches what Shield last approved. Run "Repair Shield" after confirming this is intentional.`,
      );
    } else {
      state = "active";
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
      evaluatorModified,
      hooksPathCustomized,
      policyProfileDrift,
      pushDestinationDrift,
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
   * only into an empty hook slot, one Shield already owns, or (with
   * `input.chainForeignHooks: true`) one occupied by a foreign hook that
   * gets chained rather than replaced (see the class-level "Hook
   * coexistence" doc comment). A foreign hook is never touched when
   * `chainForeignHooks` is left unset/false; Shield still writes its own
   * policy/evaluator (harmless and inert without a hook to invoke them)
   * and reports `degraded` rather than pretending full enforcement is
   * active.
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

    // Ownership/chaining checks happen BEFORE any write, so a refused
    // activation never leaves a half-written hook (or a half-chained
    // original) behind.
    type HookWrite =
      | { spec: HookSpec; hookPath: string; mode: "direct" }
      | { spec: HookSpec; hookPath: string; mode: "chain"; originalContent: string; originalMode: number | undefined }
      | { spec: HookSpec; hookPath: string; mode: "skip" };

    const hookWrites: HookWrite[] = await Promise.all(
      HOOK_SPECS.map(async (spec): Promise<HookWrite> => {
        const hookPath = path.join(gitContext.hooksDir, spec.fileName);
        const existing = await readFileIfExists(hookPath);

        if (existing === null || isShieldOwnedArtifact(existing)) {
          return { spec, hookPath, mode: "direct" };
        }

        if (!input.chainForeignHooks) {
          return { spec, hookPath, mode: "skip" };
        }

        // A previous chained original already sitting at the sidecar path
        // means either a prior chain was never cleanly finished/restored,
        // or something else wrote there — either way, silently moving
        // ANOTHER foreign hook on top of it would permanently lose
        // whichever one is already there. Fail this hook's write closed
        // rather than guess which one the user meant to keep.
        const sidecarPath = chainedOriginalPath(hookPath);
        const existingSidecar = await readFileIfExists(sidecarPath);
        if (existingSidecar !== null) {
          return { spec, hookPath, mode: "skip" };
        }

        const originalMode = await modeOf(hookPath);
        return { spec, hookPath, mode: "chain", originalContent: existing, originalMode };
      }),
    );

    // Policy + evaluator are always (re)written: they're inert without a
    // wired hook, and rewriting them keeps Shield's recorded intent
    // current (matches ShieldPolicy's "intent, not cached status"
    // design) and self-heals a previously-corrupted copy of either.
    const evaluatorScript = await fs.readFile(evaluatorScriptSource, "utf8");
    await writeFileAtomic(policyPath, serializeShieldPolicy(built.policy));
    await writeFileAtomic(evaluatorPath, evaluatorScript, 0o755);

    for (const write of hookWrites) {
      if (write.mode === "skip") continue;
      if (write.mode === "chain") {
        // Preserve the foreign hook's exact bytes and executable bit at
        // its sidecar location BEFORE Shield's own hook takes its place —
        // if the process dies between these two writes, inspect() sees a
        // hook slot that's either still the untouched foreign hook (sidecar
        // write didn't complete) or already Shield's own with a sidecar
        // present (safe, resumable — re-running enable() with chaining
        // again is a no-op here since the slot is now Shield-owned).
        await writeFileAtomic(chainedOriginalPath(write.hookPath), write.originalContent, write.originalMode);
      }
      await writeFileAtomic(write.hookPath, write.spec.build(), 0o755);
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
   * hooks (each re-verified as Shield's own immediately before touching
   * it — never a foreign hook, even one that appeared at that path after
   * Shield last installed), and its policy/evaluator copy under this
   * repo's git-common-dir. Never touches anything else. Safe to call when
   * Shield was never enabled, or is already partially/fully disabled
   * (every removal is a no-op if the file is already gone).
   *
   * When a hook being removed has a chained-original sidecar
   * (`<hookPath>.repo-identity-guard-original`), that original is
   * restored to `hookPath` — byte-for-byte, executable bit included —
   * instead of the slot simply being deleted, and the sidecar itself is
   * removed. This restoration only ever happens immediately after
   * confirming the CURRENT occupant of `hookPath` is still Shield's own
   * (the same check that gates deletion) — if something else has since
   * taken that slot, the sidecar is left exactly as it is and reported so
   * the caller can resolve it manually, rather than either deleting an
   * unrelated foreign file or silently overwriting it with the old
   * original.
   */
  async disable(repoRoot: string): Promise<ShieldInspection> {
    const gitContext = await this.resolveGitContext(repoRoot);
    const unresolvedChains: string[] = [];

    for (const spec of HOOK_SPECS) {
      const hookPath = path.join(gitContext.hooksDir, spec.fileName);
      const sidecarPath = chainedOriginalPath(hookPath);
      const existingHook = await readFileIfExists(hookPath);
      const existingSidecar = await readFileIfExists(sidecarPath);

      if (existingHook !== null && isShieldOwnedArtifact(existingHook)) {
        if (existingSidecar !== null) {
          const originalMode = await modeOf(sidecarPath);
          await writeFileAtomic(hookPath, existingSidecar, originalMode);
          await deleteIfExists(sidecarPath);
        } else {
          await deleteIfExists(hookPath);
        }
      } else if (existingSidecar !== null) {
        // Never restore over content that isn't Shield's own, and never
        // delete a sidecar we can't safely fold back — surfaced as a
        // diagnostic below instead.
        unresolvedChains.push(sidecarPath);
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

    const inspection = await this.inspect(repoRoot);
    if (unresolvedChains.length === 0) {
      return inspection;
    }
    return {
      ...inspection,
      reasons: [
        ...unresolvedChains.map(
          (p) => `A chained original hook at ${p} could not be restored automatically because something other than Shield now occupies its hook slot. Resolve this manually — the original is preserved at that exact path.`,
        ),
        ...inspection.reasons,
      ],
    };
  }

  /** Convenience wrapper over `inspect()` for a quick "is Shield actually working here" answer (status bar, a health-check command) without the caller re-deriving it from `ShieldInspection.state` itself. */
  async healthCheck(repoRoot: string, options: ShieldInspectOptions = {}): Promise<{ healthy: boolean; state: ShieldLifecycleState; summary: string }> {
    const inspection = await this.inspect(repoRoot, options);
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
