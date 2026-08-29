import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

/**
 * Shield's durable, minimal record of **where it installed hooks**.
 *
 * ## Why this exists (Phase 8 finding — "orphaned hooks")
 *
 * Shield resolves its hooks directory fresh on every call, via `git
 * rev-parse --git-path hooks`. That is the right answer to "where does
 * Git look for hooks *right now*", and it is deliberately still the only
 * thing that decides where Shield *installs*. But it is the wrong — and,
 * before this record existed, the only — answer to "where did Shield
 * previously put its hooks", because `core.hooksPath` can change after an
 * install:
 *
 * 1. Enable Shield while `core.hooksPath` is unset → hooks land in
 *    `<gitCommonDir>/hooks` (call it A).
 * 2. Set `core.hooksPath` to some other directory B.
 * 3. Disable Shield. `disable()` looks only at B, finds nothing of its
 *    own, and removes the policy + evaluator.
 * 4. Shield's `pre-commit`/`pre-merge-commit`/`pre-push` shims are still
 *    sitting in A, orphaned. Point `core.hooksPath` back at A (or unset
 *    it) and they are live again.
 *
 * Empirically reproduced before this module was written. Under the v4
 * fail-*open* shims that produced silent non-enforcement; under the v5
 * fail-*closed* shims (see `artifacts.ts`) it would be far worse — every
 * commit and push permanently blocked with no Shield installed to repair
 * or disable. Fail-closed enforcement is only safe if disable is
 * *complete*, and disable can only be complete if Shield remembers where
 * it wrote.
 *
 * ## Deliberate constraints
 *
 * - **Under Git metadata, never the working tree.** It lives at
 *   `<gitCommonDir>/repo-identity-guard/installations.json`, alongside the
 *   policy and evaluator copy, so it is never a tracked file, never
 *   committed, never pushed, and is shared by (and identical from) every
 *   worktree of the repository — the same worktree-portability argument
 *   `src/shield/storage.ts` makes for the policy itself.
 * - **No secrets, ever.** Absolute filesystem paths to hook directories
 *   and a timestamp. Nothing else is permitted by the shape, and
 *   `writeShieldInstallRecord` rejects anything else.
 * - **Written atomically** (temp file in the same directory + rename), so
 *   an interrupted write can never leave a truncated record.
 * - **Never authoritative for enforcement.** Shield's lifecycle state is
 *   still re-derived from what is actually on disk (see `ShieldManager`'s
 *   "Lifecycle state is always re-derived, never cached"). This record is
 *   *only* a list of extra places to go look; every hook path it names is
 *   still independently re-verified as Shield-owned (by marker) before
 *   Shield will touch it. A tampered or stale record can therefore only
 *   ever cause Shield to look somewhere useless — never to delete a file
 *   it cannot prove it owns.
 * - **Best-effort by design.** A missing, unreadable, or malformed record
 *   is not an error and never blocks enable/disable/repair; it just means
 *   Shield knows about fewer previous locations. Failing an install
 *   because a bookkeeping file could not be parsed would be strictly
 *   worse than proceeding with the currently-resolved hooks directory.
 */

const INSTALL_RECORD_FILE_NAME = "installations.json";

/** Bumped if the record's shape changes incompatibly. An unrecognized version reads as "no record" — never as a partially-understood one. */
export const SHIELD_INSTALL_RECORD_VERSION = 1 as const;

export interface ShieldInstallRecord {
  recordVersion: typeof SHIELD_INSTALL_RECORD_VERSION;
  /**
   * Every absolute hooks directory Shield has installed into for this
   * repository and not yet verifiably cleaned up, most recent last.
   * Retained (not replaced) across installs precisely so a location that
   * fell out of `core.hooksPath` is still reachable by `disable()`.
   */
  hookDirs: string[];
  /** Epoch milliseconds of the last write — diagnostics only, never compared for freshness. */
  updatedAt: number;
}

/** `<gitCommonDir>/repo-identity-guard/installations.json` — see this module's doc comment. */
export function shieldInstallRecordFilePath(shieldStorageDirAbsolute: string): string {
  return path.join(shieldStorageDirAbsolute, INSTALL_RECORD_FILE_NAME);
}

/**
 * Normalizes a hooks-directory list: absolute, resolved, de-duplicated
 * (case-sensitively on POSIX, case-insensitively on Windows, matching how
 * each platform actually resolves the same directory), order-preserving.
 */
export function normalizeHookDirs(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== "string" || dir.trim().length === 0) continue;
    const resolved = path.resolve(dir);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/** True when two hook-directory paths name the same directory, using the same platform rules as {@link normalizeHookDirs}. */
export function sameHookDir(a: string, b: string): boolean {
  const [ra, rb] = [path.resolve(a), path.resolve(b)];
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Parses a raw record file. Returns `undefined` for anything that isn't a
 * record of exactly the recognized shape and version — a corrupt record
 * is treated as absent, never as partially trustworthy, and never as an
 * error worth failing an operation over. Any non-string or non-absolute
 * entry is dropped rather than accepted, so a hand-edited record can't
 * point Shield at a relative/cwd-dependent path.
 */
export function parseShieldInstallRecord(raw: string): ShieldInstallRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const v = parsed as Record<string, unknown>;
  if (v.recordVersion !== SHIELD_INSTALL_RECORD_VERSION) return undefined;
  if (!Array.isArray(v.hookDirs)) return undefined;
  const hookDirs = normalizeHookDirs(
    v.hookDirs.filter((d): d is string => typeof d === "string" && path.isAbsolute(d)),
  );
  const updatedAt = typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
  return { recordVersion: SHIELD_INSTALL_RECORD_VERSION, hookDirs, updatedAt };
}

export function serializeShieldInstallRecord(record: ShieldInstallRecord): string {
  return `${JSON.stringify(
    { recordVersion: SHIELD_INSTALL_RECORD_VERSION, hookDirs: normalizeHookDirs(record.hookDirs), updatedAt: record.updatedAt },
    null,
    2,
  )}\n`;
}

/** Reads the record if present and well-formed; `undefined` for absent/unreadable/corrupt (all equivalent — see this module's doc comment). */
export async function readShieldInstallRecord(recordPath: string): Promise<ShieldInstallRecord | undefined> {
  try {
    return parseShieldInstallRecord(await fs.readFile(recordPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Writes the record atomically (same-directory temp file + rename, so the
 * rename is guaranteed to be on the same filesystem and therefore atomic).
 * Never throws: a bookkeeping write failing must not fail an otherwise
 * successful enable/repair. Returns whether the write landed, so a caller
 * that wants to report reduced cleanup coverage can.
 */
export async function writeShieldInstallRecord(recordPath: string, hookDirs: readonly string[], now: number): Promise<boolean> {
  const content = serializeShieldInstallRecord({
    recordVersion: SHIELD_INSTALL_RECORD_VERSION,
    hookDirs: normalizeHookDirs(hookDirs),
    updatedAt: now,
  });
  const dir = path.dirname(recordPath);
  const tempPath = path.join(dir, `.${INSTALL_RECORD_FILE_NAME}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, recordPath);
    return true;
  } catch {
    await fs.unlink(tempPath).catch(() => undefined);
    return false;
  }
}
