import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ICONS_JS } from "../webview/client/icons";
import { COMPONENTS_JS } from "../webview/client/components";
import { MEMORY_VIEW_JS } from "../webview/client/memoryView";
import { NAVIGATION_JS } from "../webview/client/navigation";
import { MAIN_VIEW_JS } from "../webview/client/mainView";
import { SHIELD_VIEW_JS } from "../webview/client/shieldView";
import { DETAILS_VIEW_JS } from "../webview/client/detailsView";
import { ONBOARDING_VIEW_JS } from "../webview/client/onboardingView";
import { SETTINGS_VIEW_JS } from "../webview/client/settingsView";

/**
 * Rendering-only sandbox: no DOM event simulation, just the pure
 * `render*`/derivation functions from ICONS_JS + COMPONENTS_JS +
 * MEMORY_VIEW_JS, exactly like `webviewClient.test.ts` does for the other
 * views. `state` and `memoryEditingNoteId`/`memorySearchQuery` are set via
 * the test bridge (top-level `let` in a `vm`-run script is NOT reflected
 * as a sandbox property, only `var`/functions are, hence the bridge).
 */
const RENDER_BRIDGE_JS = `
function __setMemoryEditing(id) { memoryEditingNoteId = id; }
function __setMemorySearch(q) { memorySearchQuery = q; }
`;

function loadRenderSandbox(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    console,
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
  };
  vm.createContext(sandbox);
  vm.runInContext([ICONS_JS, COMPONENTS_JS, MEMORY_VIEW_JS, RENDER_BRIDGE_JS].join("\n"), sandbox);
  return sandbox;
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    memory: { notes: [], commands: [] },
    isWorkspaceTrusted: true,
    ...overrides,
  };
}

function run(sandbox: Record<string, unknown>, script: string): unknown {
  return vm.runInContext(script, sandbox as never);
}

// ==================== escaping / XSS ====================

test("note content escaping: a note's text is HTML-escaped, never rendered as live markup", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({ memory: { notes: [{ id: "n1", text: '<img src=x onerror="alert(1)">', pinned: false, createdAt: 1 }], commands: [] } })) + ";");
  const html = run(sandbox, "renderMemory()") as string;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("saved command label/command text is HTML-escaped", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({ memory: { notes: [], commands: [{ id: "c1", label: '<script>evil()</script>', command: 'rm -rf / "; <b>', createdAt: 1 }] } })) + ";");
  const html = run(sandbox, "renderMemory()") as string;
  assert.doesNotMatch(html, /<script>evil/);
  assert.doesNotMatch(html, /<b>/);
});

// ==================== multiline rendering ====================

test("multiline notes: line breaks are preserved in the rendered text and the container uses pre-wrap so they actually display", () => {
  const sandbox = loadRenderSandbox();
  const text = "line one\nline two\nline three";
  run(sandbox, "state = " + JSON.stringify(baseState({ memory: { notes: [{ id: "n1", text, pinned: false, createdAt: 1 }], commands: [] } })) + ";");
  const html = run(sandbox, "renderMemory()") as string;
  assert.match(html, /line one\nline two\nline three/, "the raw newline characters must survive escaping");
  assert.match(html, /whitespace-pre-wrap/, "the note text container must preserve whitespace/newlines visually");
});

test("multiline notes: the edit textarea also contains the full unmangled multiline text", () => {
  const sandbox = loadRenderSandbox();
  const text = "first line\nsecond line";
  run(sandbox, "state = " + JSON.stringify(baseState({ memory: { notes: [{ id: "n1", text, pinned: false, createdAt: 1 }], commands: [] } })) + ";");
  run(sandbox, '__setMemoryEditing("n1");');
  const html = run(sandbox, "renderMemory()") as string;
  assert.match(html, /<textarea[^>]*id="editNoteText"[^>]*>first line\nsecond line<\/textarea>/);
});

// ==================== edit-mode rendering ====================

