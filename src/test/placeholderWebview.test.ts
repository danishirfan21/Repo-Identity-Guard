import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { RepoIdentityState } from "../identity/types";
import { NoteMutationResult, SidebarActions, dispatchSidebarMessage } from "../ui/sidebarMessages";
import { WireState, toWireState } from "../ui/wireState";
import { PLACEHOLDER_VIEW_JS } from "../webview/client/placeholderView";

/**
 * The placeholder webview (pending the UI redesign) and the host-side
 * message boundary. The visual design is out of scope; what is tested here
 * is what must survive any redesign: no HTML injection, no lost drafts,
 * nothing executes a note, untrusted workspaces cannot reach lock
 * actions, and malformed messages are dropped.
 */

// ==================== a minimal fake DOM ====================

class FakeNode {
  public children: FakeNode[] = [];
  public parent: FakeNode | null = null;
  public textValue = "";
  public constructor(public readonly tagName: string) {}
  public get textContent(): string {
    return this.tagName === "#text" ? this.textValue : this.children.map((c) => c.textContent).join("");
  }
  public set textContent(value: string) {
    this.children = [];
    if (this.tagName === "#text") this.textValue = value;
    else if (value !== "") this.appendChild(Object.assign(new FakeNode("#text"), { textValue: value }));
  }
  public appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  public replaceChildren(...nodes: FakeNode[]): void {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
}

class FakeElement extends FakeNode {
  public className = "";
  public id = "";
  public title = "";
  public value = "";
  public placeholder = "";
  public type = "";
  public disabled = false;
  public selectionStart: number | undefined;
  public selectionEnd: number | undefined;
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public listeners: Record<string, Array<(event: unknown) => void>> = {};
  public constructor(tagName: string, private readonly doc: FakeDocument) {
    super(tagName);
    if (tagName === "textarea" || tagName === "input") {
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
  }
  public set innerHTML(_value: string) {
    throw new Error("innerHTML must never be used by the webview");
  }
  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  public addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  public dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault: () => undefined, ...event });
  }
  public focus(): void {
    this.doc.activeElement = this;
  }
  public setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeDocument {
  public activeElement: FakeElement | null = null;
  public readonly created: FakeElement[] = [];
  public readonly app: FakeElement;
  public constructor() {
    this.app = new FakeElement("div", this);
    this.app.id = "app";
  }
  public createElement(tag: string): FakeElement {
    const element = new FakeElement(tag, this);
    this.created.push(element);
    return element;
  }
  public createTextNode(text: string): FakeNode {
    return Object.assign(new FakeNode("#text"), { textValue: text });
  }
  public getElementById(id: string): FakeElement | null {
    const walk = (node: FakeNode): FakeElement | null => {
      if (node instanceof FakeElement && node.id === id) return node;
      for (const child of node.children) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.app);
  }
}

interface View {
  document: FakeDocument;
  posted: Array<Record<string, unknown>>;
  send(message: unknown): void;
  find(predicate: (el: FakeElement) => boolean): FakeElement[];
  button(label: string): FakeElement | undefined;
}

function loadView(): View {
  const document = new FakeDocument();
  const posted: Array<Record<string, unknown>> = [];
  const windowListeners: Array<(event: { data: unknown }) => void> = [];
  const sandbox = {
    document,
    // JSON round-trip: postMessage structured-clones, and it strips the vm realm's prototypes.
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(message))) }),
    window: { addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => windowListeners.push(listener) },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(PLACEHOLDER_VIEW_JS, sandbox);
  const find = (predicate: (el: FakeElement) => boolean): FakeElement[] => {
    const results: FakeElement[] = [];
    const walk = (node: FakeNode) => {
      if (node instanceof FakeElement && predicate(node)) results.push(node);
      node.children.forEach(walk);
    };
    walk(document.app);
    return results;
  };
  return {
    document,
    posted,
    send: (message) => windowListeners.forEach((listener) => listener({ data: message })),
    find,
    button: (label) => find((el) => el.tagName === "button" && el.textContent === label)[0],
  };
}

function repoState(overrides: Partial<RepoIdentityState> = {}): RepoIdentityState {
  return {
    repositoryPresent: true,
    repoKey: "/work/acme/.git",
    repoName: "acme",
    repoRoot: "/work/acme",
    enforcement: { state: "unassigned", commitEnforced: false, push: "none", repairAvailable: false, unlockAvailable: false },
    notes: [],
    ...overrides,
  };
}

const ACTIVE_ASSIGNMENT: RepoIdentityState["assignment"] = {
  identityId: "work",
  identityLabel: "Work",
  gitName: "Danish Irfan",
  gitEmail: "work@example.com",
  assignedAt: 1,
  identityStillDefined: true,
};

