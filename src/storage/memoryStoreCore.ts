import { MemoryNote, RepoMemory } from "../types";

/**
 * Pure Repo Notes logic — no `vscode` import, so this is testable with
 * plain `node --test`, unlike `MemoryStore` itself (which needs
 * `context.globalState`). Everything that can be a pure function lives
 * here: validation/sanitization of untrusted persisted data, schema
 * migration, storage limits, search, copy, and export/import shaping.
 *
 * Structural sanitation vs. live-mutation limits are two DIFFERENT
 * questions, kept deliberately separate:
 *  - "Is this valid user data?" — `sanitizeNote`/`sanitizeNoteList`. These
 *    only check TYPES and reject/dedupe structurally broken entries. They
 *    never truncate text or cap list length — a note that predates a
 *    limit, or a repository that already has more notes than today's
 *    count limit, is still valid user data and must survive load,
 *    migration, and export byte-for-byte/entry-for-entry.
 *  - "May this NEW mutation be created?" — `validateNoteText` and the
 *    `existing.length >= MAX_NOTES_PER_REPO` check inside
 *    `memoryMutations.addNote`. These are the only place a limit can ever
 *    block something, and they always reject outright (`MemoryLimitError`)
 *    rather than truncate.
 *
 * Notes are plain text. Nothing in this module (or anywhere in the
 * extension) ever executes a note, and a note has no effect whatsoever on
 * the identity lock.
 *
 * ## Schema history and the saved-command migration (v2 → v3)
 *
 * - v1 (no `version` field): `Record<rawRepoRoot, { notes, commands }>`.
 * - v2: `{ version: 2, notesByRepoKey, commandsByCheckoutKey }` — notes
 *   keyed by repository (canonical git common dir, shared by linked
 *   worktrees), "saved commands" keyed by checkout (canonical worktree
 *   root), with a separate Run/Copy feature.
 * - v3 (current): `{ version: 3, notesByRepoKey }` — notes only. Saved
 *   commands were retired as a feature; every one is migrated, losslessly,
 *   into an ordinary note:
 *
 *     id:        "legacy-cmd-<original command id>"   (deterministic)
 *     text:      "<label>\n<command>"                  (both exactly as stored)
 *     createdAt: the command's original createdAt
 *     pinned:    false
 *
 *   The note is stored under the command's CHECKOUT key; when that
 *   checkout is next opened, `reconcileStaleKey` merges it into the
 *   repository's shared notes key, so commands saved in different linked
 *   worktrees all end up in the one repository note collection. The
 *   deterministic id makes the migration idempotent: re-running it (a
 *   second startup, a second window, importing an old export that still
 *   contains the same commands) can never create a duplicate, because
 *   every merge dedupes by id (first wins). No command is ever executed
 *   by the migration — it is a pure data transformation.
 */

export const MEMORY_SCHEMA_VERSION = 3;

/** Generous limits for real development notes — never a few hundred characters. Enforced only on NEW mutations (add/edit) and on imports; never retroactively applied to already-stored data. */
export const MAX_NOTE_LENGTH = 4000;
export const MAX_NOTES_PER_REPO = 200;

/** A reasonable ceiling on an import file's raw size, checked by the caller (extension.ts) before `JSON.parse` even runs. */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

/** Prefix of every note created from a legacy saved command — see the module doc comment. */
export const LEGACY_COMMAND_NOTE_ID_PREFIX = "legacy-cmd-";

export class MemoryLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MemoryLimitError";
  }
}

/** The on-disk shape, version 3: notes keyed by repository identity (shared across linked worktrees). */
export interface PersistedMemoryV3 {
  version: 3;
  notesByRepoKey: Record<string, MemoryNote[]>;
}

/** A retired "saved command", as stored by schema v1/v2 and export schema v1. Only ever read, to be migrated into a note. */
export interface LegacySavedCommand {
  id: string;
  label: string;
  command: string;
  createdAt: number;
}

