import { createContext, useCallback, useContext, useMemo, useReducer, useState, type ReactNode } from 'react';
import type { Identity, Note, NotesPreset, RepoState, Route } from './types';
import { makeNotes, mockDetectedEmail, mockIdentities, mockRepo, newNoteId } from './mockData';

// ---------------------------------------------------------------------------
// Mock domain state (repo lock state, identities, notes). In-memory only.
// ---------------------------------------------------------------------------

type RepoOpenState = Exclude<RepoState, 'no_repo'>;

interface MockState {
  repoState: RepoState;
  /** What "Open Folder" restores when leaving the no_repo state. */
  lastRepoState: RepoOpenState;
  identities: Identity[];
  assignedIdentityId: string | null;
  notes: Note[];
  /** Which dev preset produced the notes list ('custom' once edited). */
  notesPreset: NotesPreset | 'custom';
}

type Action =
  | { type: 'devSetRepoState'; repoState: RepoState }
  | { type: 'devSetNotes'; notes: Note[]; preset: NotesPreset }
  | { type: 'assign'; identityId: string }
  | { type: 'unlock' }
  | { type: 'applyLockedIdentity' }
  | { type: 'repaired' }
  | { type: 'openFolder' }
  | { type: 'addNote'; note: Note }
  | { type: 'updateNote'; id: string; text: string; at: number }
  | { type: 'deleteNote'; id: string }
  | { type: 'restoreNote'; note: Note; index: number }
  | { type: 'saveIdentity'; identity: Identity }
  | { type: 'reset'; state: MockState };

const needsIdentity = (s: RepoState) => s === 'locked' || s === 'needs_attention' || s === 'repair';

function initialState(): MockState {
  return {
    repoState: 'locked',
    lastRepoState: 'locked',
    identities: mockIdentities,
    assignedIdentityId: 'work',
    notes: makeNotes('two'),
    notesPreset: 'two',
  };
}

function reducer(state: MockState, action: Action): MockState {
  switch (action.type) {
    case 'devSetRepoState': {
      const repoState = action.repoState;
      let assignedIdentityId = state.assignedIdentityId;
      if (repoState === 'unassigned') assignedIdentityId = null;
      if (needsIdentity(repoState) && !assignedIdentityId) {
        assignedIdentityId = state.identities.find((i) => i.id === 'work')?.id ?? state.identities[0]?.id ?? null;
      }
      return {
        ...state,
        repoState,
        assignedIdentityId,
        lastRepoState: repoState === 'no_repo' ? state.lastRepoState : repoState,
      };
    }
    case 'devSetNotes':
      return { ...state, notes: action.notes, notesPreset: action.preset };
    case 'assign':
      return { ...state, repoState: 'locked', lastRepoState: 'locked', assignedIdentityId: action.identityId };
    case 'unlock':
      return { ...state, repoState: 'unassigned', lastRepoState: 'unassigned', assignedIdentityId: null };
    case 'applyLockedIdentity':
    case 'repaired':
      return { ...state, repoState: 'locked', lastRepoState: 'locked' };
    case 'openFolder':
      return { ...state, repoState: state.lastRepoState };
    case 'addNote':
      return { ...state, notes: [action.note, ...state.notes], notesPreset: 'custom' };
    case 'updateNote':
      return {
        ...state,
        notesPreset: 'custom',
        notes: state.notes.map((n) => (n.id === action.id ? { ...n, text: action.text, updatedAt: action.at } : n)),
      };
    case 'deleteNote':
      return { ...state, notesPreset: 'custom', notes: state.notes.filter((n) => n.id !== action.id) };
    case 'restoreNote': {
      const notes = [...state.notes];
      notes.splice(Math.min(action.index, notes.length), 0, action.note);
      return { ...state, notes, notesPreset: 'custom' };
    }
    case 'saveIdentity': {
      const exists = state.identities.some((i) => i.id === action.identity.id);
      return {
        ...state,
        identities: exists
          ? state.identities.map((i) => (i.id === action.identity.id ? action.identity : i))
          : [...state.identities, action.identity],
      };
    }
    case 'reset':
      return action.state;
  }
}