function wire(state: RepoIdentityState, options: { trusted?: boolean } = {}): WireState {
  return toWireState({
    repos: [{ id: "/work/acme", state }],
    selectedId: "/work/acme",
    identities: [
      { id: "work", label: "Work", gitName: "Danish Irfan", gitEmail: "work@example.com" },
      { id: "personal", label: "Personal", gitEmail: "me@example.com", expectedGitHubLogin: "danish", trustedSshHostAliases: ["github-personal"] },
    ],
    identityProblems: [],
    isWorkspaceTrusted: options.trusted ?? true,
  });
}

// ==================== static safety ====================

test("the webview client never parses HTML or evaluates code", () => {
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
    assert.equal(PLACEHOLDER_VIEW_JS.includes(forbidden), false, `placeholder client uses ${forbidden}`);
  }
});

test("on load the client posts 'ready' and renders a loading state", () => {
  const view = loadView();
  assert.deepEqual(view.posted, [{ type: "ready" }]);
  assert.match(view.document.app.textContent, /Loading/);
});

// ==================== XSS ====================

test("XSS: note text, repository name, identity label and reasons are inserted as text — never as markup", () => {
  const view = loadView();
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  view.send({
    type: "state",
    payload: wire(
      repoState({
        repoName: payload,
        assignment: { ...ACTIVE_ASSIGNMENT!, identityLabel: payload },
        enforcement: { state: "needs_attention", reason: payload, commitEnforced: true, push: "not_configured", repairAvailable: true, unlockAvailable: true },
        notes: [{ id: "n1", text: payload, pinned: false, createdAt: 1 }],
      }),
    ),
  });
  assert.equal(view.document.created.some((el) => el.tagName === "img" || el.tagName === "script"), false, "no element may be created from data");
  assert.ok(view.find((el) => el.tagName === "h2")[0].textContent === payload);
  assert.equal(view.find((el) => el.className === "rig-note-text")[0].textContent, payload);
  assert.equal(view.document.getElementById("lockReason")?.textContent, payload);
});

test("multiline note text is kept exactly (newlines included) in the rendered text and the edit textarea", () => {
  const view = loadView();
  const text = "line one\nline two\n\tindented $(echo not-run)";
  view.send({ type: "state", payload: wire(repoState({ notes: [{ id: "n1", text, pinned: false, createdAt: 1 }] })) });
  assert.equal(view.find((el) => el.className === "rig-note-text")[0].textContent, text);
  view.button("Edit")!.dispatch("click");
  assert.equal(view.document.getElementById("editNoteText")?.value, text);
});

// ==================== drafts are never lost ====================

test("a new-note draft survives every state push, survives a failed save, and is cleared only on a successful ack", () => {
  const view = loadView();
  view.send({ type: "state", payload: wire(repoState()) });
  const composer = view.document.getElementById("newNoteText")!;
  composer.value = "half-written note";
  composer.dispatch("input");

  // Background refreshes (file watcher, another repo changing) re-render.
  view.send({ type: "state", payload: wire(repoState()) });
  view.send({ type: "state", payload: wire(repoState({ enforcement: { state: "active", commitEnforced: true, push: "not_configured", repairAvailable: false, unlockAvailable: true }, assignment: ACTIVE_ASSIGNMENT })) });
  assert.equal(view.document.getElementById("newNoteText")?.value, "half-written note");

  view.button("Add note")!.dispatch("click");
  const add = view.posted.find((m) => m.type === "addNote")!;
  assert.equal(add.text, "half-written note");

  view.send({ type: "noteResult", requestId: add.requestId, ok: false, error: "too long" });
  view.send({ type: "state", payload: wire(repoState()) });
  assert.equal(view.document.getElementById("newNoteText")?.value, "half-written note", "a failed save keeps the draft");

  view.button("Add note")!.dispatch("click");
  const retry = view.posted.filter((m) => m.type === "addNote").at(-1)!;
  view.send({ type: "noteResult", requestId: "some-other-request", ok: true });
  assert.equal(view.document.getElementById("newNoteText")?.value, "half-written note", "an unrelated ack changes nothing");
  view.send({ type: "noteResult", requestId: retry.requestId, ok: true });
  assert.equal(view.document.getElementById("newNoteText")?.value, "");
});