test("edit mode: the note being edited renders a textarea + Save/Cancel instead of its normal view", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({ memory: { notes: [{ id: "n1", text: "editable", pinned: false, createdAt: 1 }], commands: [] } })) + ";");
  run(sandbox, '__setMemoryEditing("n1");');
  const html = run(sandbox, "renderMemory()") as string;
  assert.match(html, /id="editNoteText"/);
  assert.match(html, /id="editNoteSave"/);
  assert.match(html, /id="editNoteCancel"/);
  assert.doesNotMatch(html, /data-edit-note="n1"/, "the Edit button itself should not still be shown for the note currently being edited");
});

test("edit mode: a note NOT being edited still renders normally even while another note is being edited", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: {
      notes: [
        { id: "n1", text: "being edited", pinned: false, createdAt: 1 },
        { id: "n2", text: "not being edited", pinned: false, createdAt: 1 },
      ],
      commands: [],
    },
  })) + ";");
  run(sandbox, '__setMemoryEditing("n1");');
  const html = run(sandbox, "renderMemory()") as string;
  assert.match(html, /data-edit-note="n2"/);
  assert.match(html, /not being edited/);
});

test("edit mode: a pinned note being edited still shows its pinned styling context, not the plain list editor markup", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({ memory: { notes: [{ id: "n1", text: "pinned + editing", pinned: true, createdAt: 1 }], commands: [] } })) + ";");
  run(sandbox, '__setMemoryEditing("n1");');
  const html = run(sandbox, "renderMemory()") as string;
  assert.match(html, /border-left-color:var\(--rig-warning\)/);
  assert.match(html, /id="editNoteText"/);
});

// ==================== metadata display ====================

test("note metadata: shows a created timestamp, and an edited timestamp only once updatedAt is set", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: {
      notes: [
        { id: "n1", text: "never edited", pinned: false, createdAt: 1700000000000 },
        { id: "n2", text: "edited once", pinned: false, createdAt: 1700000000000, updatedAt: 1700000100000 },
      ],
      commands: [],
    },
  })) + ";");
  const html = run(sandbox, "renderMemory()") as string;
  const addedCount = (html.match(/Added /g) || []).length;
  const editedCount = (html.match(/Edited /g) || []).length;
  assert.equal(addedCount, 2);
  assert.equal(editedCount, 1);
});

// ==================== search / filter ====================

test("search/filter: an empty query shows every note", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: { notes: [{ id: "n1", text: "alpha", pinned: false, createdAt: 1 }, { id: "n2", text: "beta", pinned: false, createdAt: 1 }], commands: [] },
  })) + ";");
  const html = run(sandbox, "renderNotesList()") as string;
  assert.match(html, /alpha/);
  assert.match(html, /beta/);
});

test("search/filter: filtering is case-insensitive substring matching", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: { notes: [{ id: "n1", text: "Run PNPM Dev from frontend", pinned: false, createdAt: 1 }, { id: "n2", text: "unrelated note", pinned: false, createdAt: 1 }], commands: [] },
  })) + ";");
  run(sandbox, '__setMemorySearch("pnpm");');
  const html = run(sandbox, "renderNotesList()") as string;
  assert.match(html, /Run PNPM Dev/);
  assert.doesNotMatch(html, /unrelated note/);
});

test("search/filter: pinned state remains visually clear among filtered results", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: {
      notes: [
        { id: "n1", text: "pinned match", pinned: true, createdAt: 1 },
        { id: "n2", text: "unpinned match", pinned: false, createdAt: 1 },
        { id: "n3", text: "totally unrelated text", pinned: false, createdAt: 1 },
      ],
      commands: [],
    },
  })) + ";");
  run(sandbox, '__setMemorySearch("match");');
  const html = run(sandbox, "renderNotesList()") as string;
  assert.match(html, /Pinned/);
  assert.match(html, /pinned match/);
  assert.match(html, /unpinned match/);
  assert.doesNotMatch(html, /totally unrelated text/);
});

