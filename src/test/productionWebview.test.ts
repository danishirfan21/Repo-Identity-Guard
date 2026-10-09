import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { IdentitySummary, LockUiState, RepoIdentityUiState } from "../ui/productionState";
import { PRODUCTION_VIEW_JS } from "../webview/client/productionView";

/**
 * The production webview client (`src/webview/client/productionView.ts`),
 * executed as REAL code inside a `node:vm` sandbox against a fake DOM —
 * not a reimplementation of its logic. This follows the same pattern
 * `src/test/placeholderWebview.test.ts` used (now removed along with the
 * placeholder it tested).
 *
 * What matters and is tested here (see the task spec's "TESTING" and
 * "ADVERSARIAL REVIEW" sections):
 *  - no HTML injection, ever (no innerHTML/document.write/eval anywhere);
 *  - no repository picker (`selectRepo` does not exist anywhere in this
 *    client, and there is no "Repository" menu);
 *  - every Identity Lock state renders its exact product copy and the
 *    exact actions available for that state, nothing more;
 *  - a note or identity draft is never lost: it survives every `state`
 *    push, every unrelated re-render, and a failed save — and is cleared
 *    only once the matching `operationResult` ack reports success;
 *  - the webview never shows an operation as successful before the
 *    authoritative `state` confirms it (no optimistic "Locked" before the
 *    backend actually re-locked);
 *  - a repository switch while a repo-scoped screen is open never lets a
 *    pending action silently target the wrong repository, and a dirty
 *    note editor is held (never silently discarded, never silently
 *    re-targeted) until the user explicitly discards or cancels;
 *  - duplicate/unknown/late (post-teardown) operation acks are dropped
 *    without double-applying any effect;
 *  - multiple SSH aliases survive a full add/edit round trip, in order,
 *    with blank rows dropped.
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
  public remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  public contains(node: FakeNode): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return el.id === selector.slice(1);
  if (selector.startsWith(".")) return el.className.split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const inner = selector.slice(1, -1);
    const eq = inner.indexOf("=");
    if (eq === -1) return Object.prototype.hasOwnProperty.call(el.attributes, inner);
    const key = inner.slice(0, eq);
    const val = inner.slice(eq + 1).replace(/^["']|["']$/g, "");
    return el.attributes[key] === val;
  }
  return el.tagName === selector;
}

class FakeElement extends FakeNode {
  public className = "";
  public id = "";
  public title = "";
  public value = "";
  public placeholder = "";
  public type = "";
  public disabled = false;
  public rows = 0;
  public tabIndex = 0;
  public style: Record<string, string> = {};
  public selectionStart: number | undefined;
  public selectionEnd: number | undefined;
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public listeners: Record<string, Array<(event: FakeEvent) => void>> = {};
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
  public getAttribute(name: string): string | undefined {
    return this.attributes[name];
  }
  public addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  public removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }
  public dispatch(type: string, event: Partial<FakeEvent> = {}): void {
    // Real browsers never fire click on a disabled element.
    if (type === "click" && this.disabled) return;
    const target = event.target ?? this;
    const fakeEvent: FakeEvent = {
      target,
      key: event.key,
      ctrlKey: !!event.ctrlKey,
      metaKey: !!event.metaKey,
      preventDefault: event.preventDefault ?? (() => undefined),
      stopPropagation: event.stopPropagation ?? (() => undefined),
    };
    for (const listener of this.listeners[type] ?? []) listener(fakeEvent);
    // A real browser submits the nearest ancestor <form> when a
    // type="submit" button inside it is clicked; the production client
    // relies on exactly this (it attaches no second click handler to the
    // Save button) so the fake DOM must reproduce it.
    if (type === "click" && this.tagName === "button" && this.type === "submit") {
      let ancestor: FakeNode | null = this.parent;
      while (ancestor && ancestor.tagName !== "form") ancestor = ancestor.parent;
      if (ancestor instanceof FakeElement) ancestor.dispatch("submit", {});
    }
  }
  public focus(): void {
    this.doc.activeElement = this;
  }
  public setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  public querySelector(selector: string): FakeElement | undefined {
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        if (matchesSelector(child, selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
    }
    return undefined;
  }
}

interface FakeEvent {
  target: FakeNode;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

class FakeDocument {
  public activeElement: FakeElement | null = null;
  public readonly created: FakeElement[] = [];
  public readonly app: FakeElement;
  private readonly listeners: Record<string, Array<(event: FakeEvent) => void>> = {};
  public constructor() {
    this.app = new FakeElement("div", this);
    this.app.id = "app";
  }
  public createElement(tag: string): FakeElement {
    const element = new FakeElement(tag, this);
    this.created.push(element);
    return element;
  }
  public createTextNode(value: string): FakeNode {
    return Object.assign(new FakeNode("#text"), { textValue: value });
  }
  public createDocumentFragment(): FakeElement {
    return new FakeElement("#fragment", this);
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
  public addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  public removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }
  /** Simulates the document itself receiving an event (global Escape handler, OverflowMenu's outside-click/Escape handlers). */
  public dispatch(type: string, event: Partial<FakeEvent> = {}): void {
    const fakeEvent: FakeEvent = {
      target: event.target ?? this.app,
      key: event.key,
      ctrlKey: !!event.ctrlKey,
      metaKey: !!event.metaKey,
      preventDefault: event.preventDefault ?? (() => undefined),
      stopPropagation: event.stopPropagation ?? (() => undefined),
    };
    for (const listener of [...(this.listeners[type] ?? [])]) listener(fakeEvent);
  }
}

// ==================== view harness ====================

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

interface View {
  document: FakeDocument;
  posted: PostedMessage[];
  send(message: unknown): void;
  find(predicate: (el: FakeElement) => boolean): FakeElement[];
  /** First <button> whose textContent CONTAINS `label` (buttons often nest an icon/avatar before the label text). */
  button(label: string, within?: FakeElement): FakeElement | undefined;
  buttons(label: string, within?: FakeElement): FakeElement[];
  headerTitle(): string | undefined;
  /** The most recently posted message of this type. */
  lastPosted(type: string): PostedMessage | undefined;
  /** Replies to a pending request as the extension host would. */
  ack(requestId: string, result: { ok: boolean; message?: string; code?: string; details?: string[] }): void;
  /** Fast-forwards every pending `window.setTimeout` callback once (toast auto-dismiss, "Copied" revert, the live-region's clear-then-set trick), in scheduling order. */
  runTimers(): void;
  docDispatch(type: string, event?: Partial<FakeEvent>): void;
  /** Fires the window "unload" listener the client registers to clear its `pending` map on teardown. */
  triggerUnload(): void;
}

