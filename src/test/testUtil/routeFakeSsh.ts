import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SshRunner } from "../../shield/sshEndpoint";

/**
 * A fake `ssh` whose `-G` answer is sensitive to the requested USER and
 * PORT, exactly like a real `~/.ssh/config` with `Match user` / per-port
 * blocks can be — and which logs the exact argv of every invocation. Used
 * to prove the identity lock's account probe asks OpenSSH precisely the
 * question the push itself will ask (same target string, same `-p`), on
 * the shell side (real shipped evaluator) and the TypeScript side
 * (`checkPushAccount`) alike.
 *
 * `-G` resolution rules (all overridable per test via env):
 *  - hostname: FAKE_SSH_HOSTNAME_USER_<user> when the target names a user,
 *    FAKE_SSH_HOSTNAME_NO_USER when it does not, else "github.com";
 *  - port: the `-p` argument when given, else FAKE_SSH_CONFIG_PORT or "22";
 *  - identitiesonly yes.
 * `-T` prints FAKE_SSH_AUTH_OUTPUT and exits 1 (GitHub's behavior).
 */
export const ROUTE_FAKE_SSH_JS = `"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const joined = " " + args.join(" ") + " ";
if (process.env.FAKE_SSH_ARGV_LOG) fs.appendFileSync(process.env.FAKE_SSH_ARGV_LOG, args.join(" ") + "\\n");
const target = args[args.length - 1] || "";
const at = target.lastIndexOf("@");
const user = at === -1 ? "" : target.slice(0, at);
const pIdx = args.indexOf("-p");
if (joined.includes(" -G ")) {
  const hostname = (user ? process.env["FAKE_SSH_HOSTNAME_USER_" + user] : process.env.FAKE_SSH_HOSTNAME_NO_USER) || "github.com";
  const port = pIdx !== -1 ? args[pIdx + 1] : (process.env.FAKE_SSH_CONFIG_PORT || "22");
  process.stdout.write("user " + (user || "localuser") + "\\nhostname " + hostname + "\\nport " + port + "\\nidentitiesonly yes\\n");
  process.exit(0);
}
if (joined.includes(" -T ")) {
  process.stderr.write(process.env.FAKE_SSH_AUTH_OUTPUT || "");
  process.exit(1);
}
process.stderr.write("route-fake-ssh: unexpected invocation: " + joined + "\\n");
process.exit(1);
`;

export async function makeRouteFakeSsh(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "rig-route-ssh-"));
  const implPath = path.join(binDir, "impl.js");
  await fs.writeFile(implPath, ROUTE_FAKE_SSH_JS);
  await fs.writeFile(path.join(binDir, "ssh"), `#!/usr/bin/env node\nrequire(${JSON.stringify(implPath)});\n`, { mode: 0o755 });
  await fs.writeFile(path.join(binDir, "ssh.cmd"), `@echo off\r\nnode "${implPath}" %*\r\n`);
  return binDir;
}

/**
 * The same rules as an in-process `SshRunner`, for the TypeScript probe —
 * deterministic on every platform (no PATH shadowing of Node's own
 * `execFile`, which Windows does not resolve like a POSIX shell).
 */
export function routeFakeRunner(env: NodeJS.ProcessEnv, log: string[][]): SshRunner {
  return async (args) => {
    log.push([...args]);
    const target = args[args.length - 1] ?? "";
    const at = target.lastIndexOf("@");
    const user = at === -1 ? "" : target.slice(0, at);
    const pIdx = args.indexOf("-p");
    if (args.includes("-G")) {
      const hostname = (user ? env[`FAKE_SSH_HOSTNAME_USER_${user}`] : env.FAKE_SSH_HOSTNAME_NO_USER) || "github.com";
      const port = pIdx !== -1 ? args[pIdx + 1] : env.FAKE_SSH_CONFIG_PORT || "22";
      return { stdout: `user ${user || "localuser"}\nhostname ${hostname}\nport ${port}\nidentitiesonly yes\n`, stderr: "", timedOut: false, spawnFailed: false };
    }
    return { stdout: "", stderr: env.FAKE_SSH_AUTH_OUTPUT ?? "", timedOut: false, spawnFailed: false };
  };
}

export const AUTHENTICATED_AS = (login: string) => `Hi ${login}! You've successfully authenticated, but GitHub does not provide shell access.\n`;
