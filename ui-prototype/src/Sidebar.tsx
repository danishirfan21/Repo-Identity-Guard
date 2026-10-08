import { ToastHost } from './components/ToastHost';
import { AssignIdentityScreen, ConfirmAssignScreen } from './screens/AssignIdentity';
import { IdentityFormScreen, ManageIdentitiesScreen } from './screens/Identities';
import { IdentityLockScreen } from './screens/IdentityLock';
import { MainMenu } from './screens/MainMenu';
import { NoRepoScreen } from './screens/NoRepo';
import { NoteEditorScreen, RepoNotesScreen } from './screens/Notes';
import { useApp } from './state/AppState';
import type { Route } from './state/types';

function renderRoute(route: Route) {
  switch (route.name) {
    case 'menu':
      return <MainMenu />;
    case 'identityLock':
      return <IdentityLockScreen />;
    case 'assignIdentity':
      return <AssignIdentityScreen />;
    case 'confirmAssign':
      return <ConfirmAssignScreen identityId={route.identityId} />;
    case 'manageIdentities':
      return <ManageIdentitiesScreen />;
    case 'addIdentity':
      return <IdentityFormScreen />;
    case 'editIdentity':
      return <IdentityFormScreen identityId={route.identityId} />;
    case 'notes':
      return <RepoNotesScreen />;
    case 'addNote':
      return <NoteEditorScreen />;
    case 'editNote':
      return <NoteEditorScreen noteId={route.noteId} />;
  }
}

/** The simulated extension webview: everything the real sidebar would render. */
export function Sidebar() {
  const { repoState, nav } = useApp();
  // Key by stack depth + route so each push/pop mounts fresh (scroll + focus reset).
  const key = `${nav.stack.length}-${JSON.stringify(nav.current)}`;

  return (
    <div className="relative h-full flex flex-col bg-background text-on-surface font-body-md text-body-md overflow-hidden">
      {repoState === 'no_repo' ? <NoRepoScreen /> : <div key={key} className="h-full min-h-0">{renderRoute(nav.current)}</div>}
      <ToastHost />
    </div>
  );
}