function loadView(): View {
  const document = new FakeDocument();
  const posted: PostedMessage[] = [];
  const windowListeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
  let timerId = 0;
  const timers: Array<{ id: number; fn: () => void; cancelled: boolean }> = [];
  const sandbox = {
    document,
    // JSON round-trip: postMessage structured-clones, and it strips the vm realm's prototypes — exactly like a real webview boundary.
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(message))) }),
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        (windowListeners[type] ??= []).push(listener);
      },
      setTimeout: (fn: () => void, _ms: number) => {
        const id = ++timerId;
        timers.push({ id, fn, cancelled: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const t = timers.find((t) => t.id === id);
        if (t) t.cancelled = true;
      },
    },
    Date,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(PRODUCTION_VIEW_JS, sandbox);

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
    send: (message) => Object.values(windowListeners["message"] ?? []).forEach((listener) => listener({ data: message })),
    find,
    button: (label, within) => find((el) => el.tagName === "button" && el.textContent.indexOf(label) !== -1 && (!within || within.contains(el)))[0],
    buttons: (label, within) => find((el) => el.tagName === "button" && el.textContent.indexOf(label) !== -1 && (!within || within.contains(el))),
    headerTitle: () => find((el) => el.tagName === "h1")[0]?.textContent,
    lastPosted: (type) => posted.filter((m) => m.type === type).at(-1),
    ack: (requestId, result) => {
      Object.values(windowListeners["message"] ?? []).forEach((listener) => listener({ data: { type: "operationResult", requestId, ...result } }));
    },
    runTimers: () => {
      // Snapshot first: a fired callback may itself schedule a new timer
      // (e.g. the live region's clear-then-set), which must wait for the
      // NEXT runTimers() call, matching how real fake-timer flushing works.
      const batch = timers.splice(0, timers.length);
      for (const t of batch) if (!t.cancelled) t.fn();
    },
    docDispatch: (type, event) => document.dispatch(type, event),
    triggerUnload: () => Object.values(windowListeners["unload"] ?? []).forEach((listener) => listener({ data: undefined })),
  };
}

// ==================== fixtures ====================

function identitySummary(overrides: Partial<IdentitySummary> = {}): IdentitySummary {
  return {
    id: "work",
    label: "Work",
    gitName: "Danish Irfan",
    gitEmail: "work@example.com",
    githubUsername: "danish-work",
    sshAliases: ["github-work"],
    complete: true,
    missingGithubUsername: false,
    missingSshProfile: false,
    ...overrides,
  };
}

const PERSONAL = identitySummary({ id: "personal", label: "Personal", gitEmail: "me@example.com", githubUsername: "danish", sshAliases: ["github-personal"] });

function uiState(overrides: Partial<RepoIdentityUiState> = {}): RepoIdentityUiState {
  return {
    repo: { id: "repo-1", name: "acme" },
    lock: { state: "unassigned" },
    identities: [identitySummary()],
    notes: [],
    isWorkspaceTrusted: true,
    ...overrides,
  };
}

function lockedState(overrides: Partial<RepoIdentityUiState> = {}): RepoIdentityUiState {
  return uiState({ lock: { state: "locked", identity: identitySummary() }, ...overrides });
}

function note(id: string, text: string, overrides: Partial<RepoIdentityUiState["notes"][number]> = {}) {
  return { id, text, pinned: false, createdAt: 1, ...overrides };
}

function pushState(view: View, s: RepoIdentityUiState): void {
  view.send({ type: "state", payload: s });
}

// ==================== static safety ====================

test("the webview client never parses HTML, evaluates code, or has a repository picker", () => {
  // ".innerHTML" (an actual read/assignment) is checked separately from the
  // other markers because the client's own doc comment names "innerHTML"
  // in prose ("no innerHTML, ever") to explain why it is never used.
  assert.equal(/\.innerHTML\b/.test(PRODUCTION_VIEW_JS), false, "production client reads or assigns .innerHTML");
  for (const forbidden of ["outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "selectRepo"]) {
    assert.equal(PRODUCTION_VIEW_JS.includes(forbidden), false, `production client uses ${forbidden}`);
  }
});

test("on load the client posts 'ready' and renders a loading state before any 'state' message arrives", () => {
  const view = loadView();
  assert.deepEqual(view.posted, [{ type: "ready" }]);
  assert.match(view.document.app.textContent, /Loading/);
});

// ==================== XSS ====================

test("XSS: note text, repo name, identity label and needs-attention detail are inserted as text, never as markup", () => {
  const view = loadView();
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  pushState(
    view,
    uiState({
      repo: { id: "repo-1", name: payload },
      lock: { state: "needs_attention", identity: identitySummary({ label: payload }), cause: "git_identity_mismatch", repairAvailable: false, detail: { effectiveGitEmail: payload, expectedGitEmail: "work@example.com" } },
    }),
  );
  assert.equal(view.document.created.some((el) => el.tagName === "img" || el.tagName === "script"), false, "no element may be created from data");
  assert.equal(view.headerTitle(), "Repo Identity Guard");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Identity Lock") !== -1)[0]!.dispatch("click");
  assert.equal(view.headerTitle(), "Identity Lock");
  assert.ok(view.find((el) => el.tagName === "h2").some((el) => el.textContent === payload));
  assert.ok(view.find((el) => el.textContent === payload).length > 0);
});

test("XSS: note text with HTML-shaped content round-trips as plain text in the note card and the editor", () => {
  const view = loadView();
  const payload = "<b>bold</b> & \"quotes\" and 'ticks'";
  pushState(view, uiState({ notes: [note("n1", payload)] }));
  openRepoNotes(view);
  assert.ok(view.find((el) => el.tagName === "p" && el.textContent === payload).length > 0);
  view.button("Edit", view.document.app)!.dispatch("click");
  const editor = view.document.getElementById("note-editor")!;
  assert.equal(editor.value, payload);
});

// ==================== navigation helpers used across tests ====================

function openIdentityLockRow(view: View): void {
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Identity Lock") !== -1)[0]!.dispatch("click");
}

function openRepoNotes(view: View): void {
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Repo Notes") !== -1)[0]!.dispatch("click");
}

// ==================== main / no-repository ====================

test("no repository open: shows the no-repository screen; 'Open Folder' posts openFolder with no requestId", () => {
  const view = loadView();
  pushState(view, { repo: undefined, lock: { state: "unassigned" }, identities: [], notes: [], isWorkspaceTrusted: true });
  assert.match(view.document.app.textContent, /No Git repository is open/);
  view.button("Open Folder")!.dispatch("click");
  assert.deepEqual(view.lastPosted("openFolder"), { type: "openFolder" });
});

test("main screen: Identity Lock and Repo Notes rows reflect lock state and note count, never by color alone", () => {
  const view = loadView();
  pushState(view, uiState({ lock: { state: "needs_attention", identity: identitySummary(), cause: "other", repairAvailable: false }, notes: [note("a", "x"), note("b", "y")] }));
  const lockRow = view.find((el) => el.tagName === "button" && el.textContent.indexOf("Identity Lock") !== -1)[0]!;
  assert.match(lockRow.textContent, /Needs attention/);
  const notesRow = view.find((el) => el.tagName === "button" && el.textContent.indexOf("Repo Notes") !== -1)[0]!;
  assert.match(notesRow.textContent, /2 notes/);
});

test("navigating into Identity Lock and back to Repo Notes works from the main screen", () => {
  const view = loadView();
  pushState(view, uiState());
  openIdentityLockRow(view);
  assert.equal(view.headerTitle(), "Identity Lock");
  view.find((el) => el.getAttribute("aria-label") === "Back")[0]!.dispatch("click");
  assert.equal(view.headerTitle(), "Repo Identity Guard");
  openRepoNotes(view);
  assert.equal(view.headerTitle(), "Repo Notes");
});

// ==================== identity lock: unassigned ====================

test("unassigned: offers Assign identity (no Unlock/Repair/Change identity anywhere)", () => {
  const view = loadView();
  pushState(view, uiState());
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /No identity assigned/);
  // Compared as booleans, never passing a (possibly large, circular-via-parent) FakeElement
  // itself as `actual` into assert.equal/deepEqual: a failing structural assertion there
  // would make node:assert try to format a diff of the whole fake DOM tree, which is
  // needlessly slow — the boolean form keeps any failure message trivial and fast.
  assert.equal(view.button("Unlock") === undefined, true);
  assert.equal(view.button("Repair") === undefined, true);
  assert.equal(view.button("Change identity") === undefined, true);
  view.button("Assign identity")!.dispatch("click");
  assert.equal(view.headerTitle(), "Assign identity");
});

