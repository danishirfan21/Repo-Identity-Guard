import { useEffect, useState } from 'react';
import type { Note } from '../state/types';
import { relativeTime } from '../state/utils';
import { Icon } from './Icon';
import { OverflowMenu } from './Header';
import { Button, InlineAction } from './primitives';

interface NoteCardProps {
  note: Note;
  now: number;
  onCopy: () => Promise<boolean> | boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}

// Collapsed preview limits — purely a display concern. The full stored text
// is always what Copy copies and Edit loads; only the rendered <p> is capped.
const PREVIEW_MAX_CHARS = 260;
const PREVIEW_MAX_LINES = 6;

function needsTruncation(text: string): boolean {
  return text.length > PREVIEW_MAX_CHARS || text.split('\n').length > PREVIEW_MAX_LINES;
}

function previewOf(text: string): string {
  const lines = text.split('\n').slice(0, PREVIEW_MAX_LINES).join('\n');
  return lines.length > PREVIEW_MAX_CHARS ? `${lines.slice(0, PREVIEW_MAX_CHARS)}…` : `${lines}…`;
}

/**
 * A note is plain text, rendered exactly as written (line breaks kept).
 * No line is styled or labelled as a runnable command: notes are never executed.
 */
export function NoteCard({ note, now, onCopy, onEdit, onDelete, onTogglePin }: NoteCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const truncatable = needsTruncation(note.text);
  const shown = truncatable && !expanded ? previewOf(note.text) : note.text;
  const time = note.updatedAt ? `Edited ${relativeTime(note.updatedAt, now).toLowerCase()}` : relativeTime(note.createdAt, now);

  const copy = async () => {
    const ok = await onCopy();
    if (ok) {
      setCopied(true);
    }
  };

  return (
    <article className="rounded-xl bg-surface-container border border-outline-variant/40 pt-2.5 pb-1.5 px-space-md hover:border-outline-variant transition-colors">
      {note.pinned && (
        <div className="mb-1 flex items-center gap-1 font-label-sm text-label-sm text-primary">
          <Icon name="push_pin" size={12} filled />
          Pinned
        </div>
      )}
      <p className="whitespace-pre-wrap break-words font-body-md text-body-md text-on-surface">{shown}</p>
      {truncatable && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="mt-1 font-label-sm text-label-sm text-primary hover:underline underline-offset-2"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      {confirmingDelete ? (
        <div className="mt-2 pt-1.5 border-t border-outline-variant/40">
          <p className="font-body-sm text-body-sm text-on-surface">Delete this note?</p>
          <p className="font-label-sm text-label-sm text-on-surface-variant">This can't be undone.</p>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="delete"
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-0.5 -mr-1.5">
          <span className="mr-auto font-label-sm text-label-sm text-outline">{time}</span>
          <InlineAction icon="content_copy" label={copied ? '✓ Copied' : 'Copy'} onClick={copy} />
          <InlineAction icon="edit" label="Edit" onClick={onEdit} />
          <OverflowMenu
            label="More note actions"
            items={[
              { label: note.pinned ? 'Unpin' : 'Pin', icon: 'push_pin', onSelect: onTogglePin },
              { label: 'Delete note', icon: 'delete', danger: true, onSelect: () => setConfirmingDelete(true) },
            ]}
          />
        </div>
      )}
    </article>
  );
}