export function emptyPersistedMemory(): PersistedMemoryV3 {
  return { version: MEMORY_SCHEMA_VERSION, notesByRepoKey: {} };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates a single persisted note. Discards (returns `undefined`) rather
 * than throwing or repairing with guessed defaults. Deliberately does NOT
 * truncate or reject on length (see the module doc comment).
 */
export function sanitizeNote(raw: unknown): MemoryNote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.text !== "string" || !r.text.trim()) return undefined;
  if (typeof r.pinned !== "boolean") return undefined;
  if (!isFiniteNumber(r.createdAt)) return undefined;
  const note: MemoryNote = { id: r.id, text: r.text, pinned: r.pinned, createdAt: r.createdAt };
  if (isFiniteNumber(r.updatedAt)) {
    note.updatedAt = r.updatedAt;
  }
  return note;
}

/** Structural check for a legacy saved command. Never truncates `label`/`command`. */
export function sanitizeLegacyCommand(raw: unknown): LegacySavedCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.label !== "string" || !r.label.trim()) return undefined;
  if (typeof r.command !== "string" || !r.command.trim()) return undefined;
  if (!isFiniteNumber(r.createdAt)) return undefined;
  return { id: r.id, label: r.label, command: r.command, createdAt: r.createdAt };
}

/**
 * Converts one legacy saved command into an ordinary note — lossless and
 * deterministic (see the module doc comment). The command text is copied
 * byte-for-byte and is never executed or interpreted.
 */
export function legacyCommandToNote(command: LegacySavedCommand): MemoryNote {
  return {
    id: `${LEGACY_COMMAND_NOTE_ID_PREFIX}${command.id}`,
    text: `${command.label}\n${command.command}`,
    pinned: false,
    createdAt: command.createdAt,
  };
}

/** Converts a raw legacy command list (any shape) into notes, dropping only structurally invalid entries. */
export function legacyCommandsToNotes(raw: unknown): MemoryNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: MemoryNote[] = [];
  for (const entry of raw) {
    const command = sanitizeLegacyCommand(entry);
    if (command) notes.push(legacyCommandToNote(command));
  }
  return notes;
}

/**
 * Sanitizes a whole note list: discards structurally invalid entries,
 * deduplicates by id (first occurrence wins), and keeps at most one pinned
 * note (the first). Deliberately does NOT cap the list length.
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

/** Whether a (structurally valid) note's text is over today's live-mutation length limit — used only to reject an IMPORT outright, never to truncate. */
export function noteExceedsLengthLimit(note: MemoryNote): boolean {
  return note.text.length > MAX_NOTE_LENGTH;
}

function mergeNoteLists(a: MemoryNote[] | undefined, b: MemoryNote[]): MemoryNote[] {
  return sanitizeNoteList([...(a ?? []), ...b]);
}

function addNotesUnderKey(target: Record<string, MemoryNote[]>, key: string, notes: MemoryNote[]): void {
  if (!key || notes.length === 0) return;
  target[key] = mergeNoteLists(target[key], notes);
}

/** v1 (unversioned `Record<rawPath, {notes, commands}>`) → v3. Commands become notes under the same raw key. */
function migrateV1(raw: unknown): PersistedMemoryV3 {
  const result = emptyPersistedMemory();
  if (!raw || typeof raw !== "object") return result;
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!rawKey || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    addNotesUnderKey(result.notesByRepoKey, rawKey, sanitizeNoteList(v.notes));
    addNotesUnderKey(result.notesByRepoKey, rawKey, legacyCommandsToNotes(v.commands));
  }
  return result;
}

/** v2 → v3: notes kept as-is; every checkout's saved commands become notes under that checkout's key (reconciled into the repository key when opened). */
function migrateV2(r: Record<string, unknown>): PersistedMemoryV3 {
  const result = emptyPersistedMemory();
  const rawNotes = (r.notesByRepoKey && typeof r.notesByRepoKey === "object" ? r.notesByRepoKey : {}) as Record<string, unknown>;
  const rawCommands = (r.commandsByCheckoutKey && typeof r.commandsByCheckoutKey === "object" ? r.commandsByCheckoutKey : {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawNotes)) {
    addNotesUnderKey(result.notesByRepoKey, key, sanitizeNoteList(value));
  }
  for (const [key, value] of Object.entries(rawCommands)) {
    addNotesUnderKey(result.notesByRepoKey, key, legacyCommandsToNotes(value));
  }
  return result;
}

