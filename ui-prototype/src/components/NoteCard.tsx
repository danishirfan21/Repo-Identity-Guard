import type { Note } from '../state/types';
import { relativeTime } from '../state/utils';
import { OverflowMenu } from './Header';
import { InlineAction } from './primitives';

interface NoteCardProps {
  note: Note;
  now: number;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * A note is plain text, rendered exactly as written (line breaks kept).
 * No line is styled or labelled as a runnable command: notes are never executed.
 */
export function NoteCard({ note, now, onCopy, onEdit, onDelete }: NoteCardProps) {
  const time = note.updatedAt ? `Edited ${relativeTime(note.updatedAt, now).toLowerCase()}` : relativeTime(note.createdAt, now);
  return (
    <article className="rounded-xl bg-surface-container border border-outline-variant/40 pt-2.5 pb-1.5 px-space-md hover:border-outline-variant transition-colors">
      <p className="whitespace-pre-wrap break-words font-body-md text-body-md text-on-surface">{note.text}</p>
      <div className="mt-2 flex items-center gap-0.5 -mr-1.5">
        <span className="mr-auto font-label-sm text-label-sm text-outline">{time}</span>
        <InlineAction icon="content_copy" label="Copy" onClick={onCopy} />
        <InlineAction icon="edit" label="Edit" onClick={onEdit} />
        <OverflowMenu label="More note actions" items={[{ label: 'Delete note', icon: 'delete', danger: true, onSelect: onDelete }]} />
      </div>
    </article>
  );
}
