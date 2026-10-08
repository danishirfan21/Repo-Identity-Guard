import { Header } from '../components/Header';
import { ListGroup, NavRow, toneDot } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import { plural } from '../state/utils';
import { lockStatus } from './lockStatus';

/** Root screen: exactly two jobs, Identity Lock and Repo Notes. */
export function MainMenu() {
  const { repo, repoState, assignedIdentity, notes, nav } = useApp();
  const status = lockStatus(repoState, assignedIdentity);

  return (
    <Screen header={<Header title="Repo Identity Guard" subtitle={repo.name} />}>
      <ListGroup>
        <NavRow
          large
          icon="verified_user"
          tone={status.tone}
          label="Identity Lock"
          subtitle={
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${toneDot(status.tone)}`} />
              {status.summary}
            </span>
          }
          onClick={() => nav.push({ name: 'identityLock' })}
        />
        <NavRow
          large
          icon="sticky_note_2"
          tone="info"
          label="Repo Notes"
          subtitle={plural(notes.length, 'note', 'notes')}
          onClick={() => nav.push({ name: 'notes' })}
        />
      </ListGroup>
    </Screen>
  );
}