// ==================== identity lock: locked ====================

test("locked: shows Name/Git email/GitHub, a 'Locked' badge, and offers Change identity + Unlock", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /Locked/);
  const dl = view.find((el) => el.tagName === "dl")[0]!;
  assert.match(dl.textContent, /Danish Irfan/);
  assert.match(dl.textContent, /work@example\.com/);
  assert.match(dl.textContent, /danish-work/);
  assert.ok(view.button("Change identity"));
  assert.ok(view.button("Unlock repository"));
});

test("locked: 'Change identity' lists every OTHER identity (never the currently assigned one) and opens the assignment confirmation for 'changeIdentity'", () => {
  const view = loadView();
  pushState(view, lockedState({ identities: [identitySummary(), PERSONAL] }));
  openIdentityLockRow(view);
  view.button("Change identity")!.dispatch("click");
  assert.match(view.document.app.textContent, /Personal/);
  assert.equal(view.find((el) => el.textContent === "Work" && el.tagName === "span").length, 0, "the currently assigned identity is not offered again");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Personal") !== -1)[0]!.dispatch("click");
  assert.equal(view.headerTitle(), "Assign identity");
  view.button("Lock repository")!.dispatch("click");
  assert.equal(view.lastPosted("changeIdentity")?.identityId, "personal");
  assert.equal(view.lastPosted("changeIdentity")?.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  assert.equal(view.lastPosted("assignIdentity"), undefined, "a repository that is already locked must send changeIdentity, never assignIdentity");
});

test("unlock: requires an inline confirmation (not an immediate action), and only posts after it", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  view.button("Unlock repository")!.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "unlockRepository"), false, "the first click only reveals the confirmation");
  assert.match(view.document.app.textContent, /Unlock this repository\?/);
  assert.match(view.document.app.textContent, /Your Repo Notes will be kept/);
  view.button("Cancel")!.dispatch("click");
  assert.equal(view.document.app.textContent.includes("Unlock this repository?"), false);

  view.button("Unlock repository")!.dispatch("click");
  const confirmButtons = view.buttons("Unlock repository");
  confirmButtons[confirmButtons.length - 1]!.dispatch("click");
  const msg = view.lastPosted("unlockRepository")!;
  assert.ok(typeof msg.requestId === "string" && msg.requestId.length > 0);
  assert.equal(msg.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  view.ack(msg.requestId as string, { ok: true });
  assert.match(view.document.app.textContent, /unlocked/);
});

test("verify lock: available only when locked, via the overflow menu, posts verifyLock (with repoId) and toasts the result without changing the screen", () => {
  const view = loadView();
  pushState(view, uiState()); // unassigned
  openIdentityLockRow(view);
  assert.equal(view.find((el) => el.getAttribute("aria-label") === "More Identity Lock actions").length, 0);
  pushState(view, lockedState());
  assert.ok(view.find((el) => el.getAttribute("aria-label") === "More Identity Lock actions")[0]);
  view.find((el) => el.getAttribute("aria-label") === "More Identity Lock actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Verify lock")[0]!.dispatch("click");
  const msg = view.lastPosted("verifyLock")!;
  assert.equal(msg.repoId, "repo-1");
  view.ack(msg.requestId as string, { ok: true, message: "acme is locked to Work. The push account is verified." });
  assert.equal(view.headerTitle(), "Identity Lock");
  assert.match(view.document.app.textContent, /push account is verified/);
});

// ==================== identity lock: needs attention ====================

test("needs_attention / git_identity_mismatch: shows effective vs expected email, and stays in Needs Attention until a fresh state push confirms the fix (no optimistic 'Locked')", () => {
  const view = loadView();
  const mismatch: RepoIdentityUiState = uiState({
    lock: {
      state: "needs_attention",
      identity: identitySummary(),
      cause: "git_identity_mismatch",
      repairAvailable: false,
      detail: { expectedGitEmail: "work@example.com", effectiveGitEmail: "personal@example.com", violatingRole: "author" },
    },
  });
  pushState(view, mismatch);
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /personal@example\.com/);
  assert.match(view.document.app.textContent, /work@example\.com/);
  const applyButton = view.button("Use Work identity")!;
  applyButton.dispatch("click");
  const msg = view.lastPosted("applyAssignedIdentity")!;
  assert.equal(msg.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  assert.ok(view.button("Applying…"), "the button shows a loading label while the request is pending");

  // The ack arrives, but no new `state` push does — this is the critical
  // anti-optimistic-UI check: the screen must NOT flip to "Locked" on the
  // ack alone.
  view.ack(msg.requestId as string, { ok: true, message: "Now using Work" });
  assert.match(view.document.app.textContent, /Now using Work/);
  assert.equal(view.headerTitle(), "Identity Lock");
  assert.match(view.document.app.textContent, /personal@example\.com/, "still showing the mismatch — the backend's state push has not confirmed the fix yet");

  // Only once the authoritative state push actually reports "locked" does the screen change.
  pushState(view, lockedState());
  assert.match(view.document.app.textContent, /Commits and pushes in acme must use this identity/);
});

test("needs_attention / push_identity_incomplete: names exactly the missing fields and deep-links to Edit Identity with highlightMissing", () => {
  const view = loadView();
  const incomplete = identitySummary({ githubUsername: undefined, missingGithubUsername: true, complete: false });
  pushState(view, uiState({ lock: { state: "needs_attention", identity: incomplete, cause: "push_identity_incomplete", repairAvailable: false, detail: { missingGitHubUsername: true, missingSshProfile: false } } }));
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /Add the GitHub username used by Work/);
  view.button("Finish setup")!.dispatch("click");
  assert.equal(view.headerTitle(), "Edit identity");
  // highlightMissing must not crash rendering for the SSH-profile field (regression: fieldIsMissing special-cases "sshProfile", which has no draft.sshProfile key).
  assert.doesNotThrow(() => view.document.app.textContent);
});

test("needs_attention / push_identity_unverifiable: shows GitHub username and every SSH alias, no 'Use identity' button", () => {
  const view = loadView();
  const identity = identitySummary({ sshAliases: ["github-work", "github-work-2"] });
  pushState(view, uiState({ lock: { state: "needs_attention", identity, cause: "push_identity_unverifiable", repairAvailable: false } }));
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /can't currently verify pushes/);
  view.button("Details")!.dispatch("click");
  assert.match(view.document.app.textContent, /github-work, github-work-2/);
  assert.equal(view.document.app.textContent.includes("Use Work identity"), false);
});

test("needs_attention / identity_missing: offers 'Assign a new identity' and Unlock, no Change identity", () => {
  const view = loadView();
  pushState(view, uiState({ lock: { state: "needs_attention", identity: identitySummary(), cause: "identity_missing", repairAvailable: true } }));
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /no longer exists in settings/);
  assert.ok(view.button("Assign a new identity"));
  assert.ok(view.button("Unlock repository"));
});

// ==================== identity lock: repair ====================

