import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_COMMAND_NOTE_ID_PREFIX,
  MAX_NOTE_LENGTH,
  MAX_NOTES_PER_REPO,
  MEMORY_EXPORT_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
  MemoryLimitError,
  PersistedMemoryV3,
  applyMemoryImport,
  buildMemoryExport,
  emptyPersistedMemory,
  getRepoMemory,
  legacyCommandToNote,
  memoryMutations,
  needsMigration,
  normalizeLoadedMemory,
  noteCopyText,
  previewMemoryImportEntry,
  previewMemoryImportFile,
  reconcileStaleKey,
  sanitizeNoteList,
  searchNotes,
} from "../storage/memoryStoreCore";

const KEY = "repo-a";

function stateWith(notes: PersistedMemoryV3["notesByRepoKey"][string], key = KEY): PersistedMemoryV3 {
  return { version: 3, notesByRepoKey: { [key]: notes } };
}

// ==================== empty / basic add ====================

test("empty memory: a freshly-normalized empty state has no notes for any key", () => {
  const state = normalizeLoadedMemory(undefined);
  assert.deepEqual(getRepoMemory(state, KEY), { notes: [] });
  assert.equal(state.version, MEMORY_SCHEMA_VERSION);
});

test("add note: text is trimmed, id/createdAt are set, and it appears in the repo's notes", () => {
  const now = 1_700_000_000_000;
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "  Run pnpm dev  ", false, now);
  const memory = getRepoMemory(state, KEY);
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].text, "Run pnpm dev");
  assert.equal(memory.notes[0].pinned, false);
  assert.equal(memory.notes[0].createdAt, now);
  assert.equal(memory.notes[0].updatedAt, undefined);
  assert.ok(memory.notes[0].id);
});

test("whitespace rejection: an empty or whitespace-only note is rejected with MemoryLimitError, never silently stored", () => {
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEY, "   ", false, Date.now()), MemoryLimitError);
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEY, "", false, Date.now()), MemoryLimitError);
});

test("multiline preservation: a note's internal line breaks survive add, sanitize, and export/import round-trips", () => {
  const text = "API lives in services/api.\nDo not modify legacy billing.\nRun pnpm test before touching migrations.";
  const now = Date.now();
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEY, text, false, now);
  assert.equal(getRepoMemory(state, KEY).notes[0].text, text);

  const exported = buildMemoryExport([{ label: "repo-a", memory: getRepoMemory(state, KEY) }], now);
  assert.equal(exported.repositories[0].notes[0].text, text);

  const imported = applyMemoryImport(emptyPersistedMemory(), KEY, exported, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(imported, KEY).notes[0].text, text);
});

// ==================== edit ====================

test("edit note: updates text and preserves id, createdAt, and pinned state", () => {
  const now = 1_700_000_000_000;
  const withNote = memoryMutations.addNote(emptyPersistedMemory(), KEY, "original", true, now);
  const original = getRepoMemory(withNote, KEY).notes[0];

  const later = now + 60_000;
  const edited = memoryMutations.updateNote(withNote, KEY, original.id, "updated text", later);
  const note = getRepoMemory(edited, KEY).notes[0];

  assert.equal(note.id, original.id);
  assert.equal(note.createdAt, now);
  assert.equal(note.pinned, true);
  assert.equal(note.text, "updated text");
  assert.equal(note.updatedAt, later);
});

test("edit note: the note's array position and identity are stable across an edit of a non-first note", () => {
  const now = Date.now();
  let state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "first", false, now);
  state = memoryMutations.addNote(state, KEY, "second", false, now + 1);
  const before = getRepoMemory(state, KEY).notes.map((n) => n.id);
  const secondId = getRepoMemory(state, KEY).notes.find((n) => n.text === "second")!.id;

  const edited = memoryMutations.updateNote(state, KEY, secondId, "second edited", now + 2);
  const notes = getRepoMemory(edited, KEY).notes;
  assert.deepEqual(notes.map((n) => n.id), before, "editing must not add, remove or reorder entries");
  assert.ok(notes.some((n) => n.id === secondId && n.text === "second edited"));
});

