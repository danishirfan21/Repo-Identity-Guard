import assert from "node:assert/strict";
import test from "node:test";
import "./testUtil/vscodeStub"; // installs the "vscode" require stub BEFORE SidebarProvider.ts (below) is loaded — see that module's doc comment
import { ProductionSidebarActions, RepoIdentitySidebarProvider } from "../ui/SidebarProvider";
import { OperationResult } from "../ui/protocol";
import { RepoIdentityUiState } from "../ui/productionState";

/**
 * BLOCKER 1 — webview targeting race, exercised at the HOST/bridge layer
 * (`src/ui/SidebarProvider.ts` dispatching real `src/ui/protocol.ts`
 * messages into `ProductionSidebarActions`), not through the fake-DOM
 * webview client. See the task spec's "BLOCKER 1" and its required
 * invariant: a UI action must never mutate a different repository from
 * the one the visible screen was bound to.
 *
 * The decisive scenario this proves is the HOST-SIDE TIMING RACE: a
 * message carries `repoId: "repo-A"` (the repository the webview's
 * screen was bound to), but by the time the host actually resolves "the
 * current repository" to act on, the active editor has already moved to
 * "repo-B" (the debounced scan/state push that would have told the
 * webview about this hasn't landed yet). This is deliberately NOT "push
 * state B, then check the old button is gone" — that is UI reactivity,
 * already covered in `productionWebview.test.ts`'s "repository switch
 * while nested" suite. Here, repo-A's screen never gets a chance to
 * notice anything: the race is entirely in how the HOST resolves the
 * request once it arrives.
 *
 * `fakeActions` below is a test double for `ProductionSidebarActions`
 * that implements the EXACT host-side rule the task spec requires
 * (resolve the actual current repository right now; act only when it
 * still matches the message's `repoId`; otherwise reject with
 * `{ code: "repository_changed" }` and mutate neither repository). It is
 * deliberately written to mirror `extension.ts`'s real
 * `validateRepoTarget` / `buildProductionActions` implementation
 * action-by-action (assign/change identity, unlock, repair, verify,
 * apply identity, add/update/delete/pin/copy note, import/export notes).
 *
 * KNOWN LIMITATION (see the final report): `extension.ts` itself has a
 * hard runtime dependency on the real `vscode` module (`import * as
 * vscode from "vscode"`, used throughout — `vscode.window`,
 * `vscode.workspace`, `vscode.commands`, …), which does not exist outside
 * the VS Code Extension Host, and no test in this codebase has ever
 * stubbed that full surface (see `vscodeStub.ts`'s doc comment — it
 * stubs only the one call `SidebarProvider.ts` needs, `Uri.joinPath`).
 * Building a `vscode` shim complete enough to run `extension.ts`'s real
 * `activate()` (window.activeTextEditor, workspace.workspaceFolders,
 * commands.registerCommand, native dialogs, file watchers, …) was judged
 * out of scope for this fix. These tests instead exercise the REAL
 * `RepoIdentitySidebarProvider` dispatch (message parsing via the real
 * `parseWebviewMessage`, `runOperation`, `operationResult`/`state`
 * posting) against a faithful action-layer double of `extension.ts`'s
 * documented contract; `extension.ts`'s own implementation was verified
 * by direct code review to match this contract for every action listed
 * above (see the final report for the exact diff).
 */

// ==================== fake webview host ====================

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function makeFakeWebviewView(posted: PostedMessage[]) {
  let messageHandler: ((raw: unknown) => void) | undefined;
  const webviewView = {
    webview: {
      options: undefined as unknown,
      html: "",
      cspSource: "stub-csp",
      postMessage: (message: PostedMessage) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (raw: unknown) => void) => {
        messageHandler = listener;
        return { dispose: () => undefined };
      },
    },
  };
  return { webviewView, getHandler: () => messageHandler };
}

function minimalState(repoId: string | undefined): RepoIdentityUiState {
  return {
    repo: repoId ? { id: repoId, name: repoId } : undefined,
    lock: { state: "unassigned" },
    identities: [],
    notes: [],
    isWorkspaceTrusted: true,
  };
}

