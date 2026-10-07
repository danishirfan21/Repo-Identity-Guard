import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Identity } from "../identity/types";
import {
  getCoreHooksPathConfig,
  getGitCommonDir,
  getGitDir,
  getGitVersionRaw,
  getHooksDir,
} from "../services/gitService";
import {
  SHIELD_ARTIFACT_MARKER,
  SHIELD_ARTIFACT_VERSION,
  SHIELD_CHAIN_ORIGINAL_SUFFIX,
  buildPreCommitHookScript,
  buildPrePushHookScript,
  extractShieldArtifactVersion,
} from "./artifacts";
import { evaluateGitVersionSupport } from "./gitVersion";
import {
  normalizeHookDirs,
  readShieldInstallRecord,
  sameHookDir,
  shieldInstallRecordFilePath,
  writeShieldInstallRecord,
} from "./installRecord";
import { LegacyPolicyInfo, ShieldPolicy, buildShieldPolicy, parseShieldPolicy, readLegacyPolicyInfo, serializeShieldPolicy } from "./policy";
import { shieldEvaluatorScriptFilePath, shieldPolicyFilePath, shieldStorageDir } from "./storage";
import { ShieldAction, ShieldLifecycleState } from "./types";

/**
 * ShieldManager owns the identity lock's on-disk enforcement lifecycle
 * (the engine was historically a user-facing feature called "Shield Mode";
 * it is now an internal detail driven by `IdentityLockService`):
 * installing/removing/repairing the pre-commit, pre-merge-commit and
 * pre-push hooks and the lock policy + evaluator copy they read, and
 * reporting their current health. It does **not**
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
 *  - `<hooksDir>/pre-commit`, `<hooksDir>/pre-merge-commit` and
 *    `<hooksDir>/pre-push` — resolved fresh via
 *    `git rev-parse --git-path hooks` (see `getHooksDir`), and each only
 *    ever written or deleted when that exact path is empty or already
 *    carries Shield's own ownership marker (see `src/shield/artifacts.ts`).
 *    A foreign hook already occupying either path is never overwritten and
 *    never deleted UNLESS the caller explicitly opts into
 *    `chainForeignHooks` (Phase 6 — see "Hook coexistence" below); the two
 *    hooks are evaluated and installed independently either way, so a
 *    foreign `pre-push` never blocks installing Shield's `pre-commit`, or
 *    vice versa.
 *  - `<hooksDir>/<hook-name>.repo-identity-guard-original`, for each of
 *    the three hook names above — the exact
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
 * the next `inspect()` sees exactly that partial state and reports
 * `degraded`, never a stale `active` left over from a flag no one updated.
 * (The hook itself FAILS CLOSED in the mirror-image situation -- installed
 * but with its evaluator copy missing -- as of artifact v5; see
 * `artifacts.ts`. It has not "failed open" since v4, and this comment used
 * to say it did.)
 *
 * The same re-derivation is what turns "someone redirected `core.hooksPath`
 * away from Shield's hooks directory" into an automatically-detected
 * `degraded`. That much needs no bookkeeping -- but the CONVERSE does:
 * finding the hooks Shield left behind at the directory `core.hooksPath`
 * moved AWAY from is impossible without a record of where Shield installed,
 * which is exactly why `src/shield/installRecord.ts` exists. This comment
 * used to claim no such bookkeeping was required at all; that was wrong,
 * and under fail-closed shims it was dangerously wrong.
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
 * relying on a native feature that doesn't exist. Re-verified against Git
 * 2.43.0 in Phase 9 (Part 14): `hook.<name>.command` config entries are
 * accepted by `git config` and then COMPLETELY IGNORED -- neither `git
 * commit` nor `git hook run pre-commit` executes them, and the traditional
 * hook file is still the only script that runs. So sidecar chaining remains
 * the only mechanism, and no migration is available to move to.
 *
 * Shield's minimum supported Git version is **2.31.0**, NOT 2.9. This
 * comment used to say 2.9 (when `core.hooksPath` was introduced); Phase 8
 * found that wrong on two counts -- `git rev-parse --path-format=absolute`
 * needs 2.31, and `pre-merge-commit` needs 2.24 -- and
 * `src/shield/gitVersion.ts` is the authority. `enable()` refuses outright
 * below the floor.
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

/** One of the THREE hook files Shield can install — see `HOOK_SPECS`. `pre-merge-commit` was added in Phase 7 and governs the same "commit" action as `pre-commit`. */
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
  /** One entry per hook file Shield can install (`pre-commit`, `pre-merge-commit`, `pre-push`), in that order — always present, even when `ownership` is `"absent"`. */
  hooks: ShieldHookInspection[];
  policyPath?: string;
  policyPresent: boolean;
  policyValid: boolean;
  /** The assigned identity's label as recorded in a valid policy. */
  policyIdentityLabel?: string;
  /**
   * Non-secret facts read straight off the valid, parsed lock policy —
   * `undefined` whenever `policyValid` is `false`. This IS the assignment
   * record (see `src/identity/assignment.ts`).
   */
  policySnapshot?: {
    lockId: string;
    assignedAt: number;
    identityId: string;
    identityLabel: string;
    expectedGitName?: string;
    expectedGitEmail: string;
    expectedGitHubLogin?: string;
    trustedSshHostAliases: string[];
    enforcedActions: ShieldAction[];
  };
  /** Set when the policy file is a legacy (v1/v2) "Shield Mode" policy — never enforced by this build, only migrated. */
  legacyPolicy?: LegacyPolicyInfo;
  evaluatorPath?: string;
  evaluatorPresent: boolean;
  evaluatorOwned: boolean;
  evaluatorVersion?: number;
  /** True when the evaluator's on-disk content doesn't match `evaluatorScriptSource`'s content — only ever computed when `inspect()` was given that path (see `ShieldInspectOptions`); `false`, never "unknown," when it wasn't. */
  evaluatorModified: boolean;
  /** True when `core.hooksPath` (any scope) is set to something other than Git's built-in default — informational context for why a governed hook might be missing from the resolved `hooksDir`, never itself a reason to block anything. */
  hooksPathCustomized: boolean;
  /**
   * True when the assigned identity's live definition (looked up by the
   * policy's `identityId` in `ShieldInspectOptions.currentIdentities`) no
   * longer matches what the installed policy enforces — e.g. its email or
   * GitHub login was edited in settings, or it was deleted. Enforcement
   * keeps using the recorded snapshot until the lock is repaired; this is
   * never silently "fine". Always `false` when `currentIdentities` wasn't
   * supplied.
   */
  identityDrift: boolean;
  /** Which fields drifted (or `"identity removed"`), in a stable order. Empty when `identityDrift` is false. */
  identityDriftDetails: string[];
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
  /**
   * True only when a Git version was actually PARSED and found to be below
   * Shield's floor — i.e. Shield positively identified an incompatible
   * Git, as opposed to merely failing to determine the version at all
   * (`git --version` erroring, an unparseable line, or `inspect()` itself
   * failing before it ever got that far). `gitVersionSupported` alone
   * conflates those two very different cases: both make it `false`, but
   * only the first one means the fixed "requires Git 2.31" UI messaging is
   * actually true. `false` here (with `gitVersionSupported` also `false`)
   * means "unknown," and the underlying `state` — degraded, broken,
   * whatever it genuinely is — must be shown as-is, not papered over with
   * an unrelated Git-version explanation.
   */
  gitVersionKnownUnsupported: boolean;
}