test("search/filter: clearing the query restores all notes", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: { notes: [{ id: "n1", text: "alpha", pinned: false, createdAt: 1 }, { id: "n2", text: "beta", pinned: false, createdAt: 1 }], commands: [] },
  })) + ";");
  run(sandbox, '__setMemorySearch("alpha");');
  const filtered = run(sandbox, "renderNotesList()") as string;
  assert.doesNotMatch(filtered, /beta/);
  run(sandbox, '__setMemorySearch("");');
  const restored = run(sandbox, "renderNotesList()") as string;
  assert.match(restored, /alpha/);
  assert.match(restored, /beta/);
});

test("search/filter: no results shows a clear empty state naming the query", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: { notes: [{ id: "n1", text: "alpha", pinned: false, createdAt: 1 }], commands: [] },
  })) + ";");
  run(sandbox, '__setMemorySearch("zzz-no-match");');
  const html = run(sandbox, "renderNotesList()") as string;
  assert.match(html, /No notes match/);
});

test("search box is only shown once there are notes to search", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState()) + ";");
  const html = run(sandbox, "renderMemory()") as string;
  assert.doesNotMatch(html, /memorySearchInput/);
});

// ==================== accessible names ====================

test("edit/save/cancel/delete/pin controls all carry an aria-label", () => {
  const sandbox = loadRenderSandbox();
  run(sandbox, "state = " + JSON.stringify(baseState({
    memory: { notes: [{ id: "n1", text: "note", pinned: false, createdAt: 1 }], commands: [] },
  })) + ";");
  const html = run(sandbox, "renderMemory()") as string;
  assert.match(html, /aria-label="Edit note"/);
  assert.match(html, /aria-label="Pin note"/);
  assert.match(html, /aria-label="Delete note"/);

  run(sandbox, '__setMemoryEditing("n1");');
  const editingHtml = run(sandbox, "renderMemory()") as string;
  assert.match(editingHtml, /aria-label="Save note"/);
  assert.match(editingHtml, /aria-label="Cancel editing note"/);
});

// ==================== interaction wiring (full app sandbox) ====================

/**
 * A minimal, capable-enough fake DOM for exercising navigation.ts's actual
 * click/keydown/input delegation logic (not jsdom — this project doesn't
 * take that dependency; see docs/TESTING.md — just enough surface for
 * `target.closest(selector)`, `getElementById(id).value/.innerHTML`, and
 * `document.addEventListener` capture-and-replay).
 */
interface FakeElement {
  value: string;
  innerHTML: string;
  textContent: string;
  dataset: Record<string, string>;
  classList: { toggle: () => void; add: () => void; remove: () => void };
  addEventListener: () => void;
  focus: () => void;
  click: () => void;
}