test("updatedAt: editing a note to the SAME text does not set/advance updatedAt", () => {
  const now = Date.now();
  const withNote = memoryMutations.addNote(emptyPersistedMemory(), KEY, "same text", false, now);
  const noteId = getRepoMemory(withNote, KEY).notes[0].id;
  const unchanged = memoryMutations.updateNote(withNote, KEY, noteId, "same text", now + 5000);
  assert.equal(unchanged, withNote, "a no-op edit returns the very same state object (nothing to persist)");
});

test("updatedAt: pinning/unpinning never sets updatedAt", () => {
  const withNote = memoryMutations.addNote(emptyPersistedMemory(), KEY, "pin me", false, Date.now());
  const noteId = getRepoMemory(withNote, KEY).notes[0].id;
  const pinned = memoryMutations.togglePin(withNote, KEY, noteId);
  assert.equal(getRepoMemory(pinned, KEY).notes[0].updatedAt, undefined);
});

test("editing a nonexistent note id is a harmless no-op", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "real note", false, Date.now());
  const result = memoryMutations.updateNote(state, KEY, "does-not-exist", "new text", Date.now());
  assert.deepEqual(getRepoMemory(result, KEY), getRepoMemory(state, KEY));
});

test("editing over the length limit is rejected, and the ORIGINAL text is left untouched", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "original", false, Date.now());
  const noteId = getRepoMemory(state, KEY).notes[0].id;
  assert.throws(() => memoryMutations.updateNote(state, KEY, noteId, "x".repeat(MAX_NOTE_LENGTH + 1), Date.now()), MemoryLimitError);
  assert.equal(getRepoMemory(state, KEY).notes[0].text, "original");
});

// ==================== grandfathered data is never truncated ====================

test("a legacy note already over MAX_NOTE_LENGTH survives migration with EVERY character intact", () => {
  const legacyText = "x".repeat(6000);
  const state = normalizeLoadedMemory({ "/repo/legacy": { notes: [{ id: "n1", text: legacyText, pinned: false, createdAt: 1 }], commands: [] } });
  assert.equal(getRepoMemory(state, "/repo/legacy").notes[0].text, legacyText);
});

test("a legacy repository with 250 notes (more than today's 200-note limit) keeps ALL 250 through migration", () => {
  const legacyNotes = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, text: `legacy note ${i}`, pinned: false, createdAt: i }));
  const state = normalizeLoadedMemory({ "/repo/many-notes": { notes: legacyNotes, commands: [] } });
  assert.equal(getRepoMemory(state, "/repo/many-notes").notes.length, 250);
});

test("exporting a grandfathered oversized note/repository is lossless, never truncated to fit today's limits", () => {
  const legacyText = "z".repeat(5000);
  const legacyNotes = Array.from({ length: 210 }, (_, i) =>
    i === 0 ? { id: "n0", text: legacyText, pinned: false, createdAt: 0 } : { id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i },
  );
  const exported = buildMemoryExport([{ label: "repo-a", memory: getRepoMemory(stateWith(legacyNotes), KEY) }], Date.now());
  assert.equal(exported.repositories[0].notes.length, 210);
  assert.equal(exported.repositories[0].notes.find((n) => n.id === "n0")!.text, legacyText);
});

test("saving a grandfathered oversized note UNCHANGED is a harmless no-op, never rejected merely for existing", () => {
  const legacyText = "w".repeat(MAX_NOTE_LENGTH + 500);
  const state = stateWith([{ id: "n1", text: legacyText, pinned: false, createdAt: 1 }]);
  const result = memoryMutations.updateNote(state, KEY, "n1", legacyText, Date.now());
  assert.equal(getRepoMemory(result, KEY).notes[0].text, legacyText);
});

