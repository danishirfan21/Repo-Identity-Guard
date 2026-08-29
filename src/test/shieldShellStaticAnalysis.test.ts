import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { buildPreCommitHookScript, buildPrePushHookScript } from "../shield/artifacts";

/**
 * PART 12 — static analysis of every shell script Shield ships or writes.
 *
 * Shield's enforcement is shell. A syntax error or a bashism in the
 * evaluator or in a generated hook does not fail loudly at build time — it
 * fails at `git commit` time, on someone else's machine, with `/bin/sh`
 * pointing at dash or BusyBox ash rather than the bash the author happened
 * to have. Under v5 fail-CLOSED shims that is not a cosmetic failure: it
 * blocks every commit and push in the repository.
 *
 * Two independent checks, over the shipped evaluator AND a freshly-built
 * sample of each generated hook type (pre-commit, pre-merge-commit,
 * pre-push):
 *
 *  - `sh -n` — the actual `/bin/sh` on this machine parses the script.
 *    Always run; there is no excuse for shipping something the local shell
 *    cannot even parse.
 *  - `shellcheck -s sh` — POSIX-shell mode, so a bashism is an ERROR
 *    rather than being silently accepted. Skipped (not failed) when
 *    ShellCheck is not installed, since it is a developer/CI tool and not
 *    a runtime dependency of the extension; the `sh -n` check still runs
 *    in that case.
 *
 * Warnings are reviewed rather than blanket-suppressed. The evaluator
 * carries exactly one narrow `# shellcheck disable=` directive, with its
 * reason written next to it (SC2034 on `REMOTE_NAME`, kept as the
 * executable documentation of Git's pre-push positional contract).
 */

const execFileAsync = promisify(execFile);
const EVALUATOR_PATH = path.join(__dirname, "..", "..", "resources", "shield", "shield-evaluate.sh");

interface Script {
  name: string;
  source: string;
}

async function generatedScripts(): Promise<Script[]> {
  return [
    { name: "shield-evaluate.sh", source: await fs.readFile(EVALUATOR_PATH, "utf8") },
    { name: "pre-commit", source: buildPreCommitHookScript() },
    // pre-merge-commit is built from the same builder as pre-commit (see
    // HOOK_SPECS in manager.ts) — checked separately anyway, so a future
    // split into its own builder cannot silently escape analysis.
    { name: "pre-merge-commit", source: buildPreCommitHookScript() },
    { name: "pre-push", source: buildPrePushHookScript() },
  ];
}

