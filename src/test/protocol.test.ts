import assert from "node:assert/strict";
import test from "node:test";
import { WEBVIEW_MESSAGE_TYPES, WebviewMessage, operationRequiresTrust, parseWebviewMessage } from "../ui/protocol";

/**
 * The production webview message protocol's runtime boundary: every
 * well-formed message parses to exactly the requested action (never
 * coerced, never a guessed default), every malformed one is dropped, and
 * there is no `selectRepo` — see "GENERIC REQUEST/ACK PROTOCOL" and
 * FROZEN PRODUCT RULES in the task spec.
 *
 * Every repo-scoped message also carries a `repoId` — an internal
 * stale-action guard (see this module's own doc comment), never a
 * repository picker — and `parseWebviewMessage` must validate it with the
 * same discipline as every other field: missing, empty, or non-string is
 * dropped, never coerced or defaulted.
 */

test("no 'selectRepo' message exists in the protocol", () => {
  assert.ok(!(WEBVIEW_MESSAGE_TYPES as readonly string[]).includes("selectRepo"));
  assert.equal(parseWebviewMessage({ type: "selectRepo", id: "repo-1" }), undefined);
});

test("ready parses with no further fields required", () => {
  assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
});

test("assignIdentity / changeIdentity require repoId, identityId and requestId", () => {
  for (const type of ["assignIdentity", "changeIdentity"] as const) {
    assert.deepEqual(parseWebviewMessage({ type, repoId: "repo-a", identityId: "work", requestId: "r1" }), { type, repoId: "repo-a", identityId: "work", requestId: "r1" });
    assert.equal(parseWebviewMessage({ type, identityId: "work", requestId: "r1" }), undefined, `${type} without repoId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a", requestId: "r1" }), undefined, `${type} without identityId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a", identityId: "work" }), undefined, `${type} without requestId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "", identityId: "work", requestId: "r1" }), undefined, `${type} with an empty repoId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a", identityId: "", requestId: "r1" }), undefined, `${type} with an empty identityId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: 42, identityId: "work", requestId: "r1" }), undefined, `${type} with a non-string repoId must be dropped`);
  }
});

test("deleteIdentity is identity-settings CRUD, not repo-scoped: it requires identityId and requestId but no repoId, and a repoId on it is simply ignored (not validated, not echoed)", () => {
  assert.deepEqual(parseWebviewMessage({ type: "deleteIdentity", identityId: "work", requestId: "r1" }), { type: "deleteIdentity", identityId: "work", requestId: "r1" });
  assert.equal(parseWebviewMessage({ type: "deleteIdentity", requestId: "r1" }), undefined, "deleteIdentity without identityId must be dropped");
  assert.equal(parseWebviewMessage({ type: "deleteIdentity", identityId: "work" }), undefined, "deleteIdentity without requestId must be dropped");
  assert.equal(parseWebviewMessage({ type: "deleteIdentity", identityId: "", requestId: "r1" }), undefined, "deleteIdentity with an empty identityId must be dropped");
  const withStrayRepoId = parseWebviewMessage({ type: "deleteIdentity", identityId: "work", requestId: "r1", repoId: "repo-a" });
  assert.deepEqual(withStrayRepoId, { type: "deleteIdentity", identityId: "work", requestId: "r1" });
});

test("unlockRepository / repairLock / verifyLock / applyAssignedIdentity require repoId and requestId", () => {
  for (const type of ["unlockRepository", "repairLock", "verifyLock", "applyAssignedIdentity"] as const) {
    assert.deepEqual(parseWebviewMessage({ type, repoId: "repo-a", requestId: "r1" }), { type, repoId: "repo-a", requestId: "r1" });
    assert.equal(parseWebviewMessage({ type, requestId: "r1" }), undefined, `${type} without repoId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a" }), undefined, `${type} without requestId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "", requestId: "r1" }), undefined, `${type} with an empty repoId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a", requestId: "" }), undefined, `${type} with an empty requestId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: null, requestId: "r1" }), undefined, `${type} with a null repoId must be dropped`);
  }
});

test("saveIdentity: a well-formed draft (label, gitEmail, sshAliases) parses, with the full alias array preserved; saveIdentity is not repo-scoped (no repoId)", () => {
  const msg = parseWebviewMessage({
    type: "saveIdentity",
    requestId: "r1",
    identity: { id: "work", label: "Work", gitEmail: "work@example.com", gitName: "Danish", githubUsername: "danish-work", sshAliases: ["a", "b", "c"] },
  });
  assert.deepEqual(msg, {
    type: "saveIdentity",
    requestId: "r1",
    identity: { id: "work", label: "Work", gitEmail: "work@example.com", gitName: "Danish", githubUsername: "danish-work", sshAliases: ["a", "b", "c"] },
  });
});

test("saveIdentity: no id means create — the draft is still accepted without one", () => {
  const msg = parseWebviewMessage({ type: "saveIdentity", requestId: "r1", identity: { label: "New", gitEmail: "new@example.com", sshAliases: [] } });
  assert.deepEqual(msg, { type: "saveIdentity", requestId: "r1", identity: { label: "New", gitEmail: "new@example.com", sshAliases: [] } });
});

test("saveIdentity: missing label or gitEmail is dropped, never partially accepted", () => {
  assert.equal(parseWebviewMessage({ type: "saveIdentity", requestId: "r1", identity: { gitEmail: "x@example.com", sshAliases: [] } }), undefined);
  assert.equal(parseWebviewMessage({ type: "saveIdentity", requestId: "r1", identity: { label: "X", sshAliases: [] } }), undefined);
  assert.equal(parseWebviewMessage({ type: "saveIdentity", requestId: "r1" }), undefined);
});

test("saveIdentity: a non-string entry in sshAliases is dropped from the array, not coerced to a string", () => {
  const msg = parseWebviewMessage({
    type: "saveIdentity",
    requestId: "r1",
    identity: { label: "X", gitEmail: "x@example.com", sshAliases: ["ok", 42, null, "also-ok"] },
  }) as Extract<WebviewMessage, { type: "saveIdentity" }> | undefined;
  assert.ok(msg);
  assert.deepEqual(msg.identity.sshAliases, ["ok", "also-ok"]);
});

test("addNote requires repoId, non-empty text and a requestId", () => {
  assert.deepEqual(parseWebviewMessage({ type: "addNote", repoId: "repo-a", text: "hello", requestId: "r1" }), { type: "addNote", repoId: "repo-a", text: "hello", requestId: "r1" });
  assert.equal(parseWebviewMessage({ type: "addNote", text: "hello", requestId: "r1" }), undefined, "addNote without repoId must be dropped");
  assert.equal(parseWebviewMessage({ type: "addNote", repoId: "repo-a", text: "", requestId: "r1" }), undefined);
  assert.equal(parseWebviewMessage({ type: "addNote", repoId: "repo-a", requestId: "r1" }), undefined);
  assert.equal(parseWebviewMessage({ type: "addNote", repoId: "", text: "hello", requestId: "r1" }), undefined, "addNote with an empty repoId must be dropped");
});

test("updateNote allows empty text (clearing a note is a valid edit) but requires repoId, noteId and requestId", () => {
  assert.deepEqual(parseWebviewMessage({ type: "updateNote", repoId: "repo-a", noteId: "n1", text: "", requestId: "r1" }), {
    type: "updateNote",
    repoId: "repo-a",
    noteId: "n1",
    text: "",
    requestId: "r1",
  });
  assert.equal(parseWebviewMessage({ type: "updateNote", noteId: "n1", text: "x", requestId: "r1" }), undefined, "updateNote without repoId must be dropped");
  assert.equal(parseWebviewMessage({ type: "updateNote", repoId: "repo-a", text: "x", requestId: "r1" }), undefined);
});

test("deleteNote and togglePinNote require repoId, noteId and requestId", () => {
  for (const type of ["deleteNote", "togglePinNote"] as const) {
    assert.deepEqual(parseWebviewMessage({ type, repoId: "repo-a", noteId: "n1", requestId: "r1" }), { type, repoId: "repo-a", noteId: "n1", requestId: "r1" });
    assert.equal(parseWebviewMessage({ type, noteId: "n1", requestId: "r1" }), undefined, `${type} without a repoId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a", requestId: "r1" }), undefined, `${type} without a noteId must be dropped`);
    assert.equal(parseWebviewMessage({ type, repoId: "repo-a", noteId: "n1" }), undefined, `${type} without a requestId must be dropped`);
  }
});

