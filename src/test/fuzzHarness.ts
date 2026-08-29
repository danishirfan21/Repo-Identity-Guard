import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shieldPolicyFilePath, shieldStorageDir } from "../shield/storage";

/**
 * Shared machinery for Shield's differential/fuzz test harnesses
 * (Parts 7, 8 and 9). Not itself a test file — `scripts/run-tests.js` only
 * picks up `*.test.js`, so this compiles alongside them and is imported.
 *
 * ## Why it exists
 *
 * Every one of those harnesses runs the SAME case through two
 * implementations that must never disagree: the pure TypeScript reference
 * (`src/shield/evaluator.ts`, `src/shield/policy.ts`,
 * `parseRemoteUrl`) and the actual shipped runtime artifact
 * (`resources/shield/shield-evaluate.sh`, run under real `sh` against a
 * real Git repository). Doing that thousands of times needs three things
 * this module provides:
 *
 *  1. **A deterministic RNG.** Every harness prints its seed, and re-running
 *     with `SHIELD_FUZZ_SEED=<seed>` reproduces the exact same case list.
 *     A fuzz failure nobody can reproduce is not a finding.
 *  2. **A repository pool.** `git init` per case would dominate the runtime.
 *     Instead a small pool of real repositories is created once and each
 *     worker drives its own, serially, so cases never clobber each other's
 *     policy file.
 *  3. **Process-free state control.** Per case, the repository's HEAD, its
 *     in-progress-operation markers, its configured identity, and its
 *     policy are all set by writing files — no `git checkout`, no
 *     `git config` subprocess — so a case costs exactly ONE spawn (the
 *     evaluator itself). `.git/HEAD` written as `ref: refs/heads/<name>` is
 *     precisely what `git symbolic-ref` does, and written as a raw object
 *     id is precisely a detached HEAD.
 */

// ==================== deterministic RNG ====================

/** Bounded, seeded, dependency-free PRNG (mulberry32). Same seed → same sequence, forever. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  /** A subset of `items`, each included with probability `p`, order preserved. */
  subset<T>(items: readonly T[], p?: number): T[];
}

export function rngFrom(seed: number): Rng {
  const next = makeRng(seed);
  const int = (maxExclusive: number) => Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    pick: (items) => items[int(items.length)],
    bool: (probability = 0.5) => next() < probability,
    subset: (items, p = 0.5) => items.filter(() => next() < p),
  };
}

/**
 * The seed a harness should use: `SHIELD_FUZZ_SEED` when set (to reproduce
 * a specific failure), otherwise a FIXED default so CI runs are
 * reproducible by default rather than flaky-by-design. Fuzzing with a
 * random seed every run turns a real bug into an intermittent one.
 */
export function fuzzSeed(fallback: number): number {
  const fromEnv = process.env.SHIELD_FUZZ_SEED;
  const parsed = fromEnv === undefined ? NaN : Number(fromEnv);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Case count for a harness, overridable with `SHIELD_FUZZ_CASES` (e.g. to run a much larger sweep locally). */
export function fuzzCaseCount(defaultCount: number): number {
  const parsed = Number(process.env.SHIELD_FUZZ_CASES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultCount;
}

// ==================== repository pool ====================

export interface FuzzRepo {
  dir: string;
  gitCommonDir: string;
  /** A real object id in this repository, usable as a detached HEAD value. */
  headSha: string;
  /** Isolated per-repo global gitconfig path — lets a case set the CONFIGURED identity by writing one file. */
  globalConfigPath: string;
  env: NodeJS.ProcessEnv;
}

const POOL_SIZE_DEFAULT = Math.max(2, Math.min(8, os.cpus().length * 2));

export function fuzzPoolSize(): number {
  const parsed = Number(process.env.SHIELD_FUZZ_WORKERS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : POOL_SIZE_DEFAULT;
}

/**
 * Creates `count` independent real Git repositories, each fully isolated
 * from the machine's real Git configuration (its own GIT_CONFIG_GLOBAL and
 * GIT_CONFIG_SYSTEM), each with one commit so a detached HEAD is
 * expressible.
 */
export async function createRepoPool(count: number): Promise<FuzzRepo[]> {
  const repos: FuzzRepo[] = [];
  for (let i = 0; i < count; i++) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fuzz-"));
    const globalConfigPath = path.join(dir, "gitconfig-global");
    const systemConfigPath = path.join(dir, "gitconfig-system");
    await fs.writeFile(globalConfigPath, "[user]\n\tname = Baseline\n\temail = baseline@example.com\n");
    await fs.writeFile(systemConfigPath, "");
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath, GIT_CONFIG_SYSTEM: systemConfigPath };
    // Anything that could leak the host machine's identity or SSH transport
    // into a case must be removed, or a case's expected facts and the
    // shell's observed facts would disagree for reasons unrelated to Shield.
    for (const key of ["EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_PARAMETERS"]) {
      delete env[key];
    }
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
    await fs.writeFile(path.join(dir, "f.txt"), "hello\n");
    execFileSync("git", ["add", "f.txt"], { cwd: dir, env });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
    const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      env,
      encoding: "utf8",
    }).trim();
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env, encoding: "utf8" }).trim();
    await fs.mkdir(shieldStorageDir(gitCommonDir), { recursive: true });
    repos.push({ dir, gitCommonDir, headSha, globalConfigPath, env });
  }
  return repos;
}

