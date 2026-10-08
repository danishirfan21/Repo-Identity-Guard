import { createContext, useCallback, useContext, useMemo, useReducer, useState, type ReactNode } from 'react';
import type {
  Identity,
  IdentitiesPreset,
  IdentitySetup,
  Note,
  NotesPreset,
  NoteSaveResult,
  RepairResult,
  RepoState,
  Route,
} from './types';
import { isIdentityComplete, makeIdentities, makeNotes, mockDetectedEmail, mockIdentities, mockRepo, newNoteId } from './mockData';

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
  /** Which dev preset produced the identities list ('custom' once edited). */
  identitiesPreset: IdentitiesPreset | 'custom';
  /** Dev-only: completeness of the assigned identity's push-verification fields. */
  identitySetup: IdentitySetup;
}

type Action =
  | { type: 'devSetRepoState'; repoState: RepoState }
  | { type: 'devSetNotes'; notes: Note[]; preset: NotesPreset }
  | { type: 'devSetIdentities'; identities: Identity[]; preset: IdentitiesPreset }
  | { type: 'devSetIdentitySetup'; setup: IdentitySetup }
  | { type: 'assign'; identityId: string }
  | { type: 'unlock' }
  | { type: 'applyLockedIdentity' }
  | { type: 'repaired' }
  | { type: 'openFolder' }
  | { type: 'addNote'; note: Note }
  | { type: 'updateNote'; id: string; text: string; at: number }
  | { type: 'deleteNote'; id: string }
  | { type: 'restoreNote'; note: Note; index: number }
  | { type: 'toggleNotePin'; id: string }
  | { type: 'saveIdentity'; identity: Identity }
  | { type: 'deleteIdentity'; id: string }
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
    identitiesPreset: '2',
    identitySetup: 'complete',
  };
}

function applyIdentitySetup(identity: Identity, setup: IdentitySetup): Identity {
  if (setup === 'missing_github') return { ...identity, githubUsername: '' };
  if (setup === 'missing_ssh') return { ...identity, sshProfile: '' };
  // 'complete': fill in anything missing with a plausible value rather than
  // reaching into the original seed data (the identity may have come from
  // any dev preset by now).
  return {
    ...identity,
    githubUsername: identity.githubUsername || `gh-${identity.id}`,
    sshProfile: identity.sshProfile || `github-${identity.id}`,
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
      // Nothing to lock to if there are no identities at all — fall back to unassigned.
      const resolvedState = needsIdentity(repoState) && state.identities.length === 0 ? 'unassigned' : repoState;
      return {
        ...state,
        repoState: resolvedState,
        assignedIdentityId,
        lastRepoState: resolvedState === 'no_repo' ? state.lastRepoState : resolvedState,
      };
    }
    case 'devSetNotes':
      return { ...state, notes: action.notes, notesPreset: action.preset };
    case 'devSetIdentities': {
      let assignedIdentityId = state.assignedIdentityId;
      if (!action.identities.some((i) => i.id === assignedIdentityId)) {
        assignedIdentityId = needsIdentity(state.repoState) ? action.identities[0]?.id ?? null : null;
      }
      const identities =
        state.identitySetup === 'complete'
          ? action.identities
          : action.identities.map((i) => (i.id === assignedIdentityId ? applyIdentitySetup(i, state.identitySetup) : i));
      const repoState = needsIdentity(state.repoState) && identities.length === 0 ? 'unassigned' : state.repoState;
      return {
        ...state,
        identities,
        identitiesPreset: action.preset,
        assignedIdentityId,
        repoState,
        lastRepoState: repoState === 'no_repo' ? state.lastRepoState : repoState,
      };
    }
    case 'devSetIdentitySetup': {
      const id = state.assignedIdentityId;
      if (!id) return { ...state, identitySetup: action.setup };
      const identities = state.identities.map((i) => (i.id === id ? applyIdentitySetup(i, action.setup) : i));
      return { ...state, identities, identitySetup: action.setup };
    }
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
    case 'toggleNotePin':
      return {
        ...state,
        notesPreset: 'custom',
        notes: state.notes.map((n) => (n.id === action.id ? { ...n, pinned: !n.pinned } : n)),
      };
    case 'saveIdentity': {
      const exists = state.identities.some((i) => i.id === action.identity.id);
      return {
        ...state,
        identitiesPreset: 'custom',
        identities: exists
          ? state.identities.map((i) => (i.id === action.identity.id ? action.identity : i))
          : [...state.identities, action.identity],
      };
    }
    case 'deleteIdentity': {
      // Never silently delete the identity assigned to this repository.
      if (action.id === state.assignedIdentityId) return state;
      return { ...state, identitiesPreset: 'custom', identities: state.identities.filter((i) => i.id !== action.id) };
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
  assignedIdentityComplete: boolean;
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
    toggleNotePin(id: string): void;
    saveIdentity(identity: Identity): void;
    deleteIdentity(id: string): void;
  };

  dev: {
    setRepoState(s: RepoState): void;
    setNotesPreset(p: NotesPreset): void;
    identitiesPreset: IdentitiesPreset | 'custom';
    setIdentitiesPreset(p: IdentitiesPreset): void;
    identitySetup: IdentitySetup;
    setIdentitySetup(s: IdentitySetup): void;
    repairResult: RepairResult;
    setRepairResult(r: RepairResult): void;
    noteSaveResult: NoteSaveResult;
    setNoteSaveResult(r: NoteSaveResult): void;
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
  const [repairResult, setRepairResult] = useState<RepairResult>('success');
  const [noteSaveResult, setNoteSaveResult] = useState<NoteSaveResult>('success');

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
    assignedIdentityComplete: assignedIdentity ? isIdentityComplete(assignedIdentity) : true,
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
      toggleNotePin: (id) => dispatch({ type: 'toggleNotePin', id }),
      saveIdentity: (identity) => dispatch({ type: 'saveIdentity', identity }),
      deleteIdentity: (id) => dispatch({ type: 'deleteIdentity', id }),
    },
    dev: {
      setRepoState: (repoState) => {
        dispatch({ type: 'devSetRepoState', repoState });
        // Leaving or entering the no-repo state always lands on the root screen.
        if (repoState === 'no_repo' || state.repoState === 'no_repo') setStack(ROOT);
      },
      setNotesPreset: (preset) => dispatch({ type: 'devSetNotes', notes: makeNotes(preset), preset }),
      identitiesPreset: state.identitiesPreset,
      setIdentitiesPreset: (preset) => dispatch({ type: 'devSetIdentities', identities: makeIdentities(preset), preset }),
      identitySetup: state.identitySetup,
      setIdentitySetup: (setup) => dispatch({ type: 'devSetIdentitySetup', setup }),
      repairResult,
      setRepairResult,
      noteSaveResult,
      setNoteSaveResult,
      reset: () => {
        dispatch({ type: 'reset', state: initialState() });
        setStack(ROOT);
        setToast(null);
        setRepairResult('success');
        setNoteSaveResult('success');
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
