import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLimitError, MemoryStore } from "../storage/memoryStore";

/**
 * `MemoryStore` imports `vscode` only for a type annotation
 * (`vscode.ExtensionContext`), which TypeScript elides from the compiled
 * output entirely — there is no `require("vscode")` in `out/storage/
 * memoryStore.js`. That makes `MemoryStore` itself testable with a plain
 * fake `globalState`, no Extension Host needed, which is what every test
 * below does.
 */

interface FakeContext {
  globalState: {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): Promise<void>;
  };
}

/** `updateDelayMs` simulates a real `globalState.update`'s asynchrony (VS Code persists it, not instant) — widening the race window a concurrency bug would need to actually lose an update inside. */
function makeFakeContext(updateDelayMs = 0): { context: FakeContext; snapshot: () => unknown } {
  let store: unknown;
  const context: FakeContext = {
    globalState: {
      get: <T>(_key: string, defaultValue?: T): T => (store === undefined ? (defaultValue as T) : (store as T)),
      update: async (_key: string, value: unknown): Promise<void> => {
        if (updateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, updateDelayMs));
        store = value;
      },
    },
  };
  return { context, snapshot: () => store };
}

function newStore(updateDelayMs = 0): { store: MemoryStore; snapshot: () => unknown; context: FakeContext } {
  const { context, snapshot } = makeFakeContext(updateDelayMs);
  return { store: new MemoryStore(context as never), snapshot, context };
}

const KEYS = { notesKey: "repo-a", checkoutKey: "repo-a" };

test("persistence: a fresh MemoryStore constructed over the same mocked globalState sees what an earlier instance wrote", async () => {
  const { store: first, context } = newStore();
  await first.addNote(KEYS, "persisted note", false);

  const second = new MemoryStore(context as never);
  const memory = second.getMemory(KEYS);
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].text, "persisted note");
});

// ==================== concurrency ====================

test("concurrent add/add: two overlapping addNote calls never lose either note", async () => {
  const { store } = newStore(10);
  await Promise.all([store.addNote(KEYS, "first note", false), store.addNote(KEYS, "second note", false)]);
  const memory = store.getMemory(KEYS);
  assert.equal(memory.notes.length, 2);
  assert.deepEqual(memory.notes.map((n) => n.text).sort(), ["first note", "second note"]);
});

test("concurrent add/remove: an add racing a remove of a DIFFERENT note cannot resurrect the removed one", async () => {
  const { store } = newStore(10);
  await store.addNote(KEYS, "to be removed", false);
  const toRemoveId = store.getMemory(KEYS).notes[0].id;

  await Promise.all([
    store.removeNote(KEYS, toRemoveId),
    store.addNote(KEYS, "new note added concurrently", false),
  ]);

  const memory = store.getMemory(KEYS);
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].text, "new note added concurrently");
  assert.ok(!memory.notes.some((n) => n.id === toRemoveId), "the removed note must not be resurrected");
});

test("concurrent edit/pin: rapid overlapping updateNote and togglePin calls on the same note remain deterministic and both apply", async () => {
  const { store } = newStore(10);
  await store.addNote(KEYS, "original text", false);
  const noteId = store.getMemory(KEYS).notes[0].id;

  await Promise.all([store.updateNote(KEYS, noteId, "edited text"), store.togglePin(KEYS, noteId)]);

  const note = store.getMemory(KEYS).notes.find((n) => n.id === noteId)!;
  assert.equal(note.text, "edited text");
  assert.equal(note.pinned, true);
});

test("a failed mutation (over-limit) does not permanently poison the queue — a later, valid mutation still succeeds", async () => {
  const { store } = newStore(5);
  const tooLong = "x".repeat(10_000);

  const failing = store.addNote(KEYS, tooLong, false);
  const succeeding = store.addNote(KEYS, "valid note", false);

  await assert.rejects(failing, MemoryLimitError);
  await succeeding;

  const memory = store.getMemory(KEYS);
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].text, "valid note");
});

test("many concurrent addNote calls (stress) all land — none lost to interleaved read/mutate/write", async () => {
  const { store } = newStore(2);
  const count = 25;
  await Promise.all(Array.from({ length: count }, (_, i) => store.addCommand(KEYS, `cmd ${i}`, `echo ${i}`)));
  assert.equal(store.getMemory(KEYS).commands.length, count);
});

// ==================== canonical path / casing behavior ====================