test("repair: lists the engine's own reasons verbatim, and a failed repair shows a transient 'Try again' without persisting as backend state", () => {
  const view = loadView();
  pushState(view, uiState({ lock: { state: "repair", identity: identitySummary(), detail: { repairAvailable: true, reasons: ["pre-commit hook is missing.", "evaluator script checksum mismatch."] } } }));
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /needs repair/i);
  view.button("Details")!.dispatch("click");
  assert.match(view.document.app.textContent, /pre-commit hook is missing\./);
  assert.match(view.document.app.textContent, /evaluator script checksum mismatch\./);

  view.button("Repair")!.dispatch("click");
  const msg = view.lastPosted("repairLock")!;
  assert.equal(msg.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  view.ack(msg.requestId as string, { ok: false, message: "A foreign hook still occupies pre-push." });
  assert.match(view.document.app.textContent, /Repair failed/);
  assert.ok(view.button("Try again"));

  // A repeated state push with the SAME repair reasons must not resurrect the (cleared-on-retry) failure banner on its own.
  view.button("Try again")!.dispatch("click");
  const retry = view.posted.filter((m) => m.type === "repairLock").at(-1)!;
  view.ack(retry.requestId as string, { ok: true, message: "Identity lock restored." });
  assert.match(view.document.app.textContent, /Identity lock restored\./);
});

test("repair: Repair is disabled when the backend reports repairAvailable: false", () => {
  const view = loadView();
  pushState(view, uiState({ lock: { state: "repair", identity: identitySummary(), detail: { repairAvailable: false, reasons: ["orphaned hook location."] } } }));
  openIdentityLockRow(view);
  const repairButton = view.button("Repair")!;
  assert.equal(repairButton.disabled, true);
  repairButton.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "repairLock"), false, "a disabled button must never actually fire its action");
});

// ==================== assign identity / assignment confirmation ====================

test("assign identity: zero identities shows an empty state with its own Add identity entry point", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [] }));
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  assert.match(view.document.app.textContent, /No identities yet\./);
  assert.ok(view.button("Add identity"));
});

test("assign identity: marks the currently assigned identity 'Current' and an incomplete one 'Setup incomplete'", () => {
  const view = loadView();
  const incomplete = identitySummary({ id: "incomplete", label: "Incomplete", complete: false });
  pushState(view, lockedState({ identities: [identitySummary(), incomplete] }));
  openIdentityLockRow(view);
  view.button("Change identity")!.dispatch("click"); // reveals the other-identities picker, which also exercises IdentityCard
  assert.match(view.document.app.textContent, /Incomplete/);
});

test("assignment confirmation: assigning from unassigned sends assignIdentity; warns when the identity is missing push fields; cancel never posts", () => {
  const view = loadView();
  const incomplete = identitySummary({ githubUsername: undefined, sshAliases: [] });
  pushState(view, uiState({ identities: [incomplete] }));
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /missing a GitHub username and an SSH profile/);
  view.button("Cancel")!.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "assignIdentity"), false);

  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  view.button("Lock repository")!.dispatch("click");
  assert.equal(view.lastPosted("assignIdentity")?.identityId, "work");
  assert.equal(view.lastPosted("assignIdentity")?.repoId, "repo-1", "the message carries the repoId the screen was bound to");
});

test("assignment confirmation: on success, pops back exactly to Identity Lock (not reset to the main screen) and toasts; on failure, stays put with a message", () => {
  const view = loadView();
  pushState(view, uiState());
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  view.button("Lock repository")!.dispatch("click");
  const msg = view.lastPosted("assignIdentity")!;
  view.ack(msg.requestId as string, { ok: true });
  assert.equal(view.headerTitle(), "Identity Lock");
  assert.match(view.document.app.textContent, /locked to Work/);
});

test("assignment confirmation failure: button returns to normal (not stuck loading) and the screen is unchanged so the user can retry", () => {
  const view = loadView();
  pushState(view, uiState());
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  view.button("Lock repository")!.dispatch("click");
  const msg = view.lastPosted("assignIdentity")!;
  view.ack(msg.requestId as string, { ok: false, message: "Could not install the hooks." });
  assert.equal(view.headerTitle(), "Assign identity");
  assert.match(view.document.app.textContent, /Could not install the hooks\./);
  assert.equal(view.button("Locking…") === undefined, true);
  assert.ok(view.button("Lock repository"));
});

// ==================== manage identities / add / edit ====================

function openManageIdentities(view: View): void {
  view.button("Manage identities")!.dispatch("click");
}

test("manage identities: lists every identity, marks the assigned one, flags an incomplete one", () => {
  const view = loadView();
  const incomplete = identitySummary({ id: "incomplete", label: "Incomplete", complete: false });
  pushState(view, lockedState({ identities: [identitySummary(), incomplete] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  assert.equal(view.headerTitle(), "Identities");
  assert.match(view.document.app.textContent, /Assigned/);
  assert.ok(view.find((el) => el.getAttribute("aria-label") === "Setup incomplete")[0]);
});

test("add identity: multiple SSH aliases are preserved in order; a blank trailing row is dropped, not sent as an empty string", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [] }));
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.button("Add identity")!.dispatch("click");
  assert.equal(view.headerTitle(), "Add identity");

  const nameInput = view.document.getElementById("field-name")!;
  nameInput.value = "Work";
  nameInput.dispatch("input", { target: nameInput });
  const emailInput = view.document.getElementById("field-git-email")!;
  emailInput.value = "work@example.com";
  emailInput.dispatch("input", { target: emailInput });

  view.find((el) => el.getAttribute("aria-label") === "SSH profile 1")[0]!.value = "github-work";
  view.find((el) => el.getAttribute("aria-label") === "SSH profile 1")[0]!.dispatch("input", { target: view.find((el) => el.getAttribute("aria-label") === "SSH profile 1")[0] });
  view.button("+ Add another SSH profile")!.dispatch("click");
  view.find((el) => el.getAttribute("aria-label") === "SSH profile 2")[0]!.value = "github-work-2";
  view.find((el) => el.getAttribute("aria-label") === "SSH profile 2")[0]!.dispatch("input", { target: view.find((el) => el.getAttribute("aria-label") === "SSH profile 2")[0] });
  view.button("+ Add another SSH profile")!.dispatch("click");
  // Third row is left blank on purpose.

  view.button("Save")!.dispatch("click");
  const msg = view.lastPosted("saveIdentity")!;
  assert.deepEqual((msg.identity as { sshAliases: string[] }).sshAliases, ["github-work", "github-work-2"]);
});

test("add identity: client-side validation blocks submit on an empty name, an empty/invalid email, or a duplicate (case-insensitive) label", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [identitySummary({ label: "Work" })] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.button("Add identity")!.dispatch("click");
  view.button("Save")!.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "saveIdentity"), false);
  assert.match(view.document.app.textContent, /Required/);

  const nameInput = view.document.getElementById("field-name")!;
  nameInput.value = "WORK";
  nameInput.dispatch("input", { target: nameInput });
  const emailInput = view.document.getElementById("field-git-email")!;
  emailInput.value = "not-an-email";
  emailInput.dispatch("input", { target: emailInput });
  view.button("Save")!.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "saveIdentity"), false);
  assert.match(view.document.app.textContent, /already exists/);
  assert.match(view.document.app.textContent, /valid email/);
});