test("shrinking a grandfathered oversized note back under the limit is accepted as a normal edit", () => {
  const state = stateWith([{ id: "n1", text: "w".repeat(MAX_NOTE_LENGTH + 500), pinned: false, createdAt: 1 }]);
  const result = memoryMutations.updateNote(state, KEY, "n1", "shortened text", Date.now());
  assert.equal(getRepoMemory(result, KEY).notes[0].text, "shortened text");
});

test("sanitizeNoteList never caps list length to today's count limit", () => {
  const manyNotes = Array.from({ length: MAX_NOTES_PER_REPO + 50 }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  assert.equal(sanitizeNoteList(manyNotes).length, MAX_NOTES_PER_REPO + 50);
});

// ==================== pin / remove / isolation ====================

test("pin: pinning an unpinned note sets pinned true; toggling again unpins", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "note", false, Date.now());
  const noteId = getRepoMemory(state, KEY).notes[0].id;
  const pinned = memoryMutations.togglePin(state, KEY, noteId);
  assert.equal(getRepoMemory(pinned, KEY).notes[0].pinned, true);
  const unpinned = memoryMutations.togglePin(pinned, KEY, noteId);
  assert.equal(getRepoMemory(unpinned, KEY).notes[0].pinned, false);
});

test("pinning note B unpins note A — at most one pinned note at a time", () => {
  let state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "A", true, Date.now());
  state = memoryMutations.addNote(state, KEY, "B", false, Date.now());
  const bId = getRepoMemory(state, KEY).notes.find((n) => n.text === "B")!.id;
  const notes = getRepoMemory(memoryMutations.togglePin(state, KEY, bId), KEY).notes;
  assert.equal(notes.find((n) => n.text === "A")!.pinned, false);
  assert.equal(notes.find((n) => n.text === "B")!.pinned, true);
});

test("remove: deletes the matching note and leaves others untouched; a nonexistent id is harmless", () => {
  let state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "keep", false, Date.now());
  state = memoryMutations.addNote(state, KEY, "remove me", false, Date.now());
  const removeId = getRepoMemory(state, KEY).notes.find((n) => n.text === "remove me")!.id;
  const after = memoryMutations.removeNote(state, KEY, removeId);
  assert.deepEqual(getRepoMemory(after, KEY).notes.map((n) => n.text), ["keep"]);
  assert.equal(memoryMutations.removeNote(after, KEY, "no-such-id"), after);
});

test("per-repo isolation: notes added under one key never appear under a different key", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), "repo-a", "A's note", false, Date.now());
  assert.deepEqual(getRepoMemory(state, "repo-b"), { notes: [] });
  assert.equal(getRepoMemory(state, "repo-a").notes.length, 1);
});

// ==================== search / copy ====================

test("search: case-insensitive substring over note text, order preserved; an empty query returns everything", () => {
  const notes = [
    { id: "1", text: "Deploy with ./deploy.sh --prod", pinned: false, createdAt: 1 },
    { id: "2", text: "Ask Priya about billing", pinned: false, createdAt: 2 },
    { id: "3", text: "Staging DEPLOY is manual", pinned: false, createdAt: 3 },
  ];
  assert.deepEqual(searchNotes(notes, "deploy").map((n) => n.id), ["1", "3"]);
  assert.deepEqual(searchNotes(notes, "  PRIYA ").map((n) => n.id), ["2"]);
  assert.deepEqual(searchNotes(notes, "   ").map((n) => n.id), ["1", "2", "3"]);
  assert.deepEqual(searchNotes(notes, "nothing matches"), []);
});

test("copy: the copied text is the stored text byte-for-byte (including newlines and shell metacharacters)", () => {
  const text = "Release:\n  git tag -s v1.2.3 && git push --tags; echo \"$HOME\" `whoami`\n\ttab";
  const notes = [{ id: "n1", text, pinned: false, createdAt: 1 }];
  assert.equal(noteCopyText(notes, "n1"), text);
  assert.equal(noteCopyText(notes, "missing"), undefined);
});

// ==================== malformed / migration ====================