/**
 * The single entry point for turning whatever `globalState` handed back
 * (anything — `undefined`, a v1/v2/v3 blob, something hand-edited and
 * half-broken) into a trustworthy v3 state. Old, valid data always
 * migrates deterministically rather than being discarded, and every note
 * list is re-sanitized on every load regardless of the declared version —
 * `globalState` is untrusted storage.
 */
export function normalizeLoadedMemory(raw: unknown): PersistedMemoryV3 {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.version === MEMORY_SCHEMA_VERSION) {
      const result = emptyPersistedMemory();
      const rawNotes = (r.notesByRepoKey && typeof r.notesByRepoKey === "object" ? r.notesByRepoKey : {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawNotes)) {
        addNotesUnderKey(result.notesByRepoKey, key, sanitizeNoteList(value));
      }
      return result;
    }
    if (r.version === 2) return migrateV2(r);
  }
  return migrateV1(raw);
}

/** True when `raw` is not already a v3 blob, i.e. persisting `normalizeLoadedMemory(raw)` would be a migration. */
export function needsMigration(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  return !(typeof raw === "object" && (raw as Record<string, unknown>).version === MEMORY_SCHEMA_VERSION);
}

export function getRepoMemory(state: PersistedMemoryV3, notesKey: string): RepoMemory {
  return { notes: state.notesByRepoKey[notesKey] ?? [] };
}

/**
 * Opportunistic, lossless reconciliation of a legacy or stale key onto the
 * current canonical one — e.g. an entry from before path canonicalization,
 * a differently-cased Windows path, or migrated saved commands still under
 * their checkout key. Merges (never overwrites); a no-op when the keys are
 * equal or the stale key holds nothing.
 */
export function reconcileStaleKey(state: PersistedMemoryV3, staleKey: string, canonicalKey: string): PersistedMemoryV3 {
  if (staleKey === canonicalKey) return state;
  const staleEntries = state.notesByRepoKey[staleKey];
  if (!staleEntries || staleEntries.length === 0) return state;
  const next = { ...state.notesByRepoKey };
  next[canonicalKey] = mergeNoteLists(next[canonicalKey], staleEntries);
  delete next[staleKey];
  return { ...state, notesByRepoKey: next };
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

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Case-insensitive substring search over note text. An empty or
 * whitespace-only query returns every note; order is preserved.
 */
export function searchNotes(notes: readonly MemoryNote[], query: string): MemoryNote[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...notes];
  return notes.filter((note) => note.text.toLowerCase().includes(q));
}

/** The exact text "Copy note" puts on the clipboard — the stored text, byte-for-byte, or `undefined` for an unknown id. */
export function noteCopyText(notes: readonly MemoryNote[], noteId: string): string | undefined {
  return notes.find((note) => note.id === noteId)?.text;
}

/**
 * All the pure note mutation logic. Each function takes the CURRENT full
 * persisted state and returns the NEXT one (or throws `MemoryLimitError`)
 * — `MemoryStore` only reads, serializes the calls, and writes back.
 */