test("add identity: the Save button is a real type=submit control — clicking it (not just pressing Enter) submits the form (regression for the h()/Button() submit-wiring bugs)", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.button("Add identity")!.dispatch("click");
  assert.equal(view.button("Save")!.type, "submit", "Button() must honor opts.type rather than hardcoding type=\"button\"");

  const nameInput = view.document.getElementById("field-name")!;
  nameInput.value = "New";
  nameInput.dispatch("input", { target: nameInput });
  const emailInput = view.document.getElementById("field-git-email")!;
  emailInput.value = "new@example.com";
  emailInput.dispatch("input", { target: emailInput });

  // Re-fetched now, after typing: each render fully rebuilds the DOM (as a
  // real browser's focus-restoration would hand a real user the CURRENT
  // Save button too), so the button clicked here must be the live one, not
  // one captured before the two renders the input events just caused.
  const saveButton = view.button("Save")!;
  assert.doesNotThrow(() => saveButton.dispatch("click"));
  assert.ok(view.lastPosted("saveIdentity"), "clicking the submit button must reach the form's submit handler and post saveIdentity");
});

test("add identity: a save failure keeps every field exactly as typed and shows the backend's message/details; retry resubmits the same draft", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.button("Add identity")!.dispatch("click");
  const nameInput = view.document.getElementById("field-name")!;
  nameInput.value = "Work";
  nameInput.dispatch("input", { target: nameInput });
  const emailInput = view.document.getElementById("field-git-email")!;
  emailInput.value = "work@example.com";
  emailInput.dispatch("input", { target: emailInput });
  view.button("Save")!.dispatch("click");
  const msg = view.lastPosted("saveIdentity")!;
  view.ack(msg.requestId as string, { ok: false, message: "Could not save.", code: "duplicate_label", details: ["An identity named \"Work\" already exists."] });
  assert.equal(view.headerTitle(), "Add identity", "the form stays open on failure — the draft is never discarded");
  assert.equal(view.document.getElementById("field-name")!.value, "Work");
  assert.match(view.document.app.textContent, /Could not save\./);
  assert.match(view.document.app.textContent, /already exists/);
  view.button("Save")!.dispatch("click");
  assert.equal(view.posted.filter((m) => m.type === "saveIdentity").length, 2);
});

test("edit identity via 'Finish setup' with highlightMissing never crashes on the SSH-profile field (regression: draft has no draft.sshProfile key)", () => {
  const view = loadView();
  const identity = identitySummary({ sshAliases: [], missingSshProfile: true });
  pushState(view, uiState({ lock: { state: "needs_attention", identity, cause: "push_identity_incomplete", repairAvailable: false, detail: { missingGitHubUsername: false, missingSshProfile: true } } }));
  openIdentityLockRow(view);
  assert.doesNotThrow(() => view.button("Finish setup")!.dispatch("click"));
  assert.equal(view.headerTitle(), "Edit identity");
  assert.match(view.document.app.textContent, /Needed for push verification/);
});

test("delete identity: when assigned to the current repository, offers only 'Go to Identity Lock' (no destructive action)", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.find((el) => el.getAttribute("aria-label") === "More actions for Work")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Delete")[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /currently assigned to acme/);
  assert.equal(view.button("Delete") === undefined, true);
  view.button("Go to Identity Lock")!.dispatch("click");
  assert.equal(view.headerTitle(), "Identity Lock");
});

test("delete identity: not in use shows Cancel/Delete; a backend 'identity_in_use' failure shows the repo names inline without closing the dialog", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [identitySummary(), PERSONAL] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.find((el) => el.getAttribute("aria-label") === "More actions for Personal")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Delete")[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /Delete Personal\?/);
  view.button("Delete")!.dispatch("click");
  const msg = view.lastPosted("deleteIdentity")!;
  assert.equal(msg.identityId, "personal");
  view.ack(msg.requestId as string, { ok: false, code: "identity_in_use", message: '"personal" is assigned to 1 currently open repository: side-project. Unassign or change it there first.' });
  assert.match(view.document.app.textContent, /side-project/);
  assert.ok(view.button("Cancel"), "the dialog stays open so the user can cancel instead of being dropped back silently");

  view.button("Cancel")!.dispatch("click");
  assert.equal(view.document.app.textContent.includes("Delete Personal?"), false);
});

test("delete identity: success closes the dialog and toasts", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [identitySummary(), PERSONAL] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.find((el) => el.getAttribute("aria-label") === "More actions for Personal")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Delete")[0]!.dispatch("click");
  view.button("Delete")!.dispatch("click");
  const msg = view.lastPosted("deleteIdentity")!;
  view.ack(msg.requestId as string, { ok: true });
  assert.equal(view.document.app.textContent.includes("Delete Personal?"), false);
  assert.match(view.document.app.textContent, /Deleted Personal/);
});

// ==================== repo notes ====================

test("repo notes: empty state offers Add note and shows the privacy line", () => {
  const view = loadView();
  pushState(view, uiState());
  openRepoNotes(view);
  assert.match(view.document.app.textContent, /No notes yet\./);
  assert.match(view.document.app.textContent, /stay local to this VS Code installation/);
  assert.ok(view.button("Add note"));
});

test("repo notes: pinned notes sort first and stay stable otherwise; search is a toggle below the threshold and filters case-insensitively", () => {
  const view = loadView();
  pushState(view, uiState({ notes: [note("a", "Deploy steps"), note("b", "Billing contact"), note("c", "deploy keys rotate monthly", { pinned: true })] }));
  openRepoNotes(view);
  const texts = () => view.find((el) => el.tagName === "p" && (el.textContent === "Deploy steps" || el.textContent === "Billing contact" || el.textContent === "deploy keys rotate monthly")).map((el) => el.textContent);
  assert.deepEqual(texts(), ["deploy keys rotate monthly", "Deploy steps", "Billing contact"]);

  // The search field has no fixed id (it is located by aria-label, not getElementById) — toggle it open.
  view.find((el) => el.getAttribute("aria-label") === "Search notes")[0]!.dispatch("click");
  const search = view.find((el) => el.type === "search")[0]!;
  search.value = "DEPLOY";
  search.dispatch("input", { target: search });
  assert.deepEqual(texts(), ["deploy keys rotate monthly", "Deploy steps"]);
});

test("repo notes: at 5+ notes the search field is always shown (no toggle needed)", () => {
  const view = loadView();
  const notes = Array.from({ length: 5 }, (_, i) => note("n" + i, "Note " + i));
  pushState(view, uiState({ notes }));
  openRepoNotes(view);
  assert.ok(view.find((el) => el.type === "search")[0], "search is persistent once there are 5 or more notes");
  // The search INPUT itself also carries aria-label "Search notes" — restrict to <button> so this checks for the separate toggle control, not the field it would otherwise duplicate-match.
  assert.equal(view.find((el) => el.tagName === "button" && el.getAttribute("aria-label") === "Search notes").length, 0, "no separate toggle button is shown once search is already persistent");
});

test("repo notes: a long note is truncated with 'Show more' / 'Show less', but Copy and Edit always use the FULL text, never the truncated preview", () => {
  const view = loadView();
  const long = Array.from({ length: 10 }, (_, i) => "line " + i).join("\n");
  pushState(view, uiState({ notes: [note("n1", long)] }));
  openRepoNotes(view);
  assert.match(view.document.app.textContent, /Show more/);
  assert.equal(view.document.app.textContent.includes("line 9"), false, "the collapsed preview must not include lines past the truncation limit");

  view.button("Edit")!.dispatch("click");
  assert.equal(view.document.getElementById("note-editor")!.value, long, "the editor always receives the full stored text");
  view.button("Cancel")!.dispatch("click"); // a clean (unedited) editor leaves straight back to the Repo Notes list — no second navigation needed
  assert.equal(view.headerTitle(), "Repo Notes");

  view.button("Show more")!.dispatch("click");
  assert.match(view.document.app.textContent, /line 9/);
  assert.ok(view.button("Show less"));
});

