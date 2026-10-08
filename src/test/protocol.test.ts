import assert from "node:assert/strict";
import test from "node:test";
import { WEBVIEW_MESSAGE_TYPES, WebviewMessage, operationRequiresTrust, parseWebviewMessage } from "../ui/protocol";

/**
 * The production webview message protocol's runtime boundary: every
 * well-formed message parses to exactly the requested action (never
 * coerced, never a guessed default), every malformed one is dropped, and
 * there is no `selectRepo` — see "GENERIC REQUEST/ACK PROTOCOL" and
 * FROZEN PRODUCT RULES in the task spec.
 */

test("no 'selectRepo' message exists in the protocol", () => {
  assert.ok(!(WEBVIEW_MESSAGE_TYPES as readonly string[]).includes("selectRepo"));
  assert.equal(parseWebviewMessage({ type: "selectRepo", id: "repo-1" }), undefined);
});

test("ready parses with no further fields required", () => {
  assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
});

test("assignIdentity / changeIdentity / deleteIdentity require both identityId and requestId", () => {
  for (const type of ["assignIdentity", "changeIdentity", "deleteIdentity"] as const) {
    assert.deepEqual(parseWebviewMessage({ type, identityId: "work", requestId: "r1" }), { type, identityId: "work", requestId: "r1" });
    assert.equal(parseWebviewMessage({ type, requestId: "r1" }), undefined, `${type} without identityId must be dropped`);
    assert.equal(parseWebviewMessage({ type, identityId: "work" }), undefined, `${type} without requestId must be dropped`);
    assert.equal(parseWebviewMessage({ type, identityId: "", requestId: "r1" }), undefined, `${type} with an empty identityId must be dropped`);
  }
});

test("unlockRepository / repairLock / verifyLock / applyAssignedIdentity require a requestId", () => {
  for (const type of ["unlockRepository", "repairLock", "verifyLock", "applyAssignedIdentity"] as const) {
    assert.deepEqual(parseWebviewMessage({ type, requestId: "r1" }), { type, requestId: "r1" });
    assert.equal(parseWebviewMessage({ type }), undefined);
    assert.equal(parseWebviewMessage({ type, requestId: "" }), undefined);
  }
});

test("saveIdentity: a well-formed draft (label, gitEmail, sshAliases) parses, with the full alias array preserved", () => {
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

test("addNote requires non-empty text and a requestId", () => {
  assert.deepEqual(parseWebviewMessage({ type: "addNote", text: "hello", requestId: "r1" }), { type: "addNote", text: "hello", requestId: "r1" });
  assert.equal(parseWebviewMessage({ type: "addNote", text: "", requestId: "r1" }), undefined);
  assert.equal(parseWebviewMessage({ type: "addNote", requestId: "r1" }), undefined);
});

test("updateNote allows empty text (clearing a note is a valid edit) but requires noteId and requestId", () => {
  assert.deepEqual(parseWebviewMessage({ type: "updateNote", noteId: "n1", text: "", requestId: "r1" }), { type: "updateNote", noteId: "n1", text: "", requestId: "r1" });
  assert.equal(parseWebviewMessage({ type: "updateNote", text: "x", requestId: "r1" }), undefined);
});

test("deleteNote and togglePinNote now carry a requestId (extended ack coverage, see 'NOTES ACKS')", () => {
  assert.deepEqual(parseWebviewMessage({ type: "deleteNote", noteId: "n1", requestId: "r1" }), { type: "deleteNote", noteId: "n1", requestId: "r1" });
  assert.deepEqual(parseWebviewMessage({ type: "togglePinNote", noteId: "n1", requestId: "r1" }), { type: "togglePinNote", noteId: "n1", requestId: "r1" });
  assert.equal(parseWebviewMessage({ type: "deleteNote", noteId: "n1" }), undefined, "deleteNote without a requestId must be dropped");
});

test("copyNote is fire-and-forget (no requestId) but still requires a noteId", () => {
  assert.deepEqual(parseWebviewMessage({ type: "copyNote", noteId: "n1" }), { type: "copyNote", noteId: "n1" });
  assert.equal(parseWebviewMessage({ type: "copyNote" }), undefined);
});

test("importNotes / exportNotes parse with no further fields (reachable from the new protocol, unchanged behavior)", () => {
  assert.deepEqual(parseWebviewMessage({ type: "importNotes" }), { type: "importNotes" });
  assert.deepEqual(parseWebviewMessage({ type: "exportNotes" }), { type: "exportNotes" });
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
  for (const type of ["ready", "verifyLock", "saveIdentity", "deleteIdentity", "addNote", "updateNote", "deleteNote", "togglePinNote", "copyNote", "importNotes", "exportNotes"] as const) {
    assert.equal(operationRequiresTrust(type), false, `${type} must not require trust`);
  }
});