test("copyNote is now ack-based (see 'COPY MUST NOT ANNOUNCE SUCCESS BEFORE SUCCESS'): it requires repoId, noteId AND a requestId", () => {
  assert.deepEqual(parseWebviewMessage({ type: "copyNote", repoId: "repo-a", noteId: "n1", requestId: "r1" }), { type: "copyNote", repoId: "repo-a", noteId: "n1", requestId: "r1" });
  assert.equal(parseWebviewMessage({ type: "copyNote", noteId: "n1", requestId: "r1" }), undefined, "copyNote without repoId must be dropped");
  assert.equal(parseWebviewMessage({ type: "copyNote", repoId: "repo-a", requestId: "r1" }), undefined, "copyNote without noteId must be dropped");
  assert.equal(parseWebviewMessage({ type: "copyNote", repoId: "repo-a", noteId: "n1" }), undefined, "copyNote without requestId must be dropped");
});

test("importNotes / exportNotes require a repoId (single-repo export/import is repo-scoped)", () => {
  assert.deepEqual(parseWebviewMessage({ type: "importNotes", repoId: "repo-a" }), { type: "importNotes", repoId: "repo-a" });
  assert.deepEqual(parseWebviewMessage({ type: "exportNotes", repoId: "repo-a" }), { type: "exportNotes", repoId: "repo-a" });
  assert.equal(parseWebviewMessage({ type: "importNotes" }), undefined, "importNotes without a repoId must be dropped");
  assert.equal(parseWebviewMessage({ type: "exportNotes" }), undefined, "exportNotes without a repoId must be dropped");
  assert.equal(parseWebviewMessage({ type: "importNotes", repoId: "" }), undefined, "importNotes with an empty repoId must be dropped");
  assert.equal(parseWebviewMessage({ type: "importNotes", repoId: 1 }), undefined, "importNotes with a non-string repoId must be dropped");
});

