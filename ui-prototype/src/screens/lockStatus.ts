import type { Tone } from '../components/primitives';
import type { Identity, RepoState } from '../state/types';

export interface LockStatus {
  tone: Tone;
  /** Badge word, e.g. "Locked". */
  word: string;
  /** Main-menu subtitle, e.g. "Locked · Work". */
  summary: string;
}

export function lockStatus(state: RepoState, identity: Identity | null): LockStatus {
  const withLabel = (word: string) => (identity ? `${word} · ${identity.label}` : word);
  switch (state) {
    case 'locked':
      return { tone: 'success', word: 'Locked', summary: withLabel('Locked') };
    case 'needs_attention':
      return { tone: 'warning', word: 'Needs attention', summary: withLabel('Needs attention') };
    case 'repair':
      return { tone: 'error', word: 'Needs repair', summary: withLabel('Needs repair') };
    case 'unassigned':
    case 'no_repo':
      return { tone: 'neutral', word: 'Unassigned', summary: 'Unassigned' };
  }
}
