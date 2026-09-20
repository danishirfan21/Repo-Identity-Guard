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
 *
 * Structural sanitation vs. live-mutation limits are two DIFFERENT
 * questions, kept deliberately separate:
 *  - "Is this valid user data?" — `sanitizeNote`/`sanitizeCommand`/
 *    `sanitizeNoteList`/`sanitizeCommandList`. These only check TYPES and
 *    reject/dedupe structurally broken entries. They never truncate text
 *    or cap list length — a note/command that predates a limit, or a
 *    whole repository that already has more entries than today's count
 *    limit, is still valid user data and must survive load, migration,
 *    and export byte-for-byte/entry-for-entry.
 *  - "May this NEW mutation be created?" — `validateNoteText`/
 *    `validateCommandFields` and the `existing.length >= MAX_...` checks
 *    inside `memoryMutations`. These are the only place a length/count
 *    limit can ever block something, and they always reject outright
 *    (`MemoryLimitError`) rather than truncate.
 */

export const MEMORY_SCHEMA_VERSION = 2;

/** Generous limits for real development notes/commands — never a few hundred characters. Enforced only on NEW mutations (add/edit) and on imports; never retroactively applied to already-stored data. See the module doc comment above. */
export const MAX_NOTE_LENGTH = 4000;
export const MAX_NOTES_PER_REPO = 200;
export const MAX_COMMAND_LABEL_LENGTH = 200;
export const MAX_COMMAND_LENGTH = 2000;
export const MAX_COMMANDS_PER_REPO = 200;

/** A reasonable ceiling on an import file's raw size, checked by the caller (extension.ts) before `JSON.parse` even runs — not a limit on how much LEGITIMATE memory can be stored, just a guard against parsing an absurdly large file into memory. */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

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
 * dropping the one bad entry. Deliberately does NOT truncate or reject
 * on length: this is a STRUCTURAL check ("is this shaped like a note?"),
 * not a policy check — a note stored before `MAX_NOTE_LENGTH` existed,
 * or one hand-edited to be longer, is still valid user data and must
 * come back exactly as stored. Length is enforced only on new
 * add/edit/import operations (see `validateNoteText` and
 * `noteExceedsLengthLimit`).
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
    text: r.text,
    pinned: r.pinned,
    createdAt: r.createdAt,
  };
  if (isFiniteNumber(r.updatedAt)) {
    note.updatedAt = r.updatedAt;
  }
  return note;
}

/** Same structural-only contract as `sanitizeNote` — see its doc comment. Never truncates `label`/`command`. */
export function sanitizeCommand(raw: unknown): SavedCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.label !== "string" || !r.label.trim()) return undefined;
  if (typeof r.command !== "string" || !r.command.trim()) return undefined;
  if (!isFiniteNumber(r.createdAt)) return undefined;
  return {
    id: r.id,
    label: r.label,
    command: r.command,
    createdAt: r.createdAt,
  };
}

/**
 * Sanitizes a whole note list: discards structurally invalid entries,
 * deduplicates by id (first occurrence wins), and enforces "at most one
 * pinned note" defensively (keeps the first pinned one, in case
 * corrupted/imported data set more than one). Deliberately does NOT cap
 * the list length — a repository that already has more notes than
 * `MAX_NOTES_PER_REPO` (grandfathered from before the limit existed, or
 * from data merged across linked worktrees) keeps every one of them on
 * load/migrate/export. The count limit only ever blocks a NEW add — see
 * `memoryMutations.addNote`.
 */
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
  return result;
}

/** Same "never caps length" contract as `sanitizeNoteList` — see its doc comment. */
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
  return result;
}

/** Whether a (structurally valid) note's text is over today's live-mutation length limit — used only to reject an IMPORT outright, never to truncate; a grandfathered stored note this is true for is otherwise untouched. */
export function noteExceedsLengthLimit(note: MemoryNote): boolean {
  return note.text.length > MAX_NOTE_LENGTH;
}

