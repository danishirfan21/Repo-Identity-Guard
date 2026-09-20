import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NOTE_LENGTH,
  MAX_NOTES_PER_REPO,
  MAX_COMMAND_LABEL_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_COMMANDS_PER_REPO,
  MemoryLimitError,
  applyMemoryImport,
  buildMemoryExport,
  emptyPersistedMemory,
  getRepoMemory,
  memoryMutations,
  normalizeLoadedMemory,
  previewMemoryImportEntry,
  previewMemoryImportFile,
  reconcileStaleKey,
  sanitizeCommandList,
  sanitizeNoteList,
} from "../storage/memoryStoreCore";

const KEYS = { notesKey: "repo-a", checkoutKey: "repo-a" };

// ==================== empty / basic add ====================

test("empty memory: a freshly-normalized empty state has no notes or commands for any key", () => {
  const state = normalizeLoadedMemory(undefined);
  assert.deepEqual(getRepoMemory(state, KEYS), { notes: [], commands: [] });
});

test("add note: text is trimmed, id/createdAt are set, and it appears in the repo's memory", () => {
  const now = 1_700_000_000_000;
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "  Run pnpm dev  ", false, now);
  const memory = getRepoMemory(state, KEYS);
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].text, "Run pnpm dev");
  assert.equal(memory.notes[0].pinned, false);
  assert.equal(memory.notes[0].createdAt, now);
  assert.equal(memory.notes[0].updatedAt, undefined);
  assert.ok(memory.notes[0].id);
});

test("whitespace rejection: an empty or whitespace-only note is rejected with MemoryLimitError, never silently stored", () => {
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "   ", false, Date.now()), MemoryLimitError);
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "", false, Date.now()), MemoryLimitError);
});

test("multiline preservation: a note's internal line breaks survive add, sanitize, and export/import round-trips", () => {
  const text = "API lives in services/api.\nDo not modify legacy billing.\nRun pnpm test before touching migrations.";
  const now = Date.now();
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, text, false, now);
  assert.equal(getRepoMemory(state, KEYS).notes[0].text, text);

  const exported = buildMemoryExport([{ label: "repo-a", memory: getRepoMemory(state, KEYS) }], now);
  assert.equal(exported.repositories[0].notes[0].text, text);

  const imported = applyMemoryImport(emptyPersistedMemory(), KEYS, exported, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(imported, KEYS).notes[0].text, text);
});

// ==================== edit ====================

test("edit note: updates text and preserves id, createdAt, and pinned state", () => {
  const now = 1_700_000_000_000;
  const withNote = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "original", true, now);
  const original = getRepoMemory(withNote, KEYS).notes[0];

  const later = now + 60_000;
  const edited = memoryMutations.updateNote(withNote, KEYS.notesKey, original.id, "updated text", later);
  const note = getRepoMemory(edited, KEYS).notes[0];

  assert.equal(note.id, original.id);
  assert.equal(note.createdAt, now);
  assert.equal(note.pinned, true);
  assert.equal(note.text, "updated text");
  assert.equal(note.updatedAt, later);
});

test("edit note: does not implement edit as delete+recreate — the note array position and identity are stable across an edit of a non-first note", () => {
  const now = Date.now();
  let state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "first", false, now);
  state = memoryMutations.addNote(state, KEYS.notesKey, "second", false, now + 1);
  const secondId = getRepoMemory(state, KEYS).notes.find((n) => n.text === "second")!.id;

  const edited = memoryMutations.updateNote(state, KEYS.notesKey, secondId, "second edited", now + 2);
  const notes = getRepoMemory(edited, KEYS).notes;
  assert.equal(notes.length, 2, "editing must not add or remove entries");
  assert.ok(notes.some((n) => n.id === secondId && n.text === "second edited"));
});

test("updatedAt changes only when appropriate: editing a note to the SAME text does not set/advance updatedAt", () => {
  const now = Date.now();
  const withNote = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "same text", false, now);
  const noteId = getRepoMemory(withNote, KEYS).notes[0].id;

  const unchanged = memoryMutations.updateNote(withNote, KEYS.notesKey, noteId, "same text", now + 5000);
  assert.equal(getRepoMemory(unchanged, KEYS).notes[0].updatedAt, undefined, "no-op edit must not stamp updatedAt");
});