export const memoryMutations = {
  addNote(state: PersistedMemoryV3, notesKey: string, text: string, pinned: boolean, now: number): PersistedMemoryV3 {
    const validText = validateNoteText(text);
    const existing = state.notesByRepoKey[notesKey] ?? [];
    if (existing.length >= MAX_NOTES_PER_REPO) {
      throw new MemoryLimitError(`This repository already has ${existing.length} notes, at or above the ${MAX_NOTES_PER_REPO} maximum for new notes. Remove one before adding another.`);
    }
    const note: MemoryNote = { id: makeId(), text: validText, pinned, createdAt: now };
    const nextNotes = pinned ? [note, ...existing.map((n) => ({ ...n, pinned: false }))] : [note, ...existing];
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  /**
   * Saving with NO actual text change is always a no-op — skipped before
   * the length check even runs — so re-opening and closing the editor on a
   * grandfathered oversized note can never fail. Shrinking an oversized
   * note is accepted; growing any note past the limit is rejected.
   */
  updateNote(state: PersistedMemoryV3, notesKey: string, noteId: string, text: string, now: number): PersistedMemoryV3 {
    const existing = state.notesByRepoKey[notesKey] ?? [];
    const target = existing.find((note) => note.id === noteId);
    if (!target) return state;
    if (text.trim() === target.text) return state;
    const validText = validateNoteText(text);
    const nextNotes = existing.map((note) => (note.id === noteId ? { ...note, text: validText, updatedAt: now } : note));
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  removeNote(state: PersistedMemoryV3, notesKey: string, noteId: string): PersistedMemoryV3 {
    const existing = state.notesByRepoKey[notesKey] ?? [];
    const nextNotes = existing.filter((note) => note.id !== noteId);
    if (nextNotes.length === existing.length) return state;
    return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: nextNotes } };
  },

  /** Pinning only keeps a note at the top of its list. It has no other meaning. */
  togglePin(state: PersistedMemoryV3, notesKey: string, noteId: string): PersistedMemoryV3 {
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
};

// ==================== export / import ====================

/**
 * Export schema:
 * - v1 (legacy): `repositories[].{ label, notes, commands }`.
 * - v2 (current): `repositories[].{ label, notes }` — notes only.
 * Imports accept both; a v1 file's commands are converted with
 * `legacyCommandToNote` (same deterministic ids as the storage migration,
 * so re-importing an old export never duplicates already-migrated notes).
 */
export const MEMORY_EXPORT_SCHEMA_VERSION = 2;
const SUPPORTED_IMPORT_SCHEMA_VERSIONS = [1, 2];

export interface MemoryExport {
  exportSchemaVersion: 2;
  exportedAt: number;
  /** One entry per repository included in this export. */
  repositories: Array<{
    /** Opaque display label, never a filesystem path — so an export can be shared without exposing local machine layout. */
    label: string;
    notes: MemoryNote[];
  }>;
}

export function buildMemoryExport(repos: Array<{ label: string; memory: RepoMemory }>, now: number): MemoryExport {
  return {
    exportSchemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
    exportedAt: now,
    repositories: repos.map(({ label, memory }) => ({ label, notes: sanitizeNoteList(memory.notes) })),
  };
}

/** Every note an import entry contributes: its notes, plus (export v1 only) its saved commands converted to notes. */
function entryNotes(entry: Record<string, unknown>): MemoryNote[] {
  return sanitizeNoteList([...sanitizeNoteList(entry.notes), ...legacyCommandsToNotes(entry.commands)]);
}

/** One repository entry's summary from an import file, BEFORE any target repository is chosen. Never mutates anything. */
export interface ImportEntrySummary {
  index: number;
  label: string;
  noteCount: number;
  /** How many of `noteCount` came from legacy saved commands (export v1). */
  legacyCommandCount: number;
}

export interface ImportFilePreview {
  valid: boolean;
  error?: string;
  entries: ImportEntrySummary[];
}

/** First-pass, target-independent validation of an import file. */
export function previewMemoryImportFile(raw: unknown): ImportFilePreview {
  const version = raw && typeof raw === "object" ? (raw as Record<string, unknown>).exportSchemaVersion : undefined;
  if (typeof version !== "number" || !SUPPORTED_IMPORT_SCHEMA_VERSIONS.includes(version)) {
    return { valid: false, error: "This file isn't a Repo Notes export this version understands.", entries: [] };
  }
  const repositories = (raw as Record<string, unknown>).repositories;
  if (!Array.isArray(repositories) || repositories.length === 0) {
    return { valid: false, error: "This file has no repositories to import.", entries: [] };
  }
  const entries: ImportEntrySummary[] = repositories.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return { index, label: "(unreadable entry)", noteCount: 0, legacyCommandCount: 0 };
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : "(unnamed repository)";
    return { index, label, noteCount: entryNotes(e).length, legacyCommandCount: legacyCommandsToNotes(e.commands).length };
  });
  return { valid: true, entries };
}

/** Detailed, target-aware preview of importing exactly ONE repository entry. */
export interface ImportEntryPreview {
  valid: boolean;
  error?: string;
  noteCount: number;
  /** Notes whose id already exists in the target — skipped unless the caller explicitly asks to overwrite. */
  duplicateNoteIds: string[];
  /** Notes over today's length limit. Non-zero means the whole import is REJECTED — never truncated. */
  oversizedNoteCount: number;
}

