export type RepoState = 'locked' | 'unassigned' | 'needs_attention' | 'repair' | 'no_repo';

export interface Identity {
  id: string;
  label: string;
  gitName: string;
  gitEmail: string;
  githubUsername: string;
  sshProfile: string;
}

export interface Note {
  id: string;
  text: string;
  createdAt: number;
  /** Set when a note has been edited after creation. */
  updatedAt?: number;
  pinned?: boolean;
}

export type NotesPreset = 'empty' | 'two' | 'ten' | 'thirty' | 'long';

/** Dev-only: which required field (if any) the current demo identity is missing. */
export type IdentitySetup = 'complete' | 'missing_github' | 'missing_ssh';

/** Dev-only: how many identities exist, for exercising 0/1/2/8/mixed-completeness lists. */
export type IdentitiesPreset = '0' | '1' | '2' | '8' | 'incomplete';

/** Dev-only: whether the next mock Repair attempt succeeds or fails. */
export type RepairResult = 'success' | 'failure';

/** Dev-only: whether the next mock note save succeeds or fails. */
export type NoteSaveResult = 'success' | 'failure';

/** One entry in the sidebar's drill-down navigation stack. */
export type Route =
  | { name: 'menu' }
  | { name: 'identityLock' }
  | { name: 'assignIdentity' }
  | { name: 'confirmAssign'; identityId: string }
  | { name: 'manageIdentities' }
  | { name: 'addIdentity' }
  | { name: 'editIdentity'; identityId: string; highlightMissing?: boolean }
  | { name: 'notes' }
  | { name: 'addNote' }
  | { name: 'editNote'; noteId: string };

export type RouteName = Route['name'];
