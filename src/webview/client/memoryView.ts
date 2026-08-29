/**
 * Repo Memory — notes (pinned + general) and saved commands. Purely a
 * client for MemoryStore's existing messages (addMemoryNote,
 * togglePinMemoryNote, removeMemoryNote, addSavedCommand, runSavedCommand,
 * copySavedCommand, removeSavedCommand); this view never runs anything on
 * its own. "Run" always goes through the extension host, which re-checks
 * Workspace Trust before touching a terminal — this view has no path that
 * bypasses that.
 */
export const MEMORY_VIEW_JS = `
function renderMemoryNote(note) {
  if (note.pinned) {
    return \`
      <div class="vs-card relative flex items-start justify-between gap-2 rounded p-2 pl-2.5 border-l-2" style="border-left-color:var(--rig-warning)">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-tertiary">\${icon("pin", 10)}Pinned</span>
          <span class="break-words text-[12px] text-on-surface">\${esc(note.text)}</span>
        </div>
        <div class="flex shrink-0 gap-0.5">
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface" data-pin-note="\${esc(note.id)}" title="Unpin">\${icon("pin", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-error" data-remove-note="\${esc(note.id)}" title="Remove">\${icon("close", 12)}</button>
        </div>
      </div>\`;
  }
  return \`
    <li class="group flex items-start gap-2 rounded p-1 hover:bg-surface-container-high">
      <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-on-surface-variant"></span>
      <span class="min-w-0 flex-1 break-words text-[12px] leading-snug text-on-surface">\${esc(note.text)}</span>
      <div class="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
        <button class="rounded p-1 text-on-surface-variant hover:text-tertiary" data-pin-note="\${esc(note.id)}" title="Pin">\${icon("pin", 11)}</button>
        <button class="rounded p-1 text-on-surface-variant hover:text-error" data-remove-note="\${esc(note.id)}" title="Remove">\${icon("close", 11)}</button>
      </div>
    </li>\`;
}

function renderSavedCommand(cmd) {
  return \`
    <div class="vs-card group flex flex-col gap-1.5 rounded p-2">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-[11.5px] font-semibold text-on-surface">\${esc(cmd.label)}</span>
        <div class="flex shrink-0 gap-0.5">
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary" data-copy-command="\${esc(cmd.id)}" title="Copy">\${icon("copy", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-error" data-remove-command="\${esc(cmd.id)}" title="Delete">\${icon("trash", 12)}</button>
          <button class="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary" data-run-command="\${esc(cmd.id)}" title="Run in terminal">\${icon("play", 12)}</button>
        </div>
      </div>
      <code class="block overflow-x-auto whitespace-nowrap rounded bg-surface-container-lowest p-1.5 font-code-mono text-code-mono text-primary">\${esc(cmd.command)}</code>
    </div>\`;
}

function renderMemory() {
  const notes = state.memory.notes.filter((n) => !n.pinned);
  const pinned = state.memory.notes.filter((n) => n.pinned);
  const commands = state.memory.commands;
  const trustNote = state.isWorkspaceTrusted
    ? ""
    : \`<div class="vs-card flex items-start gap-1.5 rounded p-2 text-[10.5px] text-on-surface-variant"><span class="mt-0.5 shrink-0 text-tertiary">\${icon("lock", 12)}</span><span>This workspace isn't trusted, so saved commands can't run from here until Workspace Trust is enabled.</span></div>\`;

  return \`
    \${trustNote}
    <section class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">\${sectionLabel("Notes")}<button class="rounded p-1 text-on-surface-variant hover:text-primary" id="addNoteButton" title="Add note">\${icon("plus", 13)}</button></div>
      \${pinned.map(renderMemoryNote).join("")}
      \${notes.length ? '<ul class="flex flex-col">' + notes.map(renderMemoryNote).join("") + "</ul>" : (pinned.length ? "" : '<p class="text-[11px] text-on-surface-variant">No notes yet.</p>')}
      <div class="flex gap-1">
        <input id="newNoteText" class="vs-input h-7 flex-1 rounded px-2 text-[12px]" placeholder="e.g. Run pnpm dev from frontend folder" />
        <button class="vs-button-secondary rounded px-2 text-[12px]" id="addNoteSubmit">Add</button>
      </div>
    </section>
    <section class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">\${sectionLabel("Saved commands")}<button class="rounded p-1 text-on-surface-variant hover:text-primary" id="addCommandToggle" title="Add command">\${icon("plus", 13)}</button></div>
      \${commands.length ? commands.map(renderSavedCommand).join("") : '<p class="text-[11px] text-on-surface-variant">No saved commands yet.</p>'}
      <div class="flex flex-col gap-1">
        <input id="newCommandLabel" class="vs-input h-7 rounded px-2 text-[12px]" placeholder="Label, e.g. Start dev server" />
        <input id="newCommandText" class="vs-input h-7 rounded px-2 font-code-mono text-code-mono" placeholder="Command, e.g. pnpm dev" />
        <button class="vs-button-secondary h-7 rounded text-[12px]" id="addCommandButton">Save Command</button>
      </div>
    </section>
  \`;
}
`;
