import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { canonicalRepoKey, resolveProfiles } from "../core/profileResolver";
import {
  getCoreHooksPathConfig,
  getGitCommonDir,
  getGitDir,
  getGitVersionRaw,
  getHooksDir,
} from "../services/gitService";
import { Profile, RepoFacts } from "../types";
import {
  SHIELD_ARTIFACT_MARKER,
  SHIELD_ARTIFACT_VERSION,
  SHIELD_CHAIN_ORIGINAL_SUFFIX,
  buildPreCommitHookScript,
  buildPrePushHookScript,
  extractShieldArtifactVersion,
  isShieldOwnedArtifact,
} from "./artifacts";
import { SHIELD_MIN_GIT_VERSION_DISPLAY, evaluateGitVersionSupport } from "./gitVersion";
import {
  normalizeHookDirs,
  readShieldInstallRecord,
  sameHookDir,
  shieldInstallRecordFilePath,
  writeShieldInstallRecord,
} from "./installRecord";
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
export type ShieldHookFileName = "pre-commit" | "pre-merge-commit" | "pre-push";

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
  /**
   * The filesystem-level kind of whatever occupies this hook path
   * (`lstat`-based, so a symlink reads as `"symlink"`, never as its
   * target). Decides whether a *foreign* occupant can be chained at all —
   * see {@link classifyHookFile}. `"absent"` when nothing is there.
   */
  fileKind: HookFileKind;
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
  /**
   * Hook files still carrying Shield's ownership marker in a hooks
   * directory Shield previously installed into but which is no longer the
   * one Git resolves (`core.hooksPath` moved after installation). Read
   * from Shield's durable installation record — see
   * `src/shield/installRecord.ts`. Never a reason to consider Shield
   * active, always a reason to consider it degraded: point
   * `core.hooksPath` back and those hooks become live again.
   */
  orphanedHookPaths: string[];
  /**
   * The raw `git --version` line, and whether that version can support
   * Shield at all (Phase 8 — see `src/shield/gitVersion.ts`). Shield is
   * never reported `active` when this is unsupported.
   */
  gitVersionRaw?: string;
  gitVersionSupported: boolean;
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
  // Phase 7 finding: since Git 2.24, `git merge` invokes `pre-merge-commit`
  // for a real (non-fast-forward) merge commit -- NOT `pre-commit` -- so a
  // Shield install that only wrote `pre-commit` never saw a merge commit
  // at all (empirically confirmed: a mismatched identity sailed straight
  // through `git merge --no-ff`). Governs the same "commit" action, using
  // the identical evaluator call and script body as pre-commit -- Git
  // guarantees at most one of the two ever fires for a given commit, so
  // there is no double-evaluation to worry about.
  { fileName: "pre-merge-commit", action: "commit", build: buildPreCommitHookScript },
  { fileName: "pre-push", action: "push", build: buildPrePushHookScript },
];

function chainedOriginalPath(hookPath: string): string {
  return `${hookPath}${SHIELD_CHAIN_ORIGINAL_SUFFIX}`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a file as raw BYTES, never as decoded text.
 *
 * Phase 8 finding: this used to read `utf8`, and every path that
 * round-tripped a foreign hook through it (chaining an existing
 * `pre-commit` aside to its sidecar) silently corrupted any hook that was
 * not valid UTF-8. Empirically reproduced with a native executable hook:
 * the bytes `ff fe 80 81` came back out as four U+FFFD replacement
 * characters (`ef bf bd` × 4) — a "preserved" foreign hook that no longer
 * runs. Ownership detection, content comparison, and sidecar
 * preservation are all byte-level operations, so they all read bytes;
 * only content Shield itself wrote (the policy JSON) is decoded as text,
 * and only where a string is genuinely needed.
 *
 * Uses `lstat` semantics implicitly: `fs.readFile` follows symlinks, so
 * callers that care about link-ness must consult
 * {@link classifyHookFile} — never infer file type from this.
 */
async function readBytesIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: nothing there. EISDIR / ELOOP / dangling symlink (also
    // ENOENT): nothing readable there either — reported as absent so
    // `classifyHookFile` is the single place that decides what an
    // unusual file type means.
    //
    // ENOTDIR is the same class of answer and was missing (Phase 9,
    // empirically reproduced): a plain FILE occupying a path component —
    // e.g. something writing `.git/repo-identity-guard` as a file — made
    // `inspect()` throw ENOTDIR straight out of `enable()`, so a
    // repository in that state could not even be diagnosed, let alone
    // repaired. It means "nothing readable at this path" exactly as much
    // as EISDIR does. ENAMETOOLONG is included for the same reason.
    if (code === "ENOENT" || code === "EISDIR" || code === "ELOOP" || code === "ENOTDIR" || code === "ENAMETOOLONG") {
      return null;
    }
    throw error;
  }
}