test("an edit draft survives state pushes and is cleared only when its save is acknowledged", () => {
  const view = loadView();
  const notes = [{ id: "n1", text: "original", pinned: false, createdAt: 1 }];
  view.send({ type: "state", payload: wire(repoState({ notes })) });
  view.button("Edit")!.dispatch("click");
  const editor = view.document.getElementById("editNoteText")!;
  editor.value = "edited but not saved";
  editor.dispatch("input");

  view.send({ type: "state", payload: wire(repoState({ notes })) });
  assert.equal(view.document.getElementById("editNoteText")?.value, "edited but not saved");

  view.button("Save")!.dispatch("click");
  const update = view.posted.find((m) => m.type === "updateNote")!;
  assert.deepEqual({ id: update.id, text: update.text }, { id: "n1", text: "edited but not saved" });
  view.send({ type: "noteResult", requestId: update.requestId, ok: false });
  assert.equal(view.document.getElementById("editNoteText")?.value, "edited but not saved");

  view.button("Save")!.dispatch("click");
  const retry = view.posted.filter((m) => m.type === "updateNote").at(-1)!;
  view.send({ type: "noteResult", requestId: retry.requestId, ok: true });
  assert.equal(view.document.getElementById("editNoteText"), null, "edit mode ends after a successful save");
});

// ==================== actions ====================

test("Copy asks the host for the note by id (the host copies the stored text); nothing in the client runs a note", () => {
  const view = loadView();
  view.send({ type: "state", payload: wire(repoState({ notes: [{ id: "n1", text: "npm run deploy", pinned: false, createdAt: 1 }] })) });
  view.button("Copy")!.dispatch("click");
  assert.deepEqual(view.posted.at(-1), { type: "copyNote", id: "n1" });
  assert.equal(view.find((el) => el.tagName === "button" && /run|exec|terminal/i.test(el.textContent)).length, 0);
});

test("unassigned repository: says Git is not restricted, offers Assign (posting the chosen identity), no Unlock/Repair", () => {
  const view = loadView();
  view.send({ type: "state", payload: wire(repoState()) });
  assert.equal(view.document.getElementById("lockState")?.textContent, "Not locked");
  assert.match(view.document.app.textContent, /does not restrict Git in this repository/);
  assert.equal(view.button("Unlock"), undefined);
  assert.equal(view.button("Repair"), undefined);
  view.document.getElementById("identityPicker")!.value = "personal";
  view.button("Assign identity")!.dispatch("click");
  assert.deepEqual(view.posted.at(-1), { type: "assignIdentity", identityId: "personal" });
});

test("assigned repository: shows the identity, offers Change (excluding the current identity) and Unlock", () => {
  const view = loadView();
  view.send({
    type: "state",
    payload: wire(repoState({ assignment: ACTIVE_ASSIGNMENT, enforcement: { state: "active", commitEnforced: true, push: "not_configured", repairAvailable: false, unlockAvailable: true } })),
  });
  assert.equal(view.document.getElementById("lockState")?.textContent, "Locked");
  assert.equal(view.document.getElementById("assignedIdentity")?.textContent, "Work: Danish Irfan <work@example.com>");
  const options = view.document.getElementById("identityPicker")!.children.map((o) => (o as FakeElement).value);
  assert.deepEqual(options, ["personal"]);
  view.button("Unlock")!.dispatch("click");
  assert.deepEqual(view.posted.at(-1), { type: "unlockRepository" });
});

test("untrusted workspace: lock actions are disabled, notes stay fully usable", () => {
  const view = loadView();
  view.send({ type: "state", payload: wire(repoState({ notes: [{ id: "n1", text: "x", pinned: false, createdAt: 1 }] }), { trusted: false }) });
  assert.equal(view.button("Assign identity")?.disabled, true);
  assert.match(view.button("Assign identity")!.title, /isn't trusted/);
  for (const label of ["Add note", "Copy", "Edit", "Pin", "Delete", "Export", "Import"]) {
    assert.equal(view.button(label)?.disabled, false, label);
  }
});

test("search filters notes locally and keeps pinned notes first", () => {
  const view = loadView();
  view.send({
    type: "state",
    payload: wire(
      repoState({
        notes: [
          { id: "a", text: "Deploy steps", pinned: false, createdAt: 1 },
          { id: "b", text: "Billing contact", pinned: false, createdAt: 2 },
          { id: "c", text: "deploy keys rotate monthly", pinned: true, createdAt: 3 },
        ],
      }),
    ),
  });
  const texts = () => view.find((el) => el.className === "rig-note-text").map((el) => el.textContent);
  assert.deepEqual(texts(), ["deploy keys rotate monthly", "Deploy steps", "Billing contact"]);
  const search = view.document.getElementById("noteSearch")!;
  search.value = "DEPLOY";
  search.dispatch("input");
  assert.deepEqual(texts(), ["deploy keys rotate monthly", "Deploy steps"]);
});

// ==================== host-side message boundary ====================

function recordingActions(): { actions: SidebarActions; calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string, result?: NoteMutationResult) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result as never;
    };
  const actions: SidebarActions = {
    selectRepo: record("selectRepo"),
    assignIdentity: record("assignIdentity"),
    changeIdentity: record("changeIdentity"),
    unlockRepository: record("unlockRepository"),
    repairLock: record("repairLock"),
    checkLock: record("checkLock"),
    applyIdentityToGitConfig: record("applyIdentityToGitConfig"),
    editIdentities: record("editIdentities"),
    addNote: record("addNote", { ok: true }),
    updateNote: record("updateNote", { ok: true }),
    removeNote: record("removeNote"),
    togglePinNote: record("togglePinNote"),
    copyNote: record("copyNote"),
    exportNotes: record("exportNotes"),
    exportAllNotes: record("exportAllNotes"),
    importNotes: record("importNotes"),
  };
  return { actions, calls };
}