test("updatedAt changes only when appropriate: pinning/unpinning never sets updatedAt", () => {
  const now = Date.now();
  const withNote = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "pin me", false, now);
  const noteId = getRepoMemory(withNote, KEYS).notes[0].id;
  const pinned = memoryMutations.togglePin(withNote, KEYS.notesKey, noteId);
  assert.equal(getRepoMemory(pinned, KEYS).notes[0].updatedAt, undefined);
});

test("editing a nonexistent note id is a harmless no-op", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "real note", false, Date.now());
  const result = memoryMutations.updateNote(state, KEYS.notesKey, "does-not-exist", "new text", Date.now());
  assert.deepEqual(getRepoMemory(result, KEYS), getRepoMemory(state, KEYS));
});

test("editing over the length limit is rejected, and the ORIGINAL text is left untouched", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "original", false, Date.now());
  const noteId = getRepoMemory(state, KEYS).notes[0].id;
  assert.throws(() => memoryMutations.updateNote(state, KEYS.notesKey, noteId, "x".repeat(MAX_NOTE_LENGTH + 1), Date.now()), MemoryLimitError);
  assert.equal(getRepoMemory(state, KEYS).notes[0].text, "original");
});

// ==================== release blocker: grandfathered data is never truncated ====================

test("release blocker: a legacy note already over MAX_NOTE_LENGTH survives migration with EVERY character intact, never truncated", () => {
  const legacyText = "x".repeat(6000);
  const legacy = { "/repo/legacy": { notes: [{ id: "n1", text: legacyText, pinned: false, createdAt: 1 }], commands: [] } };
  const state = normalizeLoadedMemory(legacy);
  const memory = getRepoMemory(state, { notesKey: "/repo/legacy", checkoutKey: "/repo/legacy" });
  assert.equal(memory.notes[0].text.length, 6000);
  assert.equal(memory.notes[0].text, legacyText);
});

test("release blocker: a legacy repository with 250 notes (more than today's 200-note limit) keeps ALL 250 through migration", () => {
  const legacyNotes = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, text: `legacy note ${i}`, pinned: false, createdAt: i }));
  const legacy = { "/repo/many-notes": { notes: legacyNotes, commands: [] } };
  const state = normalizeLoadedMemory(legacy);
  const memory = getRepoMemory(state, { notesKey: "/repo/many-notes", checkoutKey: "/repo/many-notes" });
  assert.equal(memory.notes.length, 250, "no migration path may cap a legacy repository's note count to today's limit");
});

test("release blocker: a legacy saved command already over MAX_COMMAND_LENGTH survives migration intact", () => {
  const longCommand = "echo " + "y".repeat(3000);
  const legacy = { "/repo/long-cmd": { notes: [], commands: [{ id: "c1", label: "long", command: longCommand, createdAt: 1 }] } };
  const state = normalizeLoadedMemory(legacy);
  const memory = getRepoMemory(state, { notesKey: "/repo/long-cmd", checkoutKey: "/repo/long-cmd" });
  assert.equal(memory.commands[0].command, longCommand);
});