test("malformed stored-state sanitation: garbage input never crashes and always normalizes to an empty v3 state", () => {
  for (const garbage of [null, undefined, 42, "a string", [], { version: 2 }, { version: 3 }, { version: 3, notesByRepoKey: "nope" }, { version: 2, notesByRepoKey: "nope", commandsByCheckoutKey: 7 }, { notesByRepoKey: { a: "not-an-array" } }]) {
    const state = normalizeLoadedMemory(garbage);
    assert.equal(state.version, 3);
    assert.deepEqual(state.notesByRepoKey, {}, JSON.stringify(garbage));
  }
});

test("malformed stored-state sanitation: an individual corrupt note entry is discarded, not the whole list", () => {
  const state = normalizeLoadedMemory({
    version: 3,
    notesByRepoKey: {
      "repo-a": [
        { id: "1", text: "valid note", pinned: false, createdAt: 100 },
        { id: "2", text: "", pinned: false, createdAt: 100 },
        { id: "3", pinned: false, createdAt: 100 },
        "not even an object",
        { id: "4", text: "another valid note", pinned: true, createdAt: 200 },
      ],
    },
  });
  assert.deepEqual(state.notesByRepoKey["repo-a"].map((n) => n.text).sort(), ["another valid note", "valid note"]);
});

test("malformed stored-state sanitation: more than one pinned note is repaired to at most one", () => {
  const state = normalizeLoadedMemory({
    version: 3,
    notesByRepoKey: {
      "repo-a": [
        { id: "1", text: "first pinned", pinned: true, createdAt: 100 },
        { id: "2", text: "second pinned", pinned: true, createdAt: 200 },
      ],
    },
  });
  assert.equal(state.notesByRepoKey["repo-a"].filter((n) => n.pinned).length, 1);
});

test("needsMigration: only a non-v3 blob needs persisting; nothing stored needs nothing", () => {
  assert.equal(needsMigration(undefined), false);
  assert.equal(needsMigration(null), false);
  assert.equal(needsMigration({ version: 3, notesByRepoKey: {} }), false);
  assert.equal(needsMigration({ version: 2, notesByRepoKey: {}, commandsByCheckoutKey: {} }), true);
  assert.equal(needsMigration({ "/repo": { notes: [], commands: [] } }), true);
});

// ---- saved commands → notes ----

test("saved-command migration (v1): each command becomes a deterministic note '<label>\\n<command>' under the same key, notes kept", () => {
  const legacy = {
    "/Users/dev/project-a": {
      notes: [{ id: "n1", text: "old note", pinned: true, createdAt: 111 }],
      commands: [{ id: "c1", label: "Start", command: "npm start", createdAt: 222 }],
    },
    "/Users/dev/project-b": { notes: [{ id: "n2", text: "another old note", pinned: false, createdAt: 333 }], commands: [] },
  };
  const state = normalizeLoadedMemory(legacy);
  assert.equal(state.version, 3);
  assert.deepEqual(getRepoMemory(state, "/Users/dev/project-a").notes, [
    { id: "n1", text: "old note", pinned: true, createdAt: 111 },
    { id: `${LEGACY_COMMAND_NOTE_ID_PREFIX}c1`, text: "Start\nnpm start", pinned: false, createdAt: 222 },
  ]);
  assert.deepEqual(getRepoMemory(state, "/Users/dev/project-b").notes.map((n) => n.text), ["another old note"]);
  assert.equal(JSON.stringify(state).includes("commands"), false, "no saved-command structure survives in v3 storage");
});