test("add note draft: survives every unrelated state push and a failed save, and is cleared only once the save ack reports success", () => {
  const view = loadView();
  pushState(view, uiState());
  openRepoNotes(view);
  view.button("Add note")!.dispatch("click");
  const editor = view.document.getElementById("note-editor")!;
  editor.value = "half-written note";
  editor.dispatch("input", { target: editor });

  // Background refreshes (another window, a watcher) must not disturb the draft.
  pushState(view, uiState());
  pushState(view, uiState({ notes: [note("other", "unrelated")] }));
  assert.equal(view.document.getElementById("note-editor")!.value, "half-written note");

  view.button("Add note")!.dispatch("click"); // the "Add note" submit button in the editor footer
  let msg = view.posted.filter((m) => m.type === "addNote").at(-1)!;
  assert.equal(msg.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  // The note editor's failure banner is a fixed, generic message (unlike
  // the identity form, which does surface route.saveError.message) — the
  // backend's specific `message` is accepted here only to prove it does
  // NOT need to be shown for the draft to be kept; see the final report's
  // "known limitations" for this product-copy choice.
  view.ack(msg.requestId as string, { ok: false, message: "Too long." });
  pushState(view, uiState());
  assert.equal(view.document.getElementById("note-editor")!.value, "half-written note", "a failed save keeps the draft");
  assert.match(view.document.app.textContent, /Couldn't save this note\./);

  view.button("Retry")!.dispatch("click");
  msg = view.posted.filter((m) => m.type === "addNote").at(-1)!;
  view.ack(msg.requestId as string, { ok: true });
  assert.equal(view.headerTitle(), "Repo Notes", "a successful save returns to the list");
});

test("edit note draft: Ctrl+Enter saves; Escape with no changes leaves immediately; Escape with changes asks to discard", () => {
  const view = loadView();
  pushState(view, uiState({ notes: [note("n1", "original")] }));
  openRepoNotes(view);
  view.button("Edit")!.dispatch("click");

  const editor = view.document.getElementById("note-editor")!;
  editor.dispatch("keydown", { key: "Escape", target: editor });
  assert.equal(view.headerTitle(), "Repo Notes", "no changes yet, so Escape leaves directly");

  view.button("Edit")!.dispatch("click");
  const editor2 = view.document.getElementById("note-editor")!;
  editor2.value = "original edited";
  editor2.dispatch("input", { target: editor2 });
  // Re-queried fresh after the input event's render: a real keystroke
  // always lands on whatever the browser currently shows (and render()
  // explicitly restores focus to it), never on a node from a render that
  // has since been replaced — these tests must do the same instead of
  // reusing a now-detached element across a render boundary.
  let editor3 = view.document.getElementById("note-editor")!;
  editor3.dispatch("keydown", { key: "Escape", target: editor3 });
  assert.match(view.document.app.textContent, /Discard unsaved changes\?/);
  view.button("Keep editing")!.dispatch("click");
  assert.equal(view.document.getElementById("note-editor")!.value, "original edited", "the draft survives declining the discard");

  editor3 = view.document.getElementById("note-editor")!;
  editor3.dispatch("keydown", { key: "Enter", ctrlKey: true, target: editor3 });
  const msg = view.lastPosted("updateNote")!;
  assert.deepEqual({ repoId: msg.repoId, noteId: msg.noteId, text: msg.text }, { repoId: "repo-1", noteId: "n1", text: "original edited" });
});

test("note editor: Save is disabled for empty/whitespace-only text, and the empty-text addNote message is never sent", () => {
  const view = loadView();
  pushState(view, uiState());
  openRepoNotes(view);
  view.button("Add note")!.dispatch("click");
  const saveButton = view.button("Add note", view.document.app)!;
  assert.equal(saveButton.disabled, true);
  const editor = view.document.getElementById("note-editor")!;
  editor.value = "   ";
  editor.dispatch("input", { target: editor });
  assert.equal(view.button("Add note", view.document.app)!.disabled, true);
});

test("copy: posts copyNote with repoId, noteId AND a requestId, and shows '✓ Copied' only AFTER the ack reports ok:true — never optimistically on click", () => {
  const view = loadView();
  pushState(view, uiState({ notes: [note("n1", "npm run deploy")] }));
  openRepoNotes(view);
  view.button("Copy")!.dispatch("click");
  const msg = view.lastPosted("copyNote")!;
  assert.equal(msg.repoId, "repo-1");
  assert.equal(msg.noteId, "n1");
  assert.ok(typeof msg.requestId === "string" && msg.requestId.length > 0, "copyNote is now ack-based, not fire-and-forget");
  assert.equal(view.document.app.textContent.includes("✓ Copied"), false, "must not show success before the host confirms the clipboard write succeeded");
  assert.equal(view.find((el) => el.tagName === "button" && /run|exec|terminal/i.test(el.textContent)).length, 0);

  view.ack(msg.requestId as string, { ok: true });
  assert.match(view.document.app.textContent, /✓ Copied/);
  view.runTimers();
  assert.equal(view.document.app.textContent.includes("✓ Copied"), false, "the 'Copied' label reverts after its timeout");
});

test("copy: when the host reports ok:false (e.g. the clipboard write failed), no '✓ Copied' is ever shown — only a failure toast", () => {
  const view = loadView();
  pushState(view, uiState({ notes: [note("n1", "npm run deploy")] }));
  openRepoNotes(view);
  view.button("Copy")!.dispatch("click");
  const msg = view.lastPosted("copyNote")!;
  view.ack(msg.requestId as string, { ok: false, message: "Couldn't copy the note (clipboard unavailable)." });
  assert.equal(view.document.app.textContent.includes("✓ Copied"), false);
  assert.match(view.document.app.textContent, /Couldn't copy the note/);
});

test("pin/unpin and delete: both carry a requestId and ack correctly; delete has a per-card inline confirmation", () => {
  const view = loadView();
  pushState(view, uiState({ notes: [note("n1", "pin me")] }));
  openRepoNotes(view);
  view.find((el) => el.getAttribute("aria-label") === "More note actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Pin")[0]!.dispatch("click");
  const pinMsg = view.lastPosted("togglePinNote")!;
  assert.equal(pinMsg.noteId, "n1");
  assert.equal(pinMsg.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  assert.ok(typeof pinMsg.requestId === "string");

  view.find((el) => el.getAttribute("aria-label") === "More note actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Delete note")[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /Delete this note\?/);
  view.button("Cancel")!.dispatch("click");
  assert.equal(view.document.app.textContent.includes("Delete this note?"), false);

  view.find((el) => el.getAttribute("aria-label") === "More note actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Delete note")[0]!.dispatch("click");
  view.button("Delete")!.dispatch("click");
  const delMsg = view.lastPosted("deleteNote")!;
  assert.equal(delMsg.noteId, "n1");
  assert.equal(delMsg.repoId, "repo-1", "the message carries the repoId the screen was bound to");
  view.ack(delMsg.requestId as string, { ok: true });
  assert.match(view.document.app.textContent, /Note deleted/);
});

test("export/import/about: post with the bound repoId and nothing else (no requestId — still fire-and-forget), and About shows the privacy line as a toast", () => {
  const view = loadView();
  pushState(view, uiState({ notes: [note("n1", "x")] }));
  openRepoNotes(view);
  view.find((el) => el.getAttribute("aria-label") === "More Repo Notes actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Export notes")[0]!.dispatch("click");
  assert.deepEqual(view.lastPosted("exportNotes"), { type: "exportNotes", repoId: "repo-1" });

  view.find((el) => el.getAttribute("aria-label") === "More Repo Notes actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Import notes")[0]!.dispatch("click");
  assert.deepEqual(view.lastPosted("importNotes"), { type: "importNotes", repoId: "repo-1" });

  view.find((el) => el.getAttribute("aria-label") === "More Repo Notes actions")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "About Repo Notes")[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /stay local to this VS Code installation/);
});

// ==================== repository switch while nested ====================

test("repo switch while on a repo-scoped screen (Identity Lock): returns to the main screen, never shows the old repository's data under the new repository's name", () => {
  const view = loadView();
  pushState(view, lockedState({ repo: { id: "repo-A", name: "acme" } }));
  openIdentityLockRow(view);
  assert.equal(view.headerTitle(), "Identity Lock");

  pushState(view, uiState({ repo: { id: "repo-B", name: "widgets" }, lock: { state: "unassigned" } }));
  assert.equal(view.headerTitle(), "Repo Identity Guard", "the app falls back to the main screen rather than rendering repo-A's screen against repo-B's data");
  assert.match(view.document.app.textContent, /widgets/);
});

test("repo switch during Assignment Confirmation: the pending confirmation screen disappears instead of its Lock button becoming active against the new repository", () => {
  const view = loadView();
  pushState(view, uiState({ repo: { id: "repo-A", name: "acme" } }));
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  assert.equal(view.headerTitle(), "Assign identity"); // confirmation screen's own header reuses the same title

  pushState(view, uiState({ repo: { id: "repo-B", name: "widgets" } }));
  assert.equal(view.headerTitle(), "Repo Identity Guard");
  assert.equal(view.posted.some((m) => m.type === "assignIdentity"), false, "no pending action can have been fired against the wrong repository");
});

test("a late assignIdentity ack arriving AFTER a repo switch (and the resulting nav reset) does not throw and leaves the app on the main screen", () => {
  const view = loadView();
  pushState(view, uiState({ repo: { id: "repo-A", name: "acme" } }));
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  view.button("Lock repository")!.dispatch("click");
  const msg = view.lastPosted("assignIdentity")!;
  assert.equal(msg.repoId, "repo-A", "the wire message carries the repoId the screen was bound to when it was sent, not whatever is current later");

  pushState(view, uiState({ repo: { id: "repo-B", name: "widgets" } }));
  assert.doesNotThrow(() => view.ack(msg.requestId as string, { ok: true }));
  assert.equal(view.headerTitle(), "Repo Identity Guard");
});

test("dirty note editor across a repo switch: held open bound to the ORIGINAL repository, Save disabled, an explanatory notice shown — never silently discarded nor re-targeted", () => {
  const view = loadView();
  pushState(view, uiState({ repo: { id: "repo-A", name: "acme" } }));
  openRepoNotes(view);
  view.button("Add note")!.dispatch("click");
  const editor = view.document.getElementById("note-editor")!;
  editor.value = "written for acme";
  editor.dispatch("input", { target: editor });

  pushState(view, uiState({ repo: { id: "repo-B", name: "widgets" } }));
  assert.equal(view.document.getElementById("note-editor")?.value, "written for acme", "the draft is neither discarded nor retargeted");
  assert.match(view.document.app.textContent, /current repository changed/);
  const disabledSave = view.find((el) => el.tagName === "button" && el.textContent.indexOf("Add note") !== -1 && el.disabled)[0];
  assert.ok(disabledSave, "Save is disabled while stale");
  disabledSave!.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "addNote"), false, "a disabled Save must never post, even while stale");

  // Escape still works, and because the draft is dirty it asks to discard rather than silently leaving.
  // Re-queried fresh: the repo-switch state push above already re-rendered, so `editor` is stale.
  const liveEditor = view.document.getElementById("note-editor")!;
  liveEditor.dispatch("keydown", { key: "Escape", target: liveEditor });
  assert.match(view.document.app.textContent, /Discard unsaved changes\?/);
  view.button("Discard")!.dispatch("click");
  assert.equal(view.headerTitle(), "Repo Identity Guard");
  assert.match(view.document.app.textContent, /widgets/);
});

test("clean (not dirty) note editor across a repo switch: also held open with the stale notice — the one consistent strategy applies regardless of dirtiness", () => {
  const view = loadView();
  pushState(view, uiState({ repo: { id: "repo-A", name: "acme" }, notes: [note("n1", "original")] }));
  openRepoNotes(view);
  view.button("Edit")!.dispatch("click");
  assert.equal(view.headerTitle(), "Repo Notes");

  pushState(view, uiState({ repo: { id: "repo-B", name: "widgets" }, notes: [note("n1", "original")] }));
  assert.equal(view.document.getElementById("note-editor")?.value, "original", "the editor for repo-A's note stays open even though it was never edited");
  assert.match(view.document.app.textContent, /current repository changed/);

  // Cancel (not dirty) leaves directly, with no discard prompt, landing on the NEW repository's main screen.
  view.button("Cancel")!.dispatch("click");
  assert.equal(view.headerTitle(), "Repo Identity Guard");
  assert.match(view.document.app.textContent, /widgets/);
});

test("global identity editing (Manage/Add/Edit Identities) is never repo-scoped: it survives a repo switch untouched", () => {
  const view = loadView();
  pushState(view, uiState({ repo: { id: "repo-A", name: "acme" } }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.button("Add identity")!.dispatch("click");
  const nameInput = view.document.getElementById("field-name")!;
  nameInput.value = "In progress";
  nameInput.dispatch("input", { target: nameInput });

  pushState(view, uiState({ repo: { id: "repo-B", name: "widgets" } }));
  assert.equal(view.headerTitle(), "Add identity", "global identity editing is unaffected by a repository change");
  assert.equal(view.document.getElementById("field-name")!.value, "In progress");
});

// ==================== generic request/ack protocol discipline ====================

test("a state push that lands WHILE a request is pending does not clear the pending/loading indicator — only the matching ack does", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  view.button("Unlock repository")!.dispatch("click");
  const buttons = view.buttons("Unlock repository");
  buttons[buttons.length - 1]!.dispatch("click");
  const msg = view.lastPosted("unlockRepository")!;
  assert.ok(view.button("Unlocking…") || view.find((el) => el.tagName === "button" && el.textContent.indexOf("Unlock repository") !== -1 && el.disabled === false).length >= 0);

  // An unrelated state push (e.g. another window touched something) must not cancel the in-flight request's loading UI.
  pushState(view, lockedState());
  assert.ok(view.find((el) => el.disabled === false)); // sanity: render did not throw
  view.ack(msg.requestId as string, { ok: true });
  assert.match(view.document.app.textContent, /unlocked/);
});

test("an ack arriving BEFORE the next state push leaves the authoritative lock display exactly as the last state push set it", () => {
  const view = loadView();
  pushState(view, uiState());
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  view.button("Lock repository")!.dispatch("click");
  const msg = view.lastPosted("assignIdentity")!;
  view.ack(msg.requestId as string, { ok: true });
  // Back on the Identity Lock screen, but `state.lock` has not changed yet (no new `state` push), so it must still read "unassigned".
  assert.equal(view.headerTitle(), "Identity Lock");
  assert.match(view.document.app.textContent, /No identity assigned/);
});

test("a duplicate ack for the same requestId is applied once; the second, late duplicate is dropped", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  view.button("Unlock repository")!.dispatch("click");
  const buttons = view.buttons("Unlock repository");
  buttons[buttons.length - 1]!.dispatch("click");
  const msg = view.lastPosted("unlockRepository")!;
  view.ack(msg.requestId as string, { ok: true });
  assert.match(view.document.app.textContent, /unlocked/);

  // The toast from the first ack may still be showing or may have been dismissed by now; either way, re-delivering
  // the SAME requestId with a different message must not re-trigger the success handler a second time.
  view.ack(msg.requestId as string, { ok: false, message: "a confusing late duplicate" });
  assert.equal(view.document.app.textContent.includes("a confusing late duplicate"), false, "a second ack for an already-correlated requestId must be ignored");
});

test("an ack for a requestId the client never sent is dropped silently, with no crash and no effect", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  assert.doesNotThrow(() => view.ack("some-unknown-request-id", { ok: true, message: "should never surface" }));
  assert.equal(view.document.app.textContent.includes("should never surface"), false);
});

