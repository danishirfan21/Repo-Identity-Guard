import * as vscode from "vscode";
import { canonicalizeRepoPath } from "../services/gitService";
import { MemoryNote, RepoMemory } from "../types";
import {
  ImportOptions,
  ImportPreview,
  MemoryExport,
  PersistedMemoryV2,
  applyMemoryImport,
  buildMemoryExport,
  getRepoMemory,
  makeId,
  memoryMutations,
  normalizeLoadedMemory,
  previewMemoryImport,
  reconcileStaleKey,
} from "./memoryStoreCore";

export { MemoryLimitError, MAX_NOTE_LENGTH, MAX_NOTES_PER_REPO, MAX_COMMAND_LABEL_LENGTH, MAX_COMMAND_LENGTH, MAX_COMMANDS_PER_REPO } from "./memoryStoreCore";
export type { ImportOptions, ImportPreview, MemoryExport } from "./memoryStoreCore";

const STORAGE_KEY = "repoIdentityGuard.memoryByRepo";

export interface MemoryKeys {
  notesKey: string;
  checkoutKey: string;
}

/**
 * Repo Memory is local-first and private: it lives only in this VS Code
 * install's global storage (never a file inside the repo), so notes can
 * never be accidentally committed or pushed.
 *
 * Mutations are serialized through a single internal promise queue
 * (`enqueue`): `globalState` reads/writes are not atomic across concurrent
 * webview messages on their own (read snapshot, mutate, write back — two
 * overlapping calls can both read the same prior state and the
 * last-to-finish silently wins), so every public mutator here is queued
 * rather than racing directly against `globalState`. The queue itself
 * (`this.queue`) always resolves, even when the mutation it ran rejected —
 * see `enqueue`'s doc comment — so one failed mutation can never
 * permanently wedge every mutation after it.
 */
export class MemoryStore {
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly context: vscode.ExtensionContext) {}

  private readAll(): PersistedMemoryV2 {
    return normalizeLoadedMemory(this.context.globalState.get<unknown>(STORAGE_KEY));
  }

  private async writeAll(state: PersistedMemoryV2): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, state);
  }

  /**
   * Runs `fn` only after every previously-enqueued mutation on this store
   * has settled (succeeded OR failed), and lets later calls proceed
   * regardless of how this one turns out. `this.queue` is reassigned to a
   * promise that NEVER rejects (the `.catch(() => undefined)` at the end),
   * so a thrown `MemoryLimitError` — or any other failure — surfaces to
   * THIS call's caller via the returned/rejected `settle` promise without
   * poisoning the shared chain for every mutation queued after it.
   */
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
   * Resolves the canonical identity keys for a repository/checkout right
   * now via a real filesystem call — used by `enable`-adjacent one-shot
   * flows (export/import, reconciliation) that can afford to await it.
   * The hot path (`getMemory` on every render) instead takes an
   * already-resolved `MemoryKeys` from the caller — see
   * `extension.ts`'s `repoMemoryKeys` cache — so rendering the sidebar
   * never blocks on `fs.realpath`.
   */
  public async resolveKeys(repoRoot: string, gitCommonDir?: string): Promise<MemoryKeys> {
    const checkoutKey = await canonicalizeRepoPath(repoRoot);
    const notesKey = gitCommonDir ? await canonicalizeRepoPath(gitCommonDir) : checkoutKey;
    return { notesKey, checkoutKey };
  }

  /**
   * Opportunistic migration of a still-raw (pre-canonicalization) key
   * left over from an older release onto today's canonical keys — merges
   * (never overwrites) so no note/command is ever lost, and is a no-op
   * once a repository's data already lives under its canonical key.
   * Called once per repository per scan from `extension.ts`, right after
   * `resolveKeys`, so a repo opened again after an upgrade self-heals
   * without any explicit user action.
   */
  public async reconcileLegacyKeys(rawRepoRoot: string, keys: MemoryKeys): Promise<void> {
    if (rawRepoRoot === keys.notesKey && rawRepoRoot === keys.checkoutKey) return;
    await this.enqueue(async () => {
      const all = this.readAll();
      const withNotes = reconcileStaleKey(all, "notesByRepoKey", rawRepoRoot, keys.notesKey);
      const withCommands = reconcileStaleKey(withNotes, "commandsByCheckoutKey", rawRepoRoot, keys.checkoutKey);
      if (withCommands === all) return;
      await this.writeAll(withCommands);
    });
  }

  public getMemory(keys: MemoryKeys): RepoMemory {
    return getRepoMemory(this.readAll(), keys);
  }

  public getPinnedNote(notesKey: string): MemoryNote | undefined {
    return (this.readAll().notesByRepoKey[notesKey] ?? []).find((note) => note.pinned);
  }

  private mutate(mutator: (state: PersistedMemoryV2) => PersistedMemoryV2): Promise<PersistedMemoryV2> {
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
    return getRepoMemory(next, keys);
  }

  public async updateNote(keys: MemoryKeys, noteId: string, text: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.updateNote(state, keys.notesKey, noteId, text, Date.now()));
    return getRepoMemory(next, keys);
  }

  public async removeNote(keys: MemoryKeys, noteId: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.removeNote(state, keys.notesKey, noteId));
    return getRepoMemory(next, keys);
  }

  public async togglePin(keys: MemoryKeys, noteId: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.togglePin(state, keys.notesKey, noteId));
    return getRepoMemory(next, keys);
  }

  public async addCommand(keys: MemoryKeys, label: string, command: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.addCommand(state, keys.checkoutKey, label, command, Date.now()));
    return getRepoMemory(next, keys);
  }

  public async removeCommand(keys: MemoryKeys, commandId: string): Promise<RepoMemory> {
    const next = await this.mutate((state) => memoryMutations.removeCommand(state, keys.checkoutKey, commandId));
    return getRepoMemory(next, keys);
  }

  /** Exports the given repository's current memory only — never every repository on the machine unless the caller explicitly asks via `exportAllMemory`. */
  public exportMemory(keys: MemoryKeys, label: string): MemoryExport {
    return buildMemoryExport([{ label, memory: this.getMemory(keys) }], Date.now());
  }

  public exportAllMemory(repos: Array<{ label: string; keys: MemoryKeys }>): MemoryExport {
    return buildMemoryExport(
      repos.map(({ label, keys }) => ({ label, memory: this.getMemory(keys) })),
      Date.now(),
    );
  }

  /** Read-only: validates and summarizes what an import would do, without changing anything. */
  public previewImport(keys: MemoryKeys, raw: unknown): ImportPreview {
    return previewMemoryImport(raw, this.getMemory(keys));
  }

  /** Merges an already-previewed-valid import into ONE target repository (the currently open one) — never a multi-repo silent restore. Duplicate ids are skipped unless `options.overwriteDuplicates` is set. */
  public async importMemory(keys: MemoryKeys, raw: unknown, options: ImportOptions): Promise<RepoMemory> {
    const next = await this.mutate((state) => applyMemoryImport(state, keys, raw, options));
    return getRepoMemory(next, keys);
  }
}

export { makeId };
