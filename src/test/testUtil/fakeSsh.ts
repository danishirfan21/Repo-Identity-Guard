import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A fake `ssh`, shadowed onto PATH, that answers every shape Shield's
 * evaluator can invoke:
 *
 *  - `ssh -G <alias>` — prints an effective-config response controlled by
 *    `FAKE_SSH_HOSTNAME` (default: "github.com") and
 *    `FAKE_SSH_IDENTITIES_ONLY` (default: "yes"). `FAKE_SSH_G_FAIL`
 *    simulates `ssh -G` producing no hostname at all — used to test the
 *    fail-closed path.
 *  - `ssh -T ... <user>@<alias>` — prints `FAKE_SSH_AUTH_OUTPUT` verbatim
 *    and exits with `FAKE_SSH_AUTH_EXIT` (default 1, mirroring GitHub's own
 *    "exit 1 even on full success" behavior).
 *  - anything else — passthrough to the local `git-upload-pack`/etc. so a
 *    baseline push after a passing check still actually lands in a local
 *    bare repo.
 *
 * Extracted from shieldGitHubAccountBinding.test.ts's original
 * Phase-5-only helper (same file, same logic) so the release-blocker
 * destination-host-canonicalization fix (`resolve_canonical_ssh_host` in
 * resources/shield/shield-evaluate.sh) — which now calls `ssh -G`
 * unconditionally for every ssh-protocol push, not only Phase 5 account
 * verification — can be exercised by other test files without a real
 * `ssh` binary or a real `~/.ssh/config` alias.
 *
 * Windows note (Phase 7 finding, see shieldPrePush.test.ts for the fuller
 * writeup): a bare, extension-less `ssh` file is invisible to Windows'
 * PATH lookup, so a matching `ssh.cmd` shim is written alongside it.
 */
export async function makeFakeSshBin(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "shield-fakessh-"));
  const implPath = path.join(binDir, "fake-ssh-impl.js");
  await fs.writeFile(
    implPath,
    `"use strict";
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (joined.includes(" -G ")) {
  if (process.env.FAKE_SSH_G_FAIL === "1") {
    process.stdout.write("user git\\n");
    process.exit(0);
  }
  const identitiesOnly = (process.env.FAKE_SSH_IDENTITIES_ONLY || "yes") === "yes";
  const user = process.env.FAKE_SSH_USER || "git";
  const hostname = process.env.FAKE_SSH_HOSTNAME || "github.com";
  const port = process.env.FAKE_SSH_PORT || "22";
  process.stdout.write(
    \`user \${user}\\nhostname \${hostname}\\nport \${port}\\n\` +
    (identitiesOnly ? "identitiesonly yes\\n" : "identitiesonly no\\n")
  );
  process.exit(0);
} else if (joined.includes(" -T ")) {
  if (process.env.FAKE_SSH_PROBE_LOG) {
    require("node:fs").appendFileSync(process.env.FAKE_SSH_PROBE_LOG, args.join(" ") + "\\n");
  }
  process.stderr.write(process.env.FAKE_SSH_AUTH_OUTPUT || "");
  process.exit(parseInt(process.env.FAKE_SSH_AUTH_EXIT || "1", 10));
} else {
  const remoteCommand = args[args.length - 1] || "";
  const match = /^(\\S+)\\s+'(.*)'$/.exec(remoteCommand);
  if (!match) {
    process.stderr.write("fake-ssh: could not parse remote command: " + remoteCommand + "\\n");
    process.exit(1);
  }
  try {
    execFileSync(match[1], [match[2]], { stdio: "inherit" });
  } catch (err) {
    process.exit(typeof err.status === "number" ? err.status : 1);
  }
}
`,
  );
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
}

/** Prepends the fake ssh bin directory onto an existing PATH value. */
export function withFakeSshOnPath(env: NodeJS.ProcessEnv, fakeSshBin: string): NodeJS.ProcessEnv {
  return { ...env, PATH: `${fakeSshBin}${path.delimiter}${env.PATH ?? ""}` };
}