/** Same, for saved commands — see `noteExceedsLengthLimit`. */
export function commandExceedsLengthLimit(command: SavedCommand): boolean {
  return command.label.length > MAX_COMMAND_LABEL_LENGTH || command.command.length > MAX_COMMAND_LENGTH;
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
 * is only to make sure no data is lost or crashes the sidebar. Every
 * note/command a legacy repository already had (however long, however
 * many) is carried over in full — see `sanitizeNoteList`'s doc comment.
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
 * vouch for. Sanitizing here is STRUCTURAL ONLY (see `sanitizeNoteList`'s
 * doc comment) — a grandfathered note/command over today's length limit,
 * or a repository with more entries than today's count limit, is loaded
 * back exactly as stored, never truncated or dropped for exceeding a
 * limit that didn't exist (or wasn't reached) when it was created.
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
      throw new MemoryLimitError(`This repository already has ${existing.length} notes, at or above the ${MAX_NOTES_PER_REPO} maximum for new notes. Remove one before adding another.`);
    }
    const note: MemoryNote = { id: makeId(), text: validText, pinned, createdAt: now };
    const nextNotes = pinned
      ? [note, ...existing.map((n) => ({ ...n, pinned: false }))]
      : [note, ...existing];
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  /**
   * Editing a note that predates today's `MAX_NOTE_LENGTH` (grandfathered,
   * possibly still over the limit) must never be destroyed merely because
   * it exists: saving with NO actual text change is always a no-op —
   * skipped before the length check even runs — so re-opening and
   * closing the editor on an oversized note can never fail. Shrinking an
   * oversized note back under the limit is a normal, accepted edit.
   * Growing it, or editing any note to exceed the limit, is rejected like
   * any other new content would be.
   */
  updateNote(state: PersistedMemoryV2, notesKey: string, noteId: string, text: string, now: number): PersistedMemoryV2 {
    const existing = state.notesByRepoKey[notesKey] ?? [];
    const target = existing.find((note) => note.id === noteId);
    if (!target) return state;
    if (text.trim() === target.text) return state;
    const validText = validateNoteText(text);
    const nextNotes = existing.map((note) => (note.id === noteId ? { ...note, text: validText, updatedAt: now } : note));
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
      throw new MemoryLimitError(`This checkout already has ${existing.length} saved commands, at or above the ${MAX_COMMANDS_PER_REPO} maximum for new commands. Remove one before adding another.`);
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

/** One repository entry's summary from an import file, BEFORE any target repository is chosen — what a multi-repository export's picker is built from. Never mutates anything. */
export interface ImportEntrySummary {
  index: number;
  label: string;
  noteCount: number;
  commandCount: number;
}

export interface ImportFilePreview {
  valid: boolean;
  error?: string;
  entries: ImportEntrySummary[];
}

/**
 * First-pass, target-independent validation of an import file: is this a
 * Repo Memory export this version understands, and what repository
 * entries does it contain? Used to decide whether the caller needs to
 * show a picker (more than one entry) or can proceed directly (exactly
 * one). Never mutates anything and never needs a target repository.
 */
export function previewMemoryImportFile(raw: unknown): ImportFilePreview {
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).exportSchemaVersion !== MEMORY_EXPORT_SCHEMA_VERSION) {
    return { valid: false, error: "This file isn't a Repo Memory export this version understands.", entries: [] };
  }
  const repositories = (raw as Record<string, unknown>).repositories;
  if (!Array.isArray(repositories) || repositories.length === 0) {
    return { valid: false, error: "This file has no repositories to import.", entries: [] };
  }
  const entries: ImportEntrySummary[] = repositories.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return { index, label: "(unreadable entry)", noteCount: 0, commandCount: 0 };
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : "(unnamed repository)";
    return {
      index,
      label,
      noteCount: sanitizeNoteList(e.notes).length,
      commandCount: sanitizeCommandList(e.commands).length,
    };
  });
  return { valid: true, entries };
}

/** Detailed, target-aware preview of importing exactly ONE repository entry from the file — what the confirmation dialog is built from, and what `applyMemoryImport` re-validates before mutating anything. */
export interface ImportEntryPreview {
  valid: boolean;
  error?: string;
  noteCount: number;
  commandCount: number;
  /** Notes/commands whose id already exists in the CURRENT target repo's memory — these are skipped, never silently overwritten, unless the caller explicitly asks to overwrite. */
  duplicateNoteIds: string[];
  duplicateCommandIds: string[];
  /** Entries in this repository whose text/label/command are over today's live-mutation limits. A non-zero count here means the whole import is REJECTED (`valid: false`) — never truncated. */
  oversizedNoteCount: number;
  oversizedCommandCount: number;
}

function invalidEntryPreview(error: string): ImportEntryPreview {
  return { valid: false, error, noteCount: 0, commandCount: 0, duplicateNoteIds: [], duplicateCommandIds: [], oversizedNoteCount: 0, oversizedCommandCount: 0 };
}

