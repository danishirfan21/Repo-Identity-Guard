/**
 * Repo Memory — notes (pinned + general) and saved commands. Purely a
 * client for MemoryStore's existing messages (addMemoryNote,
 * updateMemoryNote, togglePinMemoryNote, removeMemoryNote, addSavedCommand,
 * runSavedCommand, copySavedCommand, removeSavedCommand, exportMemory,
 * exportAllMemory, importMemory); this view never runs anything on its own
 * and never writes a file itself — "Run" and export/import all go through
 * the extension host, which re-checks Workspace Trust (for Run) and shows
 * its own native save/open dialogs and confirmation prompts. Deletion
 * confirmation and the export/import preview are like that too: this view
 * only sends the request, the extension host confirms.
 *
 * Editing state (`memoryEditingNoteId`), its unsaved text
 * (`memoryEditDraft`), the new-note/new-command composer drafts
 * (`memoryNewNoteDraft`/`memoryNewCommandLabelDraft`/
 * `memoryNewCommandDraft`), and search (`memorySearchQuery`) are purely
 * local UI state, never sent anywhere except as the payload of the
 * mutation the user actually submits, and never persisted — they reset to
 * nothing every time the webview reloads.
 *
 * Drafts are intentionally NOT cleared just because a message was sent —
 * see navigation.ts's `memoryPendingRequests`/`handleMemoryMutationResult`.
 * A routine `state` push (a rescan, a file save, a branch switch) can
 * arrive and trigger a full re-render at any moment, including while the
 * user is mid-keystroke; every render below reads the CURRENT draft
 * variable, never `note.text` or an empty string, specifically so that
 * push can never silently erase what's been typed but not yet confirmed
 * saved.
 */
