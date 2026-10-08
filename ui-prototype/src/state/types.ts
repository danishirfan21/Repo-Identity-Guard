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
}

export type NotesPreset = 'empty' | 'two' | 'many';

/** One entry in the sidebar's drill-down navigation stack. */
export type Route =
  | { name: 'menu' }
  | { name: 'identityLock' }
  | { name: 'assignIdentity' }
  | { name: 'confirmAssign'; identityId: string }
  | { name: 'manageIdentities' }
  | { name: 'addIdentity' }
  | { name: 'editIdentity'; identityId: string }
  | { name: 'notes' }
  | { name: 'addNote' }
  | { name: 'editNote'; noteId: string };

export type RouteName = Route['name'];