function invalidEntryPreview(error: string): ImportEntryPreview {
  return { valid: false, error, noteCount: 0, duplicateNoteIds: [], oversizedNoteCount: 0 };
}

export function previewMemoryImportEntry(raw: unknown, entryIndex: number, target: RepoMemory): ImportEntryPreview {
  const filePreview = previewMemoryImportFile(raw);
  if (!filePreview.valid) return invalidEntryPreview(filePreview.error ?? "This file isn't a valid Repo Notes export.");

  const repositories = (raw as { repositories: unknown[] }).repositories;
  const entry = repositories[entryIndex];
  if (!entry || typeof entry !== "object") {
    return invalidEntryPreview("That repository entry could not be found in the file.");
  }
  const notes = entryNotes(entry as Record<string, unknown>);
  const oversizedNoteCount = notes.filter(noteExceedsLengthLimit).length;
  const targetNoteIds = new Set(target.notes.map((n) => n.id));
  const duplicateNoteIds = notes.filter((n) => targetNoteIds.has(n.id)).map((n) => n.id);

  if (oversizedNoteCount > 0) {
    return {
      valid: false,
      error: `This repository entry has ${oversizedNoteCount} note(s) over today's size limit (max ${MAX_NOTE_LENGTH.toLocaleString()} characters per note). Nothing was imported or truncated — shorten the oversized notes in the source and re-export, or import elsewhere.`,
      noteCount: notes.length,
      duplicateNoteIds,
      oversizedNoteCount,
    };
  }
  return { valid: true, noteCount: notes.length, duplicateNoteIds, oversizedNoteCount: 0 };
}

export interface ImportOptions {
  /** When false (the default), a note whose id already exists in the target is skipped rather than overwritten. */
  overwriteDuplicates: boolean;
}

/**
 * Merges ONE chosen repository entry from the import file into ONE target
 * repository's notes. Re-validates immediately before mutating. Never
 * executes anything — imported text is inert data, exactly like every
 * other note.
 */
export function applyMemoryImport(
  state: PersistedMemoryV3,
  notesKey: string,
  raw: unknown,
  entryIndex: number,
  options: ImportOptions,
): PersistedMemoryV3 {
  const target = getRepoMemory(state, notesKey);
  const preview = previewMemoryImportEntry(raw, entryIndex, target);
  if (!preview.valid) {
    throw new MemoryLimitError(preview.error ?? "This file isn't a valid Repo Notes export.");
  }

  const repositories = (raw as { repositories: unknown[] }).repositories;
  const notes = entryNotes(repositories[entryIndex] as Record<string, unknown>);

  const existingNotes = state.notesByRepoKey[notesKey] ?? [];
  const existingNoteIds = new Set(existingNotes.map((n) => n.id));
  let nextNotes = [...existingNotes];

  for (const note of notes) {
    const isDuplicate = existingNoteIds.has(note.id);
    if (isDuplicate && !options.overwriteDuplicates) continue;
    if (isDuplicate) {
      // Overwriting replaces the imported fields but keeps the TARGET's own
      // pinned decision — pin state is a local ordering choice.
      nextNotes = nextNotes.map((n) => (n.id === note.id ? { ...note, pinned: n.pinned } : n));
    } else {
      existingNoteIds.add(note.id);
      nextNotes = [...nextNotes, { ...note, pinned: false }];
    }
  }

  // A merge that GROWS the repository past the limit is REJECTED
  // atomically, never silently truncated. "Grew past" rather than "is
  // over", so re-importing duplicates into an already-oversized,
  // grandfathered repository is never blocked.
  if (nextNotes.length > existingNotes.length && nextNotes.length > MAX_NOTES_PER_REPO) {
    throw new MemoryLimitError(
      `This import would bring this repository to ${nextNotes.length} notes, over the ${MAX_NOTES_PER_REPO} limit. Remove some existing notes first, or import into an empty/less-full repository.`,
    );
  }

  return { ...state, notesByRepoKey: { ...state.notesByRepoKey, [notesKey]: sanitizeNoteList(nextNotes) } };
}