export async function destroyRepoPool(repos: FuzzRepo[]): Promise<void> {
  await Promise.all(repos.map((repo) => fs.rm(repo.dir, { recursive: true, force: true }).catch(() => undefined)));
}

/**
 * Runs `worker` over every case, with `repos.length` cases in flight at a
 * time and each worker pinned to its own repository — so two cases can
 * never race on the same policy file or HEAD.
 */
export async function mapWithRepos<C, R>(
  repos: FuzzRepo[],
  cases: readonly C[],
  worker: (repo: FuzzRepo, testCase: C, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(cases.length);
  let cursor = 0;
  await Promise.all(
    repos.map(async (repo) => {
      for (;;) {
        const index = cursor++;
        if (index >= cases.length) return;
        results[index] = await worker(repo, cases[index], index);
      }
    }),
  );
  return results;
}

// ==================== per-case state, written not spawned ====================

export async function writeRawPolicy(repo: FuzzRepo, raw: string): Promise<void> {
  await fs.writeFile(shieldPolicyFilePath(repo.gitCommonDir), raw);
}

export async function deletePolicy(repo: FuzzRepo): Promise<void> {
  await fs.rm(shieldPolicyFilePath(repo.gitCommonDir), { force: true });
}

/** Sets the CONFIGURED (`git config`) identity a case should see, by rewriting this repo's isolated global config. */
export async function setConfiguredIdentity(repo: FuzzRepo, name: string | undefined, email: string | undefined): Promise<void> {
  const lines = ["[user]"];
  if (name !== undefined) lines.push(`\tname = ${name}`);
  if (email !== undefined) lines.push(`\temail = ${email}`);
  await fs.writeFile(repo.globalConfigPath, `${lines.join("\n")}\n`);
}

/** Points HEAD at `branch` — byte-identical to what `git symbolic-ref HEAD refs/heads/<branch>` writes. */
export async function setHeadBranch(repo: FuzzRepo, branch: string): Promise<void> {
  await fs.writeFile(path.join(repo.gitCommonDir, "HEAD"), `ref: refs/heads/${branch}\n`);
}

/** Detaches HEAD onto this repository's real commit — byte-identical to what `git checkout --detach` writes. */
export async function setHeadDetached(repo: FuzzRepo): Promise<void> {
  await fs.writeFile(path.join(repo.gitCommonDir, "HEAD"), `${repo.headSha}\n`);
}

export type InProgressMarker = "merge" | "rebase-merge" | "rebase-apply" | "cherry-pick" | "revert" | undefined;

/** Sets exactly one in-progress-operation marker (or none), clearing all the others first. */
export async function setInProgressMarker(repo: FuzzRepo, marker: InProgressMarker): Promise<void> {
  const dir = repo.gitCommonDir;
  await Promise.all([
    fs.rm(path.join(dir, "MERGE_HEAD"), { force: true }),
    fs.rm(path.join(dir, "CHERRY_PICK_HEAD"), { force: true }),
    fs.rm(path.join(dir, "REVERT_HEAD"), { force: true }),
    fs.rm(path.join(dir, "rebase-merge"), { recursive: true, force: true }),
    fs.rm(path.join(dir, "rebase-apply"), { recursive: true, force: true }),
  ]);
  if (marker === undefined) return;
  if (marker === "merge") await fs.writeFile(path.join(dir, "MERGE_HEAD"), `${repo.headSha}\n`);
  else if (marker === "cherry-pick") await fs.writeFile(path.join(dir, "CHERRY_PICK_HEAD"), `${repo.headSha}\n`);
  else if (marker === "revert") await fs.writeFile(path.join(dir, "REVERT_HEAD"), `${repo.headSha}\n`);
  else await fs.mkdir(path.join(dir, marker), { recursive: true });
}

// ==================== running the real shipped evaluator ====================

export const EVALUATOR_SCRIPT_PATH = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

export interface EvaluatorResult {
  code: number;
  stderr: string;
  /** Every `Shield: [<id>] …` reason id the evaluator emitted, in order. */
  reasonIds: string[];
  allowed: boolean;
}

const REASON_LINE = /^Shield: \[([a-z-]+)\]/gm;

export function runEvaluator(
  repo: FuzzRepo,
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<EvaluatorResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "sh",
      [EVALUATOR_SCRIPT_PATH, ...args],
      { cwd: repo.dir, encoding: "utf8", env: options.env ?? repo.env, maxBuffer: 8 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        const reasonIds: string[] = [];
        REASON_LINE.lastIndex = 0;
        for (let match = REASON_LINE.exec(stderr); match !== null; match = REASON_LINE.exec(stderr)) {
          reasonIds.push(match[1]);
        }
        resolve({ code, stderr, reasonIds, allowed: code === 0 });
      },
    );
    child.stdin?.end(options.stdin ?? "");
  });
}