/** Text form of {@link readBytesIfExists}, for files Shield itself wrote as text (the policy). Invalid UTF-8 would be a corrupt policy either way. */
async function readFileIfExists(filePath: string): Promise<string | null> {
  const bytes = await readBytesIfExists(filePath);
  return bytes === null ? null : bytes.toString("utf8");
}

async function modeOf(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode;
  } catch {
    return undefined;
  }
}

/**
 * What actually occupies a hook path, at the filesystem-type level —
 * `lstat`, so a symlink is reported as a symlink rather than as whatever
 * it points at.
 *
 * Phase 8 finding, hook chaining: chaining used to read whatever was at
 * the hook path and write those (decoded!) bytes to the sidecar as a
 * plain regular file. Empirically, that turned a symlinked `pre-commit`
 * into a regular-file copy (breaking the "edit the target, the hook
 * changes" arrangement Husky-style setups rely on), and it happily
 * chained a NON-EXECUTABLE hook — which Git itself would never have run —
 * into a position where Shield's shim tried to `exec` it, producing
 * `exec: ...: Permission denied` on every single commit with no
 * indication of where it came from.
 *
 * So chaining is now restricted to the one file type it can support
 * faithfully and run correctly: an executable regular file, moved
 * byte-for-byte with its mode preserved. Everything else is left
 * completely untouched and reported as a precise `degraded` reason (see
 * `foreignHookRefusalReason`) — option (B) of "preserve exactly, or
 * refuse and explain". Shield never converts a file type, never decodes
 * bytes it did not write, and never installs a chain it cannot run.
 */
type HookFileKind = "absent" | "executable-regular" | "nonexecutable-regular" | "symlink" | "other";

async function classifyHookFile(filePath: string): Promise<HookFileKind> {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (stats.isSymbolicLink()) return "symlink";
  if (!stats.isFile()) return "other";
  // Windows has no meaningful executable bit — `fs.lstat().mode` reports
  // 0o666/0o444 for every file regardless — and Git for Windows runs any
  // hook file it finds. Requiring an x-bit there would refuse to chain
  // every foreign hook on Windows, so the check is POSIX-only; the
  // failure it guards against (an `exec` that dies with "Permission
  // denied") is likewise POSIX-only.
  if (process.platform === "win32") return "executable-regular";
  return (stats.mode & 0o111) !== 0 ? "executable-regular" : "nonexecutable-regular";
}

function foreignHookRefusalReason(fileName: ShieldHookFileName, hookPath: string, kind: HookFileKind): string {
  const detail =
    kind === "symlink"
      ? "it is a symbolic link, and moving it aside would replace the link with a plain copy — silently breaking the arrangement it is part of"
      : kind === "nonexecutable-regular"
        ? "it is not executable, so Git never runs it — and chaining it would make Shield's own hook try to execute it on every operation, failing with a bare \"Permission denied\""
        : "it is not a regular file (e.g. a directory, socket, or device), which Shield has no faithful way to preserve or run";
  return `A ${fileName} hook already exists at ${hookPath} that Repo Identity Guard did not create, and Shield refused to chain it because ${detail}. Shield left it completely untouched and did not install its own ${fileName} hook here. Resolve it yourself (for a symlink: replace it with a regular executable script, or point core.hooksPath at a directory Shield can manage; for a non-executable file: make it executable or remove it), then run "Repair Shield".`;
}

/**
 * Writes `content` to `filePath` via a temp-file-then-rename in the same
 * directory, so a process interruption mid-write can never leave a
 * truncated/partial file at the final path — the rename is atomic on the
 * same filesystem, which a same-directory temp file guarantees.
 */
