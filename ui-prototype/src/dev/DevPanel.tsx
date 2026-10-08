import type { ReactNode } from 'react';
import { useApp } from '../state/AppState';
import type { IdentitiesPreset, IdentitySetup, NotesPreset, NoteSaveResult, RepairResult, RepoState, Route } from '../state/types';

/*
 * Developer-only controls. Deliberately styled as a plain light-mode debug
 * panel (system font, slate palette, dashed border) so it can't be mistaken
 * for part of the extension UI.
 */

const repoStates: { value: RepoState; label: string }[] = [
  { value: 'locked', label: 'Locked' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'repair', label: 'Repair' },
  { value: 'no_repo', label: 'No repo' },
];

const identitySetups: { value: IdentitySetup; label: string }[] = [
  { value: 'complete', label: 'Complete' },
  { value: 'missing_github', label: 'Missing GitHub username' },
  { value: 'missing_ssh', label: 'Missing SSH profile' },
];

const identitiesPresets: { value: IdentitiesPreset; label: string }[] = [
  { value: '0', label: '0' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '8', label: '8' },
  { value: 'incomplete', label: 'Incomplete' },
];

const notePresets: { value: NotesPreset; label: string }[] = [
  { value: 'empty', label: 'Empty' },
  { value: 'two', label: '2 notes' },
  { value: 'ten', label: '10 notes' },
  { value: 'thirty', label: '30 notes' },
  { value: 'long', label: 'Long note' },
];

const noteSaveResults: { value: NoteSaveResult; label: string }[] = [
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
];

const repairResults: { value: RepairResult; label: string }[] = [
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
];

const widthPresets = [240, 320, 420];

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2 py-1 rounded border text-xs font-medium ${
            value === o.value
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {children}
    </div>
  );
}

const routeLabel = (r: Route) => ('identityId' in r ? `${r.name}(${r.identityId})` : 'noteId' in r ? `${r.name}(…)` : r.name);

export function DevPanel({ width, onWidthChange }: { width: number; onWidthChange: (w: number) => void }) {
  const { repoState, notesPreset, notes, identities, assignedIdentity, nav, dev } = useApp();

  return (
    <aside
      className="w-full max-w-[300px] shrink-0 rounded-md border-2 border-dashed border-amber-400 bg-slate-50 text-slate-800 p-4 flex flex-col gap-4 shadow-lg overflow-y-auto"
      style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', maxHeight: 'min(760px, calc(100vh - 80px))' }}
    >
      <div>
        <div className="inline-block rounded bg-amber-400 text-amber-950 text-[11px] font-bold tracking-widest px-1.5 py-0.5">
          DEV STATE
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Prototype controls. Not part of the extension. All state is mock and in-memory.
        </p>
      </div>

      <Group title="Repository state">
        <Segmented options={repoStates} value={repoState} onChange={dev.setRepoState} />
      </Group>

      <Group title="Identity setup (assigned identity)">
        <Segmented options={identitySetups} value={dev.identitySetup} onChange={dev.setIdentitySetup} />
        <p className="text-[11px] text-slate-500">
          Forces the repo to show "Needs attention" instead of "Locked" when the assigned identity is missing a
          required push field.
        </p>
      </Group>

      <Group title="Identities">
        <Segmented
          options={identitiesPresets}
          value={dev.identitiesPreset === 'custom' ? null : dev.identitiesPreset}
          onChange={dev.setIdentitiesPreset}
        />
        {dev.identitiesPreset === 'custom' && <p className="text-[11px] text-slate-500">Edited · {identities.length} identities</p>}
      </Group>

      <Group title="Notes">
        <Segmented options={notePresets} value={notesPreset === 'custom' ? null : notesPreset} onChange={dev.setNotesPreset} />
        {notesPreset === 'custom' && <p className="text-[11px] text-slate-500">Edited · {notes.length} notes</p>}
      </Group>

      <Group title="Note save (next Add/Edit Note)">
        <Segmented options={noteSaveResults} value={dev.noteSaveResult} onChange={dev.setNoteSaveResult} />
      </Group>

      <Group title="Repair result (next Repair attempt)">
        <Segmented options={repairResults} value={dev.repairResult} onChange={dev.setRepairResult} />
      </Group>

      <Group title={`Sidebar width · ${width}px`}>
        <input
          type="range"
          min={240}
          max={420}
          step={10}
          value={width}
          onChange={(e) => onWidthChange(Number(e.target.value))}
          className="w-full accent-slate-900"
        />
        <Segmented options={widthPresets.map((w) => ({ value: w, label: `${w}` }))} value={width} onChange={onWidthChange} />
      </Group>

      <Group title="Inspect">
        <dl className="text-[11px] font-mono text-slate-600 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          <dt className="text-slate-400">assigned</dt>
          <dd>{assignedIdentity?.id ?? 'null'}</dd>
          <dt className="text-slate-400">nav</dt>
          <dd className="break-words">{nav.stack.map(routeLabel).join(' › ')}</dd>
        </dl>
      </Group>

      <button
        type="button"
        onClick={() => {
          dev.reset();
          onWidthChange(320);
        }}
        className="self-start px-2 py-1 rounded border border-slate-300 bg-white text-xs text-slate-700 hover:bg-slate-100"
      >
        Reset prototype
      </button>
    </aside>
  );
}