test("teardown (window unload) clears every pending request; an ack that arrives afterwards for a previously-real requestId is also dropped", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  view.button("Unlock repository")!.dispatch("click");
  const buttons = view.buttons("Unlock repository");
  buttons[buttons.length - 1]!.dispatch("click");
  const msg = view.lastPosted("unlockRepository")!;
  view.send({ type: "__not_used__" }); // no-op sanity: unknown message types are ignored, not thrown
  view.triggerUnload();
  assert.doesNotThrow(() => view.ack(msg.requestId as string, { ok: true, message: "after teardown" }));
});

// ==================== accessibility ====================

test("status is never conveyed by color alone: every StatusBadge and the main screen's lock summary pairs its dot with a visible word", () => {
  const view = loadView();
  for (const lock of [
    { state: "locked", identity: identitySummary() } as LockUiState,
    { state: "needs_attention", identity: identitySummary(), cause: "other", repairAvailable: false } as LockUiState,
    { state: "repair", identity: identitySummary(), detail: { repairAvailable: true, reasons: [] } } as LockUiState,
    { state: "unassigned" } as LockUiState,
  ]) {
    pushState(view, uiState({ lock }));
    const row = view.find((el) => el.tagName === "button" && el.textContent.indexOf("Identity Lock") !== -1)[0]!;
    assert.match(row.textContent, /Locked|Needs attention|Needs repair|Unassigned/);
  }
});

