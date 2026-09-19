import { MemoryNote, RepoMemory, SavedCommand } from "../types";

/**
 * Pure Repo Memory logic — no `vscode` import, so this is testable with
 * plain `node --test`, unlike `MemoryStore` itself (which needs
 * `context.globalState` and therefore only really runs inside the
 * Extension Host). Everything that can be a pure function lives here:
 * validation/sanitization of untrusted persisted data, schema migration,
 * storage limits, and export/import shaping. `memoryStore.ts` is a thin
 * wrapper around this module plus `globalState` I/O and mutation
 * serialization.
 */

export const MEMORY_SCHEMA_VERSION = 2;

/** Generous limits for real development notes/commands — never a few hundred characters. Rejected with a clear error, never silently truncated. */
export const MAX_NOTE_LENGTH = 4000;
export const MAX_NOTES_PER_REPO = 200;
export const MAX_COMMAND_LABEL_LENGTH = 200;
export const MAX_COMMAND_LENGTH = 2000;
export const MAX_COMMANDS_PER_REPO = 200;

export class MemoryLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MemoryLimitError";
  }
}

/** The on-disk shape, version 2: notes keyed by repository identity (shared across linked worktrees), commands keyed by checkout identity (worktree-local). */
export interface PersistedMemoryV2 {
  version: 2;
  notesByRepoKey: Record<string, MemoryNote[]>;
  commandsByCheckoutKey: Record<string, SavedCommand[]>;
}

export function emptyPersistedMemory(): PersistedMemoryV2 {
  return { version: MEMORY_SCHEMA_VERSION, notesByRepoKey: {}, commandsByCheckoutKey: {} };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates a single persisted note. Discards (returns `undefined`)
 * rather than throwing or repairing with guessed defaults — an
 * individual corrupt entry must never crash the whole sidebar, and a
 * silently-invented `text`/`createdAt` would be worse than simply
 * dropping the one bad entry. `text` is capped at `MAX_NOTE_LENGTH` on
 * load (truncation, not rejection — this path is for defending against
 * corrupted/hand-edited storage, not the live add/edit path, which
 * rejects over-limit input outright instead of ever storing it).
 */
export function sanitizeNote(raw: unknown): MemoryNote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.text !== "string" || !r.text.trim()) return undefined;
  if (typeof r.pinned !== "boolean") return undefined;
  if (!isFiniteNumber(r.createdAt)) return undefined;
  const note: MemoryNote = {
    id: r.id,
    text: r.text.slice(0, MAX_NOTE_LENGTH),
    pinned: r.pinned,
    createdAt: r.createdAt,
  };
  if (isFiniteNumber(r.updatedAt)) {
    note.updatedAt = r.updatedAt;
  }
  return note;
}

export function sanitizeCommand(raw: unknown): SavedCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.label !== "string" || !r.label.trim()) return undefined;
  if (typeof r.command !== "string" || !r.command.trim()) return undefined;
  if (!isFiniteNumber(r.createdAt)) return undefined;
  return {
    id: r.id,
    label: r.label.slice(0, MAX_COMMAND_LABEL_LENGTH),
    command: r.command.slice(0, MAX_COMMAND_LENGTH),
    createdAt: r.createdAt,
  };
}

/** Sanitizes a whole note list, discarding invalid entries, deduplicating by id (first occurrence wins), and enforcing "at most one pinned note" defensively (keeps the first pinned one, in case corrupted/imported data set more than one). */
export function sanitizeNoteList(raw: unknown): MemoryNote[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: MemoryNote[] = [];
  let pinnedSeen = false;
  for (const entry of raw) {
    const note = sanitizeNote(entry);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    if (note.pinned) {
      if (pinnedSeen) {
        result.push({ ...note, pinned: false });
        continue;
      }
      pinnedSeen = true;
    }
    result.push(note);
  }
  return result.slice(0, MAX_NOTES_PER_REPO);
}

export function sanitizeCommandList(raw: unknown): SavedCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: SavedCommand[] = [];
  for (const entry of raw) {
    const command = sanitizeCommand(entry);
    if (!command || seen.has(command.id)) continue;
    seen.add(command.id);
    result.push(command);
  }
  return result.slice(0, MAX_COMMANDS_PER_REPO);
}

function mergeNoteLists(a: MemoryNote[] | undefined, b: MemoryNote[]): MemoryNote[] {
  return sanitizeNoteList([...(a ?? []), ...b]);
}