test("release blocker: exporting a grandfathered oversized note/repository is lossless, never truncated to fit today's limits", () => {
  const legacyText = "z".repeat(5000);
  const legacyNotes = Array.from({ length: 210 }, (_, i) => (i === 0 ? { id: "n0", text: legacyText, pinned: false, createdAt: 0 } : { id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  const state = { version: 2 as const, notesByRepoKey: { "repo-a": legacyNotes }, commandsByCheckoutKey: {} };
  const exported = buildMemoryExport([{ label: "repo-a", memory: getRepoMemory(state, KEYS) }], Date.now());
  assert.equal(exported.repositories[0].notes.length, 210, "export must include every grandfathered note, not just the first 200");
  assert.equal(exported.repositories[0].notes.find((n) => n.id === "n0")!.text, legacyText);
});

test("release blocker: saving a grandfathered oversized note UNCHANGED (open editor, save with no edits) is a harmless no-op, never rejected merely for existing", () => {
  const legacyText = "w".repeat(MAX_NOTE_LENGTH + 500);
  const legacy = { "/repo/oversized": { notes: [{ id: "n1", text: legacyText, pinned: false, createdAt: 1 }], commands: [] } };
  const state = normalizeLoadedMemory(legacy);
  const keys = { notesKey: "/repo/oversized", checkoutKey: "/repo/oversized" };
  const result = memoryMutations.updateNote(state, keys.notesKey, "n1", legacyText, Date.now());
  assert.equal(getRepoMemory(result, keys).notes[0].text, legacyText, "a no-op save on an oversized grandfathered note must not throw or alter it");
});

test("release blocker: shrinking a grandfathered oversized note back under the limit is accepted as a normal edit", () => {
  const legacyText = "w".repeat(MAX_NOTE_LENGTH + 500);
  const legacy = { "/repo/oversized": { notes: [{ id: "n1", text: legacyText, pinned: false, createdAt: 1 }], commands: [] } };
  const state = normalizeLoadedMemory(legacy);
  const keys = { notesKey: "/repo/oversized", checkoutKey: "/repo/oversized" };
  const shortened = "shortened text";
  const result = memoryMutations.updateNote(state, keys.notesKey, "n1", shortened, Date.now());
  assert.equal(getRepoMemory(result, keys).notes[0].text, shortened);
});

test("release blocker: no migration/sanitize path ever caps list length to today's count limit — sanitizeNoteList/sanitizeCommandList preserve every structurally valid entry", () => {
  const manyNotes = Array.from({ length: MAX_NOTES_PER_REPO + 50 }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  assert.equal(sanitizeNoteList(manyNotes).length, MAX_NOTES_PER_REPO + 50, "sanitizeNoteList must never truncate to the count limit — that limit is only ever enforced on a NEW add");

  const manyCommands = Array.from({ length: MAX_COMMANDS_PER_REPO + 50 }, (_, i) => ({ id: `c${i}`, label: `cmd ${i}`, command: "echo", createdAt: i }));
  assert.equal(sanitizeCommandList(manyCommands).length, MAX_COMMANDS_PER_REPO + 50);
});

// ==================== pin / unpin ====================

test("pin: pinning an unpinned note sets pinned true", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "note", false, Date.now());
  const noteId = getRepoMemory(state, KEYS).notes[0].id;
  const pinned = memoryMutations.togglePin(state, KEYS.notesKey, noteId);
  assert.equal(getRepoMemory(pinned, KEYS).notes[0].pinned, true);
});

test("unpin: toggling a pinned note again sets pinned false", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "note", true, Date.now());
  const noteId = getRepoMemory(state, KEYS).notes[0].id;
  const unpinned = memoryMutations.togglePin(state, KEYS.notesKey, noteId);
  assert.equal(getRepoMemory(unpinned, KEYS).notes[0].pinned, false);
});

test("pinning note B unpins note A — at most one pinned note at a time", () => {
  let state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "A", true, Date.now());
  state = memoryMutations.addNote(state, KEYS.notesKey, "B", false, Date.now());
  const bId = getRepoMemory(state, KEYS).notes.find((n) => n.text === "B")!.id;

  const afterPinB = memoryMutations.togglePin(state, KEYS.notesKey, bId);
  const notes = getRepoMemory(afterPinB, KEYS).notes;
  assert.equal(notes.find((n) => n.text === "A")!.pinned, false);
  assert.equal(notes.find((n) => n.text === "B")!.pinned, true);
});

// ==================== remove ====================

test("remove: deletes the matching note and leaves others untouched", () => {
  let state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "keep", false, Date.now());
  state = memoryMutations.addNote(state, KEYS.notesKey, "remove me", false, Date.now());
  const removeId = getRepoMemory(state, KEYS).notes.find((n) => n.text === "remove me")!.id;
  const after = memoryMutations.removeNote(state, KEYS.notesKey, removeId);
  const notes = getRepoMemory(after, KEYS).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, "keep");
});

test("deleting a nonexistent note id is harmless", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "note", false, Date.now());
  const after = memoryMutations.removeNote(state, KEYS.notesKey, "no-such-id");
  assert.deepEqual(getRepoMemory(after, KEYS), getRepoMemory(state, KEYS));
});

