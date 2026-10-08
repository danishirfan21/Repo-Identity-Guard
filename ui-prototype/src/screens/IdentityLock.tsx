import { useState, type ReactNode } from 'react';
import { Header, OverflowMenu } from '../components/Header';
import { Icon } from '../components/Icon';
import { IdentityCard } from '../components/IdentityCard';
import {
  Button,
  Card,
  Collapsible,
  IconTile,
  KeyValueList,
  LinkButton,
  ListGroup,
  NavRow,
  StatusBadge,
  type Tone,
} from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import type { Identity } from '../state/types';
import { useMockAsync } from '../state/utils';
import { lockStatus } from './lockStatus';

/** Identity Lock: renders one of four variants for the current repo state. */
export function IdentityLockScreen() {
  const { repo, repoState, assignedIdentity, nav, showToast } = useApp();
  const identity = assignedIdentity;

  const header = (
    <Header
      title="Identity Lock"
      subtitle={repo.name}
      onBack={nav.pop}
      actions={
        repoState === 'locked' && identity ? (
          <OverflowMenu
            items={[
              {
                label: 'Verify lock',
                icon: 'fact_check',
                onSelect: () => showToast(`Lock verified · Git is using ${identity.gitEmail}`, { icon: 'verified_user' }),
              },
            ]}
          />
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (repoState === 'unassigned' || !identity) body = <UnassignedView />;
  else if (repoState === 'needs_attention') body = <NeedsAttentionView identity={identity} />;
  else if (repoState === 'repair') body = <RepairView identity={identity} />;
  else body = <LockedView identity={identity} />;

  return <Screen header={header}>{body}</Screen>;
}

// ---------------------------------------------------------------------------

function StatusCardHeader({ icon, tone, title, badge, children }: { icon: string; tone: Tone; title: string; badge?: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <h2 className="font-title-md text-title-md text-on-surface pt-[1px]">{title}</h2>
          {badge && <StatusBadge tone={tone}>{badge}</StatusBadge>}
        </div>
        {children && <div className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">{children}</div>}
      </div>
    </div>
  );
}

function UnlockRow() {
  const { repo, actions, showToast } = useApp();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return <NavRow icon="lock_open" label="Unlock repository" quiet chevron={false} onClick={() => setConfirming(true)} />;
  }
  return (
    <div className="px-space-md py-2.5 bg-surface-container-low">
      <p className="font-title-md text-title-md text-on-surface">Unlock {repo.name}?</p>
      <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
        Commits and pushes will no longer be checked. You can assign an identity again at any time.
      </p>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="lock_open"
          onClick={() => {
            actions.unlock();
            showToast(`${repo.name} unlocked`, { icon: 'lock_open', tone: 'info' });
          }}
        >
          Unlock
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Locked
// ---------------------------------------------------------------------------

function LockedView({ identity }: { identity: Identity }) {
  const { repo, identities, nav } = useApp();
  const [picking, setPicking] = useState(false);
  const others = identities.filter((i) => i.id !== identity.id);
  const status = lockStatus('locked', identity);

  return (
    <>
      <Card>
        <StatusCardHeader icon="verified_user" tone={status.tone} title={identity.label} badge={status.word}>
          Commits and pushes in {repo.name} must use this identity.
        </StatusCardHeader>

        <KeyValueList
          className="mt-space-md"
          rows={[
            { k: 'Name', v: identity.gitName },
            { k: 'Git email', v: identity.gitEmail, mono: true },
            { k: 'GitHub', v: identity.githubUsername || 'Not set', mono: true },
          ]}
        />

        <Button
          block
          className="mt-space-md"
          icon={picking ? 'close' : 'sync_alt'}
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
        >
          {picking ? 'Cancel' : 'Change identity'}
        </Button>

        {picking && (
          <div className="mt-2 flex flex-col gap-1.5">
            <p className="font-label-sm text-label-sm text-outline px-0.5">Switch {repo.name} to</p>
            {others.map((o) => (
              <IdentityCard key={o.id} compact identity={o} onClick={() => nav.push({ name: 'confirmAssign', identityId: o.id })} />
            ))}
            {others.length === 0 && (
              <p className="font-body-sm text-body-sm text-on-surface-variant px-0.5">No other identities yet.</p>
            )}
            <div className="px-0.5 pt-0.5">
              <LinkButton icon="add" onClick={() => nav.push({ name: 'addIdentity' })}>
                Add identity
              </LinkButton>
            </div>
          </div>
        )}
      </Card>

      <ListGroup>
        <NavRow icon="tune" label="Manage identities" onClick={() => nav.push({ name: 'manageIdentities' })} />
        <UnlockRow />
      </ListGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Unassigned (neutral, not a warning)
// ---------------------------------------------------------------------------

function UnassignedView() {
  const { nav } = useApp();
  return (
    <Card>
      <StatusCardHeader icon="lock_open" tone="neutral" title="No identity assigned">
        Git is unrestricted in this repository. Repo Identity Guard won't interfere with commits or pushes.
      </StatusCardHeader>
      <Button block variant="primary" icon="verified_user" className="mt-space-md" onClick={() => nav.push({ name: 'assignIdentity' })}>
        Assign identity
      </Button>
      <div className="mt-2.5 flex justify-center">
        <LinkButton onClick={() => nav.push({ name: 'manageIdentities' })}>Manage identities</LinkButton>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Needs attention (Git is using a different identity than the lock)
// ---------------------------------------------------------------------------

function NeedsAttentionView({ identity }: { identity: Identity }) {
  const { repo, detectedEmail, actions, showToast } = useApp();
  const [applying, run] = useMockAsync();
  const status = lockStatus('needs_attention', identity);

  return (
    <>
      <Card>
        <StatusCardHeader icon="warning" tone={status.tone} title={identity.label} badge={status.word} />

        <p className="mt-space-md font-body-md text-body-md text-on-surface">
          This repository is locked to <span className="font-semibold">{identity.label}</span>, but Git is currently using:
        </p>
        <div className="mt-2 rounded-lg bg-surface-container-lowest border border-outline-variant/30 px-2.5 py-2 flex flex-col gap-1">
          <div className="flex items-start gap-1.5 font-code-sm text-code-sm text-tertiary min-w-0">
            <Icon name="close" size={14} className="mt-[1px]" />
            <span className="min-w-0 break-all">{detectedEmail}</span>
          </div>
          <div className="flex items-start gap-1.5 font-code-sm text-code-sm min-w-0">
            <Icon name="check" size={14} className="text-secondary mt-[1px]" />
            <span className="min-w-0 break-all text-on-surface">
              <span className="text-outline">Expected: </span>
              {identity.gitEmail}
            </span>
          </div>
        </div>
        <p className="mt-2 font-body-sm text-body-sm text-on-surface-variant">
          Commits in {repo.name} are blocked until Git uses the {identity.label} identity.
        </p>

        <Button
          block
          variant="primary"
          icon="check"
          className="mt-space-md"
          loading={applying}
          onClick={() =>
            run(700, () => {
              actions.applyLockedIdentity();
              showToast(`Now using ${identity.label} · ${identity.gitEmail}`);
            })
          }
        >
          {applying ? 'Applying…' : `Use ${identity.label} identity`}
        </Button>

        <div className="mt-2.5">
          <Collapsible>
            <KeyValueList
              stacked
              rows={[
                { k: 'Locked to', v: identity.label },
                { k: 'Git is using', v: detectedEmail, mono: true },
                { k: 'Comes from', v: 'Global Git config' },
                { k: 'This repository', v: 'No user.email set' },
              ]}
            />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              “Use {identity.label} identity” sets user.name and user.email for this repository only. Your global Git
              config isn't changed.
            </p>
          </Collapsible>
        </div>
      </Card>

      <ListGroup>
        <UnlockRow />
      </ListGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Repair (the lock can't currently be enforced)
// ---------------------------------------------------------------------------

function RepairView({ identity }: { identity: Identity }) {
  const { repo, actions, showToast } = useApp();
  const [repairing, runRepair] = useMockAsync();
  const [, runFinish] = useMockAsync();
  const [done, setDone] = useState(false);
  const status = lockStatus('repair', identity);

  const repair = () =>
    runRepair(1200, () => {
      setDone(true);
      runFinish(1100, () => {
        actions.repaired();
        showToast(`Identity lock restored · Locked to ${identity.label}`);
      });
    });

  if (done) {
    return (
      <Card>
        <StatusCardHeader icon="verified_user" tone="success" title="Identity lock restored" badge="Locked">
          Restored cleanly. Commits and pushes in {repo.name} are restricted to {identity.label} again.
        </StatusCardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <StatusCardHeader icon="build_circle" tone={status.tone} title="Identity lock needs repair">
        Repo Identity Guard can't currently enforce this repository's identity.
      </StatusCardHeader>

      <p className="mt-space-md font-body-sm text-body-sm text-on-surface-variant">
        Repair restores the lock to {identity.label}. Your commits, branches and notes aren't touched.
      </p>
      <Button block variant="primary" icon="build" className="mt-space-md" loading={repairing} onClick={repair}>
        {repairing ? 'Repairing…' : 'Repair'}
      </Button>

      <div className="mt-2.5">
        <Collapsible>
          <KeyValueList
            stacked
            rows={[
              { k: 'Locked to', v: `${identity.label} (${identity.gitEmail})` },
              { k: 'What happened', v: "The identity lock's commit and push checks are missing from this repository." },
              { k: 'Likely cause', v: 'Another tool changed where Git looks for hooks, or the hook files were deleted.' },
              { k: 'Repair will', v: `Reinstall the checks for ${identity.label}. Nothing else in ${repo.name} changes.` },
            ]}
          />
        </Collapsible>
      </div>
    </Card>
  );
}