test("saved-command migration (v2): commands keyed by CHECKOUT become notes under that checkout key, losslessly (long text, shell metacharacters, newlines)", () => {
  const longCommand = "echo " + "y".repeat(3000) + " && rm -rf \"$TMP\"/x; `date`\nsecond line";
  const v2 = {
    version: 2,
    notesByRepoKey: { "/repo/.git": [{ id: "n1", text: "repo note", pinned: false, createdAt: 1 }] },
    commandsByCheckoutKey: {
      "/repo": [{ id: "c1", label: "  Deploy (prod)  ", command: longCommand, createdAt: 5 }],
      "/repo-wt": [{ id: "c2", label: "Test", command: "pnpm test", createdAt: 6 }, { id: "bad" }],
    },
  };
  const state = normalizeLoadedMemory(v2);
  assert.deepEqual(state.notesByRepoKey["/repo/.git"].map((n) => n.id), ["n1"]);
  assert.deepEqual(state.notesByRepoKey["/repo"], [
    { id: "legacy-cmd-c1", text: `  Deploy (prod)  \n${longCommand}`, pinned: false, createdAt: 5 },
  ]);
  assert.deepEqual(state.notesByRepoKey["/repo-wt"].map((n) => n.text), ["Test\npnpm test"]);
});

test("saved-command migration is idempotent and deterministic: migrating twice, or re-normalizing the result, changes nothing", () => {
  const v2 = {
    version: 2,
    notesByRepoKey: {},
    commandsByCheckoutKey: { "/repo": [{ id: "c1", label: "Build", command: "make", createdAt: 1 }] },
  };
  const first = normalizeLoadedMemory(v2);
  assert.deepEqual(normalizeLoadedMemory(v2), first);
  assert.deepEqual(normalizeLoadedMemory(JSON.parse(JSON.stringify(first))), first);
  assert.equal(needsMigration(first), false);
});

test("saved-command migration across worktrees: reconciling each checkout key into the shared repository key collects every command once", () => {
  const v2 = {
    version: 2,
    notesByRepoKey: { "/repo/.git": [{ id: "n1", text: "shared", pinned: false, createdAt: 1 }] },
    commandsByCheckoutKey: {
      "/repo": [{ id: "c1", label: "A", command: "a", createdAt: 2 }],
      "/repo-wt": [{ id: "c2", label: "B", command: "b", createdAt: 3 }],
    },
  };
  let state = normalizeLoadedMemory(v2);
  state = reconcileStaleKey(state, "/repo", "/repo/.git");
  state = reconcileStaleKey(state, "/repo-wt", "/repo/.git");
  // A second window / second startup doing the same thing again is harmless.
  const settled = state;
  state = reconcileStaleKey(state, "/repo", "/repo/.git");
  state = reconcileStaleKey(state, "/repo-wt", "/repo/.git");
  assert.equal(state, settled, "re-reconciling is a no-op");
  assert.deepEqual(Object.keys(state.notesByRepoKey), ["/repo/.git"]);
  assert.deepEqual(state.notesByRepoKey["/repo/.git"].map((n) => n.id), ["n1", "legacy-cmd-c1", "legacy-cmd-c2"]);
});

test("a migrated command note is an ordinary note: searchable, copyable as exact text, editable, deletable", () => {
  const note = legacyCommandToNote({ id: "c9", label: "Release", command: "npm version patch && git push --follow-tags", createdAt: 9 });
  let state = stateWith([note]);
  assert.deepEqual(searchNotes(getRepoMemory(state, KEY).notes, "follow-tags").map((n) => n.id), ["legacy-cmd-c9"]);
  assert.equal(noteCopyText(getRepoMemory(state, KEY).notes, "legacy-cmd-c9"), "Release\nnpm version patch && git push --follow-tags");
  state = memoryMutations.updateNote(state, KEY, "legacy-cmd-c9", "Release\nnpm version minor", 10);
  assert.equal(getRepoMemory(state, KEY).notes[0].text, "Release\nnpm version minor");
  state = memoryMutations.removeNote(state, KEY, "legacy-cmd-c9");
  assert.deepEqual(getRepoMemory(state, KEY).notes, []);
});