// ==================== per-repo isolation ====================

test("per-repo isolation: notes/commands added under one key never appear under a different key", () => {
  const keysA = { notesKey: "repo-a", checkoutKey: "repo-a" };
  const keysB = { notesKey: "repo-b", checkoutKey: "repo-b" };
  let state = memoryMutations.addNote(emptyPersistedMemory(), keysA.notesKey, "A's note", false, Date.now());
  state = memoryMutations.addCommand(state, keysA.checkoutKey, "A's cmd", "echo a", Date.now());

  assert.deepEqual(getRepoMemory(state, keysB), { notes: [], commands: [] });
  assert.equal(getRepoMemory(state, keysA).notes.length, 1);
  assert.equal(getRepoMemory(state, keysA).commands.length, 1);
});

// ==================== malformed / migration ====================

test("malformed stored-state sanitation: garbage input never crashes and always normalizes to something usable", () => {
  for (const garbage of [null, undefined, 42, "a string", [], { version: 2 }, { version: 2, notesByRepoKey: "nope" }, { notesByRepoKey: { a: "not-an-array" } }]) {
    const state = normalizeLoadedMemory(garbage);
    assert.equal(state.version, 2);
    assert.deepEqual(state.notesByRepoKey, {});
  }
});

test("malformed stored-state sanitation: an individual corrupt note/command entry is discarded, not the whole list", () => {
  const raw = {
    version: 2,
    notesByRepoKey: {
      "repo-a": [
        { id: "1", text: "valid note", pinned: false, createdAt: 100 },
        { id: "2", text: "", pinned: false, createdAt: 100 }, // empty text -- invalid
        { id: "3", pinned: false, createdAt: 100 }, // missing text -- invalid
        "not even an object",
        { id: "4", text: "another valid note", pinned: true, createdAt: 200 },
      ],
    },
    commandsByCheckoutKey: {},
  };
  const state = normalizeLoadedMemory(raw);
  const notes = state.notesByRepoKey["repo-a"];
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.text).sort(), ["another valid note", "valid note"]);
});

test("malformed stored-state sanitation: more than one pinned note in corrupt/imported data is repaired to at most one", () => {
  const raw = {
    version: 2,
    notesByRepoKey: {
      "repo-a": [
        { id: "1", text: "first pinned", pinned: true, createdAt: 100 },
        { id: "2", text: "second pinned", pinned: true, createdAt: 200 },
      ],
    },
    commandsByCheckoutKey: {},
  };
  const state = normalizeLoadedMemory(raw);
  const pinnedCount = state.notesByRepoKey["repo-a"].filter((n) => n.pinned).length;
  assert.equal(pinnedCount, 1);
});

test("old-schema migration: a pre-versioning Record<repoRoot, {notes,commands}> blob migrates deterministically with no data loss", () => {
  const legacy = {
    "/Users/dev/project-a": {
      notes: [{ id: "n1", text: "old note", pinned: true, createdAt: 111 }],
      commands: [{ id: "c1", label: "Start", command: "npm start", createdAt: 111 }],
    },
    "/Users/dev/project-b": {
      notes: [{ id: "n2", text: "another old note", pinned: false, createdAt: 222 }],
      commands: [],
    },
  };
  const state = normalizeLoadedMemory(legacy);
  assert.equal(state.version, 2);
  const memoryA = getRepoMemory(state, { notesKey: "/Users/dev/project-a", checkoutKey: "/Users/dev/project-a" });
  assert.equal(memoryA.notes[0].text, "old note");
  assert.equal(memoryA.notes[0].pinned, true);
  assert.equal(memoryA.commands[0].command, "npm start");
  const memoryB = getRepoMemory(state, { notesKey: "/Users/dev/project-b", checkoutKey: "/Users/dev/project-b" });
  assert.equal(memoryB.notes[0].text, "another old note");
});

test("old-schema migration is deterministic: migrating the same legacy blob twice produces the same result", () => {
  const legacy = { "/repo": { notes: [{ id: "n1", text: "x", pinned: false, createdAt: 1 }], commands: [] } };
  const first = normalizeLoadedMemory(legacy);
  const second = normalizeLoadedMemory(legacy);
  assert.deepEqual(first, second);
});

