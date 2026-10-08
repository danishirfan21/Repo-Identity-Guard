/**
 * PLACEHOLDER webview client.
 *
 * The product UI is being redesigned separately; this is deliberately the
 * thinnest client that exercises the new backend contract (`WireState`,
 * built from `RepoIdentityState`) so the extension stays usable in the
 * meantime. No layout or visual design effort went into it on purpose.
 *
 * Safety properties that DO matter and are tested
 * (src/test/placeholderWebview.test.ts):
 *  - XSS: every piece of user/repository data (note text, identity
 *    labels, repository names, reasons) is inserted with `textContent` /
 *    `value`, never `innerHTML`. There is no `innerHTML` anywhere here.
 *  - No lost drafts: the new-note composer and the edit textarea keep
 *    their text across every backend `state` push, and are only cleared
 *    once the extension host ACKs the save (`noteResult` with ok: true).
 *  - Nothing here executes a note or runs a command; "Copy" asks the
 *    extension host to put the note's exact text on the clipboard.
 */
export const PLACEHOLDER_VIEW_JS = `
const vscodeApi = acquireVsCodeApi();
let state = null;
let newNoteDraft = "";
let editingNoteId = null;
let editDraft = "";
let searchQuery = "";
let requestCounter = 0;
const pendingNoteRequests = new Map();

function nextRequestId() {
  requestCounter += 1;
  return "req-" + requestCounter;
}

function post(message) {
  vscodeApi.postMessage(message);
}

/** Builds an element from plain data. Text is ALWAYS assigned via textContent — never parsed as HTML. */
function el(tag, props, children) {
  const node = document.createElement(tag);
  const p = props || {};
  if (p.className) node.className = p.className;
  if (p.text !== undefined) node.textContent = String(p.text);
  if (p.id) node.id = p.id;
  if (p.title) node.title = p.title;
  if (p.ariaLabel) node.setAttribute("aria-label", p.ariaLabel);
  if (p.disabled) {
    node.disabled = true;
    node.setAttribute("aria-disabled", "true");
  }
  if (p.dataset) for (const key of Object.keys(p.dataset)) node.dataset[key] = String(p.dataset[key]);
  if (p.onClick) node.addEventListener("click", p.onClick);
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function button(label, onClick, options) {
  const o = options || {};
  return el("button", { className: o.primary ? "vs-button-primary" : "vs-button-secondary", text: label, onClick, disabled: o.disabled, title: o.title, ariaLabel: o.ariaLabel || label, dataset: o.dataset });
}

const UNTRUSTED_TITLE = "This workspace isn't trusted, so Repo Identity Guard won't change Git hooks or config here.";

function stateLabel(enforcementState) {
  switch (enforcementState) {
    case "active": return "Locked";
    case "needs_attention": return "Needs attention";
    case "unavailable": return "Unavailable";
    default: return "Not locked";
  }
}

function formatTimestamp(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (e) {
    return "";
  }
}

function filteredNotes(notes) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter((note) => note.text.toLowerCase().includes(q));
}

function renderRepoList() {
  if (!state || state.repos.length <= 1) return null;
  return el("section", { className: "vs-card" }, [
    el("div", { className: "rig-muted", text: "Repositories" }),
    ...state.repos.map((repo) =>
      el("div", {}, [
        button((repo.selected ? "\\u25B8 " : "") + repo.name, () => post({ type: "selectRepo", id: repo.id }), { ariaLabel: "Select repository " + repo.name }),
        el("span", { className: "rig-state-" + repo.enforcementState, text: " " + stateLabel(repo.enforcementState) + (repo.assignedLabel ? " (" + repo.assignedLabel + ")" : "") }),
      ]),
    ),
  ]);
}

function identityPicker(excludeId) {
  const select = el("select", { className: "vs-input", id: "identityPicker", ariaLabel: "Identity" });
  for (const identity of state.identities) {
    if (identity.id === excludeId) continue;
    const option = el("option", { text: identity.label + " — " + identity.gitEmail });
    option.value = identity.id;
    select.appendChild(option);
  }
  return select;
}

function renderLock(repo) {
  const trusted = state.isWorkspaceTrusted;
  const guard = { disabled: !trusted, title: trusted ? undefined : UNTRUSTED_TITLE };
  const enforcement = repo.enforcement;
  const children = [
    el("div", { className: "rig-muted", text: "Identity lock" }),
    el("div", { className: "rig-state-" + enforcement.state, id: "lockState", text: stateLabel(enforcement.state) }),
  ];
  if (repo.assignment) {
    const a = repo.assignment;
    children.push(el("div", { id: "assignedIdentity", text: a.identityLabel + ": " + (a.gitName ? a.gitName + " " : "") + "<" + a.gitEmail + ">" }));
    children.push(el("div", { className: "rig-muted", text: a.expectedGitHubLogin ? "Pushes must authenticate as GitHub user " + a.expectedGitHubLogin : "Every push is blocked: no GitHub account is configured for push verification on this identity" }));
  } else if (enforcement.state === "unassigned") {
    children.push(el("div", { className: "rig-muted", text: "No identity is assigned. Repo Identity Guard does not restrict Git in this repository." }));
  }
  if (enforcement.reason) children.push(el("div", { id: "lockReason", text: enforcement.reason }));
  for (const problem of state.identityProblems) children.push(el("div", { className: "rig-state-needs_attention", text: problem }));

  const actions = el("div", {}, []);
  if (enforcement.state === "unassigned") {
    if (state.identities.length > 0) {
      actions.appendChild(identityPicker());
      actions.appendChild(button("Assign identity", () => post({ type: "assignIdentity", identityId: document.getElementById("identityPicker").value }), { primary: true, ...guard }));
    } else {
      actions.appendChild(el("div", { className: "rig-muted", text: "Add an identity first." }));
    }
  } else if (repo.assignment) {
    if (state.identities.some((i) => i.id !== repo.assignment.identityId)) {
      actions.appendChild(identityPicker(repo.assignment.identityId));
      actions.appendChild(button("Change identity", () => post({ type: "changeIdentity", identityId: document.getElementById("identityPicker").value }), guard));
    }
    actions.appendChild(button("Use identity in Git config", () => post({ type: "applyIdentityToGitConfig" }), guard));
    actions.appendChild(button("Check lock", () => post({ type: "checkLock" })));
  }
  if (enforcement.repairAvailable) actions.appendChild(button("Repair", () => post({ type: "repairLock" }), guard));
  if (enforcement.unlockAvailable) actions.appendChild(button("Unlock", () => post({ type: "unlockRepository" }), guard));
  actions.appendChild(button("Edit identities", () => post({ type: "editIdentities" })));
  children.push(actions);
  return el("section", { className: "vs-card", id: "lockSection" }, children);
}

function renderNote(note) {
  if (editingNoteId === note.id) {
    const textarea = el("textarea", { className: "vs-input", id: "editNoteText", ariaLabel: "Edit note text" });
    textarea.value = editDraft;
    textarea.addEventListener("input", () => { editDraft = textarea.value; });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); saveEdit(note.id); }
    });
    return el("li", { className: "vs-card" }, [
      textarea,
      button("Cancel", () => { editingNoteId = null; editDraft = ""; render(); }, { ariaLabel: "Cancel editing note" }),
      button("Save", () => saveEdit(note.id), { primary: true, ariaLabel: "Save note", dataset: { saveNote: note.id } }),
    ]);
  }
  const meta = "Added " + formatTimestamp(note.createdAt) + (note.updatedAt ? " · Edited " + formatTimestamp(note.updatedAt) : "") + (note.pinned ? " · Pinned" : "");
  return el("li", { className: "vs-card", dataset: { noteId: note.id } }, [
    el("div", { className: "rig-note-text", text: note.text }),
    el("div", { className: "rig-muted", text: meta }),
    button("Copy", () => post({ type: "copyNote", id: note.id }), { ariaLabel: "Copy note", dataset: { copyNote: note.id } }),
    button("Edit", () => { editingNoteId = note.id; editDraft = note.text; render(); }, { ariaLabel: "Edit note", dataset: { editNote: note.id } }),
    button(note.pinned ? "Unpin" : "Pin", () => post({ type: "togglePinNote", id: note.id }), { ariaLabel: note.pinned ? "Unpin note" : "Pin note", dataset: { pinNote: note.id } }),
    button("Delete", () => post({ type: "removeNote", id: note.id }), { ariaLabel: "Delete note", dataset: { removeNote: note.id } }),
  ]);
}

function saveEdit(noteId) {
  const requestId = nextRequestId();
  pendingNoteRequests.set(requestId, { kind: "edit", noteId });
  post({ type: "updateNote", id: noteId, text: editDraft, requestId });
}

function addNote() {
  if (!newNoteDraft.trim()) return;
  const requestId = nextRequestId();
  pendingNoteRequests.set(requestId, { kind: "add" });
  post({ type: "addNote", text: newNoteDraft, requestId });
}

function renderNotesList(repo) {
  const notes = filteredNotes(repo.notes);
  const pinned = notes.filter((n) => n.pinned);
  const others = notes.filter((n) => !n.pinned);
  if (notes.length === 0) {
    return el("div", { className: "rig-muted", id: "notesEmpty", text: searchQuery.trim() ? 'No notes match "' + searchQuery.trim() + '".' : "No notes yet." });
  }
  return el("ul", { id: "notesList" }, [...pinned, ...others].map(renderNote));
}

function renderNotes(repo) {
  const composer = el("textarea", { className: "vs-input", id: "newNoteText", ariaLabel: "New note" });
  composer.value = newNoteDraft;
  composer.placeholder = "Private note for this repository (never committed, never executed)";
  composer.addEventListener("input", () => { newNoteDraft = composer.value; });
  composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addNote(); }
  });
  const children = [el("div", { className: "rig-muted", text: "Notes" }), composer, button("Add note", addNote, { primary: true })];
  if (repo.notes.length > 0) {
    const search = el("input", { className: "vs-input", id: "noteSearch", ariaLabel: "Search notes" });
    search.type = "text";
    search.value = searchQuery;
    search.placeholder = "Search notes";
    search.addEventListener("input", () => {
      searchQuery = search.value;
      const container = document.getElementById("notesContainer");
      if (container) container.replaceChildren(renderNotesList(repo));
    });
    children.push(search);
  }
  children.push(el("div", { id: "notesContainer" }, [renderNotesList(repo)]));
  children.push(
    el("div", {}, [
      button("Export", () => post({ type: "exportNotes" })),
      button("Export all", () => post({ type: "exportAllNotes" })),
      button("Import", () => post({ type: "importNotes" })),
    ]),
  );
  return el("section", { className: "vs-card", id: "notesSection" }, children);
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : null;
  const selection = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;

  if (!state) {
    app.replaceChildren(el("div", { className: "rig-muted", text: "Loading…" }));
    return;
  }
  const repo = state.selected;
  if (!repo) {
    app.replaceChildren(el("div", { className: "rig-muted", text: "Open a folder inside a Git repository to lock its identity or keep private notes for it." }));
    return;
  }
  app.replaceChildren(
    ...[
      renderRepoList(),
      el("h2", { text: repo.repoName || "Repository" }),
      renderLock(repo),
      renderNotes(repo),
    ].filter(Boolean),
  );

  if (activeId) {
    const again = document.getElementById(activeId);
    if (again) {
      again.focus();
      if (selection && typeof again.setSelectionRange === "function") again.setSelectionRange(selection[0], selection[1]);
    }
  }
}

window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type === "state") {
    state = message.payload;
    if (editingNoteId && state.selected && !state.selected.notes.some((n) => n.id === editingNoteId)) {
      editingNoteId = null;
      editDraft = "";
    }
    render();
  } else if (message.type === "noteResult") {
    const pending = pendingNoteRequests.get(message.requestId);
    if (!pending) return;
    pendingNoteRequests.delete(message.requestId);
    if (!message.ok) return; // keep the draft / edit mode exactly as the user left it
    if (pending.kind === "add") newNoteDraft = "";
    if (pending.kind === "edit" && editingNoteId === pending.noteId) { editingNoteId = null; editDraft = ""; }
    render();
  }
});

render();
post({ type: "ready" });
`;
