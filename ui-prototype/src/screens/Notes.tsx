import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Header, IconButton, OverflowMenu } from '../components/Header';
import { Icon } from '../components/Icon';
import { NoteCard } from '../components/NoteCard';
import { Button, Card } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import { copyText, useNow } from '../state/utils';

const PRIVACY_LINE = 'Notes stay local to Repo Identity Guard and are not committed to your repository.';

const PRIVACY_FOOTER = (
  <span className="flex items-start gap-1.5">
    <Icon name="lock" size={12} className="mt-[1px]" />
    {PRIVACY_LINE}
  </span>
);

// Below this many notes, search is reachable via a header icon instead of a
// permanent field; at or above it, the field is always visible.
const PERSISTENT_SEARCH_THRESHOLD = 5;

function sortedNotes<T extends { pinned?: boolean }>(notes: T[]): T[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => Number(!!b.note.pinned) - Number(!!a.note.pinned) || a.index - b.index)
    .map(({ note }) => note);
}

export function RepoNotesScreen() {
  const { repo, notes, nav, actions, showToast } = useApp();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow();

  const persistent = notes.length >= PERSISTENT_SEARCH_THRESHOLD;
  const showSearchField = persistent || searchOpen;

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const ordered = useMemo(() => sortedNotes(notes), [notes]);
  const q = query.trim().toLowerCase();
  const visible = q ? ordered.filter((n) => n.text.toLowerCase().includes(q)) : ordered;

  const copyOne = async (text: string) => copyText(text);

  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };

  return (
    <Screen
      header={
        <Header
          title="Repo Notes"
          subtitle={repo.name}
          onBack={nav.pop}
          actions={
            <>
              {!persistent && notes.length > 0 && (
                <IconButton
                  icon="search"
                  label={showSearchField ? 'Close search' : 'Search notes'}
                  active={showSearchField}
                  onClick={() => (showSearchField ? closeSearch() : setSearchOpen(true))}
                />
              )}
              <IconButton icon="add" label="Add note" onClick={() => nav.push({ name: 'addNote' })} />
              <OverflowMenu
                items={[
                  {
                    label: 'Copy all notes',
                    icon: 'content_copy',
                    onSelect: async () => {
                      if (!notes.length) {
                        showToast('No notes to copy', { tone: 'info' });
                        return;
                      }
                      const ok = await copyOne(notes.map((n) => n.text).join('\n\n---\n\n'));
                      showToast(ok ? 'All notes copied to clipboard' : "Couldn't access the clipboard", ok ? { icon: 'content_copy' } : { tone: 'info' });
                    },
                  },
                  { label: 'About Repo Notes', icon: 'info', onSelect: () => showToast(PRIVACY_LINE, { tone: 'info', icon: 'lock' }) },
                ]}
              />
            </>
          }
        />
      }
      subheader={
        notes.length > 0 && showSearchField ? (
          <div className="relative">
            <Icon name="search" size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !persistent) closeSearch();
              }}
              placeholder="Search notes..."
              aria-label="Search notes"
              className="w-full h-8 rounded-lg bg-surface-container-lowest border border-outline-variant pl-8 pr-8 font-body-md text-body-md text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-lg text-outline hover:text-on-surface"
              >
                <Icon name="close" size={14} />
              </button>
            ) : (
              !persistent && (
                <button
                  type="button"
                  aria-label="Close search"
                  onClick={closeSearch}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-lg text-outline hover:text-on-surface"
                >
                  <Icon name="close" size={14} />
                </button>
              )
            )}
          </div>
        ) : undefined
      }
      footer={notes.length > 0 ? PRIVACY_FOOTER : undefined}
    >
      {notes.length === 0 ? (
        <EmptyNotes repoName={repo.name} onAdd={() => nav.push({ name: 'addNote' })} />
      ) : visible.length === 0 ? (
        <p className="py-6 text-center font-body-sm text-body-sm text-on-surface-variant">No notes match "{query.trim()}".</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              now={now}
              onCopy={() => copyOne(note.text)}
              onEdit={() => nav.push({ name: 'editNote', noteId: note.id })}
              onDelete={() => actions.deleteNote(note.id)}
              onTogglePin={() => actions.toggleNotePin(note.id)}
            />
          ))}
        </div>
      )}
    </Screen>
  );
}