test("reconcileStaleKey merges a stale key's data into the canonical key without dropping anything, and removes the stale key", () => {
  let state = memoryMutations.addNote(emptyPersistedMemory(), "/raw/path", "stale note", false, Date.now());
  state = memoryMutations.addNote(state, "/canonical/path", "already canonical note", false, Date.now());

  const reconciled = reconcileStaleKey(state, "notesByRepoKey", "/raw/path", "/canonical/path");
  assert.equal(reconciled.notesByRepoKey["/raw/path"], undefined);
  assert.equal(reconciled.notesByRepoKey["/canonical/path"].length, 2);
});

test("reconcileStaleKey is a no-op when the stale key has no data, or already equals the canonical key", () => {
  const state = emptyPersistedMemory();
  assert.equal(reconcileStaleKey(state, "notesByRepoKey", "/nothing/here", "/canonical"), state);
  assert.equal(reconcileStaleKey(state, "notesByRepoKey", "/same", "/same"), state);
});

// ==================== storage limits (new mutations only) ====================

test("maximum-size boundaries: a note exactly at MAX_NOTE_LENGTH is accepted; one character over is rejected", () => {
  const atLimit = "x".repeat(MAX_NOTE_LENGTH);
  const overLimit = "x".repeat(MAX_NOTE_LENGTH + 1);
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, atLimit, false, Date.now());
  assert.equal(getRepoMemory(state, KEYS).notes[0].text.length, MAX_NOTE_LENGTH);
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, overLimit, false, Date.now()), MemoryLimitError);
});

test("maximum-size boundaries: the MAX_NOTES_PER_REPOth note is accepted; the next one is rejected with a clear message, and existing notes are untouched", () => {
  let state = emptyPersistedMemory();
  for (let i = 0; i < MAX_NOTES_PER_REPO; i++) {
    state = memoryMutations.addNote(state, KEYS.notesKey, `note ${i}`, false, Date.now());
  }
  assert.equal(getRepoMemory(state, KEYS).notes.length, MAX_NOTES_PER_REPO);
  assert.throws(
    () => memoryMutations.addNote(state, KEYS.notesKey, "one too many", false, Date.now()),
    (error: unknown) => error instanceof MemoryLimitError && /maximum/i.test(error.message),
  );
  assert.equal(getRepoMemory(state, KEYS).notes.length, MAX_NOTES_PER_REPO, "the rejected add must not have mutated the existing state");
});

test("maximum-size boundaries: saved command label/command length and count limits are enforced the same way", () => {
  assert.throws(() => memoryMutations.addCommand(emptyPersistedMemory(), KEYS.checkoutKey, "x".repeat(MAX_COMMAND_LABEL_LENGTH + 1), "cmd", Date.now()), MemoryLimitError);
  assert.throws(() => memoryMutations.addCommand(emptyPersistedMemory(), KEYS.checkoutKey, "label", "x".repeat(MAX_COMMAND_LENGTH + 1), Date.now()), MemoryLimitError);

  let state = emptyPersistedMemory();
  for (let i = 0; i < MAX_COMMANDS_PER_REPO; i++) {
    state = memoryMutations.addCommand(state, KEYS.checkoutKey, `cmd ${i}`, "echo hi", Date.now());
  }
  assert.throws(() => memoryMutations.addCommand(state, KEYS.checkoutKey, "one more", "echo hi", Date.now()), MemoryLimitError);
});

test("a repository already grandfathered ABOVE the note limit still rejects a brand new add (does not silently allow unbounded growth)", () => {
  const legacyNotes = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  const state = { version: 2 as const, notesByRepoKey: { [KEYS.notesKey]: legacyNotes }, commandsByCheckoutKey: {} };
  assert.throws(() => memoryMutations.addNote(state, KEYS.notesKey, "one more note", false, Date.now()), MemoryLimitError);
  assert.equal(getRepoMemory(state, KEYS).notes.length, 250, "the rejected add must not touch the existing grandfathered notes");
});

test("over-limit text is REJECTED, never silently truncated, on the live add path", () => {
  const over = "y".repeat(MAX_NOTE_LENGTH + 500);
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, over, false, Date.now()), MemoryLimitError);
});