test("dispatch: malformed messages are dropped — never coerced, never actioned with a guessed default", async () => {
  const { actions, calls } = recordingActions();
  const replies: Array<[unknown, NoteMutationResult]> = [];
  const reply = (requestId: unknown, result: NoteMutationResult) => replies.push([requestId, result]);
  for (const message of [
    { type: "assignIdentity" },
    { type: "assignIdentity", identityId: "   " },
    { type: "assignIdentity", identityId: 42 },
    { type: "assignIdentity", identityId: { id: "work" } },
    { type: "changeIdentity", identityId: "" },
    { type: "selectRepo", id: null },
    { type: "removeNote" },
    { type: "copyNote", id: 7 },
    { type: "runCommand", command: "rm -rf /" },
    { type: "copyContextForAi" },
    { type: "enableShield" },
    { type: undefined },
    {},
  ]) {
    await dispatchSidebarMessage(actions, message as never, reply);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(replies, []);
});

test("dispatch: a note mutation always gets exactly one reply carrying its requestId (so the client can keep or clear the draft)", async () => {
  const { actions, calls } = recordingActions();
  const replies: Array<[unknown, NoteMutationResult]> = [];
  const reply = (requestId: unknown, result: NoteMutationResult) => replies.push([requestId, result]);
  await dispatchSidebarMessage(actions, { type: "addNote", text: "   ", requestId: "r1" }, reply);
  await dispatchSidebarMessage(actions, { type: "addNote", text: "hello", requestId: "r2" }, reply);
  await dispatchSidebarMessage(actions, { type: "updateNote", id: "n1", text: 5, requestId: "r3" }, reply);
  await dispatchSidebarMessage(actions, { type: "updateNote", id: "n1", text: "edited", requestId: "r4" }, reply);
  assert.deepEqual(replies.map(([id, result]) => [id, result.ok]), [
    ["r1", false],
    ["r2", true],
    ["r3", false],
    ["r4", true],
  ]);
  assert.deepEqual(calls, [
    ["addNote", "hello"],
    ["updateNote", "n1", "edited"],
  ]);
});

test("dispatch: well-formed lock messages reach the actions with exactly the requested identity", async () => {
  const { actions, calls } = recordingActions();
  await dispatchSidebarMessage(actions, { type: "assignIdentity", identityId: "work" }, () => undefined);
  await dispatchSidebarMessage(actions, { type: "changeIdentity", identityId: "personal" }, () => undefined);
  await dispatchSidebarMessage(actions, { type: "unlockRepository" }, () => undefined);
  assert.deepEqual(calls, [["assignIdentity", "work"], ["changeIdentity", "personal"], ["unlockRepository"]]);
});

// ==================== wire state ====================

test("wire state: each repository carries its own state; no workspace aggregate; no local path for the selected repository", () => {
  const assigned = repoState({ repoName: "acme", assignment: ACTIVE_ASSIGNMENT, enforcement: { state: "active", commitEnforced: true, push: "not_configured", repairAvailable: false, unlockAvailable: true } });
  const other = repoState({ repoName: "side-project", repoRoot: "/home/me/side", repoKey: "/home/me/side/.git" });
  const state = toWireState({
    repos: [
      { id: "/work/acme", state: assigned },
      { id: "/home/me/side", state: other },
    ],
    selectedId: "/work/acme",
    identities: [{ id: "work", label: "Work", gitEmail: "work@example.com", expectedGitHubLogin: "danish-work" }],
    identityProblems: ["identities[1]: gitEmail is required."],
    isWorkspaceTrusted: true,
  });
  assert.deepEqual(state.repos.map((r) => [r.name, r.enforcementState, r.assignedLabel, r.selected]), [
    ["acme", "active", "Work", true],
    ["side-project", "unassigned", undefined, false],
  ]);
  assert.equal("repoRoot" in (state.selected ?? {}), false);
  assert.equal(state.identities[0].push, "unverifiable");
  assert.deepEqual(state.identityProblems, ["identities[1]: gitEmail is required."]);
  const serialized = JSON.stringify(state);
  for (const obsolete of ["aggregate", "SAFE", "capabilit", "protectedBranches", "strictPushSetup", "commands"]) {
    assert.equal(serialized.includes(obsolete), false, obsolete);
  }
});