async function haveShellCheck(): Promise<boolean> {
  try {
    await execFileAsync("shellcheck", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const SKIP_ON_WINDOWS =
  process.platform === "win32"
    ? "POSIX `sh` and ShellCheck are not part of a standard windows-latest image; the same scripts are analyzed on the ubuntu and macos legs of the matrix, and Git for Windows runs them under its own bundled sh."
    : false;

test("PART 12 — every shipped and generated Shield script parses under the real /bin/sh", { skip: SKIP_ON_WINDOWS }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-shellcheck-"));
  try {
    for (const script of await generatedScripts()) {
      const file = path.join(dir, script.name);
      await fs.writeFile(file, script.source);
      await execFileAsync("sh", ["-n", file]).catch((error) => {
        assert.fail(`sh -n rejected ${script.name}:\n${(error as { stderr?: string }).stderr ?? String(error)}`);
      });
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 12 — ShellCheck (POSIX sh mode) reports nothing on the evaluator or any generated hook", { skip: SKIP_ON_WINDOWS }, async (t) => {
  if (!(await haveShellCheck())) {
    t.skip("shellcheck is not installed on this machine (it is a developer/CI tool, not a runtime dependency)");
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-shellcheck-"));
  try {
    const problems: string[] = [];
    for (const script of await generatedScripts()) {
      const file = path.join(dir, script.name);
      await fs.writeFile(file, script.source);
      try {
        // `-s sh` forces POSIX-shell mode, which is what makes a bashism an
        // error here rather than an accepted convenience.
        await execFileAsync("shellcheck", ["-s", "sh", file]);
      } catch (error) {
        problems.push(`${script.name}:\n${(error as { stdout?: string }).stdout ?? String(error)}`);
      }
    }
    assert.equal(problems.length, 0, `ShellCheck reported problems:\n\n${problems.join("\n\n")}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 12 — the target is POSIX sh, not bash: no bashism appears in any shipped or generated script", async () => {
  // A second, independent net, so this still catches the most common
  // bashisms on a machine with no ShellCheck installed. Comments are
  // stripped first so prose describing a bashism does not trip it.
  const patterns: Array<[RegExp, string]> = [
    [/\[\[\s/, "[[ ... ]] test (bash/ksh only)"],
    // Anchored to STATEMENT position (line start, or after ; { && ||), not
    // "anywhere on the line": the hook scripts print prose that legitimately
    // contains words like "any other local user", and a bare /\slocal\s/
    // matched inside that quoted message. ShellCheck parses the quoting
    // properly and covers the real cases; this net only has to be
    // conservative enough not to cry wolf.
    [/(?:^|[;{]|&&|\|\|)[ \t]*local[ \t]/m, "`local` (not in POSIX sh)"],
    [/(?:^|[;{]|&&|\|\|)[ \t]*declare[ \t]/m, "`declare`"],
    [/(?:^|[;{]|&&|\|\|)[ \t]*source[ \t]/m, "`source` (use `.`)"],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\}/, "array subscript"],
    [/\$\(\(.*\+\+.*\)\)/, "++ inside arithmetic expansion"],
    [/(?:^|[;{]|&&|\|\|)[ \t]*echo[ \t]+-[eEn]\b/m, "`echo -e`/`-n`/`-E` (not portable; use printf)"],
    // NOTE: the bash `function` keyword is deliberately NOT in this list.
    // The evaluator embeds a recursive-descent JSON parser written in awk,
    // where `function name(args)` is correct and required awk syntax, and a
    // plain-text scan cannot tell that apart from shell. ShellCheck itself
    // understands the quoting and would flag a real shell `function`
    // keyword, so that case is covered properly by the test above rather
    // than approximately here.
    [/&>/, "`&>` redirection"],
    [/=~/, "`=~` regex match operator"],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?\}/, "${var^^} case conversion"],
    [/\$\{[A-Za-z_][A-Za-z0-9_]*,,?\}/, "${var,,} case conversion"],
    [/<<</, "here-string"],
    [/(?:^|[;{]|&&|\|\|)[ \t]*(?:mapfile|readarray)[ \t]/m, "mapfile/readarray"],
  ];
  for (const script of await generatedScripts()) {
    const code = script.source
      .split("\n")
      .map((line) => (/^\s*#/.test(line) ? "" : line))
      .join("\n");
    for (const [pattern, description] of patterns) {
      assert.doesNotMatch(code, pattern, `${script.name} contains a bashism: ${description}`);
    }
    assert.match(script.source.split("\n")[0], /^#!\/bin\/sh$/, `${script.name} must declare #!/bin/sh`);
  }
});

test("PART 12 — every ShellCheck suppression in the evaluator is narrow and carries a written reason", async () => {
  const source = await fs.readFile(EVALUATOR_PATH, "utf8");
  const lines = source.split("\n");
  const directives = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /#\s*shellcheck\s+disable=/.test(line));

  for (const { line, index } of directives) {
    // Narrow: a specific code, never a bare `disable=all` or a file-level
    // directive at the top of the script.
    assert.match(line, /disable=SC\d+/, `non-specific ShellCheck suppression: ${line.trim()}`);
    assert.doesNotMatch(line, /disable=all/, `blanket ShellCheck suppression: ${line.trim()}`);
    assert.ok(index > 5, "a file-level ShellCheck suppression would disable the check for the whole script");
    // Documented: the line immediately after it must be a comment
    // explaining why, not the suppressed statement itself.
    assert.match(
      lines[index + 1] ?? "",
      /^\s*#/,
      `ShellCheck suppression on line ${index + 1} has no written reason beneath it: ${line.trim()}`,
    );
  }
});
