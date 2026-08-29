import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { ShieldManager } from "../shield/manager";
import { Profile, RepoFacts } from "../types";

/**
 * PART 11 — package a real VSIX and inspect what is actually inside it.
 *
 * Shield is the reason this matters more than usual. `src/extension.ts`
 * resolves its evaluator as
 * `path.join(context.extensionPath, "resources", "shield",
 * "shield-evaluate.sh")` and copies it into every repository Shield
 * guards. A `.vscodeignore` rule that swallowed `resources/**` would
 * produce an extension that compiles, tests green, installs cleanly, and
 * then fails at the exact moment a user turns Shield on — on a machine
 * that has no way to get the missing file back.
 *
 * So this builds a real VSIX with the real `@vscode/vsce`, extracts it, and
 * checks both directions:
 *
 *  - everything Shield and the UI need IS there;
 *  - nothing that should not ship IS there (sources, compiled tests, source
 *    maps, .git, node_modules, temp test repositories, env files, keys).
 *
 * Then it runs a genuine smoke test: the extracted `extension/` directory
 * is treated as `extensionPath` and handed to the real `ShieldManager`,
 * which must be able to enable Shield in a real repository from it. That is
 * the only check that proves the packaged evaluator is not merely present
 * but readable and usable the way the extension uses it.
 *
 * `vsce package` is a build step, not a runtime dependency, and it needs
 * network-free local `node_modules`. When it is unavailable the test SKIPS
 * with the reason rather than failing — but the `.vscodeignore` contract
 * itself is additionally asserted by a second, dependency-free test below,
 * so the most dangerous regression (excluding `resources/**`) is caught
 * either way.
 */

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, "..", "..");

interface Packaged {
  extensionDir: string;
  files: string[];
}

async function packageVsix(workDir: string): Promise<Packaged | undefined> {
  const vsixPath = path.join(workDir, "test-package.vsix");
  try {
    await execFileAsync(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules", "@vscode", "vsce", "vsce"),
        "package",
        "--no-dependencies",
        "--allow-missing-repository",
        "-o",
        vsixPath,
      ],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return undefined;
  }

  // Extract without shelling out to `unzip` (absent on many images): the
  // VSIX is an ordinary zip, and its central directory is enough to list
  // and read entries with Node alone.
  const extractDir = path.join(workDir, "extracted");
  await fs.mkdir(extractDir, { recursive: true });
  await extractZip(vsixPath, extractDir);

  const files: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  await walk(extractDir, "");
  return { extensionDir: path.join(extractDir, "extension"), files };
}

/** Minimal zip reader — enough for a VSIX (stored or deflated entries, no encryption, no zip64). */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const zlib = await import("node:zlib");
  const inflateRaw = promisify(zlib.inflateRaw);
  const buffer = await fs.readFile(zipPath);

  // Locate the end-of-central-directory record by scanning backwards.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "the packaged VSIX has no zip end-of-central-directory record");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "malformed zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? raw : await inflateRaw(raw);

    // Zip-slip guard: never write outside destDir, whatever the archive says.
    const target = path.join(destDir, decodeURIComponent(name));
    const resolved = path.resolve(target);
    assert.ok(resolved.startsWith(path.resolve(destDir) + path.sep), `zip entry escapes the extraction directory: ${name}`);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content);
  }
}