function mergeCommandLists(a: SavedCommand[] | undefined, b: SavedCommand[]): SavedCommand[] {
  return sanitizeCommandList([...(a ?? []), ...b]);
}

/**
 * Migrates the pre-schema-versioning shape (`Record<rawPath,
 * {notes,commands}>`, no `version` field at all) into v2. This is a
 * best-effort, PURE, filesystem-free step: it carries each old raw-path
 * key over as BOTH the notes key and the checkout key unchanged (it
 * cannot know whether that path was a linked worktree without calling
 * `git`, which does not belong in a pure function). `MemoryStore`'s own
 * lazy reconciliation (real `canonicalizeRepoPath` calls, made when a
 * repository is actually opened again) is what later moves a migrated
 * entry onto the shared, worktree-aware `notesKey` — this function's job
 * is only to make sure no data is lost or crashes the sidebar.
 */
function migrateLegacyMemory(raw: unknown): PersistedMemoryV2 {
  const result = emptyPersistedMemory();
  if (!raw || typeof raw !== "object") return result;
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!rawKey || !value || typeof value !== "object") continue;
    const notes = sanitizeNoteList((value as Record<string, unknown>).notes);
    const commands = sanitizeCommandList((value as Record<string, unknown>).commands);
    if (notes.length > 0) {
      result.notesByRepoKey[rawKey] = mergeNoteLists(result.notesByRepoKey[rawKey], notes);
    }
    if (commands.length > 0) {
      result.commandsByCheckoutKey[rawKey] = mergeCommandLists(result.commandsByCheckoutKey[rawKey], commands);
    }
  }
  return result;
}

/**
 * The single entry point for turning whatever `globalState` handed back
 * (anything — `undefined`, a v1 blob, a v2 blob, something hand-edited
 * and half-broken) into a trustworthy `PersistedMemoryV2`. Old, valid v1
 * memory from before this schema always continues to work: it migrates
 * deterministically rather than being discarded. Every note/command list,
 * on every load, is re-sanitized regardless of the declared version —
 * `globalState` is untrusted storage, not a value TypeScript's types can
 * vouch for.
 */
export function normalizeLoadedMemory(raw: unknown): PersistedMemoryV2 {
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).version === MEMORY_SCHEMA_VERSION) {
    const r = raw as Record<string, unknown>;
    const notesByRepoKey: Record<string, MemoryNote[]> = {};
    const commandsByCheckoutKey: Record<string, SavedCommand[]> = {};
    const rawNotes = (r.notesByRepoKey && typeof r.notesByRepoKey === "object" ? r.notesByRepoKey : {}) as Record<string, unknown>;
    const rawCommands = (r.commandsByCheckoutKey && typeof r.commandsByCheckoutKey === "object" ? r.commandsByCheckoutKey : {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(rawNotes)) {
      const notes = sanitizeNoteList(value);
      if (notes.length > 0) notesByRepoKey[key] = notes;
    }
    for (const [key, value] of Object.entries(rawCommands)) {
      const commands = sanitizeCommandList(value);
      if (commands.length > 0) commandsByCheckoutKey[key] = commands;
    }
    return { version: MEMORY_SCHEMA_VERSION, notesByRepoKey, commandsByCheckoutKey };
  }
  return migrateLegacyMemory(raw);
}

export function getRepoMemory(state: PersistedMemoryV2, keys: { notesKey: string; checkoutKey: string }): RepoMemory {
  return {
    notes: state.notesByRepoKey[keys.notesKey] ?? [],
    commands: state.commandsByCheckoutKey[keys.checkoutKey] ?? [],
  };
}

/**
 * Opportunistic, lossless reconciliation of a legacy or stale key onto
 * the current canonical one — e.g. an entry left over from before
 * `canonicalizeRepoPath` existed, or from a Windows path that used to be
 * spelled with different casing. Only runs when `staleKey !== canonicalKey`
 * and the stale key actually holds data; merges (never overwrites) into
 * whatever the canonical key already has, so no note/command is ever
 * dropped by a repointing repo/worktree.
 */
