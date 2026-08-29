/**
 * Shield's own minimum Git version, and the pure parsing/comparison
 * helpers behind it.
 *
 * ## Why Shield has a floor of its own (Phase 8 finding)
 *
 * docs/SHIELD_MODE.md previously claimed Shield's minimum supported Git
 * version was **2.9** (when `core.hooksPath` was introduced). That was
 * wrong on two independent counts, both verifiable from Git's own release
 * history rather than from anything about this extension:
 *
 * 1. **`git rev-parse --path-format=absolute` was added in Git 2.31.**
 *    Both installed hook shims *and* the standalone evaluator resolve the
 *    repository with `git rev-parse --path-format=absolute
 *    --git-common-dir`. On Git < 2.31 that invocation simply fails. Under
 *    the old fail-open shims that meant every hook silently exited 0 —
 *    Shield reporting ACTIVE while enforcing nothing at all. (The v5 shims
 *    fail closed instead, which is safe but useless: on such a Git,
 *    Shield can only ever block.)
 * 2. **`pre-merge-commit` was added in Git 2.24.** Commit enforcement for
 *    real (non-fast-forward) merge commits depends entirely on that hook —
 *    `git merge` does not run `pre-commit` for the merge commit it
 *    creates. On Git < 2.24, `git merge --no-ff` is simply not covered.
 *
 * 2.31 subsumes 2.24, so **2.31.0 is Shield's single floor**, and the
 * rule is: *Shield never reports ACTIVE on a Git that cannot run the
 * hooks Shield claims to enforce.* Below the floor, `inspect()` reports
 * `degraded` with the specific missing coverage spelled out, and
 * `enable()`/`repair()` refuse rather than writing artifacts that would
 * only ever block.
 *
 * This is deliberately **Shield-specific** and does not change the
 * extension's overall VS Code engine requirement or the Git version the
 * non-Shield sidebar/status engine works against — everything outside
 * Shield uses long-established plumbing (`rev-parse --git-dir`, `config`,
 * `status --porcelain=v2`, `var`, `symbolic-ref`) that predates 2.9.
 */

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** The raw `git --version` line this was parsed from, for diagnostics. */
  raw: string;
}

/**
 * Shield's minimum supported Git version. See this module's doc comment
 * for the empirical basis of each component.
 */
export const SHIELD_MIN_GIT_VERSION: Readonly<{ major: number; minor: number; patch: number }> = {
  major: 2,
  minor: 31,
  patch: 0,
};

export const SHIELD_MIN_GIT_VERSION_DISPLAY = `${SHIELD_MIN_GIT_VERSION.major}.${SHIELD_MIN_GIT_VERSION.minor}.${SHIELD_MIN_GIT_VERSION.patch}`;

/** Git version at which `pre-merge-commit` became available — merge-commit coverage. Informational: subsumed by {@link SHIELD_MIN_GIT_VERSION}. */
export const GIT_VERSION_PRE_MERGE_COMMIT_DISPLAY = "2.24";
/** Git version at which `rev-parse --path-format` became available — the binding constraint. */
export const GIT_VERSION_PATH_FORMAT_DISPLAY = "2.31";

/**
 * Parses the first three numeric components out of a `git --version`
 * line. Tolerates every vendor suffix shape seen in the wild —
 * `git version 2.39.5 (Apple Git-154)`, `git version 2.45.1.windows.1`,
 * `git version 2.43.0` — by reading only the leading `N[.N[.N]]` run and
 * ignoring everything after it. Returns `undefined` when no version can
 * be read at all; a caller must treat that as "unknown", never as
 * "new enough".
 */
export function parseGitVersion(raw: string): GitVersion | undefined {
  const match = /(?:^|\s)(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.replace(/^git version\s*/i, " "));
  if (!match) return undefined;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return undefined;
  return {
    major,
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
    raw: raw.trim(),
  };
}

/** -1 / 0 / 1, comparing major, then minor, then patch. */
export function compareGitVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export interface GitVersionSupport {
  /** True only when a version was actually read AND it is >= the floor. Unknown is never "supported". */
  supported: boolean;
  version?: GitVersion;
  /** A precise, user-facing explanation of what Shield cannot enforce here. Empty when `supported`. */
  reason?: string;
}

/**
 * Decides whether a Git version can support Shield, and — when it can't —
 * says exactly which enforcement is missing rather than a bare "too old".
 * An unreadable/unparseable version is deliberately NOT treated as
 * supported: Shield must never claim ACTIVE on a Git it could not
 * identify.
 */
export function evaluateGitVersionSupport(raw: string | undefined | null): GitVersionSupport {
  const version = raw ? parseGitVersion(raw) : undefined;
  if (!version) {
    return {
      supported: false,
      reason: `Shield could not determine this machine's Git version ("git --version" produced ${raw ? `an unrecognized line: ${JSON.stringify(raw.trim())}` : "no output"}), so it cannot confirm that the hooks it installs are supported here. Shield requires Git ${SHIELD_MIN_GIT_VERSION_DISPLAY} or newer.`,
    };
  }
  if (compareGitVersions(version, SHIELD_MIN_GIT_VERSION) < 0) {
    const missing: string[] = [];
    if (compareGitVersions(version, { major: 2, minor: 31, patch: 0 }) < 0) {
      missing.push(
        `"git rev-parse --path-format" (Git ${GIT_VERSION_PATH_FORMAT_DISPLAY}+), which every Shield hook and the standalone evaluator use to locate this repository's policy — without it Shield cannot evaluate anything at all`,
      );
    }
    if (compareGitVersions(version, { major: 2, minor: 24, patch: 0 }) < 0) {
      missing.push(
        `the "pre-merge-commit" hook (Git ${GIT_VERSION_PRE_MERGE_COMMIT_DISPLAY}+), without which a real merge commit ("git merge --no-ff") is never checked for identity at all`,
      );
    }
    return {
      supported: false,
      version,
      reason: `Shield requires Git ${SHIELD_MIN_GIT_VERSION_DISPLAY} or newer; this machine has ${version.major}.${version.minor}.${version.patch}. Missing: ${missing.join("; ")}.`,
    };
  }
  return { supported: true, version };
}