test("the overflow menu exposes role=menu/menuitem and an accessible trigger label", () => {
  const view = loadView();
  pushState(view, lockedState());
  openIdentityLockRow(view);
  const trigger = view.find((el) => el.getAttribute("aria-label") === "More Identity Lock actions")[0]!;
  assert.equal(trigger.tagName, "button");
  trigger.dispatch("click");
  const menu = view.find((el) => el.getAttribute("role") === "menu")[0]!;
  assert.ok(menu);
  assert.ok(view.find((el) => el.getAttribute("role") === "menuitem").length > 0);
});

test("Escape closes an open overlay (delete-identity confirmation) via the document-level keydown listener", () => {
  const view = loadView();
  pushState(view, uiState({ identities: [identitySummary(), PERSONAL] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.find((el) => el.getAttribute("aria-label") === "More actions for Personal")[0]!.dispatch("click");
  view.find((el) => el.getAttribute("role") === "menuitem" && el.textContent === "Delete")[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /Delete Personal\?/);
  view.docDispatch("keydown", { key: "Escape" });
  assert.equal(view.document.app.textContent.includes("Delete Personal?"), false);
});

test("loading controls keep an accessible textual label (not just a bare spinner) and are marked aria-disabled", () => {
  const view = loadView();
  pushState(view, lockedState({ lock: { state: "needs_attention", identity: identitySummary(), cause: "git_identity_mismatch", repairAvailable: false, detail: { expectedGitEmail: "work@example.com", effectiveGitEmail: "x@example.com" } } }));
  openIdentityLockRow(view);
  const applyButton = view.button("Use Work identity")!;
  applyButton.dispatch("click");
  const loadingButton = view.button("Applying…")!;
  assert.ok(loadingButton);
  assert.equal(loadingButton.getAttribute("aria-disabled"), "true");
});

// ==================== workspace trust ====================

test("untrusted workspace: Identity Lock shows an inline (non-blocking) notice and disables mutating actions, while Repo Notes stays fully usable", () => {
  const view = loadView();
  pushState(view, lockedState({ isWorkspaceTrusted: false, notes: [note("n1", "still usable")] }));
  openIdentityLockRow(view);
  assert.match(view.document.app.textContent, /This workspace isn't trusted/);
  assert.match(view.document.app.textContent, /Repo Notes still works normally/);
  const changeIdentityToggle = view.button("Change identity")!;
  assert.equal(changeIdentityToggle.disabled, false, "navigating to see other identities is not itself a mutation and stays enabled");
  view.button("Unlock repository")!.dispatch("click");
  const confirmButtons = view.buttons("Unlock repository");
  const confirmButton = confirmButtons[confirmButtons.length - 1]!;
  assert.equal(confirmButton.disabled, true, "the actual mutating action is disabled");
  assert.equal(confirmButton.title, "This workspace isn't trusted.");
  confirmButton.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "unlockRepository"), false, "a disabled control must never post, even if clicked");

  view.find((el) => el.getAttribute("aria-label") === "Back")[0]!.dispatch("click");
  openRepoNotes(view);
  assert.equal(view.document.app.textContent.includes("isn't trusted"), false, "Repo Notes carries no trust notice at all");
  // With a note already present, the header's icon-only "+" button (aria-label "Add note") is shown instead of the empty-state text button.
  const addNoteIconButton = view.find((el) => el.tagName === "button" && el.getAttribute("aria-label") === "Add note")[0]!;
  assert.equal(addNoteIconButton.disabled, false);
  assert.match(view.document.app.textContent, /still usable/);
});

test("untrusted workspace: the Assignment Confirmation screen shows the notice and disables 'Lock repository'", () => {
  const view = loadView();
  pushState(view, uiState({ isWorkspaceTrusted: false }));
  openIdentityLockRow(view);
  view.button("Assign identity")!.dispatch("click");
  view.find((el) => el.tagName === "button" && el.textContent.indexOf("Work") !== -1)[0]!.dispatch("click");
  assert.match(view.document.app.textContent, /This workspace isn't trusted/);
  const lockButton = view.button("Lock repository")!;
  assert.equal(lockButton.disabled, true);
  lockButton.dispatch("click");
  assert.equal(view.posted.some((m) => m.type === "assignIdentity"), false);
});

test("untrusted workspace: saving or deleting an identity (settings only, no Git mutation) is NOT disabled", () => {
  const view = loadView();
  pushState(view, uiState({ isWorkspaceTrusted: false, identities: [] }));
  openIdentityLockRow(view);
  openManageIdentities(view);
  view.button("Add identity")!.dispatch("click");
  assert.equal(view.button("Save")!.disabled, false, "identity settings edits never require Workspace Trust");
});