export const MEMORY_VIEW_JS = `
let memoryEditingNoteId = null;
let memoryEditDraft = "";
let memoryNewNoteDraft = "";
let memoryNewCommandLabelDraft = "";
let memoryNewCommandDraft = "";
let memorySearchQuery = "";

function formatMemoryTimestamp(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

function memoryNoteMeta(note) {
  const created = "Added " + formatMemoryTimestamp(note.createdAt);
  const updated = note.updatedAt ? " · Edited " + formatMemoryTimestamp(note.updatedAt) : "";
  return created + updated;
}

/** \`disabled\` + an explanatory \`title\`/\`aria-disabled\` when Workspace Trust blocks the action this control performs — never just a silently no-op button. */
function memoryDisabledAttrs(reason) {
  return state.isWorkspaceTrusted ? "" : \` disabled aria-disabled="true" title="\${esc(reason)}"\`;
}

function renderMemoryNoteEditor(note) {
  return \`
    <div class="vs-card flex flex-col gap-1.5 rounded p-2">
      <textarea class="vs-input min-h-[4.5rem] rounded p-1.5 text-[12px]" id="editNoteText" aria-label="Edit note text"\${memoryDisabledAttrs("This workspace isn't trusted, so notes can't be edited here.")}>\${esc(memoryEditDraft)}</textarea>
      <div class="flex justify-end gap-1">
        <button class="vs-button-secondary rounded px-2 text-[11px]" id="editNoteCancel" aria-label="Cancel editing note" title="Cancel">Cancel</button>
        <button class="vs-button-secondary rounded px-2 text-[11px]" id="editNoteSave" data-save-note="\${esc(note.id)}" aria-label="Save note" title="Save"\${memoryDisabledAttrs("This workspace isn't trusted, so notes can't be edited here.")}>\${icon("check", 11)}Save</button>
      </div>
    </div>\`;
}

function renderMemoryNote(note) {
  if (memoryEditingNoteId === note.id) {
    return note.pinned
      ? \`<div class="border-l-2 pl-0.5" style="border-left-color:var(--rig-warning)">\${renderMemoryNoteEditor(note)}</div>\`
      : \`<li>\${renderMemoryNoteEditor(note)}</li>\`;
  }
  const editDisabled = memoryDisabledAttrs("This workspace isn't trusted, so notes can't be edited here.");
  const pinDisabled = memoryDisabledAttrs("This workspace isn't trusted, so notes can't be pinned here.");
  const deleteDisabled = memoryDisabledAttrs("This workspace isn't trusted, so notes can't be deleted here.");
  if (note.pinned) {
    return \`
      <div class="vs-card relative flex items-start justify-between gap-2 rounded p-2 pl-2.5 border-l-2" style="border-left-color:var(--rig-warning)">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-tertiary">\${icon("pin", 10)}Pinned</span>
          <span class="whitespace-pre-wrap break-words text-[12px] text-on-surface">\${esc(note.text)}</span>
          <span class="text-[9.5px] text-on-surface-variant">\${esc(memoryNoteMeta(note))}</span>
        </div>
        <div class="flex shrink-0 gap-0.5">
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" data-edit-note="\${esc(note.id)}" aria-label="Edit note" title="Edit"\${editDisabled}>\${icon("edit", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" data-pin-note="\${esc(note.id)}" aria-label="Unpin note" title="Unpin"\${pinDisabled}>\${icon("pin", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-error" data-remove-note="\${esc(note.id)}" aria-label="Delete note" title="Delete"\${deleteDisabled}>\${icon("close", 12)}</button>
        </div>
      </div>\`;
  }
  return \`
    <li class="group flex items-start gap-2 rounded p-1 hover:bg-surface-container-high">
      <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-on-surface-variant"></span>
      <div class="min-w-0 flex-1 flex flex-col gap-0.5">
        <span class="whitespace-pre-wrap break-words text-[12px] leading-snug text-on-surface">\${esc(note.text)}</span>
        <span class="text-[9.5px] text-on-surface-variant">\${esc(memoryNoteMeta(note))}</span>
      </div>
      <div class="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
        <button class="rounded p-1 text-on-surface-variant hover:text-primary" data-edit-note="\${esc(note.id)}" aria-label="Edit note" title="Edit"\${editDisabled}>\${icon("edit", 11)}</button>
        <button class="rounded p-1 text-on-surface-variant hover:text-tertiary" data-pin-note="\${esc(note.id)}" aria-label="Pin note" title="Pin"\${pinDisabled}>\${icon("pin", 11)}</button>
        <button class="rounded p-1 text-on-surface-variant hover:text-error" data-remove-note="\${esc(note.id)}" aria-label="Delete note" title="Delete"\${deleteDisabled}>\${icon("close", 11)}</button>
      </div>
    </li>\`;
}

function filteredMemoryNotes() {
  const q = memorySearchQuery.trim().toLowerCase();
  const all = state.memory.notes;
  if (!q) return all;
  return all.filter((n) => n.text.toLowerCase().includes(q));
}

/** Renders ONLY the notes list — kept as its own function so the search box's input handler can refresh just this container instead of the whole Memory screen, which would otherwise steal focus/cursor position out of the search field on every keystroke. */
function renderNotesList() {
  const matches = filteredMemoryNotes();
  const notes = matches.filter((n) => !n.pinned);
  const pinned = matches.filter((n) => n.pinned);

  if (matches.length === 0) {
    return memorySearchQuery.trim()
      ? '<p class="text-[11px] text-on-surface-variant">No notes match "' + esc(memorySearchQuery.trim()) + '".</p>'
      : '<p class="text-[11px] text-on-surface-variant">No notes yet.</p>';
  }

  return \`
    \${pinned.map(renderMemoryNote).join("")}
    \${notes.length ? '<ul class="flex flex-col">' + notes.map(renderMemoryNote).join("") + "</ul>" : ""}
  \`;
}

function renderSavedCommand(cmd) {
  const runDisabled = memoryDisabledAttrs("This workspace isn't trusted, so saved commands can't run here.");
  const deleteDisabled = memoryDisabledAttrs("This workspace isn't trusted, so saved commands can't be deleted here.");
  return \`
    <div class="vs-card group flex flex-col gap-1.5 rounded p-2">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-[11.5px] font-semibold text-on-surface">\${esc(cmd.label)}</span>
        <div class="flex shrink-0 gap-0.5">
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary" data-copy-command="\${esc(cmd.id)}" aria-label="Copy command" title="Copy">\${icon("copy", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-error" data-remove-command="\${esc(cmd.id)}" aria-label="Delete saved command" title="Delete"\${deleteDisabled}>\${icon("trash", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary" data-run-command="\${esc(cmd.id)}" aria-label="Run command in terminal" title="Run in terminal"\${runDisabled}>\${icon("play", 12)}</button>
        </div>
      </div>
      <code class="block overflow-x-auto whitespace-nowrap rounded bg-surface-container-lowest p-1.5 font-code-mono text-code-mono text-primary">\${esc(cmd.command)}</code>
    </div>\`;
}

function renderMemory() {
  const commands = state.memory.commands;
  const trustNote = state.isWorkspaceTrusted
    ? ""
    : \`<div class="vs-card flex items-start gap-1.5 rounded p-2 text-[10.5px] text-on-surface-variant"><span class="mt-0.5 shrink-0 text-tertiary">\${icon("lock", 12)}</span><span>This workspace isn't trusted, so notes and saved commands can't be added, edited, deleted, pinned, run, or imported here. You can still view, search, and export what's already here — enable Workspace Trust to make changes.</span></div>\`;
  const searchBox = state.memory.notes.length > 0
    ? \`<div class="relative">
        \${icon("search", 11)}
        <input id="memorySearchInput" class="vs-input h-7 w-full rounded pl-6 pr-2 text-[12px]" style="padding-left:22px" placeholder="Search notes" value="\${esc(memorySearchQuery)}" aria-label="Search notes" />
      </div>\`
    : "";
  const addDisabled = memoryDisabledAttrs("This workspace isn't trusted, so notes can't be added here.");
  const commandDisabled = memoryDisabledAttrs("This workspace isn't trusted, so saved commands can't be added here.");
  const importDisabled = memoryDisabledAttrs("This workspace isn't trusted, so Repo Memory can't be imported here.");

  return \`
    \${trustNote}
    <section class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">\${sectionLabel("Notes")}<button class="rounded p-1 text-on-surface-variant hover:text-primary" id="addNoteButton" aria-label="Add note" title="Add note"\${addDisabled}>\${icon("plus", 13)}</button></div>
      \${searchBox}
      <div id="notesListContainer" class="flex flex-col gap-1.5">\${renderNotesList()}</div>
      <textarea id="newNoteText" rows="2" class="vs-input rounded p-1.5 text-[12px]" placeholder="e.g. API lives in services/api. Run pnpm test before touching migrations." aria-label="New note text"\${addDisabled}>\${esc(memoryNewNoteDraft)}</textarea>
      <div class="flex justify-end">
        <button class="vs-button-secondary rounded px-2 text-[12px]" id="addNoteSubmit"\${addDisabled}>Add</button>
      </div>
    </section>
    <section class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">\${sectionLabel("Saved commands")}<button class="rounded p-1 text-on-surface-variant hover:text-primary" id="addCommandToggle" aria-label="Add saved command" title="Add command"\${commandDisabled}>\${icon("plus", 13)}</button></div>
      \${commands.length ? commands.map(renderSavedCommand).join("") : '<p class="text-[11px] text-on-surface-variant">No saved commands yet.</p>'}
      <div class="flex flex-col gap-1">
        <input id="newCommandLabel" class="vs-input h-7 rounded px-2 text-[12px]" placeholder="Label, e.g. Start dev server" value="\${esc(memoryNewCommandLabelDraft)}"\${commandDisabled} />
        <input id="newCommandText" class="vs-input h-7 rounded px-2 font-code-mono text-code-mono" placeholder="Command, e.g. pnpm dev" value="\${esc(memoryNewCommandDraft)}"\${commandDisabled} />
        <button class="vs-button-secondary h-7 rounded text-[12px]" id="addCommandButton"\${commandDisabled}>Save Command</button>
      </div>
    </section>
    <section class="flex flex-col gap-1.5">
      \${sectionLabel("Backup")}
      <div class="flex gap-1">
        <button class="vs-button-secondary h-7 flex-1 rounded text-[11px]" id="exportMemoryButton" title="Export this repository's Repo Memory to a JSON file">\${icon("download", 12)}Export</button>
        <button class="vs-button-secondary h-7 flex-1 rounded text-[11px]" id="exportAllMemoryButton" title="Export every detected repository's Repo Memory to a JSON file">\${icon("download", 12)}Export all</button>
        <button class="vs-button-secondary h-7 flex-1 rounded text-[11px]" id="importMemoryButton" title="Import Repo Memory from a JSON file"\${importDisabled}>\${icon("upload", 12)}Import</button>
      </div>
    </section>
  \`;
}
`;