export function reconcileStaleKey(
  state: PersistedMemoryV2,
  bucket: "notesByRepoKey" | "commandsByCheckoutKey",
  staleKey: string,
  canonicalKey: string,
): PersistedMemoryV2 {
  if (staleKey === canonicalKey) return state;
  if (bucket === "notesByRepoKey") {
    const staleEntries = state.notesByRepoKey[staleKey];
    if (!staleEntries || staleEntries.length === 0) return state;
    const nextNotesByRepoKey = { ...state.notesByRepoKey };
    nextNotesByRepoKey[canonicalKey] = mergeNoteLists(nextNotesByRepoKey[canonicalKey], staleEntries);
    delete nextNotesByRepoKey[staleKey];
    return { ...state, notesByRepoKey: nextNotesByRepoKey };
  }
  const staleEntries = state.commandsByCheckoutKey[staleKey];
  if (!staleEntries || staleEntries.length === 0) return state;
  const nextCommandsByCheckoutKey = { ...state.commandsByCheckoutKey };
  nextCommandsByCheckoutKey[canonicalKey] = mergeCommandLists(nextCommandsByCheckoutKey[canonicalKey], staleEntries);
  delete nextCommandsByCheckoutKey[staleKey];
  return { ...state, commandsByCheckoutKey: nextCommandsByCheckoutKey };
}

function validateNoteText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new MemoryLimitError("A note can't be empty or just whitespace.");
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new MemoryLimitError(`Notes are limited to ${MAX_NOTE_LENGTH.toLocaleString()} characters (this one is ${trimmed.length.toLocaleString()}).`);
  }
  return trimmed;
}

function validateCommandFields(label: string, command: string): { label: string; command: string } {
  const trimmedLabel = label.trim();
  const trimmedCommand = command.trim();
  if (!trimmedLabel || !trimmedCommand) {
    throw new MemoryLimitError("A saved command needs both a label and a command.");
  }
  if (trimmedLabel.length > MAX_COMMAND_LABEL_LENGTH) {
    throw new MemoryLimitError(`Command labels are limited to ${MAX_COMMAND_LABEL_LENGTH.toLocaleString()} characters.`);
  }
  if (trimmedCommand.length > MAX_COMMAND_LENGTH) {
    throw new MemoryLimitError(`Commands are limited to ${MAX_COMMAND_LENGTH.toLocaleString()} characters.`);
  }
  return { label: trimmedLabel, command: trimmedCommand };
}

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * All the pure note/command mutation logic, factored out of `MemoryStore`
 * so it's directly unit-testable without touching `globalState` at all.
 * Each function takes the CURRENT full persisted state and returns the
 * NEXT one (or throws `MemoryLimitError`) — `MemoryStore` is responsible
 * only for reading, serializing the calls, and writing the result back.
 */