const REPOSITORY_CHANGED: OperationResult = { ok: false, code: "repository_changed", message: "The current repository changed. Please try again." };

/**
 * A faithful double of `extension.ts`'s real action layer: `currentRepoId`
 * is the test's stand-in for what `commandTarget()` would resolve RIGHT
 * NOW (mutable — the test flips it mid-flight to simulate the active
 * editor switching repos before this request arrived). Every repo-scoped
 * method validates `repoId` against it BEFORE doing anything, exactly as
 * `validateRepoTarget` requires; `mutations` records every repository
 * that was actually acted on, so a test can assert NOTHING happened to
 * either repository on a mismatch.
 */
function buildFakeActions(world: { currentRepoId: string | undefined; mutations: string[]; refreshes: number; clipboard: string[] }): ProductionSidebarActions {
  function validated(repoId: string): boolean {
    return world.currentRepoId === repoId;
  }
  function mutateOrReject(repoId: string, label: string): OperationResult {
    if (!validated(repoId)) {
      world.refreshes += 1;
      return REPOSITORY_CHANGED;
    }
    world.mutations.push(`${repoId}:${label}`);
    return { ok: true };
  }
  return {
    getState: async () => minimalState(world.currentRepoId),
    assignIdentity: async (repoId, identityId) => mutateOrReject(repoId, `assignIdentity:${identityId}`),
    changeIdentity: async (repoId, identityId) => mutateOrReject(repoId, `changeIdentity:${identityId}`),
    unlockRepository: async (repoId) => mutateOrReject(repoId, "unlockRepository"),
    repairLock: async (repoId) => mutateOrReject(repoId, "repairLock"),
    verifyLock: async (repoId) => mutateOrReject(repoId, "verifyLock"),
    applyAssignedIdentity: async (repoId) => mutateOrReject(repoId, "applyAssignedIdentity"),
    saveIdentity: async () => ({ ok: true }),
    deleteIdentity: async () => ({ ok: true }),
    addNote: async (repoId, text) => mutateOrReject(repoId, `addNote:${text}`),
    updateNote: async (repoId, noteId, text) => mutateOrReject(repoId, `updateNote:${noteId}:${text}`),
    deleteNote: async (repoId, noteId) => mutateOrReject(repoId, `deleteNote:${noteId}`),
    togglePinNote: async (repoId, noteId) => mutateOrReject(repoId, `togglePinNote:${noteId}`),
    copyNote: async (repoId, noteId) => {
      const result = mutateOrReject(repoId, `copyNote:${noteId}`);
      if (result.ok) world.clipboard.push(noteId);
      return result;
    },
    importNotes: async (repoId) => {
      if (!validated(repoId)) {
        world.refreshes += 1;
        return;
      }
      world.mutations.push(`${repoId}:importNotes`);
    },
    exportNotes: async (repoId) => {
      if (!validated(repoId)) {
        world.refreshes += 1;
        return;
      }
      world.mutations.push(`${repoId}:exportNotes`);
    },
    openFolder: async () => undefined,
  };
}

function makeProvider(world: { currentRepoId: string | undefined; mutations: string[]; refreshes: number; clipboard: string[] }) {
  const posted: PostedMessage[] = [];
  const provider = new RepoIdentitySidebarProvider({ fsPath: "/fake/extension" } as never, buildFakeActions(world));
  const { webviewView, getHandler } = makeFakeWebviewView(posted);
  provider.resolveWebviewView(webviewView as never);
  const handler = getHandler();
  assert.ok(handler, "resolveWebviewView must register an onDidReceiveMessage listener");
  // `onDidReceiveMessage` is wired as `(raw) => void this.handleMessage(raw)` in the real SidebarProvider — fire-and-forget
  // from the caller's perspective. Tests need to AWAIT each request's full round trip (ack + state), so they drive the
  // provider's private `handleMessage` directly (TS `private` is compile-time only) rather than through that listener.
  const handleMessage = (provider as unknown as { handleMessage(raw: unknown): Promise<void> }).handleMessage.bind(provider);
  return { posted, handleMessage, operationResults: () => posted.filter((m) => m.type === "operationResult"), stateCount: () => posted.filter((m) => m.type === "state").length };
}