function loadInteractiveSandbox(): { sandbox: Record<string, unknown>; sent: Array<{ type: string; extra?: Record<string, unknown> }>; dispatchClick: (selector: string, dataset?: Record<string, string>) => void; dispatchKeydown: (targetId: string, key: string, modifiers?: { metaKey?: boolean; ctrlKey?: boolean }) => void; dispatchInput: (targetId: string, value: string) => void; el: (id: string) => FakeElement } {
  const sent: Array<{ type: string; extra?: Record<string, unknown> }> = [];
  const elements = new Map<string, FakeElement>();

  function elementFor(id: string) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "",
        innerHTML: "",
        textContent: "",
        dataset: {},
        classList: { toggle: () => undefined, add: () => undefined, remove: () => undefined },
        addEventListener: () => undefined,
        focus: () => undefined,
        click: () => undefined,
      });
    }
    return elements.get(id)!;
  }

  const listeners: Record<string, Array<(event: unknown) => void>> = { click: [], keydown: [], input: [], change: [] };

  const sandbox: Record<string, unknown> = {
    console,
    acquireVsCodeApi: () => ({ postMessage: (msg: { type: string; [k: string]: unknown }) => sent.push({ type: msg.type, extra: msg }) }),
    document: {
      getElementById: (id: string) => elementFor(id),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        (listeners[type] ??= []).push(handler);
      },
    },
    window: { addEventListener: () => undefined },
    Element: function Element(this: unknown) {},
  };
  vm.createContext(sandbox);
  const script = [ICONS_JS, COMPONENTS_JS, MAIN_VIEW_JS, SHIELD_VIEW_JS, DETAILS_VIEW_JS, ONBOARDING_VIEW_JS, MEMORY_VIEW_JS, SETTINGS_VIEW_JS, NAVIGATION_JS].join("\n");
  vm.runInContext(script, sandbox);

  function makeTarget(idOrSelectorMatches: Record<string, boolean>): unknown {
    const target = Object.create((sandbox.Element as { prototype: object }).prototype);
    (target as { closest: (sel: string) => unknown }).closest = (sel: string) => (idOrSelectorMatches[sel] ? elementFor("__matched__" + sel) : null);
    return target;
  }

  function dispatchClick(selector: string, dataset: Record<string, string> = {}): void {
    const matched = elementFor("__matched__" + selector);
    matched.dataset = dataset;
    const target = makeTarget({ [selector]: true });
    for (const handler of listeners.click) handler({ target });
  }

  function dispatchKeydown(targetId: string, key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}): void {
    const target = Object.create((sandbox.Element as { prototype: object }).prototype);
    (target as { id: string }).id = targetId;
    (target as { closest: () => null }).closest = () => null;
    for (const handler of listeners.keydown) handler({ key, target, ...modifiers });
  }

  function dispatchInput(targetId: string, value: string): void {
    const target = Object.create((sandbox.Element as { prototype: object }).prototype);
    (target as { id: string }).id = targetId;
    (target as { value: string }).value = value;
    elementFor(targetId).value = value;
    for (const handler of listeners.input) handler({ target });
  }

  return { sandbox, sent, dispatchClick, dispatchKeydown, dispatchInput, el: elementFor };
}

test("webview wiring: clicking Edit sets edit mode, then Save sends updateMemoryNote with the textarea's current value", () => {
  const { sandbox, sent, dispatchClick, el } = loadInteractiveSandbox();
  vm.runInContext(
    'state = ' + JSON.stringify({
      memory: { notes: [{ id: "n1", text: "original", pinned: false, createdAt: 1 }], commands: [] },
      isWorkspaceTrusted: true,
      summary: { level: "safe", capabilityResults: [] },
      workspace: { repos: [] },
    }) + '; navigate("memory");',
    sandbox as never,
  );

  dispatchClick("[data-edit-note]", { editNote: "n1" });
  assert.equal(vm.runInContext("memoryEditingNoteId", sandbox as never), "n1");

  el("editNoteText").value = "edited via textarea";
  dispatchClick("[data-save-note]", { saveNote: "n1" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "updateMemoryNote");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].extra)), { type: "updateMemoryNote", id: "n1", text: "edited via textarea" });
  assert.equal(vm.runInContext("memoryEditingNoteId", sandbox as never), null, "saving must exit edit mode");
});

test("webview wiring: Cancel exits edit mode WITHOUT sending any message", () => {
  const { sandbox, sent, dispatchClick } = loadInteractiveSandbox();
  vm.runInContext(
    'state = ' + JSON.stringify({ memory: { notes: [{ id: "n1", text: "original", pinned: false, createdAt: 1 }], commands: [] }, isWorkspaceTrusted: true, summary: { level: "safe", capabilityResults: [] }, workspace: { repos: [] } }) + '; navigate("memory");',
    sandbox as never,
  );
  dispatchClick("[data-edit-note]", { editNote: "n1" });
  dispatchClick("#editNoteCancel");
  assert.equal(sent.length, 0, "Cancel must never send a mutation");
  assert.equal(vm.runInContext("memoryEditingNoteId", sandbox as never), null);
});