test("openFolder parses with no further fields and is listed in WEBVIEW_MESSAGE_TYPES", () => {
  assert.deepEqual(parseWebviewMessage({ type: "openFolder" }), { type: "openFolder" });
  assert.ok((WEBVIEW_MESSAGE_TYPES as readonly string[]).includes("openFolder"));
});

test("malformed input of every shape is dropped, never throws", () => {
  for (const bad of [null, undefined, 42, "a string", [], {}, { type: 123 }, { noType: true }]) {
    assert.doesNotThrow(() => parseWebviewMessage(bad));
    assert.equal(parseWebviewMessage(bad), undefined);
  }
});

// ==================== workspace trust mapping ====================

test("operationRequiresTrust: only Git-mutating operations require Workspace Trust", () => {
  for (const type of ["assignIdentity", "changeIdentity", "unlockRepository", "repairLock", "applyAssignedIdentity"] as const) {
    assert.equal(operationRequiresTrust(type), true, `${type} must require trust`);
  }
});

test("operationRequiresTrust: notes, identity SETTINGS edits, and the read-only lock check never require Workspace Trust", () => {
  for (const type of ["ready", "verifyLock", "saveIdentity", "deleteIdentity", "addNote", "updateNote", "deleteNote", "togglePinNote", "copyNote", "importNotes", "exportNotes", "openFolder"] as const) {
    assert.equal(operationRequiresTrust(type), false, `${type} must not require trust`);
  }
});