// ==================== export / import ====================

test("export: produces a schema-versioned document containing exactly the given repository's notes and commands", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "exportable note", false, Date.now());
  const memory = getRepoMemory(state, KEYS);
  const exported = buildMemoryExport([{ label: "my-repo", memory }], 12345);
  assert.equal(exported.exportSchemaVersion, 1);
  assert.equal(exported.exportedAt, 12345);
  assert.equal(exported.repositories.length, 1);
  assert.equal(exported.repositories[0].label, "my-repo");
  assert.equal(exported.repositories[0].notes[0].text, "exportable note");
});

test("safe import: previewMemoryImportFile never mutates anything and correctly summarizes entries", () => {
  const source = memoryMutations.addNote(emptyPersistedMemory(), "source", "imported note", false, Date.now());
  const exported = buildMemoryExport([{ label: "source", memory: getRepoMemory(source, { notesKey: "source", checkoutKey: "source" }) }], Date.now());

  const target = emptyPersistedMemory();
  const filePreview = previewMemoryImportFile(exported);
  assert.equal(filePreview.valid, true);
  assert.equal(filePreview.entries.length, 1);
  assert.equal(filePreview.entries[0].noteCount, 1);

  const entryPreview = previewMemoryImportEntry(exported, 0, getRepoMemory(target, KEYS));
  assert.equal(entryPreview.valid, true);
  assert.equal(entryPreview.noteCount, 1);
  assert.deepEqual(getRepoMemory(target, KEYS), { notes: [], commands: [] }, "preview must not mutate the target");
});

test("safe import: a file with the wrong/missing schema version is rejected with a clear error, not imported", () => {
  const preview = previewMemoryImportFile({ exportSchemaVersion: 999, repositories: [] });
  assert.equal(preview.valid, false);
  assert.ok(preview.error);
  assert.throws(() => applyMemoryImport(emptyPersistedMemory(), KEYS, { exportSchemaVersion: 999, repositories: [] }, 0, { overwriteDuplicates: false }), MemoryLimitError);
});

test("safe import: imported notes never arrive pre-pinned, even if the export file has one marked pinned", () => {
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: "n1", text: "was pinned", pinned: true, createdAt: 1 }], commands: [] } }], Date.now());
  const imported = applyMemoryImport(emptyPersistedMemory(), KEYS, exported, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(imported, KEYS).notes[0].pinned, false);
});

test("duplicate import behavior: a note/command with an id that already exists in the target is SKIPPED by default, never silently overwritten", () => {
  const now = Date.now();
  const target = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "original text", false, now);
  const originalId = getRepoMemory(target, KEYS).notes[0].id;

  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: originalId, text: "conflicting text", pinned: false, createdAt: now }], commands: [] } }], now);
  const preview = previewMemoryImportEntry(exported, 0, getRepoMemory(target, KEYS));
  assert.deepEqual(preview.duplicateNoteIds, [originalId]);

  const imported = applyMemoryImport(target, KEYS, exported, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(imported, KEYS).notes.length, 1);
  assert.equal(getRepoMemory(imported, KEYS).notes[0].text, "original text", "must be skipped, not overwritten, without explicit opt-in");
});

test("duplicate import behavior: overwriteDuplicates: true replaces the conflicting entry", () => {
  const now = Date.now();
  const target = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "original text", false, now);
  const originalId = getRepoMemory(target, KEYS).notes[0].id;

  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: originalId, text: "new text", pinned: false, createdAt: now }], commands: [] } }], now);
  const imported = applyMemoryImport(target, KEYS, exported, 0, { overwriteDuplicates: true });
  assert.equal(getRepoMemory(imported, KEYS).notes.length, 1);
  assert.equal(getRepoMemory(imported, KEYS).notes[0].text, "new text");
});