test("webview wiring: Ctrl+Enter in the edit textarea triggers Save; plain Enter does not", () => {
  const { sandbox, sent, dispatchClick, dispatchKeydown, el } = loadInteractiveSandbox();
  vm.runInContext(
    'state = ' + JSON.stringify({ memory: { notes: [{ id: "n1", text: "original", pinned: false, createdAt: 1 }], commands: [] }, isWorkspaceTrusted: true, summary: { level: "safe", capabilityResults: [] }, workspace: { repos: [] } }) + '; navigate("memory");',
    sandbox as never,
  );
  dispatchClick("[data-edit-note]", { editNote: "n1" });
  // The keydown handler's Ctrl/Cmd+Enter path calls
  // `document.getElementById("editNoteSave").click()` directly rather than
  // re-dispatching a synthetic click event — wire this fake element's
  // `.click()` the same way a real save button click would resolve
  // (`[data-save-note="n1"]`), so the SAME code path the click handler
  // itself uses is exercised, not a hand-rolled shortcut.
  el("editNoteSave").click = () => dispatchClick("[data-save-note]", { saveNote: "n1" });

  dispatchKeydown("editNoteText", "Enter", {});
  assert.equal(sent.length, 0, "plain Enter in a multiline textarea must insert a newline, never submit");

  dispatchKeydown("editNoteText", "Enter", { ctrlKey: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "updateMemoryNote");
});

test("webview wiring: typing in the search box updates only the notes list, never the search input's own value/focus", () => {
  const { sandbox, dispatchInput, el } = loadInteractiveSandbox();
  vm.runInContext(
    'state = ' + JSON.stringify({
      memory: { notes: [{ id: "n1", text: "run pnpm dev", pinned: false, createdAt: 1 }, { id: "n2", text: "something else", pinned: false, createdAt: 1 }], commands: [] },
      isWorkspaceTrusted: true,
      summary: { level: "safe", capabilityResults: [] },
      workspace: { repos: [] },
    }) + '; navigate("memory");',
    sandbox as never,
  );
  dispatchInput("memorySearchInput", "pnpm");
  const listHtml = el("notesListContainer").innerHTML;
  assert.match(listHtml, /run pnpm dev/);
  assert.doesNotMatch(listHtml, /something else/);
});

test("webview wiring: removeMemoryNote/togglePinMemoryNote/addMemoryNote messages carry the expected payload shape", () => {
  const { sandbox, sent, dispatchClick, el } = loadInteractiveSandbox();
  vm.runInContext(
    'state = ' + JSON.stringify({ memory: { notes: [], commands: [] }, isWorkspaceTrusted: true, summary: { level: "safe", capabilityResults: [] }, workspace: { repos: [] } }) + '; navigate("memory");',
    sandbox as never,
  );

  el("newNoteText").value = "a brand new note";
  dispatchClick("#addNoteSubmit");
  assert.equal(sent[0].type, "addMemoryNote");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].extra)), { type: "addMemoryNote", text: "a brand new note", pinned: false });

  dispatchClick("[data-pin-note]", { pinNote: "n1" });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].extra)), { type: "togglePinMemoryNote", id: "n1" });

  dispatchClick("[data-remove-note]", { removeNote: "n1" });
  assert.deepEqual(JSON.parse(JSON.stringify(sent[2].extra)), { type: "removeMemoryNote", id: "n1" });
});

test("webview wiring: export/export-all/import buttons send parameterless requests to the extension host", () => {
  const { sandbox, sent, dispatchClick } = loadInteractiveSandbox();
  vm.runInContext(
    'state = ' + JSON.stringify({ memory: { notes: [], commands: [] }, isWorkspaceTrusted: true, summary: { level: "safe", capabilityResults: [] }, workspace: { repos: [] } }) + '; navigate("memory");',
    sandbox as never,
  );
  dispatchClick("#exportMemoryButton");
  dispatchClick("#exportAllMemoryButton");
  dispatchClick("#importMemoryButton");
  assert.deepEqual(JSON.parse(JSON.stringify(sent.map((s) => s.type))), ["exportMemory", "exportAllMemory", "importMemory"]);
});