test("reconcileStaleKey merges a stale key's notes into the canonical key without dropping anything, and removes the stale key", () => {
  let state = memoryMutations.addNote(emptyPersistedMemory(), "/raw/path", "stale note", false, Date.now());
  state = memoryMutations.addNote(state, "/canonical/path", "already canonical note", false, Date.now());
  const reconciled = reconcileStaleKey(state, "/raw/path", "/canonical/path");
  assert.equal(reconciled.notesByRepoKey["/raw/path"], undefined);
  assert.equal(reconciled.notesByRepoKey["/canonical/path"].length, 2);
});

test("reconcileStaleKey is a no-op when the stale key has no data, or already equals the canonical key", () => {
  const state = emptyPersistedMemory();
  assert.equal(reconcileStaleKey(state, "/nothing/here", "/canonical"), state);
  assert.equal(reconcileStaleKey(state, "/same", "/same"), state);
});

// ==================== storage limits (new mutations only) ====================

test("maximum-size boundaries: a note exactly at MAX_NOTE_LENGTH is accepted; one character over is rejected", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), KEY, "x".repeat(MAX_NOTE_LENGTH), false, Date.now());
  assert.equal(getRepoMemory(state, KEY).notes[0].text.length, MAX_NOTE_LENGTH);
  assert.throws(() => memoryMutations.addNote(emptyPersistedMemory(), KEY, "x".repeat(MAX_NOTE_LENGTH + 1), false, Date.now()), MemoryLimitError);
});

test("maximum-size boundaries: the MAX_NOTES_PER_REPOth note is accepted; the next one is rejected, and existing notes are untouched", () => {
  let state = emptyPersistedMemory();
  for (let i = 0; i < MAX_NOTES_PER_REPO; i++) {
    state = memoryMutations.addNote(state, KEY, `note ${i}`, false, Date.now());
  }
  assert.throws(
    () => memoryMutations.addNote(state, KEY, "one too many", false, Date.now()),
    (error: unknown) => error instanceof MemoryLimitError && /maximum/i.test(error.message),
  );
  assert.equal(getRepoMemory(state, KEY).notes.length, MAX_NOTES_PER_REPO);
});

test("a repository already grandfathered ABOVE the note limit still rejects a brand new add", () => {
  const legacyNotes = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  const state = stateWith(legacyNotes);
  assert.throws(() => memoryMutations.addNote(state, KEY, "one more note", false, Date.now()), MemoryLimitError);
  assert.equal(getRepoMemory(state, KEY).notes.length, 250);
});

// ==================== export / import ====================

test("export: produces a v2 (notes-only) document containing exactly the given repository's notes, no paths", () => {
  const state = memoryMutations.addNote(emptyPersistedMemory(), "/home/me/secret-project/.git", "exportable note", false, Date.now());
  const exported = buildMemoryExport([{ label: "my-repo", memory: getRepoMemory(state, "/home/me/secret-project/.git") }], 12345);
  assert.equal(exported.exportSchemaVersion, MEMORY_EXPORT_SCHEMA_VERSION);
  assert.equal(exported.exportSchemaVersion, 2);
  assert.equal(exported.exportedAt, 12345);
  assert.deepEqual(exported.repositories.map((r) => r.label), ["my-repo"]);
  assert.equal(exported.repositories[0].notes[0].text, "exportable note");
  assert.equal(JSON.stringify(exported).includes("secret-project"), false, "an export never contains a local path");
  assert.equal("commands" in exported.repositories[0], false);
});

test("safe import: previews never mutate anything and correctly summarize entries", () => {
  const source = memoryMutations.addNote(emptyPersistedMemory(), "source", "imported note", false, Date.now());
  const exported = buildMemoryExport([{ label: "source", memory: getRepoMemory(source, "source") }], Date.now());
  const target = emptyPersistedMemory();
  const filePreview = previewMemoryImportFile(exported);
  assert.equal(filePreview.valid, true);
  assert.deepEqual(filePreview.entries, [{ index: 0, label: "source", noteCount: 1, legacyCommandCount: 0 }]);
  const entryPreview = previewMemoryImportEntry(exported, 0, getRepoMemory(target, KEY));
  assert.equal(entryPreview.valid, true);
  assert.equal(entryPreview.noteCount, 1);
  assert.deepEqual(target, emptyPersistedMemory());
});

