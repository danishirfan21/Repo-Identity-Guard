import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Header, IconButton, OverflowMenu } from '../components/Header';
import { Icon } from '../components/Icon';
import { NoteCard } from '../components/NoteCard';
import { Button } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import { copyText, useNow } from '../state/utils';

const PRIVACY_FOOTER = (
  <span className="flex items-start gap-1.5">
    <Icon name="lock" size={12} className="mt-[1px]" />
    Notes stay local to Repo Identity Guard and are not committed to your repository.
  </span>
);

export function RepoNotesScreen() {
  const { repo, notes, nav, actions, showToast } = useApp();
  const [query, setQuery] = useState('');
  const now = useNow();

  const q = query.trim().toLowerCase();
  const visible = q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;

  const copy = async (text: string, what = 'Note') => {
    const ok = await copyText(text);
    showToast(ok ? `${what} copied to clipboard` : "Couldn't access the clipboard", ok ? { icon: 'content_copy' } : { tone: 'info' });
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
              <IconButton icon="add" label="Add note" onClick={() => nav.push({ name: 'addNote' })} />
              <OverflowMenu
                items={[
                  {
                    label: 'Copy all notes',
                    icon: 'content_copy',
                    onSelect: () =>
                      notes.length
                        ? copy(notes.map((n) => n.text).join('\n\n---\n\n'), 'All notes')
                        : showToast('No notes to copy', { tone: 'info' }),
                  },
                ]}
              />
            </>
          }
        />
      }
      footer={PRIVACY_FOOTER}
    >
      {notes.length === 0 ? (
        <EmptyNotes repoName={repo.name} onAdd={() => nav.push({ name: 'addNote' })} />
      ) : (
        <>
          <div className="relative">
            <Icon name="search" size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes..."
              aria-label="Search notes"
              className="w-full h-8 rounded-lg bg-surface-container-lowest border border-outline-variant pl-8 pr-8 font-body-md text-body-md text-on-surface placeholder:text-outline/70 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-lg text-outline hover:text-on-surface"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="py-6 text-center font-body-sm text-body-sm text-on-surface-variant">
              No notes match “{query.trim()}”.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {visible.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  now={now}
                  onCopy={() => copy(note.text)}
                  onEdit={() => nav.push({ name: 'editNote', noteId: note.id })}
                  onDelete={() => actions.deleteNote(note.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

function EmptyNotes({ repoName, onAdd }: { repoName: string; onAdd: () => void }) {
  return (
    <div className="mt-2 flex flex-col items-center text-center gap-2 rounded-xl border border-dashed border-outline-variant px-space-lg py-space-xl">
      <span className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
        <Icon name="sticky_note_2" size={22} />
      </span>
      <h2 className="font-title-md text-title-md text-on-surface">No notes yet</h2>
      <p className="font-body-sm text-body-sm text-on-surface-variant max-w-[240px]">
        Keep private reminders for {repoName}: setup steps, who to ask, things not to forget.
      </p>
      <Button size="sm" variant="primary" icon="add" className="mt-1" onClick={onAdd}>
        Add note
      </Button>
    </div>
  );
}

/** Add Note (no noteId) and Edit Note share this dedicated full-screen editor. */
export function NoteEditorScreen({ noteId }: { noteId?: string }) {
  const { repo, notes, actions, nav, showToast } = useApp();
  const existing = noteId ? notes.find((n) => n.id === noteId) : undefined;
  const isEdit = !!noteId;
  const [text, setText] = useState(existing?.text ?? '');
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

  const canSave = text.trim().length > 0;

  const save = () => {
    if (!canSave) return;
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      nav.pop();
    }
  };

  if (isEdit && !existing) return null;

  return (
    <Screen header={<Header title="Repo Notes" subtitle={repo.name} onBack={nav.pop} />} footer={PRIVACY_FOOTER}>
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

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={nav.pop}>
          Cancel
        </Button>
        <Button variant="primary" icon={isEdit ? 'check' : 'add'} disabled={!canSave} onClick={save}>
          {isEdit ? 'Save' : 'Add note'}
        </Button>
      </div>
    </Screen>
  );
}