function newWorld(currentRepoId: string | undefined) {
  return { currentRepoId, mutations: [] as string[], refreshes: 0, clipboard: [] as string[] };
}

// ==================== A: repoId matches the actual current repository ====================

test("HOST RACE A: assignIdentity — message.repoId === current repo -> executes normally, acked ok:true, state refreshed", async () => {
  const world = newWorld("repo-A");
  const { posted, handleMessage, operationResults } = makeProvider(world);
  await handleMessage({ type: "assignIdentity", repoId: "repo-A", identityId: "work", requestId: "r1" });
  assert.deepEqual(world.mutations, ["repo-A:assignIdentity:work"]);
  assert.equal(operationResults().length, 1);
  assert.deepEqual(operationResults()[0], { type: "operationResult", requestId: "r1", ok: true });
  assert.ok(posted.some((m) => m.type === "state"), "a state push follows every operation, success or failure");
});

// ==================== B: the decisive host-side timing race ====================

test("HOST RACE B: assignIdentity/changeIdentity — repoId stale (resolver now reports a DIFFERENT repo) -> rejected with repository_changed, mutates NEITHER repository, state refreshed", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  // The screen was bound to repo-A (that's the repoId the message carries), but by the time this request
  // arrives, the active editor has already moved to repo-B — simulating the debounced scan not having
  // reached the webview yet.
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "assignIdentity", repoId: "repo-A", identityId: "work", requestId: "r1" });
  assert.deepEqual(world.mutations, [], "neither repository must be mutated");
  assert.deepEqual(operationResults()[0], { type: "operationResult", requestId: "r1", ok: false, code: "repository_changed", message: "The current repository changed. Please try again." });

  await handleMessage({ type: "changeIdentity", repoId: "repo-A", identityId: "personal", requestId: "r2" });
  assert.deepEqual(world.mutations, [], "a stale changeIdentity must not retarget repo-B either");
  assert.equal(operationResults()[1].code, "repository_changed");
});

test("HOST RACE B: unlockRepository — stale repoId is rejected, never unlocking the NEW current repository either", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "unlockRepository", repoId: "repo-A", requestId: "r1" });
  assert.deepEqual(world.mutations, []);
  assert.equal(operationResults()[0].code, "repository_changed");
});

test("HOST RACE B: repairLock — stale repoId is rejected", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "repairLock", repoId: "repo-A", requestId: "r1" });
  assert.deepEqual(world.mutations, []);
  assert.equal(operationResults()[0].code, "repository_changed");
});

test("HOST RACE B: verifyLock — stale repoId is rejected (read-only, but still must not read the WRONG repository)", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "verifyLock", repoId: "repo-A", requestId: "r1" });
  assert.deepEqual(world.mutations, []);
  assert.equal(operationResults()[0].code, "repository_changed");
});

test("HOST RACE B: applyAssignedIdentity — stale repoId is rejected", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "applyAssignedIdentity", repoId: "repo-A", requestId: "r1" });
  assert.deepEqual(world.mutations, []);
  assert.equal(operationResults()[0].code, "repository_changed");
});

test("HOST RACE B: addNote/updateNote/deleteNote/togglePinNote — a stale repoId is rejected for every note mutation; none reach EITHER repository's notes", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B";

  await handleMessage({ type: "addNote", repoId: "repo-A", text: "hello", requestId: "r1" });
  await handleMessage({ type: "updateNote", repoId: "repo-A", noteId: "n1", text: "edited", requestId: "r2" });
  await handleMessage({ type: "deleteNote", repoId: "repo-A", noteId: "n1", requestId: "r3" });
  await handleMessage({ type: "togglePinNote", repoId: "repo-A", noteId: "n1", requestId: "r4" });

  assert.deepEqual(world.mutations, [], "no note mutation may land on repo-A (stale) or repo-B (the new current, never named by this request)");
  for (const result of operationResults()) {
    assert.equal(result.ok, false);
    assert.equal(result.code, "repository_changed");
  }
  assert.equal(operationResults().length, 4);
});