export function previewMemoryImportEntry(raw: unknown, entryIndex: number, target: RepoMemory): ImportEntryPreview {
  const filePreview = previewMemoryImportFile(raw);
  if (!filePreview.valid) return invalidEntryPreview(filePreview.error ?? "This file isn't a valid Repo Memory export.");

  const repositories = (raw as { repositories: unknown[] }).repositories;
  const entry = repositories[entryIndex];
  if (!entry || typeof entry !== "object") {
    return invalidEntryPreview("That repository entry could not be found in the file.");
  }
  const e = entry as Record<string, unknown>;
  const notes = sanitizeNoteList(e.notes);
  const commands = sanitizeCommandList(e.commands);
  const oversizedNoteCount = notes.filter(noteExceedsLengthLimit).length;
  const oversizedCommandCount = commands.filter(commandExceedsLengthLimit).length;

  const targetNoteIds = new Set(target.notes.map((n) => n.id));
  const targetCommandIds = new Set(target.commands.map((c) => c.id));
  const duplicateNoteIds = notes.filter((n) => targetNoteIds.has(n.id)).map((n) => n.id);
  const duplicateCommandIds = commands.filter((c) => targetCommandIds.has(c.id)).map((c) => c.id);

  if (oversizedNoteCount > 0 || oversizedCommandCount > 0) {
    return {
      valid: false,
      error: `This repository entry has ${oversizedNoteCount} note(s) and/or ${oversizedCommandCount} saved command(s) over today's size limits (max ${MAX_NOTE_LENGTH.toLocaleString()} characters per note, ${MAX_COMMAND_LABEL_LENGTH}/${MAX_COMMAND_LENGTH.toLocaleString()} characters for a saved command's label/command). Nothing was imported or truncated — remove or shorten the oversized entries in the source and re-export, or import elsewhere.`,
      noteCount: notes.length,
      commandCount: commands.length,
      duplicateNoteIds,
      duplicateCommandIds,
      oversizedNoteCount,
      oversizedCommandCount,
    };
  }

  return { valid: true, noteCount: notes.length, commandCount: commands.length, duplicateNoteIds, duplicateCommandIds, oversizedNoteCount: 0, oversizedCommandCount: 0 };
}

export interface ImportOptions {
  /** When false (the default), a note/command whose id already exists in the target is skipped rather than overwritten. */
  overwriteDuplicates: boolean;
}

/**
 * Merges ONE chosen repository entry from the import file into ONE
 * target repository's memory (the currently selected one). Multi-entry
 * export-all files are never silently merged together — the caller
 * (extension.ts) presents a picker when a file has more than one
 * repository entry and passes the user's chosen `entryIndex` here.
 * Re-validates the entry (structural shape, oversized entries, target
 * duplicates) immediately before mutating, so a file that changed on
 * disk between preview and apply can't sneak past the same checks. Never
 * executes anything — saved commands are copied as inert data, exactly
 * like every other field.
 */
export function applyMemoryImport(
  state: PersistedMemoryV2,
  keys: { notesKey: string; checkoutKey: string },
  raw: unknown,
  entryIndex: number,
  options: ImportOptions,
): PersistedMemoryV2 {
  const target = getRepoMemory(state, keys);
  const preview = previewMemoryImportEntry(raw, entryIndex, target);
  if (!preview.valid) {
    throw new MemoryLimitError(preview.error ?? "This file isn't a valid Repo Memory export.");
  }

  const repositories = (raw as { repositories: unknown[] }).repositories;
  const entry = repositories[entryIndex] as Record<string, unknown>;
  const notes = sanitizeNoteList(entry.notes);
  const commands = sanitizeCommandList(entry.commands);

  const existingNotes = state.notesByRepoKey[keys.notesKey] ?? [];
  const existingCommands = state.commandsByCheckoutKey[keys.checkoutKey] ?? [];
  const existingNoteIds = new Set(existingNotes.map((n) => n.id));
  const existingCommandIds = new Set(existingCommands.map((c) => c.id));

  let nextNotes = [...existingNotes];
  let nextCommands = [...existingCommands];

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

  // A merge that actually GROWS the repository's note/command count past
  // the limit must be REJECTED atomically, not silently truncated by a
  // capping sanitize pass — that would be exactly the "silently lose a
  // user's notes" failure this whole import path exists to avoid. Guarded
  // by "grew past" rather than a bare "is over" so that re-importing
  // duplicates-only (or overwriting in place) into an already-oversized,
  // grandfathered repository — which adds nothing new — is never blocked.
  if (nextNotes.length > existingNotes.length && nextNotes.length > MAX_NOTES_PER_REPO) {
    throw new MemoryLimitError(
      `This import would bring this repository to ${nextNotes.length} notes, over the ${MAX_NOTES_PER_REPO} limit. Remove some existing notes first, or import into an empty/less-full repository.`,
    );
  }
  if (nextCommands.length > existingCommands.length && nextCommands.length > MAX_COMMANDS_PER_REPO) {
    throw new MemoryLimitError(
      `This import would bring this checkout to ${nextCommands.length} saved commands, over the ${MAX_COMMANDS_PER_REPO} limit. Remove some existing commands first.`,
    );
  }

  // Imported notes never arrive pre-pinned (see the `pinned: false` above)
  // -- an import silently taking over the one pinned-note-in-AI-context
  // slot would bypass the explicit, per-note opt-in that slot exists to
  // protect. Sanitizing again also re-applies the at-most-one-pinned
  // invariant to the merged result; it can never itself drop an entry for
  // being "too many" or "too long" (see `sanitizeNoteList`'s doc comment)
  // — the count limit was already checked above, and length was already
  // checked by `previewMemoryImportEntry`.
  return {
    ...state,
    notesByRepoKey: { ...state.notesByRepoKey, [keys.notesKey]: sanitizeNoteList(nextNotes) },
    commandsByCheckoutKey: { ...state.commandsByCheckoutKey, [keys.checkoutKey]: sanitizeCommandList(nextCommands) },
  };
}