function EmptyNotes({ repoName, onAdd }: { repoName: string; onAdd: () => void }) {
  return (
    <div className="mt-2 flex flex-col items-center text-center gap-2 rounded-xl border border-dashed border-outline-variant px-space-lg py-space-xl">
      <span className="h-8 w-8 inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
        <Icon name="sticky_note_2" size={18} />
      </span>
      <h2 className="font-title-md text-title-md text-on-surface">No notes yet.</h2>
      <p className="font-body-sm text-body-sm text-on-surface-variant max-w-[240px]">
        Keep setup steps, reminders, URLs, commands, or anything else useful for {repoName}.
      </p>
      <Button size="sm" variant="primary" icon="add" className="mt-1" onClick={onAdd}>
        Add note
      </Button>
      <p className="mt-2 flex items-start gap-1.5 font-label-sm text-label-sm text-outline max-w-[240px]">
        <Icon name="lock" size={12} className="mt-[1px] shrink-0" />
        {PRIVACY_LINE}
      </p>
    </div>
  );
}

/** Add Note (no noteId) and Edit Note share this dedicated full-screen editor. */
export function NoteEditorScreen({ noteId }: { noteId?: string }) {
  const { repo, notes, actions, nav, showToast, dev } = useApp();
  const existing = noteId ? notes.find((n) => n.id === noteId) : undefined;
  const isEdit = !!noteId;
  const initialText = existing?.text ?? '';
  const [text, setText] = useState(initialText);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEdit && !existing) nav.pop();
  }, [isEdit, existing, nav]);

  // Focus on open; when editing, put the caret at the end of the text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const dirty = text !== initialText;
  const canSave = text.trim().length > 0;

  const commitSave = () => {
    const clean = text.replace(/^\s*\n/, '').trimEnd();
    if (isEdit && existing) {
      if (clean !== existing.text) actions.updateNote(existing.id, clean);
      showToast('Note saved');
    } else {
      actions.addNote(clean);
      showToast('Note added');
    }
    nav.pop();
  };

  const save = () => {
    if (!canSave || saving) return;
    setSaveFailed(false);
    if (dev.noteSaveResult === 'failure') {
      setSaving(true);
      window.setTimeout(() => {
        setSaving(false);
        setSaveFailed(true);
      }, 500);
      return;
    }
    commitSave();
  };

  const tryLeave = () => {
    if (dirty) setConfirmDiscard(true);
    else nav.pop();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      tryLeave();
    }
    // Plain Enter is left alone: it inserts a newline, it never submits.
  };

  if (isEdit && !existing) return null;

  return (
    <Screen header={<Header title="Repo Notes" subtitle={repo.name} onBack={tryLeave} />} footer={PRIVACY_FOOTER}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="note-editor" className="font-label-sm text-label-sm uppercase tracking-wider text-outline px-0.5">
          {isEdit ? 'Editing note' : 'New note'}
        </label>
        <textarea
          id="note-editor"
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={8}
          placeholder="Write a note for this repository…"
          spellCheck
          className="w-full min-h-[150px] resize-y rounded-lg bg-surface-container-lowest border border-outline-variant px-2.5 py-2 font-body-md text-body-md text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
        />
        <p className="font-label-sm text-label-sm text-outline px-0.5">Enter for newline · Ctrl/Cmd+Enter to save</p>
      </div>

      {saveFailed && (
        <div className="flex items-start gap-1.5 rounded-lg bg-error/10 border border-error/25 px-2.5 py-2">
          <Icon name="error" size={14} className="text-error mt-[1px]" />
          <div className="min-w-0 flex-1">
            <p className="font-body-sm text-body-sm text-on-surface">Couldn't save this note.</p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Your draft is still here.</p>
            <Button size="sm" variant="secondary" icon="refresh" className="mt-1.5" onClick={save}>
              Retry
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={tryLeave}>
          Cancel
        </Button>
        <Button variant="primary" icon={isEdit ? 'check' : 'add'} disabled={!canSave} loading={saving} onClick={save}>
          {saving ? 'Saving…' : isEdit ? 'Save' : 'Add note'}
        </Button>
      </div>

      {confirmDiscard && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-3" onMouseDown={() => setConfirmDiscard(false)}>
          <Card className="w-full max-w-[300px]">
            <div onMouseDown={(e) => e.stopPropagation()}>
              <p className="font-title-md text-title-md text-on-surface">Discard unsaved changes?</p>
              <div className="mt-space-md flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                  Keep editing
                </Button>
                <Button variant="danger" icon="delete" onClick={nav.pop}>
                  Discard
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </Screen>
  );
}