test("duplicate import behavior: overwriting a duplicate note preserves the TARGET repo's own pinned state, never silently flipped by the import", () => {
  const now = Date.now();
  const target = memoryMutations.addNote(emptyPersistedMemory(), KEYS.notesKey, "original text", true, now);
  const originalId = getRepoMemory(target, KEYS).notes[0].id;

  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: originalId, text: "new text", pinned: false, createdAt: now }], commands: [] } }], now);
  const imported = applyMemoryImport(target, KEYS, exported, 0, { overwriteDuplicates: true });
  const note = getRepoMemory(imported, KEYS).notes[0];
  assert.equal(note.text, "new text", "the overwrite must still replace content");
  assert.equal(note.pinned, true, "pin state is a local decision, never silently changed by an import overwrite");
});

test("adversarial: an import that would push a repository's note count over MAX_NOTES_PER_REPO is REJECTED, never silently truncated", () => {
  let state = emptyPersistedMemory();
  for (let i = 0; i < MAX_NOTES_PER_REPO - 1; i++) {
    state = memoryMutations.addNote(state, KEYS.notesKey, `existing note ${i}`, false, Date.now());
  }
  const importedNotes = Array.from({ length: 5 }, (_, i) => ({ id: `imported-${i}`, text: `imported note ${i}`, pinned: false, createdAt: Date.now() }));
  const exported = buildMemoryExport([{ label: "x", memory: { notes: importedNotes, commands: [] } }], Date.now());

  assert.throws(
    () => applyMemoryImport(state, KEYS, exported, 0, { overwriteDuplicates: false }),
    (error: unknown) => error instanceof MemoryLimitError && /over the .* limit/i.test(error.message),
  );
  // Rejected import must leave the target's existing notes completely untouched.
  assert.equal(getRepoMemory(state, KEYS).notes.length, MAX_NOTES_PER_REPO - 1);
});

test("adversarial: an import that would push a checkout's command count over MAX_COMMANDS_PER_REPO is REJECTED, never silently truncated", () => {
  let state = emptyPersistedMemory();
  for (let i = 0; i < MAX_COMMANDS_PER_REPO - 1; i++) {
    state = memoryMutations.addCommand(state, KEYS.checkoutKey, `cmd ${i}`, "echo hi", Date.now());
  }
  const importedCommands = Array.from({ length: 5 }, (_, i) => ({ id: `imported-cmd-${i}`, label: `cmd ${i}`, command: "echo hi", createdAt: Date.now() }));
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [], commands: importedCommands } }], Date.now());

  assert.throws(() => applyMemoryImport(state, KEYS, exported, 0, { overwriteDuplicates: false }), MemoryLimitError);
  assert.equal(getRepoMemory(state, KEYS).commands.length, MAX_COMMANDS_PER_REPO - 1);
});

test("release blocker: an import containing a note over today's length limit is REJECTED outright, never truncated to fit", () => {
  const oversizedNote = { id: "oversized", text: "q".repeat(MAX_NOTE_LENGTH + 1), pinned: false, createdAt: Date.now() };
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [oversizedNote], commands: [] } }], Date.now());
  const target = emptyPersistedMemory();

  const preview = previewMemoryImportEntry(exported, 0, getRepoMemory(target, KEYS));
  assert.equal(preview.valid, false);
  assert.equal(preview.oversizedNoteCount, 1);

  assert.throws(() => applyMemoryImport(target, KEYS, exported, 0, { overwriteDuplicates: false }), MemoryLimitError);
  assert.deepEqual(getRepoMemory(target, KEYS), { notes: [], commands: [] }, "a rejected oversized import must change nothing");
});

test("release blocker: an import containing a saved command over today's limits is REJECTED outright, never truncated", () => {
  const oversizedCommand = { id: "oversized-cmd", label: "x".repeat(MAX_COMMAND_LABEL_LENGTH + 1), command: "echo hi", createdAt: Date.now() };
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [], commands: [oversizedCommand] } }], Date.now());
  const target = emptyPersistedMemory();

  const preview = previewMemoryImportEntry(exported, 0, getRepoMemory(target, KEYS));
  assert.equal(preview.valid, false);
  assert.equal(preview.oversizedCommandCount, 1);
  assert.throws(() => applyMemoryImport(target, KEYS, exported, 0, { overwriteDuplicates: false }), MemoryLimitError);
});