export const memoryMutations = {
  addNote(state: PersistedMemoryV2, notesKey: string, text: string, pinned: boolean, now: number): PersistedMemoryV2 {
    const validText = validateNoteText(text);
    const existing = state.notesByRepoKey[notesKey] ?? [];
    if (existing.length >= MAX_NOTES_PER_REPO) {
      throw new MemoryLimitError(`This repository already has ${MAX_NOTES_PER_REPO} notes, the maximum. Remove one before adding another.`);
    }
    const note: MemoryNote = { id: makeId(), text: validText, pinned, createdAt: now };
    const nextNotes = pinned
      ? [note, ...existing.map((n) => ({ ...n, pinned: false }))]
      : [note, ...existing];
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  updateNote(state: PersistedMemoryV2, notesKey: string, noteId: string, text: string, now: number): PersistedMemoryV2 {
    const validText = validateNoteText(text);
    const existing = state.notesByRepoKey[notesKey] ?? [];
    let changed = false;
    const nextNotes = existing.map((note) => {
      if (note.id !== noteId) return note;
      if (note.text === validText) return note;
      changed = true;
      return { ...note, text: validText, updatedAt: now };
    });
    if (!changed) return state;
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  removeNote(state: PersistedMemoryV2, notesKey: string, noteId: string): PersistedMemoryV2 {
    const existing = state.notesByRepoKey[notesKey] ?? [];
    const nextNotes = existing.filter((note) => note.id !== noteId);
    if (nextNotes.length === existing.length) return state;
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  togglePin(state: PersistedMemoryV2, notesKey: string, noteId: string): PersistedMemoryV2 {
    const existing = state.notesByRepoKey[notesKey] ?? [];
    const target = existing.find((note) => note.id === noteId);
    if (!target) return state;
    const nextPinned = !target.pinned;
    const nextNotes = existing.map((note) => ({
      ...note,
      pinned: note.id === noteId ? nextPinned : nextPinned ? false : note.pinned,
    }));
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  addCommand(state: PersistedMemoryV2, checkoutKey: string, label: string, command: string, now: number): PersistedMemoryV2 {
    const valid = validateCommandFields(label, command);
    const existing = state.commandsByCheckoutKey[checkoutKey] ?? [];
    if (existing.length >= MAX_COMMANDS_PER_REPO) {
      throw new MemoryLimitError(`This checkout already has ${MAX_COMMANDS_PER_REPO} saved commands, the maximum. Remove one before adding another.`);
    }
    const saved: SavedCommand = { id: makeId(), label: valid.label, command: valid.command, createdAt: now };
    return { ...state, commandsByCheckoutKey: { ...state.commandsByCheckoutKey, [checkoutKey]: [saved, ...existing] } };
  },

  removeCommand(state: PersistedMemoryV2, checkoutKey: string, commandId: string): PersistedMemoryV2 {
    const existing = state.commandsByCheckoutKey[checkoutKey] ?? [];
    const nextCommands = existing.filter((command) => command.id !== commandId);
    if (nextCommands.length === existing.length) return state;
    return { ...state, commandsByCheckoutKey: { ...state.commandsByCheckoutKey, [checkoutKey]: nextCommands } };
  },
};

// ==================== export / import ====================

export const MEMORY_EXPORT_SCHEMA_VERSION = 1;

export interface MemoryExport {
  exportSchemaVersion: 1;
  exportedAt: number;
  /** One entry per repository included in this export — usually one (the current repo), or every repository when exporting all. */
  repositories: Array<{
    /** Opaque, not a filesystem path — never leaked into the export so it can be shared without exposing local machine layout. */
    label: string;
    notes: MemoryNote[];
    commands: SavedCommand[];
  }>;
}

export function buildMemoryExport(
  repos: Array<{ label: string; memory: RepoMemory }>,
  now: number,
): MemoryExport {
  return {
    exportSchemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    exportedAt: now,
    repositories: repos.map(({ label, memory }) => ({
      label,
      notes: sanitizeNoteList(memory.notes),
      commands: sanitizeCommandList(memory.commands),
    })),
  };
}

export interface ImportPreview {
  valid: boolean;
  error?: string;
  repositoryCount: number;
  noteCount: number;
  commandCount: number;
  /** Notes/commands whose id already exists in the CURRENT target repo's memory — these are skipped, never silently overwritten, unless the caller explicitly asks to overwrite. */
  duplicateNoteIds: string[];
  duplicateCommandIds: string[];
}

/** Validates and summarizes an import file's content WITHOUT mutating anything — what the "preview/explain what will happen" step in the UI is built from. Only ever inspects data (ids/text/labels); a saved command's `command` string is data here too, never executed. */
export function previewMemoryImport(raw: unknown, target: RepoMemory): ImportPreview {
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).exportSchemaVersion !== MEMORY_EXPORT_SCHEMA_VERSION) {
    return { valid: false, error: "This file isn't a Repo Memory export this version understands.", repositoryCount: 0, noteCount: 0, commandCount: 0, duplicateNoteIds: [], duplicateCommandIds: [] };
  }
  const repositories = (raw as Record<string, unknown>).repositories;
  if (!Array.isArray(repositories)) {
    return { valid: false, error: "This file has no repositories to import.", repositoryCount: 0, noteCount: 0, commandCount: 0, duplicateNoteIds: [], duplicateCommandIds: [] };
  }
  const targetNoteIds = new Set(target.notes.map((n) => n.id));
  const targetCommandIds = new Set(target.commands.map((c) => c.id));
  const duplicateNoteIds: string[] = [];
  const duplicateCommandIds: string[] = [];
  let noteCount = 0;
  let commandCount = 0;
  for (const entry of repositories) {
    if (!entry || typeof entry !== "object") continue;
    const notes = sanitizeNoteList((entry as Record<string, unknown>).notes);
    const commands = sanitizeCommandList((entry as Record<string, unknown>).commands);
    noteCount += notes.length;
    commandCount += commands.length;
    for (const note of notes) if (targetNoteIds.has(note.id)) duplicateNoteIds.push(note.id);
    for (const command of commands) if (targetCommandIds.has(command.id)) duplicateCommandIds.push(command.id);
  }
  return {
    valid: true,
    repositoryCount: repositories.length,
    noteCount,
    commandCount,
    duplicateNoteIds,
    duplicateCommandIds,
  };
}

export interface ImportOptions {
  /** When false (the default), a note/command whose id already exists in the target is skipped rather than overwritten. */
  overwriteDuplicates: boolean;
}

/**
 * Merges every note/command from every repository in the import file into
 * ONE target repository's memory (the currently selected one — imports
 * are scoped to "bring these notes into the repo I have open," never a
 * silent multi-repo restore that could resurrect notes under repositories
 * the user isn't looking at). Never executes anything — saved commands
 * are copied as inert data, exactly like every other field.
 */
export function applyMemoryImport(
  state: PersistedMemoryV2,
  keys: { notesKey: string; checkoutKey: string },
  raw: unknown,
  options: ImportOptions,
): PersistedMemoryV2 {
  const preview = previewMemoryImport(raw, getRepoMemory(state, keys));
  if (!preview.valid) {
    throw new MemoryLimitError(preview.error ?? "This file isn't a valid Repo Memory export.");
  }
  const repositories = (raw as { repositories: unknown[] }).repositories;
  const existingNotes = state.notesByRepoKey[keys.notesKey] ?? [];
  const existingCommands = state.commandsByCheckoutKey[keys.checkoutKey] ?? [];
  const existingNoteIds = new Set(existingNotes.map((n) => n.id));
  const existingCommandIds = new Set(existingCommands.map((c) => c.id));

  let nextNotes = [...existingNotes];
  let nextCommands = [...existingCommands];

  for (const entry of repositories) {
    if (!entry || typeof entry !== "object") continue;
    const notes = sanitizeNoteList((entry as Record<string, unknown>).notes);
    const commands = sanitizeCommandList((entry as Record<string, unknown>).commands);
    for (const note of notes) {
      const isDuplicate = existingNoteIds.has(note.id);
      if (isDuplicate && !options.overwriteDuplicates) continue;
      if (isDuplicate) {
        // Overwriting replaces the imported fields (text, createdAt, ...)
        // but keeps the TARGET repo's own pinned decision — pin state is a
        // local judgment about what matters right now, not something an
        // import should silently flip either way.
        nextNotes = nextNotes.map((n) => (n.id === note.id ? { ...note, pinned: n.pinned } : n));
      } else {
        existingNoteIds.add(note.id);
        nextNotes = [...nextNotes, { ...note, pinned: false }];
      }
    }
    for (const command of commands) {
      const isDuplicate = existingCommandIds.has(command.id);
      if (isDuplicate && !options.overwriteDuplicates) continue;
      if (isDuplicate) {
        nextCommands = nextCommands.map((c) => (c.id === command.id ? command : c));
      } else {
        existingCommandIds.add(command.id);
        nextCommands = [...nextCommands, command];
      }
    }
  }

  // A merged result that exceeds the per-repo limit must be REJECTED, not
  // silently truncated -- `sanitizeNoteList`/`sanitizeCommandList` below
  // would otherwise quietly drop whichever entries land past the cutoff,
  // which is exactly the "silently lose a user's notes" failure this
  // whole import path exists to avoid. Checked BEFORE sanitizing/writing
  // anything, so a rejected import leaves the target repo's memory
  // completely untouched.
  if (nextNotes.length > MAX_NOTES_PER_REPO) {
    throw new MemoryLimitError(
      `This import would bring this repository to ${nextNotes.length} notes, over the ${MAX_NOTES_PER_REPO} limit. Remove some existing notes first, or import into an empty/less-full repository.`,
    );
  }
  if (nextCommands.length > MAX_COMMANDS_PER_REPO) {
    throw new MemoryLimitError(
      `This import would bring this checkout to ${nextCommands.length} saved commands, over the ${MAX_COMMANDS_PER_REPO} limit. Remove some existing commands first.`,
    );
  }

  // Imported notes never arrive pre-pinned (see the `pinned: false` above)
  // -- an import silently taking over the one pinned-note-in-AI-context
  // slot would bypass the explicit, per-note opt-in that slot exists to
  // protect. Sanitizing again also re-applies the at-most-one-pinned
  // invariant to the merged result (the count limits were already
  // checked above, so this sanitize pass cannot itself drop anything).
  return {
    ...state,
    notesByRepoKey: { ...state.notesByRepoKey, [keys.notesKey]: sanitizeNoteList(nextNotes) },
    commandsByCheckoutKey: { ...state.commandsByCheckoutKey, [keys.checkoutKey]: sanitizeCommandList(nextCommands) },
  };
}