async function writeFileAtomic(filePath: string, content: string | Buffer, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.writeFile(tempPath, content, mode !== undefined ? { mode } : undefined);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Phase 9: clean the temp file up on failure. Without this, a failed
    // rename (a directory occupying the destination, a read-only mount, a
    // full disk) stranded a `.<name>.tmp-<hex>` file in Shield's own
    // storage/hooks directory forever — which `disable()`'s deliberately
    // non-forcing `rmdir` then could never clear, so a repository that hit
    // one transient write error kept a permanent, unexplained leftover.
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
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

/** Byte-level ownership check — see {@link readBytesIfExists} for why nothing here decodes text it did not write. */
function isOwnedBytes(bytes: Buffer): boolean {
  return bytes.includes(SHIELD_ARTIFACT_MARKER);
}

/** Byte-level version extraction. `latin1` is a lossless byte↔char mapping, so an ASCII marker is found without any risk of mangling surrounding non-UTF-8 bytes. */
function versionOfBytes(bytes: Buffer): number | undefined {
  return extractShieldArtifactVersion(bytes.toString("latin1"));
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
          fileKind: "absent" as HookFileKind,
        })),
        policyPresent: false,
        policyValid: false,
        evaluatorPresent: false,
        evaluatorOwned: false,
        evaluatorModified: false,
        hooksPathCustomized: false,
        policyProfileDrift: false,
        pushDestinationDrift: false,
        orphanedHookPaths: [],
        gitVersionSupported: false,
      };
    }

    const policyPath = shieldPolicyFilePath(gitContext.gitCommonDir);
    const evaluatorPath = shieldEvaluatorScriptFilePath(gitContext.gitCommonDir);

    const [policyRaw, evaluatorRaw, coreHooksPath, gitVersionRaw, ...hookRaws] = await Promise.all([
      readFileIfExists(policyPath),
      readBytesIfExists(evaluatorPath),
      getCoreHooksPathConfig(repoRoot),
      getGitVersionRaw(repoRoot),
      ...HOOK_SPECS.map((spec) => readBytesIfExists(path.join(gitContext.hooksDir, spec.fileName))),
    ]);
    const [chainedRaws, hookKinds] = await Promise.all([
      Promise.all(
        HOOK_SPECS.map((spec) => readBytesIfExists(chainedOriginalPath(path.join(gitContext.hooksDir, spec.fileName)))),
      ),
      Promise.all(HOOK_SPECS.map((spec) => classifyHookFile(path.join(gitContext.hooksDir, spec.fileName)))),
    ]);

    const policyResult = policyRaw !== null ? parseShieldPolicy(policyRaw) : undefined;
    const evaluatorOwned = evaluatorRaw !== null && isOwnedBytes(evaluatorRaw);
    const evaluatorVersion = evaluatorOwned ? versionOfBytes(evaluatorRaw as Buffer) : undefined;
    const evaluatorSource = options.evaluatorScriptSource
      ? await readBytesIfExists(options.evaluatorScriptSource).catch(() => null)
      : null;
    const evaluatorModified =
      evaluatorOwned &&
      evaluatorSource !== null &&
      evaluatorVersion === SHIELD_ARTIFACT_VERSION &&
      !(evaluatorRaw as Buffer).equals(evaluatorSource);

    const hooks: ShieldHookInspection[] = HOOK_SPECS.map((spec, i) => {
      const raw = hookRaws[i];
      const ownership: ShieldArtifactOwnership = raw === null ? "absent" : isOwnedBytes(raw) ? "shield" : "foreign";
      const version = ownership === "shield" ? versionOfBytes(raw as Buffer) : undefined;
      const contentModified =
        ownership === "shield" &&
        version === SHIELD_ARTIFACT_VERSION &&
        !(raw as Buffer).equals(Buffer.from(spec.build(), "utf8"));
      return {
        fileName: spec.fileName,
        action: spec.action,
        path: path.join(gitContext.hooksDir, spec.fileName),
        ownership,
        version,
        contentModified,
        hasChainedOriginal: chainedRaws[i] !== null,
        fileKind: hookKinds[i],
      };
    });

    // Phase 8: never report ACTIVE on a Git that cannot run the hooks
    // Shield claims to enforce — see src/shield/gitVersion.ts.
    const gitVersionSupport = evaluateGitVersionSupport(gitVersionRaw);

    // Shield-owned hooks left behind at a hooks directory Shield installed
    // into earlier but that `core.hooksPath` has since moved away from.
    // Read-only: every candidate is re-verified as Shield-owned right now,
    // straight off disk — the record only says *where to look*.
    const orphanedHookPaths = await this.findOrphanedShieldHookPaths(gitContext);

    const reasons: string[] = [];
    let state: ShieldLifecycleState;

    const anyShieldArtifactPresent =
      policyRaw !== null ||
      evaluatorRaw !== null ||
      hooks.some((h) => h.ownership === "shield") ||
      orphanedHookPaths.length > 0;

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
      // Shield genuinely isn't installed here. Report "off" even on an
      // unsupported Git — nagging about a Git version for a feature the
      // user never enabled would be noise, and `enable()` refuses (with
      // the full explanation) at the moment it actually matters.
      state = "off";
    } else if (!gitVersionSupport.supported) {
      // Ahead of every other check: on a Git this old, the hooks either
      // cannot run at all or cannot cover merge commits, so no amount of
      // correct-looking on-disk state adds up to real enforcement.
      state = "degraded";
      reasons.push(gitVersionSupport.reason as string);
    } else if (foreignHooks.length > 0) {
      state = "degraded";
      for (const hook of foreignHooks) {
        reasons.push(
          hook.fileKind === "executable-regular"
            ? `A ${hook.fileName} hook already exists at ${hook.path} that Repo Identity Guard did not create. Shield will not overwrite or delete it — move it aside yourself, enable Shield with hook chaining, or run "Repair Shield" after resolving it.`
            : foreignHookRefusalReason(hook.fileName, hook.path, hook.fileKind),
        );
      }
    } else if (orphanedHookPaths.length > 0) {
      // Reported before the policy/evaluator checks: a hook Shield can no
      // longer see (because core.hooksPath moved) but that would spring
      // back to life the moment it moves back is the single most
      // dangerous inconsistency Shield can be in, now that its hooks fail
      // CLOSED. "Repair Shield" adopts them; "Disable Shield" removes
      // them.
      state = "degraded";
      for (const orphan of orphanedHookPaths) {
        reasons.push(
          `A Shield-owned hook is still installed at ${orphan}, which is not the hooks directory Git currently uses${coreHooksPath ? ` ("core.hooksPath" is set to "${coreHooksPath}")` : ""}. It is inert right now, but would take effect again if that setting changed back. Run "Repair Shield" or "Disable Shield" — both clean up Shield's previous installation locations.`,
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
      orphanedHookPaths,
      gitVersionRaw: gitVersionRaw ?? undefined,
      gitVersionSupported: gitVersionSupport.supported,
    };
  }

  /**
   * Shield-owned hook files sitting in a hooks directory Shield's durable
   * installation record names, but which is NOT the hooks directory Git
   * resolves right now.
   *
   * Two invariants, both deliberate:
   *  - the record is only ever a list of *places to look*; every path it
   *    yields is re-read and re-verified as carrying Shield's ownership
   *    marker before it is reported (and, in `disable()`/`enable()`,
   *    before it is touched). A tampered record can point Shield at
   *    `/etc`; it still cannot get Shield to delete anything there.
   *  - a hooks directory that IS the current one is excluded, because
   *    those hooks are inspected properly by the main path above and are
   *    not orphans at all.
   */
  private async findOrphanedShieldHookPaths(gitContext: ShieldGitContext): Promise<string[]> {
    const record = await readShieldInstallRecord(shieldInstallRecordFilePath(shieldStorageDir(gitContext.gitCommonDir)));
    if (!record) return [];

    const staleDirs = record.hookDirs.filter((dir) => !sameHookDir(dir, gitContext.hooksDir));
    const found: string[] = [];
    for (const dir of staleDirs) {
      for (const spec of HOOK_SPECS) {
        const hookPath = path.join(dir, spec.fileName);
        const bytes = await readBytesIfExists(hookPath).catch(() => null);
        if (bytes !== null && isOwnedBytes(bytes)) found.push(hookPath);
      }
    }
    return found;
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

    // ---- canonical identity vs. approved push destination ----
    //
    // These are two DIFFERENT facts and Phase 8 found them conflated:
    // `approvedPushDestination` was built from the `remote*` (origin
    // fetch) facts, so every repository whose actual plain-push
    // destination differs from origin's fetch URL had Shield approving
    // the wrong place. That is not a rare shape — Git offers four
    // separate ways to arrange it, all of which `getPushRemoteName` /
    // `getPushUrl` already resolve correctly for the sidebar:
    // `branch.<name>.pushRemote`, `remote.pushDefault`,
    // `remote.<name>.pushurl`, and a `branch.<name>.remote` that isn't
    // origin. In each, Shield would previously approve origin's owner/repo
    // and then evaluate a real push that legitimately goes elsewhere —
    // blocking correct pushes, and (in the mirror case) approving a
    // destination nobody pushes to.
    //
    // - `approvedRepositoryKey` stays origin-based: it is the repository's
    //   canonical IDENTITY, the same key `resolveProfiles`/`exactRepos`
    //   match against, and origin is the right notion of "which repo is
    //   this" even for a repo that pushes somewhere else.
    // - `approvedPushDestination` is now built strictly from the
    //   `pushRemote*` facts: the destination a plain `git push` would
    //   ACTUALLY reach, which is the only thing pre-push evaluation
    //   compares against.
    //
    // No fallback to origin when the push destination didn't resolve: an
    // absent `approvedPushDestination` already fails closed at push time
    // (see `destinationReasons`), and silently substituting origin here
    // would reintroduce exactly the bug this fixes.
    const approvedRepositoryKey = canonicalRepoKey(facts.remoteHost, facts.remoteOwner, facts.remoteRepo);
    const approvedPushDestination =
      facts.pushRemoteOwner || facts.pushRemoteHost || facts.pushRemoteRepo
        ? { host: facts.pushRemoteHost, owner: facts.pushRemoteOwner, repo: facts.pushRemoteRepo }
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

    // Phase 8: refuse outright on a Git that cannot run the hooks Shield
    // would install. Writing them anyway would produce artifacts that can
    // only ever fail closed (or, worse, never fire) while Shield claims to
    // be protecting the repository — see src/shield/gitVersion.ts.
    const gitVersionSupport = evaluateGitVersionSupport(await getGitVersionRaw(repoRoot));
    if (!gitVersionSupport.supported) {
      const inspection = await this.inspect(repoRoot);
      return {
        ok: false,
        inspection: {
          ...inspection,
          reasons: [
            `${gitVersionSupport.reason as string} Shield was not installed; nothing on disk was changed.`,
            ...inspection.reasons,
          ],
        },
      };
    }

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
      | { spec: HookSpec; hookPath: string; mode: "chain"; originalContent: Buffer; originalMode: number | undefined }
      | { spec: HookSpec; hookPath: string; mode: "skip" };

    const hookWrites: HookWrite[] = await Promise.all(
      HOOK_SPECS.map(async (spec): Promise<HookWrite> => {
        const hookPath = path.join(gitContext.hooksDir, spec.fileName);
        const kind = await classifyHookFile(hookPath);
        const existing = kind === "absent" ? null : await readBytesIfExists(hookPath);

        // A symlink or non-regular file at the hook path can never be
        // Shield's own (Shield only ever writes plain regular files), so
        // it is foreign by construction and must be left alone — reading
        // through the link to check for a marker would be meaningless and
        // overwriting it would follow the link to somewhere Shield does
        // not own.
        if (kind === "absent" || (kind === "executable-regular" && existing !== null && isOwnedBytes(existing))) {
          return { spec, hookPath, mode: "direct" };
        }
        if (kind === "nonexecutable-regular" && existing !== null && isOwnedBytes(existing)) {
          // Shield's own hook that lost its executable bit somehow — still
          // Shield's, still safe to rewrite (with mode 0o755 restored).
          return { spec, hookPath, mode: "direct" };
        }

        if (!input.chainForeignHooks) {
          return { spec, hookPath, mode: "skip" };
        }

        // Phase 8: only an executable REGULAR file can be chained
        // faithfully — see `classifyHookFile`. A symlink, a
        // non-executable file, or anything that isn't a regular file is
        // left exactly as it is, with `inspect()` reporting a precise
        // reason, rather than being converted into something Shield can
        // handle.
        if (kind !== "executable-regular" || existing === null) {
          return { spec, hookPath, mode: "skip" };
        }

        // A previous chained original already sitting at the sidecar path
        // means either a prior chain was never cleanly finished/restored,
        // or something else wrote there — either way, silently moving
        // ANOTHER foreign hook on top of it would permanently lose
        // whichever one is already there. Fail this hook's write closed
        // rather than guess which one the user meant to keep.
        const sidecarPath = chainedOriginalPath(hookPath);
        if ((await classifyHookFile(sidecarPath)) !== "absent") {
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
    const evaluatorScript = await fs.readFile(evaluatorScriptSource);

    // ==================================================================
    // TRANSACTION — prepare → persist lifecycle metadata → install →
    //               verify → commit (Phase 9)
    // ==================================================================
    //
    // Phase 9 finding, empirically reproduced (see
    // src/test/shieldInstallRecordTransaction.test.ts): the install record
    // used to be written best-effort, AFTER orphan cleanup and in the same
    // breath as the artifacts, and its failure was reported as a warning
    // while all three hook shims were installed anyway. The observed result
    // on a repository whose record file could not be written was
    // `state: "active"`, three live fail-CLOSED hooks on disk, and NO
    // durable record naming the directory they live in — precisely the
    // orphan hazard `installRecord.ts` exists to prevent, and the one that
    // (under v5 fail-closed shims) can permanently block every commit and
    // push in a repository with no Shield left to repair or disable it.
    //
    // So the record is now a SAFETY PREREQUISITE, not bookkeeping:
    //
    //  1. prepare — everything above this point: resolve Git context,
    //     refuse an unsupported Git, build the policy, classify every hook
    //     slot, read the evaluator source. No writes have happened yet.
    //  2. persist required lifecycle metadata — create Shield's storage
    //     directory and durably record every hooks directory Shield will
    //     be responsible for. This is a SUPERSET (previous locations plus
    //     this one), so at no instant is a live Shield hook missing from
    //     the record. If this step cannot be completed, the transaction
    //     ABORTS here, before anything is installed, moved, or removed.
    //  3. install/update artifacts — policy, evaluator, hooks — each with
    //     an exact byte+mode snapshot taken first so a failure part-way
    //     through can be rolled back to the state that preceded it.
    //  4. verify — a fresh `inspect()`.
    //  5. commit — narrow the record to the locations that actually still
    //     hold something, and report.
    //
    // Orphan cleanup deliberately moved to AFTER step 2: destroying a
    // known-good previous installation is a mutation like any other, and
    // must never happen on the strength of a transaction that cannot even
    // record where it is going.

    const storageDir = shieldStorageDir(gitContext.gitCommonDir);
    const installRecordPath = shieldInstallRecordFilePath(storageDir);
    const previousRecord = await readShieldInstallRecord(installRecordPath);

    // Does Shield already have something on disk here worth protecting?
    // Decides FIRST-ENABLE (abort must leave no Shield state behind) from
    // REPAIR/MIGRATION (abort must leave the existing, known-good
    // enforcement exactly as it is).
    const preExisting = await this.hasExistingShieldState(gitContext, previousRecord);

    // ---- step 2: persist required lifecycle metadata ----
    let storageDirCreated = false;
    let metadataFailure: string | undefined;
    try {
      storageDirCreated = (await fs.mkdir(storageDir, { recursive: true })) !== undefined;
    } catch (error) {
      metadataFailure = `Shield's storage directory (${storageDir}) could not be created: ${toMessage(error)}`;
    }

    // The superset: every hooks directory Shield was already responsible
    // for, PLUS the one it is about to install into. Writing the superset
    // first (and narrowing it only after cleanup has actually succeeded)
    // guarantees the record is never momentarily missing a live location.
    const supersetDirs = normalizeHookDirs([...(previousRecord?.hookDirs ?? []), gitContext.hooksDir]);
    if (metadataFailure === undefined) {
      // An existing record that already names every directory this install
      // needs IS durable lifecycle metadata — there is nothing new to
      // persist, so a failure to rewrite an already-correct file must not
      // abort an otherwise-safe repair.
      const alreadyCurrent =
        !!previousRecord &&
        supersetDirs.length === previousRecord.hookDirs.length &&
        supersetDirs.every((dir) => previousRecord.hookDirs.some((d) => sameHookDir(d, dir)));
      if (!alreadyCurrent && !(await writeShieldInstallRecord(installRecordPath, supersetDirs, input.now ?? Date.now()))) {
        metadataFailure = `Shield could not durably record which hooks directory it installs into (${installRecordPath} is not writable)`;
      }
    }

    if (metadataFailure !== undefined) {
      // ---- ABORT. Nothing has been installed, moved, or removed. ----
      if (storageDirCreated) {
        // Leave no Shield state behind on a failed FIRST enable. rmdir
        // (never rm -rf) so this can only ever remove a directory Shield
        // itself just created and that is still empty.
        await fs.rmdir(storageDir).catch(() => undefined);
      }
      const inspection = await this.inspect(repoRoot);
      const headline = preExisting
        ? `${metadataFailure}. Shield could not safely establish lifecycle tracking, so this repair was ABORTED before touching anything: no hook was installed, moved, or removed, and the Shield installation already present here is unchanged and still enforcing. Until this is resolved Shield cannot guarantee it can find and remove every hook it owns, so it is reported as degraded. Fix the permissions on ${storageDir} and run "Repair Shield" again.`
        : `${metadataFailure}. Shield was NOT enabled: without that record it could not guarantee it would later be able to find and remove the hooks it installs, and a Shield hook that Disable Shield cannot reach would block every commit and push in this repository with no Shield left to repair it. Nothing was installed and no Shield state was left behind. Fix the permissions on ${storageDir} and try again.`;
      return {
        ok: false,
        inspection: {
          ...inspection,
          // Never report ACTIVE out of an aborted enable/repair: lifecycle
          // tracking is exactly the thing that could not be established.
          state: inspection.state === "active" ? "degraded" : inspection.state,
          reasons: [headline, ...inspection.reasons],
        },
      };
    }

    // Adopt any Shield-owned hooks stranded at a previous install location
    // BEFORE installing here, so a repair genuinely consolidates rather
    // than adding a third live copy. Same conservative ownership rule as
    // `disable()`: a chained original is restored if one is waiting,
    // otherwise the hook is simply removed; anything Shield cannot prove
    // it owns is left completely alone. Safe to run now — and only now —
    // because the record above already names every location involved.
    const orphanCleanup = await this.cleanUpOrphanedInstallations(gitContext);

    // ---- step 3: install artifacts, with rollback ----
    //
    // Every write snapshots the exact prior bytes and mode of the path it
    // touches first, and pushes an undo. On a failure part-way through,
    // undos run in REVERSE order — hooks before evaluator before policy —
    // so the rollback itself can never pass through the one state that is
    // genuinely dangerous under v5 fail-closed shims ("hook present,
    // evaluator gone"). Nothing outside the exact set of paths this
    // operation wrote is ever touched.
    const undos: Array<() => Promise<void>> = [];
    const writeTracked = async (filePath: string, content: string | Buffer, mode?: number): Promise<void> => {
      const before = await readBytesIfExists(filePath).catch(() => null);
      const beforeMode = before === null ? undefined : await modeOf(filePath);
      undos.push(async () => {
        if (before === null) await deleteIfExists(filePath);
        else await writeFileAtomic(filePath, before, beforeMode);
      });
      await writeFileAtomic(filePath, content, mode);
    };

    try {
      await writeTracked(policyPath, serializeShieldPolicy(built.policy));
      await writeTracked(evaluatorPath, evaluatorScript, 0o755);

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
          await writeTracked(chainedOriginalPath(write.hookPath), write.originalContent, write.originalMode);
        }
        await writeTracked(write.hookPath, write.spec.build(), 0o755);
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const undo of undos.reverse()) {
        await undo().catch((rollbackError) => rollbackFailures.push(toMessage(rollbackError)));
      }
      const inspection = await this.inspect(repoRoot);
      return {
        ok: false,
        inspection: {
          ...inspection,
          state: inspection.state === "active" ? "degraded" : inspection.state,
          reasons: [
            `Shield could not finish installing its artifacts: ${toMessage(error)}. ${
              rollbackFailures.length === 0
                ? "Everything this operation had written was rolled back to its previous contents; nothing Shield does not own was touched."
                : `Rolling back was itself incomplete (${rollbackFailures.join("; ")}) — run "Repair Shield" or "Disable Shield".`
            } Shield's installation record still names every hooks directory involved, so "Disable Shield" can still reach them.`,
            ...orphanCleanup.reasons,
            ...inspection.reasons,
          ],
        },
      };
    }

    // ---- steps 4 + 5: verify, then commit the narrowed record ----
    const inspection = await this.inspect(repoRoot);

    // Narrow the record from the superset written in step 2 down to the
    // locations that actually still hold something: this hooks directory,
    // plus any previous location cleanup could not finish. Best-effort by
    // design — the superset already on disk is a strict over-approximation,
    // so failing to narrow it can only ever make a later Disable/Repair
    // look in one extra place, never miss one.
    const narrowedDirs = normalizeHookDirs([
      ...(previousRecord?.hookDirs ?? []).filter((dir) => orphanCleanup.stillPresentDirs.some((d) => sameHookDir(d, dir))),
      gitContext.hooksDir,
    ]);
    if (narrowedDirs.length !== supersetDirs.length) {
      await writeShieldInstallRecord(installRecordPath, narrowedDirs, input.now ?? Date.now());
    }

    const extraReasons = [...orphanCleanup.reasons];
    return {
      ok: inspection.state === "active" && extraReasons.length === 0,
      inspection: extraReasons.length === 0 ? inspection : { ...inspection, reasons: [...extraReasons, ...inspection.reasons] },
    };
  }

  /**
   * Whether this repository already carries Shield state worth protecting
   * — used only to tell a failed FIRST enable (which must leave nothing
   * behind) from a failed REPAIR/migration (which must leave the existing,
   * known-good enforcement completely untouched). Deliberately generous:
   * anything that even looks like a prior Shield install counts, because
   * the consequence of guessing "first enable" wrongly is destroying
   * working enforcement, while guessing "repair" wrongly only leaves an
   * empty directory behind.
   */
  private async hasExistingShieldState(
    gitContext: ShieldGitContext,
    previousRecord: { hookDirs: string[] } | undefined,
  ): Promise<boolean> {
    if (previousRecord && previousRecord.hookDirs.length > 0) return true;
    for (const filePath of [shieldPolicyFilePath(gitContext.gitCommonDir), shieldEvaluatorScriptFilePath(gitContext.gitCommonDir)]) {
      if ((await readBytesIfExists(filePath).catch(() => null)) !== null) return true;
    }
    for (const spec of HOOK_SPECS) {
      const bytes = await readBytesIfExists(path.join(gitContext.hooksDir, spec.fileName)).catch(() => null);
      if (bytes !== null && isOwnedBytes(bytes)) return true;
    }
    return false;
  }

  /**
   * Removes/restores Shield-owned hooks left at hooks directories Shield
   * previously installed into but that Git no longer resolves. Shared by
   * `enable()`/`repair()` (which consolidates onto the current location)
   * and `disable()` (which must reach every location or risk leaving a
   * fail-closed hook behind with no evaluator — see `artifacts.ts`).
   *
   * Applies exactly the same conservative ownership rule as `disable()`
   * at the current location: a path is only ever touched after its
   * CURRENT content is re-read and proven to carry Shield's marker, and a
   * chained original is restored over the hook rather than the hook
   * simply being deleted. `stillPresentDirs` reports directories where
   * something Shield-related remains (an unrestorable chained original,
   * an I/O failure), so a caller can keep them on the record and try
   * again later rather than forgetting they exist.
   */
  private async cleanUpOrphanedInstallations(
    gitContext: ShieldGitContext,
  ): Promise<{ reasons: string[]; stillPresentDirs: string[] }> {
    const record = await readShieldInstallRecord(shieldInstallRecordFilePath(shieldStorageDir(gitContext.gitCommonDir)));
    if (!record) return { reasons: [], stillPresentDirs: [] };

    const reasons: string[] = [];
    const stillPresentDirs: string[] = [];

    for (const dir of record.hookDirs) {
      if (sameHookDir(dir, gitContext.hooksDir)) continue;
      let leftovers = false;
      for (const spec of HOOK_SPECS) {
        const hookPath = path.join(dir, spec.fileName);
        try {
          const outcome = await this.removeOwnedHook(hookPath);
          if (outcome === "unresolved-chain") {
            leftovers = true;
            reasons.push(
              `A chained original hook at ${chainedOriginalPath(hookPath)} (from a previous Shield installation location) could not be restored automatically because something other than Shield now occupies ${hookPath}. Resolve this manually — the original is preserved at that exact path.`,
            );
          }
        } catch (error) {
          leftovers = true;
          reasons.push(
            `Shield could not clean up its previously-installed hook at ${hookPath}: ${toMessage(error)}. That hook is inert while "core.hooksPath" points elsewhere, but should be removed by hand.`,
          );
        }
      }
      if (leftovers) stillPresentDirs.push(dir);
    }

    return { reasons, stillPresentDirs };
  }

  /**
   * Removes one hook path if — and only if — its current content proves
   * it is Shield's own, restoring a chained original over it when one is
   * waiting. The single place this rule is implemented, so the current
   * location and every recorded previous location are treated identically.
   *
   * Returns `"removed"`, `"restored"` (a chained original was folded
   * back), `"absent"` (nothing of Shield's here), or `"unresolved-chain"`
   * (a sidecar exists but the hook slot is no longer Shield's, so neither
   * deleting nor overwriting would be safe).
   */
  private async removeOwnedHook(hookPath: string): Promise<"removed" | "restored" | "absent" | "unresolved-chain"> {
    const sidecarPath = chainedOriginalPath(hookPath);
    const hookKind = await classifyHookFile(hookPath);
    // A symlink at the hook path is never Shield's own — Shield only ever
    // writes regular files — so it is never removed, and following it to
    // read a marker would be misleading.
    const existingHook = hookKind === "executable-regular" || hookKind === "nonexecutable-regular" ? await readBytesIfExists(hookPath) : null;
    const existingSidecar = await readBytesIfExists(sidecarPath).catch(() => null);

    if (existingHook !== null && isOwnedBytes(existingHook)) {
      if (existingSidecar !== null) {
        const originalMode = await modeOf(sidecarPath);
        await writeFileAtomic(hookPath, existingSidecar, originalMode);
        await deleteIfExists(sidecarPath);
        return "restored";
      }
      await deleteIfExists(hookPath);
      return "removed";
    }
    if (existingSidecar !== null) return "unresolved-chain";
    return "absent";
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
    const extraReasons: string[] = [];

    // ============ ORDER MATTERS — hooks first, artifacts second ============
    //
    // Shield's hook shims fail CLOSED as of artifact v5: a hook that is
    // installed but whose evaluator is missing blocks the operation and
    // says "broken Shield installation". That is exactly right for
    // tampering, and exactly wrong if a *legitimate, completed* disable
    // could ever leave a hook behind after deleting the evaluator — the
    // user would be permanently unable to commit or push, with no Shield
    // left to repair or disable.
    //
    // So disable removes/disarms every hook it can prove it owns, at the
    // current hooks directory AND at every hooks directory in Shield's
    // durable installation record, strictly BEFORE deleting the evaluator,
    // policy, and the record itself. If the process dies partway through,
    // the state it dies in is always "some hooks removed, evaluator still
    // present" — which enforces slightly more than intended (safe) rather
    // than blocking everything (unsafe). Never the reverse.
    //
    // The installation record must therefore be read here, before it is
    // deleted, and only deleted once every location it names has been
    // handled.
    const orphanCleanup = await this.cleanUpOrphanedInstallations(gitContext);
    extraReasons.push(...orphanCleanup.reasons);

    for (const spec of HOOK_SPECS) {
      const hookPath = path.join(gitContext.hooksDir, spec.fileName);
      if ((await this.removeOwnedHook(hookPath)) === "unresolved-chain") {
        // Never restore over content that isn't Shield's own, and never
        // delete a sidecar we can't safely fold back — surfaced as a
        // diagnostic below instead.
        unresolvedChains.push(chainedOriginalPath(hookPath));
      }
    }

    // Only now — with every hook Shield owns gone — are the artifacts the
    // hooks depend on removed.
    const storageDir = shieldStorageDir(gitContext.gitCommonDir);
    await deleteIfExists(shieldPolicyFilePath(gitContext.gitCommonDir));
    await deleteIfExists(shieldEvaluatorScriptFilePath(gitContext.gitCommonDir));
    if (orphanCleanup.stillPresentDirs.length === 0) {
      await deleteIfExists(shieldInstallRecordFilePath(storageDir));
    } else {
      // A location Shield could not finish cleaning stays recorded, so a
      // later Disable/Repair still knows where to look. Deleting the
      // record here would strand it permanently.
      await writeShieldInstallRecord(
        shieldInstallRecordFilePath(storageDir),
        orphanCleanup.stillPresentDirs,
        Date.now(),
      );
    }
    try {
      await fs.rmdir(storageDir);
    } catch {
      // Non-empty (unexpected extra file, or a retained install record) or
      // already gone — never force-remove anything Shield didn't itself
      // just delete above.
    }

    const inspection = await this.inspect(repoRoot);
    const reasons = [
      ...extraReasons,
      ...unresolvedChains.map(
        (p) => `A chained original hook at ${p} could not be restored automatically because something other than Shield now occupies its hook slot. Resolve this manually — the original is preserved at that exact path.`,
      ),
      ...inspection.reasons,
    ];
    return reasons.length === inspection.reasons.length ? inspection : { ...inspection, reasons };
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