test("canonical path/casing behavior: resolveKeys canonicalizes a symlinked path to the same key as its real target", async () => {
  const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-real-"));
  const linkPath = path.join(os.tmpdir(), `memstore-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.symlink(realDir, linkPath, "dir");
    const { store } = newStore();
    const keysViaReal = await store.resolveKeys(realDir);
    const keysViaLink = await store.resolveKeys(linkPath);
    assert.equal(keysViaReal.checkoutKey, keysViaLink.checkoutKey, "a symlink and its real target must canonicalize to the SAME key");
  } finally {
    await fs.rm(linkPath, { force: true }).catch(() => undefined);
    await fs.rm(realDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("canonical path/casing behavior: resolveKeys falls back to the raw path (never throws) when the path does not exist on disk", async () => {
  const { store } = newStore();
  const keys = await store.resolveKeys("/definitely/does/not/exist/anywhere");
  assert.equal(keys.checkoutKey, "/definitely/does/not/exist/anywhere");
});

test("canonical path/casing behavior: notesKey is derived from gitCommonDir when supplied, independent of repoRoot", async () => {
  const commonDir = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-common-"));
  const checkoutDir = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-checkout-"));
  try {
    const { store } = newStore();
    const keys = await store.resolveKeys(checkoutDir, commonDir);
    assert.notEqual(keys.notesKey, keys.checkoutKey);
    const realCommon = await fs.realpath(commonDir);
    assert.equal(keys.notesKey, process.platform === "win32" ? realCommon.toLowerCase() : realCommon);
  } finally {
    await fs.rm(commonDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ==================== linked-worktree semantics (via shared notesKey) ====================

test("linked-worktree semantics: two different checkouts that share the SAME gitCommonDir share notes, but keep separate saved commands", async () => {
  const sharedCommonDir = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-shared-common-"));
  const worktreeA = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-wt-a-"));
  const worktreeB = await fs.mkdtemp(path.join(os.tmpdir(), "memstore-wt-b-"));
  try {
    const { store } = newStore();
    const keysA = await store.resolveKeys(worktreeA, sharedCommonDir);
    const keysB = await store.resolveKeys(worktreeB, sharedCommonDir);
    assert.equal(keysA.notesKey, keysB.notesKey, "linked worktrees of the same repo must share a notes key");
    assert.notEqual(keysA.checkoutKey, keysB.checkoutKey, "linked worktrees must NOT share a checkout key");

    await store.addNote(keysA, "shared repo note", false);
    assert.equal(store.getMemory(keysB).notes.length, 1, "a note added from worktree A must be visible from worktree B");

    await store.addCommand(keysA, "A-only command", "echo a");
    await store.addCommand(keysB, "B-only command", "echo b");
    assert.equal(store.getMemory(keysA).commands.length, 1, "saved commands must stay per-checkout");
    assert.equal(store.getMemory(keysB).commands.length, 1);
    assert.equal(store.getMemory(keysA).commands[0].label, "A-only command");
    assert.equal(store.getMemory(keysB).commands[0].label, "B-only command");
  } finally {
    await fs.rm(sharedCommonDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(worktreeA, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(worktreeB, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ==================== legacy key reconciliation ====================

test("reconcileLegacyKeys migrates data stored under a raw (pre-canonicalization) key onto the canonical keys, losslessly", async () => {
  const { store } = newStore();
  const rawRoot = "/some/raw/repoRoot";
  await store.addNote({ notesKey: rawRoot, checkoutKey: rawRoot }, "legacy note", false);
  await store.addCommand({ notesKey: rawRoot, checkoutKey: rawRoot }, "legacy cmd", "echo legacy");

  const canonicalKeys = { notesKey: "/canonical/notes", checkoutKey: "/canonical/checkout" };
  await store.reconcileLegacyKeys(rawRoot, canonicalKeys);

  const memory = store.getMemory(canonicalKeys);
  assert.equal(memory.notes.length, 1);
  assert.equal(memory.notes[0].text, "legacy note");
  assert.equal(memory.commands.length, 1);
  assert.equal(memory.commands[0].label, "legacy cmd");
  assert.deepEqual(store.getMemory({ notesKey: rawRoot, checkoutKey: rawRoot }), { notes: [], commands: [] }, "the stale key must be cleared after reconciliation");
});

test("reconcileLegacyKeys never overwrites data already present under the canonical key — it merges", async () => {
  const { store } = newStore();
  const rawRoot = "/raw/root";
  const canonicalKeys = { notesKey: "/canonical", checkoutKey: "/canonical" };
  await store.addNote(canonicalKeys, "already canonical note", false);
  await store.addNote({ notesKey: rawRoot, checkoutKey: rawRoot }, "legacy note", false);

  await store.reconcileLegacyKeys(rawRoot, canonicalKeys);

  assert.equal(store.getMemory(canonicalKeys).notes.length, 2);
});

// ==================== export / import via MemoryStore ====================

test("MemoryStore.exportMemory / importMemory round-trip preserves note text and skips duplicates by default", async () => {
  const { store: sourceStore } = newStore();
  await sourceStore.addNote(KEYS, "note to export", false);
  const exported = sourceStore.exportMemory(KEYS, "my-repo");

  const { store: targetStore } = newStore();
  const preview = targetStore.previewImport(KEYS, exported);
  assert.equal(preview.valid, true);
  assert.equal(preview.noteCount, 1);

  const result = await targetStore.importMemory(KEYS, exported, { overwriteDuplicates: false });
  assert.equal(result.notes[0].text, "note to export");

  // Importing the SAME export again must skip the now-duplicate id, not double it.
  const again = await targetStore.importMemory(KEYS, exported, { overwriteDuplicates: false });
  assert.equal(again.notes.length, 1);
});

test("MemoryStore.exportAllMemory includes every supplied repository under its own label", () => {
  const { store } = newStore();
  const exported = store.exportAllMemory([
    { label: "repo-1", keys: { notesKey: "r1", checkoutKey: "r1" } },
    { label: "repo-2", keys: { notesKey: "r2", checkoutKey: "r2" } },
  ]);
  assert.deepEqual(exported.repositories.map((r) => r.label), ["repo-1", "repo-2"]);
});