test("safe import: a file with the wrong/missing schema version is rejected with a clear error, not imported", () => {
  for (const bad of [{ exportSchemaVersion: 999, repositories: [] }, { repositories: [{ label: "x", notes: [] }] }, null, "text"]) {
    const preview = previewMemoryImportFile(bad);
    assert.equal(preview.valid, false);
    assert.ok(preview.error);
    assert.throws(() => applyMemoryImport(emptyPersistedMemory(), KEY, bad, 0, { overwriteDuplicates: false }), MemoryLimitError);
  }
});

test("legacy import (export v1 with saved commands): commands are imported as notes with the SAME deterministic ids as the storage migration", () => {
  const v1Export = {
    exportSchemaVersion: 1,
    exportedAt: 1,
    repositories: [
      {
        label: "old",
        notes: [{ id: "n1", text: "a note", pinned: false, createdAt: 1 }],
        commands: [{ id: "c1", label: "Lint", command: "npm run lint -- --fix", createdAt: 2 }],
      },
    ],
  };
  const preview = previewMemoryImportFile(v1Export);
  assert.deepEqual(preview.entries, [{ index: 0, label: "old", noteCount: 2, legacyCommandCount: 1 }]);

  const imported = applyMemoryImport(emptyPersistedMemory(), KEY, v1Export, 0, { overwriteDuplicates: false });
  assert.deepEqual(getRepoMemory(imported, KEY).notes.map((n) => [n.id, n.text]), [
    ["n1", "a note"],
    ["legacy-cmd-c1", "Lint\nnpm run lint -- --fix"],
  ]);

  // Importing the same old export into a repository whose stored commands
  // were ALREADY migrated never duplicates them.
  const again = applyMemoryImport(imported, KEY, v1Export, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(again, KEY).notes.length, 2);
});

test("imported command text is NEVER executed — it is inert data copied as a note", () => {
  let executed = false;
  const originalEval = globalThis.eval;
  try {
    (globalThis as unknown as { eval: (s: string) => unknown }).eval = (script: string) => {
      executed = true;
      return originalEval(script);
    };
    const v1Export = {
      exportSchemaVersion: 1,
      exportedAt: 1,
      repositories: [{ label: "x", notes: [], commands: [{ id: "c1", label: "dangerous", command: "throw new Error('should never run')", createdAt: 1 }] }],
    };
    const imported = applyMemoryImport(emptyPersistedMemory(), KEY, v1Export, 0, { overwriteDuplicates: false });
    assert.equal(getRepoMemory(imported, KEY).notes[0].text, "dangerous\nthrow new Error('should never run')");
  } finally {
    globalThis.eval = originalEval;
  }
  assert.equal(executed, false);
});

test("safe import: imported notes never arrive pre-pinned", () => {
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: "n1", text: "was pinned", pinned: true, createdAt: 1 }] } }], Date.now());
  const imported = applyMemoryImport(emptyPersistedMemory(), KEY, exported, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(imported, KEY).notes[0].pinned, false);
});

test("duplicate import behavior: an existing id is SKIPPED by default, replaced only with overwriteDuplicates (keeping the target's pin)", () => {
  const now = Date.now();
  const target = memoryMutations.addNote(emptyPersistedMemory(), KEY, "original text", true, now);
  const originalId = getRepoMemory(target, KEY).notes[0].id;
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: originalId, text: "new text", pinned: false, createdAt: now }] } }], now);

  assert.deepEqual(previewMemoryImportEntry(exported, 0, getRepoMemory(target, KEY)).duplicateNoteIds, [originalId]);
  const skipped = applyMemoryImport(target, KEY, exported, 0, { overwriteDuplicates: false });
  assert.equal(getRepoMemory(skipped, KEY).notes[0].text, "original text");

  const overwritten = applyMemoryImport(target, KEY, exported, 0, { overwriteDuplicates: true });
  assert.equal(getRepoMemory(overwritten, KEY).notes.length, 1);
  assert.equal(getRepoMemory(overwritten, KEY).notes[0].text, "new text");
  assert.equal(getRepoMemory(overwritten, KEY).notes[0].pinned, true);
});