test("release blocker: re-importing duplicates-only into an already-grandfathered-over-limit repository does not spuriously throw (nothing is actually growing)", () => {
  const legacyNotes = Array.from({ length: 205 }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  const target: import("../storage/memoryStoreCore").PersistedMemoryV2 = { version: 2, notesByRepoKey: { [KEYS.notesKey]: legacyNotes }, commandsByCheckoutKey: {} };
  // Export exactly what's already there, then re-import it (overwrite) into the SAME repo -- this must NOT throw, since nothing is being added.
  const exported = buildMemoryExport([{ label: "x", memory: getRepoMemory(target, KEYS) }], Date.now());
  const imported = applyMemoryImport(target, KEYS, exported, 0, { overwriteDuplicates: true });
  assert.equal(getRepoMemory(imported, KEYS).notes.length, 205, "re-importing duplicates-only must not throw or drop entries just because the repo is already over today's limit");
});

// ==================== multi-repository import semantics ====================

test("multi-repository import: previewMemoryImportFile summarizes every repository entry without merging them", () => {
  const exported = buildMemoryExport(
    [
      { label: "repo-1", memory: { notes: [{ id: "n1", text: "repo 1 note", pinned: false, createdAt: 1 }], commands: [] } },
      { label: "repo-2", memory: { notes: [{ id: "n2", text: "repo 2 note", pinned: false, createdAt: 1 }, { id: "n3", text: "repo 2 note 2", pinned: false, createdAt: 1 }], commands: [] } },
    ],
    Date.now(),
  );
  const preview = previewMemoryImportFile(exported);
  assert.equal(preview.valid, true);
  assert.equal(preview.entries.length, 2);
  assert.deepEqual(preview.entries.map((e) => ({ label: e.label, noteCount: e.noteCount })), [
    { label: "repo-1", noteCount: 1 },
    { label: "repo-2", noteCount: 2 },
  ]);
});

test("multi-repository import: applyMemoryImport with entryIndex imports ONLY that chosen repository's notes, never every entry combined", () => {
  const exported = buildMemoryExport(
    [
      { label: "repo-1", memory: { notes: [{ id: "n1", text: "repo 1 note", pinned: false, createdAt: 1 }], commands: [] } },
      { label: "repo-2", memory: { notes: [{ id: "n2", text: "repo 2 note", pinned: false, createdAt: 1 }], commands: [] } },
    ],
    Date.now(),
  );
  const target = emptyPersistedMemory();
  const imported = applyMemoryImport(target, KEYS, exported, 1, { overwriteDuplicates: false });
  const notes = getRepoMemory(imported, KEYS).notes;
  assert.equal(notes.length, 1, "must import only entry index 1, never combine both entries");
  assert.equal(notes[0].text, "repo 2 note");
});

test("imported saved commands are NEVER executed — applyMemoryImport only ever reads/copies the `command` string as data", () => {
  let executed = false;
  const originalExec = globalThis.eval;
  // Defense-in-depth sanity check: even if something in the import path
  // tried to eval/exec the imported command text, this proves it doesn't
  // by asserting no such call happens for a command string that would be
  // obviously observable if it were ever run.
  try {
    (globalThis as unknown as { eval: (s: string) => unknown }).eval = (script: string) => {
      executed = true;
      return originalExec(script);
    };
    const exported = buildMemoryExport(
      [{ label: "x", memory: { notes: [], commands: [{ id: "c1", label: "dangerous", command: "throw new Error('should never run')", createdAt: 1 }] } }],
      Date.now(),
    );
    const imported = applyMemoryImport(emptyPersistedMemory(), KEYS, exported, 0, { overwriteDuplicates: false });
    assert.equal(getRepoMemory(imported, KEYS).commands[0].command, "throw new Error('should never run')");
  } finally {
    globalThis.eval = originalExec;
  }
  assert.equal(executed, false);
});

test("sanitizeNoteList and sanitizeCommandList discard structurally invalid entries but never cap valid-list length", () => {
  const mixed = [{ id: "n1", text: "valid", pinned: false, createdAt: 1 }, "garbage", { id: "n1", text: "duplicate id, skipped", pinned: false, createdAt: 2 }];
  const sanitized = sanitizeNoteList(mixed);
  assert.equal(sanitized.length, 1, "invalid entries and duplicate ids are still filtered");
  assert.equal(sanitized[0].text, "valid");
});