export interface ShieldOperationResult {
  ok: boolean;
  inspection: ShieldInspection;
  /**
   * Set by `enable()`/`repair()` with `requireComplete` when the operation
   * could not produce a fully active installation and therefore restored
   * the previous on-disk state (a first install is removed entirely; a
   * re-install puts back the exact prior bytes) — so a failed operation
   * never leaves a half-installed lock behind.
   */
  rolledBack?: boolean;
  /**
   * Non-fatal problems from an otherwise-successful operation (e.g. a stale
   * hook at a previous `core.hooksPath` location that could not be cleaned
   * up). Present only when there is something to say.
   */
  warnings?: string[];
}

export interface ShieldEnableInput {
  /** The identity to enforce. Must already be validated by the caller (`sanitizeIdentity`). */
  identity: Identity;
  /** Random id of this assignment — see `ShieldPolicy.lockId`. */
  lockId: string;
  /** When the assignment was made — see `ShieldPolicy.assignedAt`. */
  assignedAt: number;
  now?: number;
  /**
   * Explicit, never-default opt-in to chain a foreign hook already
   * occupying a slot the lock needs, instead of refusing. See the
   * class-level "Hook coexistence" doc comment. Defaults to `false`.
   */
  chainForeignHooks?: boolean;
  /**
   * All-or-nothing mode, used by every identity-lock operation:
   *  - preflight: if any hook slot is occupied by something that would be
   *    left untouched (a foreign hook without `chainForeignHooks`, a
   *    symlink, a non-executable file, a stale sidecar), refuse BEFORE
   *    writing anything;
   *  - verify: if the fresh post-install inspection is not `active`,
   *    restore the previous on-disk state and report `rolledBack`.
   * Without it, `enable()` keeps the partial-install behavior (writes what
   * it can and reports `degraded`) that the engine's own hardening tests
   * exercise.
   */
  requireComplete?: boolean;
}

