import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteUrl } from "../services/gitService";

test("parses HTTPS remote URLs", () => {
  const parsed = parseRemoteUrl("https://github.com/AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "https");
  assert.equal(parsed.host, "github.com");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("parses scp-like SSH remote URLs", () => {
  const parsed = parseRemoteUrl("git@github.com:AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.host, "github.com");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("parses SSH host-alias remote URLs", () => {
  const parsed = parseRemoteUrl("git@github-work:AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.host, "github-work");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("parses ssh:// URLs", () => {
  const parsed = parseRemoteUrl("ssh://git@github.com/AcmeSoftware/example-project.git");
  assert.equal(parsed.protocol, "ssh");
  assert.equal(parsed.host, "github.com");
  assert.equal(parsed.owner, "AcmeSoftware");
  assert.equal(parsed.repo, "example-project");
});

test("returns unknown protocol for unparsable remotes", () => {
  const parsed = parseRemoteUrl("not a url at all");
  assert.equal(parsed.protocol, "unknown");
});
