import type * as vscode from "vscode";
import { canonicalizeRepoPath } from "../services/gitService";
import { RepoMemory } from "../types";
import {
  ImportEntryPreview,
  ImportFilePreview,
  ImportOptions,
  MemoryExport,
  PersistedMemoryV3,
  applyMemoryImport,
  buildMemoryExport,
  getRepoMemory,
  makeId,
  memoryMutations,
  needsMigration,
  normalizeLoadedMemory,
  noteCopyText,
  previewMemoryImportEntry,
  previewMemoryImportFile,
  reconcileStaleKey,
  searchNotes,
} from "./memoryStoreCore";

export { MemoryLimitError, MAX_NOTE_LENGTH, MAX_NOTES_PER_REPO, MAX_IMPORT_FILE_BYTES } from "./memoryStoreCore";
export type { ImportEntryPreview, ImportEntrySummary, ImportFilePreview, ImportOptions, MemoryExport } from "./memoryStoreCore";

const STORAGE_KEY = "repoIdentityGuard.memoryByRepo";

/**
 * The persistence surface `MemoryStore` needs — exactly the subset of
 * `vscode.Memento` it uses, so tests can supply an in-memory fake.
 */
export interface MemoryBackend {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface MemoryKeys {
  /** Canonical git common directory — the repository-wide notes key shared by every linked worktree. */
  notesKey: string;
  /**
   * Canonical checkout (worktree) root. Notes never live here any more; it
   * is kept only so data stored under it by older releases (migrated saved
   * commands) can be reconciled into `notesKey` — see `reconcileLegacyKeys`.
   */
  checkoutKey: string;
}

/**
 * Repo Notes is local-first and private: it lives only in this VS Code
 * install's global storage (never a file inside the repository), so notes
 * can never be accidentally committed or pushed, and it is never added to
 * Settings Sync.
 *
 * Mutations are serialized through a single internal promise queue
 * (`enqueue`): `globalState` read-modify-write is not atomic across
 * concurrent webview messages, so every public mutator is queued. The
 * queue always resolves, even when the mutation it ran rejected, so one
 * failed mutation can never wedge every mutation after it.
 *
 * SCOPE OF THIS GUARANTEE: the queue serializes mutations WITHIN ONE
 * `MemoryStore` instance (one VS Code window). Two windows editing notes
 * around the same moment can still lose an update to each other —
 * `globalState` offers no cross-window notification or compare-and-swap.
 * See `src/test/memoryStore.test.ts`'s "documented limitation" test and
 * README.md.
 */
export class MemoryStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly backend: MemoryBackend;

  public constructor(contextOrBackend: vscode.ExtensionContext | MemoryBackend) {
    this.backend = "globalState" in contextOrBackend ? contextOrBackend.globalState : contextOrBackend;
  }

  private readAll(): PersistedMemoryV3 {
    return normalizeLoadedMemory(this.backend.get<unknown>(STORAGE_KEY));
  }

  private async writeAll(state: PersistedMemoryV3): Promise<void> {
    await this.backend.update(STORAGE_KEY, state);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const previousSettled = this.queue;
    const settle = previousSettled.then(fn, fn);
    this.queue = settle.then(
      () => undefined,
      () => undefined,
    );
    return settle;
  }

  /**
   * Persists the schema migration (v1/v2 → v3, saved commands → notes)
   * once, at activation, so it is not merely re-derived in memory on every
   * read. Idempotent: a v3 store is left untouched, and the migration
   * itself is deterministic (see memoryStoreCore.ts).
   */
  public async migrateStorage(): Promise<boolean> {
    return this.enqueue(async () => {
      const raw = this.backend.get<unknown>(STORAGE_KEY);
      if (!needsMigration(raw)) return false;
      await this.writeAll(normalizeLoadedMemory(raw));
      return true;
    });
  }

  /** Resolves the canonical keys for a repository/checkout via a real filesystem call. */
  public async resolveKeys(repoRoot: string, gitCommonDir?: string): Promise<MemoryKeys> {
    const checkoutKey = await canonicalizeRepoPath(repoRoot);
    const notesKey = gitCommonDir ? await canonicalizeRepoPath(gitCommonDir) : checkoutKey;
    return { notesKey, checkoutKey };
  }

  /**
   * Opportunistic, lossless reconciliation of notes stored under a raw
   * (pre-canonicalization) repository root, or under this checkout's key
   * (saved commands migrated from schema v2), onto the repository-wide
   * notes key. Merges by id, never overwrites; a no-op once reconciled.
   */
  public async reconcileLegacyKeys(rawRepoRoot: string, keys: MemoryKeys): Promise<void> {
    await this.enqueue(async () => {
      const all = this.readAll();
      let next = reconcileStaleKey(all, rawRepoRoot, keys.notesKey);
      next = reconcileStaleKey(next, keys.checkoutKey, keys.notesKey);
      if (next === all) return;
      await this.writeAll(next);
    });
  }

  public getMemory(keys: MemoryKeys): RepoMemory {
    return getRepoMemory(this.readAll(), keys.notesKey);
  }

  public searchNotes(keys: MemoryKeys, query: string): RepoMemory {
    return { notes: searchNotes(this.getMemory(keys).notes, query) };
  }

  /** The exact stored text of one note (what "Copy note" copies), or `undefined`. */
  public getNoteText(keys: MemoryKeys, noteId: string): string | undefined {
    return noteCopyText(this.getMemory(keys).notes, noteId);
  }

  private mutate(mutator: (state: PersistedMemoryV3) => PersistedMemoryV3): Promise<PersistedMemoryV3> {
    return this.enqueue(async () => {
      const all = this.readAll();
      const next = mutator(all);
      if (next !== all) {
        await this.writeAll(next);
      }
      return next;
    });
  }

  public async addNote(keys: MemoryKeys, text: string, pinned = false): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.addNote(state, keys.notesKey, text, pinned, Date.now()));
    return getRepoMemory(next, keys.notesKey);
  }

  public async updateNote(keys: MemoryKeys, noteId: string, text: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.updateNote(state, keys.notesKey, noteId, text, Date.now()));
    return getRepoMemory(next, keys.notesKey);
  }

  public async removeNote(keys: MemoryKeys, noteId: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.removeNote(state, keys.notesKey, noteId));
    return getRepoMemory(next, keys.notesKey);
  }

  public async togglePin(keys: MemoryKeys, noteId: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.togglePin(state, keys.notesKey, noteId));
    return getRepoMemory(next, keys.notesKey);
  }

  /** Exports the given repository's notes only. */
  public exportMemory(keys: MemoryKeys, label: string): MemoryExport {
    return buildMemoryExport([{ label, memory: this.getMemory(keys) }], Date.now());
  }

  public exportAllMemory(repos: Array<{ label: string; keys: MemoryKeys }>): MemoryExport {
    return buildMemoryExport(
      repos.map(({ label, keys }) => ({ label, memory: this.getMemory(keys) })),
      Date.now(),
    );
  }

  public previewImportFile(raw: unknown): ImportFilePreview {
    return previewMemoryImportFile(raw);
  }

  public previewImportEntry(keys: MemoryKeys, raw: unknown, entryIndex: number): ImportEntryPreview {
    return previewMemoryImportEntry(raw, entryIndex, this.getMemory(keys));
  }

  public async importMemory(keys: MemoryKeys, raw: unknown, entryIndex: number, options: ImportOptions): Promise<RepoMemory> {
    const next = await this.mutate((state) => applyMemoryImport(state, keys.notesKey, raw, entryIndex, options));
    return getRepoMemory(next, keys.notesKey);
  }
}

export { makeId };
