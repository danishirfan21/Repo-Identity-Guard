import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubSshAuthOutput, sshConfigHasIdentitiesOnly } from "../shield/githubSshVerification";

/**
 * Unit tests for Shield Mode Phase 5's GitHub SSH response parser. Every
 * case here is a real, captured GitHub CLI output shape (or a faithful
 * reproduction of one) — no network access, no `ssh` process, no shell
 * involved. This is deliberately the same list the task itself calls for:
 * success, wrong username, deploy-key identity, permission denied,
 * timeout, unknown host, malformed output, and the exit-code footgun.
 */

test("parses a successful personal-account response, extracting the login", () => {
  const outcome = parseGitHubSshAuthOutput(
    "Hi danish-work! You've successfully authenticated, but GitHub does not provide shell access.\n",
  );
  assert.deepEqual(outcome, { kind: "authenticated-user", login: "danish-work" });
});

test("a 'wrong username' response is parsed the same way as any other authenticated login — comparison is the caller's job, not the parser's", () => {
  const outcome = parseGitHubSshAuthOutput(
    "Hi danish-personal! You've successfully authenticated, but GitHub does not provide shell access.\n",
  );
  assert.deepEqual(outcome, { kind: "authenticated-user", login: "danish-personal" });
});

test("parses a deploy-key/App-installation identity (owner/repo shape) as unverifiable, never as a personal login", () => {
  const outcome = parseGitHubSshAuthOutput(
    "Hi AcmeSoftware/acme-frontend! You've successfully authenticated, but GitHub does not provide shell access.\n",
  );
  assert.deepEqual(outcome, { kind: "authenticated-deploy-key", identity: "AcmeSoftware/acme-frontend" });
});

test("parses GitHub's permission-denied response", () => {
  const outcome = parseGitHubSshAuthOutput("git@github.com: Permission denied (publickey).\n");
  assert.deepEqual(outcome, { kind: "permission-denied" });
});

test("parses a connection timeout", () => {
  const outcome = parseGitHubSshAuthOutput("ssh: connect to host github.com port 22: Connection timed out\n");
  assert.deepEqual(outcome, { kind: "timeout" });
});

test("parses an unknown/untrusted host key (StrictHostKeyChecking=yes refusing to connect) — never treated as a pass", () => {
  const outcome = parseGitHubSshAuthOutput(
    "No ED25519 host key is known for github-work and you have requested strict checking.\r\nHost key verification failed.\n",
  );
  assert.deepEqual(outcome, { kind: "host-key-unverified" });
});

test("parses a changed-host-key warning phrased around 'key fingerprint' the same way", () => {
  const outcome = parseGitHubSshAuthOutput(
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nSomeone could be eavesdropping on you right now!\nIt is also possible that a host key has just been changed.\nThe fingerprint for the ED25519 key sent by the remote host is...\nPlease contact your system administrator.\nAdd correct host key to know the ED25519 key fingerprint for.\n",
  );
  assert.deepEqual(outcome, { kind: "host-key-unverified" });
});

test("malformed/unrecognized output is never guessed at — preserved verbatim as 'malformed'", () => {
  const raw = "garbage nonsense that matches nothing GitHub would ever actually say\n";
  const outcome = parseGitHubSshAuthOutput(raw);
  assert.deepEqual(outcome, { kind: "malformed", raw });
});

test("empty output is malformed, not silently treated as any kind of success", () => {
  const outcome = parseGitHubSshAuthOutput("");
  assert.equal(outcome.kind, "malformed");
});

test("a 'Hi !' with no identity between 'Hi' and '!' is malformed, not an empty login", () => {
  const raw = "Hi ! You've successfully authenticated, but GitHub does not provide shell access.\n";
  const outcome = parseGitHubSshAuthOutput(raw);
  assert.deepEqual(outcome, { kind: "malformed", raw });
});

test("expected GitHub exit-code behavior: the parser's signature takes no exit code at all, by design — GitHub commonly exits 1 on full success", () => {
  // parseGitHubSshAuthOutput(output: string) has no second parameter for
  // an exit code; this is deliberate; see the module's doc comment. A
  // caller that gated on `code === 0` before calling this would silently
  // treat every successful GitHub authentication as a failure, since
  // GitHub's SSH endpoint has no shell to hand back and exits 1 anyway.
  const outcome = parseGitHubSshAuthOutput(
    "Hi danish-work! You've successfully authenticated, but GitHub does not provide shell access.\n",
  );
  assert.equal(outcome.kind, "authenticated-user");
});

// ---------------- sshConfigHasIdentitiesOnly ----------------

test("sshConfigHasIdentitiesOnly is true when ssh -G's effective config sets it", () => {
  const output = "user git\nhostname github.com\nport 22\nidentitiesonly yes\nidentityfile ~/.ssh/id_work\n";
  assert.equal(sshConfigHasIdentitiesOnly(output), true);
});

test("sshConfigHasIdentitiesOnly is false when absent", () => {
  const output = "user git\nhostname github.com\nport 22\nidentityfile ~/.ssh/id_ed25519\n";
  assert.equal(sshConfigHasIdentitiesOnly(output), false);
});

test("sshConfigHasIdentitiesOnly is false when set to no", () => {
  const output = "user git\nidentitiesonly no\n";
  assert.equal(sshConfigHasIdentitiesOnly(output), false);
});

test("sshConfigHasIdentitiesOnly tolerates surrounding whitespace and CRLF line endings", () => {
  const output = "user git\r\n  identitiesonly yes  \r\nhostname github.com\r\n";
  assert.equal(sshConfigHasIdentitiesOnly(output), true);
});

test("sshConfigHasIdentitiesOnly is case-insensitive (ssh -G itself always lowercases keys, but never assume the value is)", () => {
  const output = "IdentitiesOnly Yes\n";
  assert.equal(sshConfigHasIdentitiesOnly(output), true);
});