// ---------------------------------------------------------------------------
// Toasts (brief feedback inside the simulated sidebar)
// ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  message: string;
  icon?: string;
  tone?: 'success' | 'info';
  action?: { label: string; run: () => void };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface AppContextValue {
  repo: { name: string };
  repoState: RepoState;
  identities: Identity[];
  assignedIdentity: Identity | null;
  detectedEmail: string;
  notes: Note[];
  notesPreset: NotesPreset | 'custom';

  actions: {
    assign(identityId: string): void;
    unlock(): void;
    applyLockedIdentity(): void;
    repaired(): void;
    openFolder(): void;
    addNote(text: string): void;
    updateNote(id: string, text: string): void;
    deleteNote(id: string): void;
    saveIdentity(identity: Identity): void;
  };

  dev: {
    setRepoState(s: RepoState): void;
    setNotesPreset(p: NotesPreset): void;
    reset(): void;
  };

  nav: {
    stack: Route[];
    current: Route;
    push(route: Route): void;
    pop(): void;
    /** Pop back to the nearest matching route, or rebuild [menu, route] if absent. */
    popTo(route: Route): void;
    reset(): void;
  };

  toast: Toast | null;
  showToast(message: string, opts?: Omit<Toast, 'id' | 'message'>): void;
  dismissToast(): void;
}

const AppContext = createContext<AppContextValue | null>(null);

const ROOT: Route[] = [{ name: 'menu' }];

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [stack, setStack] = useState<Route[]>(ROOT);
  const [toast, setToast] = useState<Toast | null>(null);

  const showToast = useCallback((message: string, opts?: Omit<Toast, 'id' | 'message'>) => {
    setToast({ id: Date.now() + Math.random(), message, tone: 'success', ...opts });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const nav = useMemo<AppContextValue['nav']>(
    () => ({
      stack,
      current: stack[stack.length - 1],
      push: (route) => setStack((s) => [...s, route]),
      pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      popTo: (route) =>
        setStack((s) => {
          for (let i = s.length - 1; i >= 0; i--) {
            if (s[i].name === route.name) return s.slice(0, i + 1);
          }
          return route.name === 'menu' ? ROOT : [...ROOT, route];
        }),
      reset: () => setStack(ROOT),
    }),
    [stack],
  );

  const assignedIdentity = state.identities.find((i) => i.id === state.assignedIdentityId) ?? null;

  const value: AppContextValue = {
    repo: mockRepo,
    repoState: state.repoState,
    identities: state.identities,
    assignedIdentity,
    detectedEmail: mockDetectedEmail,
    notes: state.notes,
    notesPreset: state.notesPreset,
    actions: {
      assign: (identityId) => dispatch({ type: 'assign', identityId }),
      unlock: () => dispatch({ type: 'unlock' }),
      applyLockedIdentity: () => dispatch({ type: 'applyLockedIdentity' }),
      repaired: () => dispatch({ type: 'repaired' }),
      openFolder: () => {
        dispatch({ type: 'openFolder' });
        setStack(ROOT);
      },
      addNote: (text) => dispatch({ type: 'addNote', note: { id: newNoteId(), text, createdAt: Date.now() } }),
      updateNote: (id, text) => dispatch({ type: 'updateNote', id, text, at: Date.now() }),
      deleteNote: (id) => {
        const index = state.notes.findIndex((n) => n.id === id);
        const note = state.notes[index];
        if (!note) return;
        dispatch({ type: 'deleteNote', id });
        showToast('Note deleted', {
          icon: 'delete',
          tone: 'info',
          action: { label: 'Undo', run: () => dispatch({ type: 'restoreNote', note, index }) },
        });
      },
      saveIdentity: (identity) => dispatch({ type: 'saveIdentity', identity }),
    },
    dev: {
      setRepoState: (repoState) => {
        dispatch({ type: 'devSetRepoState', repoState });
        // Leaving or entering the no-repo state always lands on the root screen.
        if (repoState === 'no_repo' || state.repoState === 'no_repo') setStack(ROOT);
      },
      setNotesPreset: (preset) => dispatch({ type: 'devSetNotes', notes: makeNotes(preset), preset }),
      reset: () => {
        dispatch({ type: 'reset', state: initialState() });
        setStack(ROOT);
        setToast(null);
      },
    },
    nav,
    toast,
    showToast,
    dismissToast,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