export interface ShieldInspectOptions {
  /**
   * Absolute path to this extension's own bundled
   * `resources/shield/shield-evaluate.sh`. When supplied, `inspect()`
   * compares it byte-for-byte against the installed evaluator copy to
   * populate `evaluatorModified` — a modified-but-still-owned evaluator
   * (marker intact, body hand-edited) would otherwise be indistinguishable
   * from a genuine one. Omit to skip this check.
   */
  evaluatorScriptSource?: string;
  /**
   * The caller's current identity list (fresh from settings). When
   * supplied, the identity the policy was built from is looked up by id
   * and compared field by field, populating `identityDrift`. Omit to skip.
   */
  currentIdentities?: Identity[];
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
        ? "it is not executable, so Git never runs it — and chaining it would make the identity lock's own hook try to execute it on every operation, failing with a bare \"Permission denied\""
        : "it is not a regular file (e.g. a directory, socket, or device), which Repo Identity Guard has no faithful way to preserve or run";
  return `A ${fileName} hook already exists at ${hookPath} that Repo Identity Guard did not create, and Repo Identity Guard refused to chain it because ${detail}. It was left completely untouched and the identity lock's own ${fileName} hook was not installed here. Resolve it yourself (for a symlink: replace it with a regular executable script, or point core.hooksPath at a directory Repo Identity Guard can manage; for a non-executable file: make it executable or remove it), then try again.`;
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

function normalizeAliasList(aliases: string[] | undefined): string {
  return [...(aliases ?? [])].map((a) => a.trim().toLowerCase()).sort().join(",");
}

/**
 * Field-by-field comparison of the identity a policy was built from with
 * that identity's live definition. Order is the order drift is reported
 * in. Exact comparison on purpose: any edit to an enforced value means the
 * installed lock no longer enforces what settings say.
 */
export function identityDriftFields(policy: ShieldPolicy, live: Identity | undefined): string[] {
  if (!live) return ["identity removed"];
  const fields: string[] = [];
  if (live.label !== policy.identityLabel) fields.push("label");
  if ((live.gitName ?? "") !== (policy.expectedGitName ?? "")) fields.push("gitName");
  if (live.gitEmail !== policy.expectedGitEmail) fields.push("gitEmail");
  if ((live.expectedGitHubLogin ?? "") !== (policy.expectedGitHubLogin ?? "")) fields.push("expectedGitHubLogin");
  if (normalizeAliasList(live.trustedSshHostAliases) !== normalizeAliasList(policy.trustedSshHostAliases)) fields.push("trustedSshHostAliases");
  return fields;
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
  /**
   * Resolves the repo-facing paths Shield operates on, fresh, every call —
   * never cached across calls.
   *
   * `getGitDir`/`getGitCommonDir` are shared with the general (non-Shield)
   * facts collector and deliberately do NOT pass `--path-format=absolute`
   * to `git rev-parse` there, because that flag requires Git 2.31+ and
   * those functions still have to work below Shield's own version floor.
   * `getHooksDir` has no such constraint (it is Shield-only, already
   * gated behind the 2.31 floor) and does pass it, which makes `git`
   * canonicalize the result -- resolving a symlinked temp/home directory
   * (e.g. macOS's /var -> /private/var) the way `path.resolve` never
   * does. Left alone, that mismatch means `gitCommonDir` and `hooksDir`
   * can name the *same* real directory with two different strings, and
   * everything Shield derives from `gitCommonDir` (the storage dir, the
   * install record, the policy/evaluator paths) would silently disagree
   * with paths derived from `hooksDir`. `fs.realpath` here canonicalizes
   * `gitDir`/`gitCommonDir` the same way, without touching the shared,
   * older-Git-safe functions themselves.
   */
  async resolveGitContext(repoRoot: string): Promise<ShieldGitContext> {
    const [rawGitDir, rawGitCommonDir, hooksDir] = await Promise.all([
      getGitDir(repoRoot),
      getGitCommonDir(repoRoot),
      getHooksDir(repoRoot),
    ]);
    const [gitDir, gitCommonDir] = await Promise.all([
      rawGitDir ? await fs.realpath(rawGitDir).catch(() => rawGitDir) : rawGitDir,
      rawGitCommonDir ? await fs.realpath(rawGitCommonDir).catch(() => rawGitCommonDir) : rawGitCommonDir,
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
        identityDrift: false,
        identityDriftDetails: [],
        orphanedHookPaths: [],
        gitVersionSupported: false,
        // The Git version was never even read here — resolveGitContext
        // failed before that, for an unrelated reason. Unknown, not
        // positively unsupported.
        gitVersionKnownUnsupported: false,
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

    // Phase 9 / Part 10: is Shield's lifecycle tracking still intact for
    // the hooks that are live RIGHT HERE?
    //
    // Found by the lifecycle torture harness: corrupt (or delete) the
    // installation record while Shield is installed and `inspect()`
    // happily reported ACTIVE. A corrupt record reads as *absent* by
    // design (see installRecord.ts), and absent meant "no previous
    // locations to check" — so the one state the record exists to prevent,
    // "live Shield hooks nobody is keeping track of", was the one state it
    // could not report. Move `core.hooksPath` from there and Disable
    // Shield can no longer reach those hooks; move it back and they are
    // live again with no evaluator beside them.
    //
    // This is deliberately narrow: it only fires when a Shield-owned hook
    // actually exists at the CURRENT hooks directory and the record does
    // not name that directory. "Repair Shield" rewrites the record and
    // clears it. It also correctly catches a repository installed by a
    // Shield version that predates the record entirely.
    const installRecord = await readShieldInstallRecord(
      shieldInstallRecordFilePath(shieldStorageDir(gitContext.gitCommonDir)),
    );
    const installRecordCoversLiveHooks =
      !hooks.some((h) => h.ownership === "shield") ||
      (!!installRecord && installRecord.hookDirs.some((dir) => sameHookDir(dir, gitContext.hooksDir)));

    const reasons: string[] = [];
    let state: ShieldLifecycleState;

    const anyShieldArtifactPresent =
      policyRaw !== null ||
      evaluatorRaw !== null ||
      hooks.some((h) => h.ownership === "shield") ||
      orphanedHookPaths.length > 0;

    // Only a hook whose action this policy actually enforces matters for
    // "is the lock fully active" — a commit-only lock (no expected GitHub
    // login) must not report degraded over a missing or foreign pre-push
    // hook it does not need.
    const enforcedActions = policyResult?.ok ? policyResult.policy.enforcedActions : undefined;
    const governs = (h: ShieldHookInspection) => (enforcedActions ? enforcedActions.includes(h.action) : true);
    const missingGovernedHooks = hooks.filter((h) => h.ownership === "absent" && governs(h));
    const foreignHooks = hooks.filter((h) => h.ownership === "foreign" && governs(h));
    const outdatedOrIncompatibleHooks = hooks.filter(
      (h) => h.ownership === "shield" && (h.version === undefined || h.version !== SHIELD_ARTIFACT_VERSION),
    );
    const modifiedHooks = hooks.filter((h) => h.contentModified);

    let identityDrift = false;
    let identityDriftDetails: string[] = [];
    if (policyResult?.ok && options.currentIdentities) {
      const policy = policyResult.policy;
      identityDriftDetails = identityDriftFields(
        policy,
        options.currentIdentities.find((identity) => identity.id === policy.identityId),
      );
      identityDrift = identityDriftDetails.length > 0;
    }

    const hooksPathCustomized = !!coreHooksPath;
    const hooksPathNote = hooksPathCustomized
      ? ` ("core.hooksPath" is currently set to "${coreHooksPath}" — if that was changed after the lock was installed, this is why.)`
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
            ? `A ${hook.fileName} hook already exists at ${hook.path} that Repo Identity Guard did not create. It will not be overwritten or deleted — move it aside yourself, or re-assign the identity with hook chaining, then run "Repair Identity Lock".`
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
          `An identity-lock hook is still installed at ${orphan}, which is not the hooks directory Git currently uses${coreHooksPath ? ` ("core.hooksPath" is set to "${coreHooksPath}")` : ""}. It is inert ONLY while "core.hooksPath" points elsewhere -- it is not harmless, and it takes effect again the moment that setting changes back or is unset. Run "Repair Identity Lock" or "Unlock Current Repository" — both clean up previous installation locations.`,
        );
      }
    } else if (!policyResult) {
      state = "degraded";
      reasons.push('Identity-lock files are present but no policy file was found, so every commit and push is blocked. Run "Repair Identity Lock" or "Unlock Current Repository".');
    } else if (!policyResult.ok) {
      state = "broken";
      reasons.push(
        `The identity-lock policy file is invalid: ${policyResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}.`,
      );
    } else if (!evaluatorOwned) {
      state = "degraded";
      reasons.push(
        'The identity-lock evaluator copy is missing or was modified outside Repo Identity Guard. Run "Repair Identity Lock" to reinstall it.',
      );
    } else if (evaluatorModified) {
      state = "degraded";
      reasons.push('The identity-lock evaluator copy has been modified outside Repo Identity Guard. Run "Repair Identity Lock" to restore it.');
    } else if (evaluatorVersion === undefined || evaluatorVersion !== SHIELD_ARTIFACT_VERSION) {
      state = "degraded";
      reasons.push(
        evaluatorVersion !== undefined && evaluatorVersion > SHIELD_ARTIFACT_VERSION
          ? `The identity-lock evaluator copy is a newer version (v${evaluatorVersion}) than this build of the extension recognizes (v${SHIELD_ARTIFACT_VERSION}). Update the extension, then run "Repair Identity Lock."`
          : 'A newer identity-lock evaluator is available. Run "Repair Identity Lock" to update it.',
      );
    } else if (missingGovernedHooks.length > 0) {
      state = "degraded";
      for (const hook of missingGovernedHooks) {
        reasons.push(`The identity lock's ${hook.fileName} hook is missing. Run "Repair Identity Lock" to reinstall it.${hooksPathNote}`);
      }
    } else if (modifiedHooks.length > 0) {
      state = "degraded";
      for (const hook of modifiedHooks) {
        reasons.push(`The identity lock's ${hook.fileName} hook has been modified outside Repo Identity Guard. Run "Repair Identity Lock" to restore it.`);
      }
    } else if (outdatedOrIncompatibleHooks.length > 0) {
      state = "degraded";
      for (const hook of outdatedOrIncompatibleHooks) {
        reasons.push(
          hook.version !== undefined && hook.version > SHIELD_ARTIFACT_VERSION
            ? `The identity lock's ${hook.fileName} hook is a newer version (v${hook.version}) than this build of the extension recognizes (v${SHIELD_ARTIFACT_VERSION}). Update the extension, then run "Repair Identity Lock."`
            : `A newer identity-lock ${hook.fileName} hook is available. Run "Repair Identity Lock" to update it.`,
        );
      }
    } else if (!installRecordCoversLiveHooks) {
      state = "degraded";
      reasons.push(
        `The identity lock's hooks are installed at ${gitContext.hooksDir}, but its installation record does not name that directory (it is missing, unreadable, or corrupt). Enforcement is working right now, but if "core.hooksPath" is changed before the repository is unlocked, Unlock would not know to look here — and a lock hook left behind with no evaluator beside it blocks every commit and push. Run "Repair Identity Lock" to restore the record.`,
      );
    } else if (identityDrift) {
      state = "degraded";
      reasons.push(
        identityDriftDetails[0] === "identity removed"
          ? `The identity this repository is locked to ("${policyResult?.ok ? policyResult.policy.identityId : "?"}") no longer exists in settings. The lock keeps enforcing the identity recorded when it was installed until you assign another identity or unlock the repository.`
          : `The assigned identity was edited in settings since this lock was installed (${identityDriftDetails.join(", ")}), but the lock still enforces the previous values. Run "Repair Identity Lock" to apply the edit.`,
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
      policyIdentityLabel: policyResult?.ok ? policyResult.policy.identityLabel : undefined,
      policySnapshot: policyResult?.ok
        ? {
            lockId: policyResult.policy.lockId,
            assignedAt: policyResult.policy.assignedAt,
            identityId: policyResult.policy.identityId,
            identityLabel: policyResult.policy.identityLabel,
            expectedGitName: policyResult.policy.expectedGitName,
            expectedGitEmail: policyResult.policy.expectedGitEmail,
            expectedGitHubLogin: policyResult.policy.expectedGitHubLogin,
            trustedSshHostAliases: [...policyResult.policy.trustedSshHostAliases],
            enforcedActions: [...policyResult.policy.enforcedActions],
          }
        : undefined,
      legacyPolicy: policyRaw !== null && !policyResult?.ok ? readLegacyPolicyInfo(policyRaw) : undefined,
      evaluatorPath,
      evaluatorPresent: evaluatorRaw !== null,
      evaluatorOwned,
      evaluatorVersion,
      evaluatorModified,
      hooksPathCustomized,
      identityDrift,
      identityDriftDetails,
      orphanedHookPaths,
      gitVersionRaw: gitVersionRaw ?? undefined,
      gitVersionSupported: gitVersionSupport.supported,
      gitVersionKnownUnsupported: !gitVersionSupport.supported && gitVersionSupport.version !== undefined,
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
   * Installs (or re-installs) the identity lock for this repo: writes the
   * lock policy for `input.identity` and a fresh evaluator copy under this
   * repo's git-common-dir, then installs the pre-commit, pre-merge-commit
   * AND pre-push hook shims — each independently, and each only into an
   * empty hook slot, one the lock already owns, or (with
   * `input.chainForeignHooks: true`) one occupied by a foreign hook that
   * gets chained rather than replaced (see the class-level "Hook
   * coexistence" doc comment). A foreign hook is never touched when
   * `chainForeignHooks` is left unset/false.
   *
   * With `input.requireComplete` (what `IdentityLockService` always
   * passes) the operation is all-or-nothing: an occupied slot the lock
   * needs refuses the operation before anything is written, and a
   * post-install inspection that is not `active` restores the previous
   * on-disk state. Without it, a refused slot is skipped and the result is
   * reported `degraded` (the engine's original partial-install behavior).
   *
   * `evaluatorScriptSource` is the absolute path to this extension's own
   * bundled `resources/shield/shield-evaluate.sh` — passed in rather than
   * resolved here so this class stays free of any `vscode`/extension-path
   * dependency and stays directly testable.
   */
  async enable(repoRoot: string, evaluatorScriptSource: string, input: ShieldEnableInput): Promise<ShieldOperationResult> {
    const gitContext = await this.resolveGitContext(repoRoot).catch((error) => {
      throw new Error(`Cannot install the identity lock: ${toMessage(error)}`);
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
            `${gitVersionSupport.reason as string} The identity lock was not installed; nothing on disk was changed.`,
            ...inspection.reasons,
          ],
        },
      };
    }

    const policy: ShieldPolicy = buildShieldPolicy({
      identity: input.identity,
      lockId: input.lockId,
      assignedAt: input.assignedAt,
      now: input.now,
    });

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

    // ---- preflight (requireComplete): refuse before writing anything ----
    //
    // An identity lock must never be reported (or persisted) as assigned
    // while a hook it needs could not be installed. So in all-or-nothing
    // mode, any slot governing an ENFORCED action that would be skipped
    // (foreign hook without chaining, a symlink, a non-executable file, a
    // stale chained-original sidecar) refuses the whole operation up
    // front. A skipped slot for an action the lock does not enforce (the
    // pre-push slot of a commit-only lock) is fine: nothing is lost by
    // leaving a foreign hook there untouched.
    if (input.requireComplete) {
      const blockingSkips = hookWrites.filter((w) => w.mode === "skip" && policy.enforcedActions.includes(w.spec.action));
      if (blockingSkips.length > 0) {
        const refusals: string[] = [];
        for (const write of blockingSkips) {
          const kind = await classifyHookFile(write.hookPath);
          const sidecarKind = await classifyHookFile(chainedOriginalPath(write.hookPath));
          if (kind === "executable-regular" && sidecarKind !== "absent") {
            refusals.push(
              `A ${write.spec.fileName} hook exists at ${write.hookPath} and a previously chained original is still waiting at ${chainedOriginalPath(write.hookPath)}. Repo Identity Guard will not move another hook on top of it. Resolve which one you want to keep, then try again.`,
            );
          } else if (kind === "executable-regular") {
            refusals.push(
              `A ${write.spec.fileName} hook already exists at ${write.hookPath} that Repo Identity Guard did not create. It was left untouched. Assign the identity again with hook chaining (your hook keeps running after the identity check), or move it aside first.`,
            );
          } else {
            refusals.push(foreignHookRefusalReason(write.spec.fileName, write.hookPath, kind));
          }
        }
        const inspection = await this.inspect(repoRoot);
        return {
          ok: false,
          inspection: {
            ...inspection,
            reasons: [...refusals, "Nothing was written: the identity lock was not installed or changed.", ...inspection.reasons],
          },
        };
      }
    }

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
      metadataFailure = `The identity lock's storage directory (${storageDir}) could not be created: ${toMessage(error)}`;
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
        metadataFailure = `Repo Identity Guard could not durably record which hooks directory it installs into (${installRecordPath} is not writable)`;
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
        ? `${metadataFailure}. Lifecycle tracking could not be safely established, so this operation was ABORTED before touching anything: no hook was installed, moved, or removed, and the identity lock already present here is unchanged and still enforcing. Until this is resolved Repo Identity Guard cannot guarantee it can find and remove every hook it owns, so it is reported as needing attention. Fix the permissions on ${storageDir} and run "Repair Identity Lock" again.`
        : `${metadataFailure}. The identity lock was NOT installed: without that record Repo Identity Guard could not guarantee it would later be able to find and remove the hooks it installs, and a lock hook that Unlock cannot reach would block every commit and push in this repository. Nothing was installed and nothing was left behind. Fix the permissions on ${storageDir} and try again.`;
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
      await writeTracked(policyPath, serializeShieldPolicy(policy));
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
      if (input.requireComplete && !preExisting && rollbackFailures.length === 0) {
        // A failed FIRST install leaves nothing behind, not even the
        // install record / storage directory written in step 2.
        await this.disable(repoRoot).catch(() => undefined);
      }
      const inspection = await this.inspect(repoRoot);
      return {
        ok: false,
        rolledBack: rollbackFailures.length === 0,
        inspection: {
          ...inspection,
          state: inspection.state === "active" ? "degraded" : inspection.state,
          reasons: [
            `The identity lock could not finish installing: ${toMessage(error)}. ${
              rollbackFailures.length === 0
                ? "Everything this operation had written was rolled back to its previous contents; nothing Repo Identity Guard does not own was touched."
                : `Rolling back was itself incomplete (${rollbackFailures.join("; ")}) — run "Repair Identity Lock" or "Unlock Current Repository".`
            } The installation record still names every hooks directory involved, so Unlock can still reach them.`,
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

    // ---- verify (requireComplete): never leave a half-active lock ----
    if (input.requireComplete && inspection.state !== "active") {
      const rollbackFailures: string[] = [];
      if (preExisting) {
        // A re-install of an existing lock: put back the exact previous
        // bytes, so the lock that was there before keeps enforcing.
        for (const undo of [...undos].reverse()) {
          await undo().catch((rollbackError) => rollbackFailures.push(toMessage(rollbackError)));
        }
      } else {
        // A first install: remove everything (restoring any chained hook).
        await this.disable(repoRoot).catch((rollbackError) => rollbackFailures.push(toMessage(rollbackError)));
      }
      const after = await this.inspect(repoRoot);
      return {
        ok: false,
        rolledBack: rollbackFailures.length === 0,
        inspection: {
          ...after,
          reasons: [
            `The identity lock was installed but did not verify as fully active (${inspection.reasons.join(" ") || inspection.state}). ${
              rollbackFailures.length === 0
                ? preExisting
                  ? "The previous lock was restored exactly as it was."
                  : "Everything it installed was removed again."
                : `Restoring the previous state was itself incomplete (${rollbackFailures.join("; ")}).`
            }`,
            ...after.reasons,
          ],
        },
      };
    }

    return {
      ok: inspection.state === "active" && extraReasons.length === 0,
      inspection: extraReasons.length === 0 ? inspection : { ...inspection, reasons: [...extraReasons, ...inspection.reasons] },
      warnings: extraReasons.length > 0 ? extraReasons : undefined,
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
  ): Promise<{ reasons: string[]; stillPresentDirs: string[]; ownedHooksRemaining: string[] }> {
    const record = await readShieldInstallRecord(shieldInstallRecordFilePath(shieldStorageDir(gitContext.gitCommonDir)));
    if (!record) return { reasons: [], stillPresentDirs: [], ownedHooksRemaining: [] };

    const reasons: string[] = [];
    const stillPresentDirs: string[] = [];
    // Hooks that still carry the ownership marker after cleanup (an I/O
    // error prevented their removal). Unlike an unresolved chain (where the
    // slot is no longer ours), these can still fire if `core.hooksPath`
    // points back here — so `disable()` must not delete the evaluator and
    // policy they depend on while any remain.
    const ownedHooksRemaining: string[] = [];

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
              `A chained original hook at ${chainedOriginalPath(hookPath)} (from a previous installation location) could not be restored automatically because something other than Repo Identity Guard now occupies ${hookPath}. Resolve this manually — the original is preserved at that exact path.`,
            );
          }
        } catch (error) {
          leftovers = true;
          const bytes = await readBytesIfExists(hookPath).catch(() => null);
          if (bytes !== null && isOwnedBytes(bytes)) ownedHooksRemaining.push(hookPath);
          reasons.push(
            `Repo Identity Guard could not clean up its previously-installed hook at ${hookPath}: ${toMessage(error)}. That hook is inert while "core.hooksPath" points elsewhere, but must be removed (fix the permissions and run Unlock again, or delete it by hand).`,
          );
        }
      }
      if (leftovers) stillPresentDirs.push(dir);
    }

    return { reasons, stillPresentDirs, ownedHooksRemaining };
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

  /** Same mechanics as `enable` — exposed separately so callers can frame it as "repair" (re-sync an installed lock after an identity edit, an extension update, or a previously-blocking foreign hook being cleared) without implying a fresh assignment. */
  async repair(repoRoot: string, evaluatorScriptSource: string, input: ShieldEnableInput): Promise<ShieldOperationResult> {
    return this.enable(repoRoot, evaluatorScriptSource, input);
  }

  /**
   * Removes only what Shield itself owns: its pre-commit,
   * pre-merge-commit AND pre-push hooks (each re-verified as Shield's own
   * immediately before touching
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

    // Identity-lock hardening: if a hook the lock owns could NOT be
    // removed from a previous hooks directory, the policy and evaluator
    // are kept. Deleting them would (a) make the lock report "unassigned"
    // while a lock hook still exists, and (b) turn that leftover hook into
    // a fail-closed "broken installation" the moment `core.hooksPath`
    // points back at it. Keeping them leaves a coherent "unlock incomplete"
    // state that a later Unlock can finish.
    const storageDir = shieldStorageDir(gitContext.gitCommonDir);
    if (orphanCleanup.ownedHooksRemaining.length > 0) {
      await writeShieldInstallRecord(shieldInstallRecordFilePath(storageDir), orphanCleanup.stillPresentDirs, Date.now());
      const inspection = await this.inspect(repoRoot);
      return {
        ...inspection,
        reasons: [
          `Unlock is incomplete: ${orphanCleanup.ownedHooksRemaining.length} identity-lock hook(s) could not be removed (${orphanCleanup.ownedHooksRemaining.join(", ")}), so the lock policy was kept and this repository is still assigned.`,
          ...extraReasons,
          ...inspection.reasons,
        ],
      };
    }

    // Only now — with every hook the lock owns gone — are the artifacts the
    // hooks depend on removed.
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
        (p) => `A chained original hook at ${p} could not be restored automatically because something other than Repo Identity Guard now occupies its hook slot. Resolve this manually — the original is preserved at that exact path.`,
      ),
      ...inspection.reasons,
    ];
    return reasons.length === inspection.reasons.length ? inspection : { ...inspection, reasons };
  }

  /** Convenience wrapper over `inspect()` for a quick "is the lock actually working here" answer without the caller re-deriving it from `ShieldInspection.state` itself. */
  async healthCheck(repoRoot: string, options: ShieldInspectOptions = {}): Promise<{ healthy: boolean; state: ShieldLifecycleState; summary: string }> {
    const inspection = await this.inspect(repoRoot, options);
    const healthy = inspection.state === "active" && inspection.reasons.length === 0;
    const label = inspection.policyIdentityLabel ? ` (${inspection.policyIdentityLabel})` : "";
    const summary =
      inspection.state === "off"
        ? "No identity lock is installed in this repository."
        : inspection.state === "active"
          ? healthy
            ? `The identity lock is active${label}.`
            : `The identity lock is active${label}, but needs attention: ${inspection.reasons.join(" ")}`
          : inspection.state === "degraded"
            ? `The identity lock needs attention: ${inspection.reasons.join(" ")}`
            : `The identity lock is broken: ${inspection.reasons.join(" ")}`;
    return { healthy, state: inspection.state, summary };
  }
}