test("PART 11 — the packaged VSIX contains everything Shield and the UI need, and nothing that should not ship", { timeout: 600_000 }, async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-vsix-"));
  try {
    const packaged = await packageVsix(workDir);
    if (!packaged) {
      t.skip("@vscode/vsce could not run here (it is a build tool, not a runtime dependency); the .vscodeignore contract is still asserted by the next test");
      return;
    }
    const { files } = packaged;

    // ---- must be present ----
    const required = [
      // THE Shield file. Its absence would make "Enable Shield" fail at the
      // point of use, with no way for the user to recover it.
      "extension/resources/shield/shield-evaluate.sh",
      // Compiled extension entry point + the Shield implementation.
      "extension/out/extension.js",
      "extension/out/shield/manager.js",
      "extension/out/shield/evaluator.js",
      "extension/out/shield/policy.js",
      "extension/out/shield/installRecord.js",
      // Webview assets and the activity-bar icon.
      "extension/media/sidebar.css",
      "extension/resources/repo-id.svg",
      "extension/out/webview/client/settingsView.js",
      // Package metadata.
      "extension/package.json",
    ];
    for (const file of required) {
      assert.ok(files.includes(file), `the VSIX is missing ${file}\nPackaged:\n${files.join("\n")}`);
    }

    // ---- must NOT be present ----
    const forbidden: Array<[RegExp, string]> = [
      [/^extension\/src\//, "TypeScript sources"],
      [/^extension\/out\/test\//, "compiled tests"],
      [/\.map$/, "source maps"],
      [/^extension\/\.git\//, "git metadata"],
      [/^extension\/node_modules\//, "node_modules"],
      [/^extension\/\.github\//, "CI workflow files"],
      [/^extension\/scripts\//, "developer scripts"],
      [/^extension\/\.claude\//, "local agent/workspace state"],
      [/^extension\/\.tmp-/, "temporary test repositories or generated test data"],
      [/(^|\/)\.env($|\.)/, "environment files"],
      [/\.(pem|key|p12)$/, "keys or certificates"],
      [/\.vsix$/, "a nested VSIX"],
      [/(^|\/)package-lock\.json$/, "the lockfile"],
    ];
    for (const [pattern, description] of forbidden) {
      const hits = files.filter((f) => pattern.test(f));
      assert.deepEqual(hits, [], `the VSIX ships ${description}: ${hits.join(", ")}`);
    }

    // Nothing that looks like a credential got swept in.
    for (const file of files) {
      assert.doesNotMatch(file, /secret|credential|token|password/i, `suspicious file name in the VSIX: ${file}`);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 11 — smoke test: Shield can be enabled from an extracted VSIX treated as extensionPath", { timeout: 600_000 }, async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-vsix-smoke-"));
  try {
    const packaged = await packageVsix(workDir);
    if (!packaged) {
      t.skip("@vscode/vsce could not run here (build tool, not a runtime dependency)");
      return;
    }

    // Exactly the expression src/extension.ts uses.
    const evaluatorSource = path.join(packaged.extensionDir, "resources", "shield", "shield-evaluate.sh");
    const contents = await fs.readFile(evaluatorSource, "utf8");
    assert.match(contents, /^#!\/bin\/sh/, "the packaged evaluator is not a POSIX shell script");
    assert.match(contents, /repo-identity-guard-shield-artifact/, "the packaged evaluator has no Shield ownership marker");

    // ...and it genuinely works as the source for a real installation.
    const repo = await fs.mkdtemp(path.join(workDir, "repo-"));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, "gc"), GIT_CONFIG_SYSTEM: path.join(repo, "gs") };
    await fs.writeFile(path.join(repo, "gc"), "");
    await fs.writeFile(path.join(repo, "gs"), "");
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, env });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.name", "Danish Irfan"]);
    await git(["config", "user.email", "work@example.com"]);
    await git(["remote", "add", "origin", "git@github.com:AcmeSoftware/thing.git"]);

    const profile: Profile = {
      id: "work",
      label: "Work",
      gitName: "Danish Irfan",
      gitEmail: "work@example.com",
      expectedRemoteOwners: ["AcmeSoftware"],
      strictPushSetup: false,
    };
    const facts: RepoFacts = {
      isGitRepo: true,
      repoRoot: repo,
      currentBranch: "main",
      remoteHost: "github.com",
      remoteOwner: "AcmeSoftware",
      remoteRepo: "thing",
      pushRemoteHost: "github.com",
      pushRemoteOwner: "AcmeSoftware",
      pushRemoteRepo: "thing",
    };

    const manager = new ShieldManager();
    const result = await manager.enable(repo, evaluatorSource, { facts, profiles: [profile], protectedBranches: ["main"] });
    assert.equal(result.inspection.state, "active", result.inspection.reasons.join(" | "));

    // The installed copy is byte-identical to the packaged one, and
    // inspect() — given the packaged file as the comparison source, exactly
    // as the extension does — sees no modification.
    const healthy = await manager.inspect(repo, { evaluatorScriptSource: evaluatorSource });
    assert.equal(healthy.state, "active", healthy.reasons.join(" | "));
    assert.equal(healthy.evaluatorModified, false);
    assert.equal((await manager.disable(repo)).state, "off");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("PART 11 — .vscodeignore never excludes resources/, out/ (non-test), or media/", async () => {
  // Dependency-free backstop for the single most damaging packaging
  // regression: excluding the directory Shield's evaluator lives in. This
  // runs even where `vsce` cannot.
  const ignore = await fs.readFile(path.join(REPO_ROOT, ".vscodeignore"), "utf8");
  const rules = ignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  for (const rule of rules) {
    assert.ok(!/^resources(\/|$)/.test(rule), `.vscodeignore excludes Shield's evaluator directory: "${rule}"`);
    assert.ok(!/^media(\/|$)/.test(rule), `.vscodeignore excludes the webview assets: "${rule}"`);
    assert.ok(!/^out(\/\*\*)?$/.test(rule), `.vscodeignore excludes the entire compiled output: "${rule}"`);
    assert.ok(!/^package\.json$/.test(rule), `.vscodeignore excludes package.json: "${rule}"`);
  }
  // And the exclusions that MUST be there are.
  for (const required of ["src/**", "out/test/**", "node_modules/**", ".git/**"]) {
    assert.ok(rules.includes(required), `.vscodeignore is missing the required exclusion "${required}"`);
  }
});
