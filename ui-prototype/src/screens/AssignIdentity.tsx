import { useEffect } from 'react';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { IdentityCard } from '../components/IdentityCard';
import { AddRow, Button, Card, IconTile, LinkButton, StatusBadge } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import { isIdentityComplete, missingFields } from '../state/mockData';
import { useMockAsync } from '../state/utils';

export function AssignIdentityScreen() {
  const { repo, repoState, identities, assignedIdentity, nav } = useApp();

  if (identities.length === 0) {
    return (
      <Screen header={<Header title="Assign identity" subtitle={repo.name} onBack={nav.pop} />}>
        <div className="mt-2 flex flex-col items-center text-center gap-2 rounded-xl border border-dashed border-outline-variant px-space-lg py-space-xl">
          <span className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
            <Icon name="person_add" size={22} />
          </span>
          <h2 className="font-title-md text-title-md text-on-surface">No identities yet.</h2>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-[240px]">
            Create an identity first, then assign it to this repository.
          </p>
          <Button size="sm" variant="primary" icon="add" className="mt-1" onClick={() => nav.push({ name: 'addIdentity' })}>
            Add identity
          </Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen header={<Header title="Assign identity" subtitle={repo.name} onBack={nav.pop} />}>
      <p className="font-body-md text-body-md text-on-surface-variant px-0.5">Choose an identity for this repository.</p>

      <div className="flex flex-col gap-2">
        {identities.map((identity) => {
          const current = repoState !== 'unassigned' && assignedIdentity?.id === identity.id;
          return (
            <IdentityCard
              key={identity.id}
              identity={identity}
              compact={identities.length > 4}
              onClick={() => nav.push({ name: 'confirmAssign', identityId: identity.id })}
              trailing={
                current ? (
                  <StatusBadge tone="success">Current</StatusBadge>
                ) : !isIdentityComplete(identity) ? (
                  <StatusBadge tone="warning">Setup incomplete</StatusBadge>
                ) : undefined
              }
            />
          );
        })}
        <AddRow label="Add identity" onClick={() => nav.push({ name: 'addIdentity' })} />
      </div>

      <div className="flex justify-center">
        <LinkButton onClick={() => nav.push({ name: 'manageIdentities' })}>Manage identities</LinkButton>
      </div>
    </Screen>
  );
}

/** Confirmation step: pushed screen rather than a modal (modals are cramped in a narrow sidebar). */
export function ConfirmAssignScreen({ identityId }: { identityId: string }) {
  const { repo, identities, actions, nav, showToast } = useApp();
  const identity = identities.find((i) => i.id === identityId);
  const [locking, run] = useMockAsync();

  useEffect(() => {
    if (!identity) nav.pop();
  }, [identity, nav]);
  if (!identity) return null;

  const confirm = () =>
    run(600, () => {
      actions.assign(identity.id);
      nav.popTo({ name: 'identityLock' });
      showToast(`${repo.name} locked to ${identity.label}`, { icon: 'verified_user' });
    });

  return (
    <Screen header={<Header title="Assign identity" subtitle={repo.name} onBack={nav.pop} />}>
      <Card>
        <div className="flex items-start gap-2.5">
          <IconTile icon="lock" tone="info" />
          <div className="min-w-0 flex-1">
            <h2 className="font-title-md text-title-md text-on-surface break-words">
              Lock {repo.name} to {identity.label}?
            </h2>
            <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
              Commits and pushes will be restricted to this identity.
            </p>
          </div>
        </div>

        <div className="mt-space-md">
          <IdentityCard identity={identity} showGitName />
        </div>

        {!isIdentityComplete(identity) && (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-tertiary/10 border border-tertiary/25 px-2.5 py-2">
            <Icon name="info" size={14} className="text-tertiary mt-[1px]" />
            <p className="font-body-sm text-body-sm text-on-surface">
              This identity is missing {missingFields(identity).length === 2 ? 'a GitHub username and an SSH profile' : !identity.githubUsername ? 'a GitHub username' : 'an SSH profile'}, so push verification won't work until you add it.
            </p>
          </div>
        )}

        <div className="mt-space-md flex justify-end gap-2">
          <Button variant="secondary" onClick={nav.pop} disabled={locking}>
            Cancel
          </Button>
          <Button variant="primary" icon="lock" loading={locking} onClick={confirm}>
            Lock repository
          </Button>
        </div>
      </Card>
    </Screen>
  );
}