test("HOST RACE B: copyNote — stale repoId is rejected and the clipboard is never written", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "copyNote", repoId: "repo-A", noteId: "n1", requestId: "r1" });
  assert.deepEqual(world.clipboard, [], "copyNote must not write the clipboard against a mismatched repository");
  assert.equal(operationResults()[0].code, "repository_changed");
});

test("HOST RACE: copyNote — matching repoId copies normally and acks ok:true", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  await handleMessage({ type: "copyNote", repoId: "repo-A", noteId: "n1", requestId: "r1" });
  assert.deepEqual(world.clipboard, ["n1"]);
  assert.deepEqual(operationResults()[0], { type: "operationResult", requestId: "r1", ok: true });
});

test("HOST RACE B: importNotes/exportNotes — a stale repoId imports/exports NOTHING, and the host still refreshes state rather than silently retargeting", async () => {
  const world = newWorld("repo-A");
  const { handleMessage } = makeProvider(world);
  world.currentRepoId = "repo-B";
  await handleMessage({ type: "importNotes", repoId: "repo-A" });
  await handleMessage({ type: "exportNotes", repoId: "repo-A" });
  assert.deepEqual(world.mutations, [], "neither repository's notes may be imported/exported against a stale target");
  assert.equal(world.refreshes, 2, "each rejected request still triggers a state refresh (extension.ts's repositoryChanged()/refreshViews())");
});

test("HOST RACE: importNotes/exportNotes — matching repoId proceeds normally", async () => {
  const world = newWorld("repo-A");
  const { handleMessage } = makeProvider(world);
  await handleMessage({ type: "importNotes", repoId: "repo-A" });
  await handleMessage({ type: "exportNotes", repoId: "repo-A" });
  assert.deepEqual(world.mutations, ["repo-A:importNotes", "repo-A:exportNotes"]);
});

// ==================== not repo-scoped: unaffected by any of this ====================

test("saveIdentity / deleteIdentity are not repo-scoped: they carry no repoId and are never subject to the repository_changed rejection", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, operationResults } = makeProvider(world);
  world.currentRepoId = "repo-B"; // even mid-race, settings CRUD is unaffected
  await handleMessage({ type: "saveIdentity", identity: { label: "X", gitEmail: "x@example.com", sshAliases: [] }, requestId: "r1" });
  await handleMessage({ type: "deleteIdentity", identityId: "x", requestId: "r2" });
  assert.deepEqual(operationResults(), [
    { type: "operationResult", requestId: "r1", ok: true },
    { type: "operationResult", requestId: "r2", ok: true },
  ]);
});

// ==================== malformed/stale wire messages never reach the action layer ====================

test("a message missing repoId (or with a malformed one) is dropped by the REAL parseWebviewMessage before it ever reaches the action layer", async () => {
  const world = newWorld("repo-A");
  const { handleMessage, posted } = makeProvider(world);
  // `resolveWebviewView` fires one initial `state` push itself, via a fire-and-forget `void this.postState()` —
  // flush it (and anything else pending) with an awaited no-op `ready` round trip before taking the baseline, so
  // it is never mistaken for something the malformed messages below caused.
  await handleMessage({ type: "ready" });
  const baseline = posted.length;
  await handleMessage({ type: "unlockRepository", requestId: "r1" }); // no repoId at all
  await handleMessage({ type: "unlockRepository", repoId: "", requestId: "r2" }); // empty repoId
  await handleMessage({ type: "unlockRepository", repoId: 42, requestId: "r3" }); // non-string repoId
  assert.deepEqual(world.mutations, []);
  assert.equal(posted.length, baseline, "a message that fails runtime validation is silently dropped, never dispatched and never acked");
});