test("an import that would push a repository over MAX_NOTES_PER_REPO is REJECTED atomically, never truncated", () => {
  let state = emptyPersistedMemory();
  for (let i = 0; i < MAX_NOTES_PER_REPO - 1; i++) {
    state = memoryMutations.addNote(state, KEY, `existing note ${i}`, false, Date.now());
  }
  const importedNotes = Array.from({ length: 5 }, (_, i) => ({ id: `imported-${i}`, text: `imported note ${i}`, pinned: false, createdAt: Date.now() }));
  const exported = buildMemoryExport([{ label: "x", memory: { notes: importedNotes } }], Date.now());
  assert.throws(
    () => applyMemoryImport(state, KEY, exported, 0, { overwriteDuplicates: false }),
    (error: unknown) => error instanceof MemoryLimitError && /over the .* limit/i.test(error.message),
  );
  assert.equal(getRepoMemory(state, KEY).notes.length, MAX_NOTES_PER_REPO - 1);
});

test("an import containing a note over today's length limit is REJECTED outright, never truncated", () => {
  const exported = buildMemoryExport([{ label: "x", memory: { notes: [{ id: "big", text: "q".repeat(MAX_NOTE_LENGTH + 1), pinned: false, createdAt: 1 }] } }], Date.now());
  const preview = previewMemoryImportEntry(exported, 0, { notes: [] });
  assert.equal(preview.valid, false);
  assert.equal(preview.oversizedNoteCount, 1);
  assert.throws(() => applyMemoryImport(emptyPersistedMemory(), KEY, exported, 0, { overwriteDuplicates: false }), MemoryLimitError);
});

test("re-importing duplicates-only into an already-grandfathered-over-limit repository does not spuriously throw", () => {
  const legacyNotes = Array.from({ length: 205 }, (_, i) => ({ id: `n${i}`, text: `note ${i}`, pinned: false, createdAt: i }));
  const target = stateWith(legacyNotes);
  const exported = buildMemoryExport([{ label: "x", memory: getRepoMemory(target, KEY) }], Date.now());
  const imported = applyMemoryImport(target, KEY, exported, 0, { overwriteDuplicates: true });
  assert.equal(getRepoMemory(imported, KEY).notes.length, 205);
});

test("multi-repository import: preview summarizes every entry; apply imports ONLY the chosen entry", () => {
  const exported = buildMemoryExport(
    [
      { label: "repo-1", memory: { notes: [{ id: "n1", text: "repo 1 note", pinned: false, createdAt: 1 }] } },
      { label: "repo-2", memory: { notes: [{ id: "n2", text: "repo 2 note", pinned: false, createdAt: 1 }, { id: "n3", text: "repo 2 note 2", pinned: false, createdAt: 1 }] } },
    ],
    Date.now(),
  );
  assert.deepEqual(previewMemoryImportFile(exported).entries.map((e) => [e.label, e.noteCount]), [
    ["repo-1", 1],
    ["repo-2", 2],
  ]);
  const imported = applyMemoryImport(emptyPersistedMemory(), KEY, exported, 0, { overwriteDuplicates: false });
  assert.deepEqual(getRepoMemory(imported, KEY).notes.map((n) => n.text), ["repo 1 note"]);
});

test("sanitizeNoteList discards structurally invalid entries and duplicate ids", () => {
  const mixed = [{ id: "n1", text: "valid", pinned: false, createdAt: 1 }, "garbage", { id: "n1", text: "duplicate id, skipped", pinned: false, createdAt: 2 }];
  assert.deepEqual(sanitizeNoteList(mixed).map((n) => n.text), ["valid"]);
});
