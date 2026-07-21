import * as vscode from "vscode";
import { MemoryNote, RepoMemory, SavedCommand, emptyRepoMemory } from "../types";

const STORAGE_KEY = "repoIdentityGuard.memoryByRepo";

/**
 * Repo Memory is local-first and private: it lives only in this VS Code
 * install's global storage (never a file inside the repo), so notes can
 * never be accidentally committed or pushed.
 */
export class MemoryStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  private readAll(): Record<string, RepoMemory> {
    return this.context.globalState.get<Record<string, RepoMemory>>(STORAGE_KEY, {});
  }

  private async writeAll(all: Record<string, RepoMemory>): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, all);
  }

  public getMemory(repoRoot: string): RepoMemory {
    return this.readAll()[repoRoot] ?? emptyRepoMemory();
  }

  private async mutate(
    repoRoot: string,
    mutator: (memory: RepoMemory) => RepoMemory,
  ): Promise<RepoMemory> {
    const all = this.readAll();
    const next = mutator(all[repoRoot] ?? emptyRepoMemory());
    all[repoRoot] = next;
    await this.writeAll(all);
    return next;
  }

  public getPinnedNote(repoRoot: string): MemoryNote | undefined {
    return this.getMemory(repoRoot).notes.find((note) => note.pinned);
  }

  public async addNote(repoRoot: string, text: string, pinned = false): Promise<RepoMemory> {
    const note: MemoryNote = {
      id: makeId(),
      text: text.trim(),
      pinned,
      createdAt: Date.now(),
    };
    return this.mutate(repoRoot, (memory) => ({
      ...memory,
      notes: pinned
        ? [note, ...memory.notes.map((existing) => ({ ...existing, pinned: false }))]
        : [note, ...memory.notes],
    }));
  }

  public async removeNote(repoRoot: string, noteId: string): Promise<RepoMemory> {
    return this.mutate(repoRoot, (memory) => ({
      ...memory,
      notes: memory.notes.filter((note) => note.id !== noteId),
    }));
  }

  public async togglePin(repoRoot: string, noteId: string): Promise<RepoMemory> {
    return this.mutate(repoRoot, (memory) => {
      const target = memory.notes.find((note) => note.id === noteId);
      const nextPinned = target ? !target.pinned : false;
      return {
        ...memory,
        notes: memory.notes.map((note) => ({
          ...note,
          pinned: note.id === noteId ? nextPinned : nextPinned ? false : note.pinned,
        })),
      };
    });
  }

  public async addCommand(
    repoRoot: string,
    label: string,
    command: string,
  ): Promise<RepoMemory> {
    const saved: SavedCommand = {
      id: makeId(),
      label: label.trim(),
      command: command.trim(),
      createdAt: Date.now(),
    };
    return this.mutate(repoRoot, (memory) => ({
      ...memory,
      commands: [saved, ...memory.commands],
    }));
  }

  public async removeCommand(repoRoot: string, commandId: string): Promise<RepoMemory> {
    return this.mutate(repoRoot, (memory) => ({
      ...memory,
      commands: memory.commands.filter((command) => command.id !== commandId),
    }));
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
