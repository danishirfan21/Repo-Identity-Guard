import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { Button } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';

/** Root-level alternate state when no Git repository is open. */
export function NoRepoScreen() {
  const { actions } = useApp();
  return (
    <Screen header={<Header title="Repo Identity Guard" />}>
      <div className="mt-6 flex flex-col items-center text-center gap-2 px-space-sm">
        <span className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
          <Icon name="folder_off" size={22} />
        </span>
        <h2 className="font-title-md text-title-md text-on-surface">No Git repository is open.</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-[240px]">
          Open a Git repository to use Identity Lock and Repo Notes.
        </p>
        <Button variant="primary" icon="folder_open" className="mt-2" onClick={actions.openFolder}>
          Open Folder
        </Button>
      </div>
    </Screen>
  );
}
