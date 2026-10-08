import { useEffect } from 'react';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { IdentityCard } from '../components/IdentityCard';
import { AddRow, Button, Card, IconTile, LinkButton, StatusBadge } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import { useMockAsync } from '../state/utils';

export function AssignIdentityScreen() {
  const { repo, repoState, identities, assignedIdentity, nav } = useApp();

  return (
    <Screen header={<Header title="Assign identity" subtitle={repo.name} onBack={nav.pop} />}>
      <p className="font-body-md text-body-md text-on-surface-variant px-0.5">Choose an identity for this repository.</p>

      <div className="flex flex-col gap-2">
        {identities.map((identity) => (
          <IdentityCard
            key={identity.id}
            identity={identity}
            onClick={() => nav.push({ name: 'confirmAssign', identityId: identity.id })}
            trailing={
              repoState !== 'unassigned' && assignedIdentity?.id === identity.id ? (
                <StatusBadge tone="success">Current</StatusBadge>
              ) : undefined
            }
          />
        ))}
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

        {!identity.githubUsername && (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-tertiary/10 border border-tertiary/25 px-2.5 py-2">
            <Icon name="info" size={14} className="text-tertiary mt-[1px]" />
            <p className="font-body-sm text-body-sm text-on-surface">
              This identity has no GitHub username yet, so pushes will be blocked until you add one.
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
