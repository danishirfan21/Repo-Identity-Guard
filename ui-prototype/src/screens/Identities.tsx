import { useEffect, useState, type FormEvent } from 'react';
import { Field } from '../components/Field';
import { Header, OverflowMenu } from '../components/Header';
import { Icon } from '../components/Icon';
import { IdentityCard } from '../components/IdentityCard';
import { AddRow, Button, Card, SectionLabel } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import { isIdentityComplete } from '../state/mockData';
import type { Identity } from '../state/types';

/** Global identity list. Not repo-scoped, so the header carries no repo name. */
export function ManageIdentitiesScreen() {
  const { repo, identities, assignedIdentity, nav } = useApp();
  const [deleteTarget, setDeleteTarget] = useState<Identity | null>(null);

  return (
    <Screen
      header={<Header title="Identities" onBack={nav.pop} />}
      footer="Identities are reusable across repositories."
    >
      <SectionLabel>Configured identities</SectionLabel>
      <div className="flex flex-col gap-2">
        {identities.map((identity) => {
          const assigned = assignedIdentity?.id === identity.id;
          return (
            <div key={identity.id} className="flex items-stretch gap-1.5">
              <div className="flex-1 min-w-0">
                <IdentityCard
                  identity={identity}
                  showGitName
                  onClick={() => nav.push({ name: 'editIdentity', identityId: identity.id })}
                  trailing={
                    !isIdentityComplete(identity) ? (
                      <span className="inline-flex items-center gap-1" title="Setup incomplete">
                        <Icon name="error" size={16} className="text-tertiary" aria-label="Setup incomplete" />
                      </span>
                    ) : assigned ? (
                      <span className="font-label-sm text-label-sm text-secondary whitespace-nowrap">Assigned</span>
                    ) : undefined
                  }
                />
              </div>
              <OverflowMenu
                label={`More actions for ${identity.label}`}
                items={[
                  { label: 'Edit', icon: 'edit', onSelect: () => nav.push({ name: 'editIdentity', identityId: identity.id }) },
                  { label: 'Delete', icon: 'delete', danger: true, onSelect: () => setDeleteTarget(identity) },
                ]}
              />
            </div>
          );
        })}
        {identities.length === 0 && (
          <p className="font-body-sm text-body-sm text-on-surface-variant px-0.5">No identities yet.</p>
        )}
        <AddRow label="Add identity" onClick={() => nav.push({ name: 'addIdentity' })} />
      </div>

      {deleteTarget && (
        <DeleteIdentityDialog
          identity={deleteTarget}
          repoName={repo.name}
          assigned={assignedIdentity?.id === deleteTarget.id}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => setDeleteTarget(null)}
        />
      )}
    </Screen>
  );
}

/**
 * Shared delete confirmation. An identity assigned to the current repository
 * offers no delete option — the user must change or unlock first.
 */
function DeleteIdentityDialog({
  identity,
  repoName,
  assigned,
  onClose,
  onDeleted,
}: {
  identity: Identity;
  repoName: string;
  assigned: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { actions, showToast, nav } = useApp();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-3" onMouseDown={onClose}>
      <Card className="w-full max-w-[320px]">
        <div onMouseDown={(e) => e.stopPropagation()}>
          {assigned ? (
            <>
              <p className="font-title-md text-title-md text-on-surface break-words">
                {identity.label} is currently assigned to {repoName}.
              </p>
              <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
                Change or unlock this repository before deleting {identity.label}.
              </p>
              <div className="mt-space-md flex justify-end">
                <Button
                  variant="primary"
                  icon="verified_user"
                  autoFocus
                  onClick={() => {
                    onClose();
                    nav.popTo({ name: 'identityLock' });
                  }}
                >
                  Go to Identity Lock
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="font-title-md text-title-md text-on-surface break-words">Delete {identity.label}?</p>
              <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">This removes the reusable identity.</p>
              <div className="mt-space-md flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  icon="delete"
                  onClick={() => {
                    actions.deleteIdentity(identity.id);
                    showToast(`Deleted ${identity.label}`, { icon: 'delete', tone: 'info' });
                    onDeleted();
                  }}
                >
                  Delete
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

type Draft = Omit<Identity, 'id'>;

const emptyDraft: Draft = { label: '', gitName: '', gitEmail: '', githubUsername: '', sshProfile: '' };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'identity';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add Identity (no identityId) and Edit Identity share one form. */
export function IdentityFormScreen({ identityId, highlightMissing = false }: { identityId?: string; highlightMissing?: boolean }) {
  const { repo, identities, assignedIdentity, actions, nav, showToast } = useApp();
  const repoName = repo.name;
  const existing = identityId ? identities.find((i) => i.id === identityId) : undefined;
  const isEdit = !!identityId;

  const [draft, setDraft] = useState<Draft>(() => (existing ? { ...existing } : emptyDraft));
  const [touched, setTouched] = useState<Partial<Record<keyof Draft, boolean>>>(
    highlightMissing ? { githubUsername: true, sshProfile: true } : {},
  );
  const [submitted, setSubmitted] = useState(false);
  const [sshHelpOpen, setSshHelpOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (isEdit && !existing) nav.pop();
  }, [isEdit, existing, nav]);

  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const blur = (key: keyof Draft) => () => setTouched((t) => ({ ...t, [key]: true }));

  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!draft.label.trim()) errors.label = 'Required';
  else {
    const dupe = identities.some((i) => i.id !== existing?.id && i.label.trim().toLowerCase() === draft.label.trim().toLowerCase());
    if (dupe) errors.label = `An identity named ${draft.label.trim()} already exists.`;
  }
  if (!draft.gitEmail.trim()) errors.gitEmail = 'Required';
  else if (!EMAIL_RE.test(draft.gitEmail.trim())) errors.gitEmail = 'Enter a valid email address.';
  if (!draft.githubUsername.trim()) errors.githubUsername = 'GitHub username is required for push verification.';
  if (!draft.sshProfile.trim()) errors.sshProfile = 'SSH profile is required for push verification.';

  // Required-field hints/errors show once a field has been touched (blurred) or after a save attempt.
  const shown: Partial<Record<keyof Draft, string>> = {};
  (Object.keys(errors) as (keyof Draft)[]).forEach((key) => {
    if (submitted || touched[key]) shown[key] = errors[key];
  });

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const clean: Draft = {
      label: draft.label.trim(),
      gitName: draft.gitName.trim(),
      gitEmail: draft.gitEmail.trim(),
      githubUsername: draft.githubUsername.trim().replace(/^@/, ''),
      sshProfile: draft.sshProfile.trim(),
    };
    let id = existing?.id;
    if (!id) {
      id = slug(clean.label);
      if (identities.some((i) => i.id === id)) id = `${id}-${Date.now().toString(36)}`;
    }
    actions.saveIdentity({ id, ...clean });
    nav.pop();
    showToast(isEdit ? `Saved ${clean.label}` : `Added ${clean.label}`);
  };

  if (isEdit && !existing) return null;

  const missingHighlight = (key: 'githubUsername' | 'sshProfile') =>
    highlightMissing && !shown[key] && !draft[key].trim()
      ? `${key === 'githubUsername' ? 'GitHub username' : 'SSH profile'} — Required for push verification`
      : undefined;

  return (
    <Screen
      header={<Header title={isEdit ? 'Edit identity' : 'Add identity'} subtitle={existing?.label} onBack={nav.pop} />}
    >
      <form className="flex flex-col gap-space-md" onSubmit={save} noValidate>
        <Field
          label="Name"
          icon="badge"
          required
          placeholder="Work"
          value={draft.label}
          onChange={set('label')}
          onBlur={blur('label')}
          error={shown.label}
          hint="Only shown inside Repo Identity Guard."
          autoFocus={!isEdit}
        />
        <Field label="Git name" icon="person_outline" placeholder="Jane Doe" value={draft.gitName} onChange={set('gitName')} />
        <Field
          label="Git email"
          icon="alternate_email"
          type="email"
          mono
          required
          placeholder="jane@company.com"
          value={draft.gitEmail}
          onChange={set('gitEmail')}
          onBlur={blur('gitEmail')}
          error={shown.gitEmail}
        />
        <Field
          label="GitHub username"
          icon="account_tree"
          mono
          required
          placeholder="jane-company"
          value={draft.githubUsername}
          onChange={set('githubUsername')}
          onBlur={blur('githubUsername')}
          error={shown.githubUsername}
          note={missingHighlight('githubUsername')}
          highlight={highlightMissing && !draft.githubUsername.trim()}
          autoCapitalize="off"
          spellCheck={false}
        />
        <Field
          label="SSH profile"
          icon="key"
          mono
          required
          placeholder="github-work"
          value={draft.sshProfile}
          onChange={set('sshProfile')}
          onBlur={blur('sshProfile')}
          error={shown.sshProfile}
          note={missingHighlight('sshProfile')}
          highlight={highlightMissing && !draft.sshProfile.trim()}
          autoCapitalize="off"
          spellCheck={false}
        />

        <div className="-mt-1">
          <button
            type="button"
            aria-expanded={sshHelpOpen}
            onClick={() => setSshHelpOpen((o) => !o)}
            className="inline-flex items-center gap-1 font-body-sm text-body-sm text-primary hover:underline underline-offset-2"
          >
            <Icon name="help_outline" size={14} />
            What is an SSH profile?
            <Icon name="expand_more" size={14} className={`transition-transform ${sshHelpOpen ? 'rotate-180' : ''}`} />
          </button>
          {sshHelpOpen && (
            <p className="mt-1.5 rounded-lg bg-surface-container-low border border-outline-variant/40 px-2.5 py-2 font-body-sm text-body-sm text-on-surface-variant">
              An SSH profile is the Host name in your <span className="font-code-sm text-code-sm text-on-surface">~/.ssh/config</span>{' '}
              used for this GitHub account, for example{' '}
              <span className="font-code-sm text-code-sm text-on-surface">github-work</span>.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {isEdit ? (
            <Button variant="ghost" icon="delete" className="text-error" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={nav.pop}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon="check">
              Save
            </Button>
          </div>
        </div>
      </form>

      {isEdit && existing && deleteOpen && (
        <DeleteIdentityDialog
          identity={existing}
          repoName={repoName}
          assigned={assignedIdentity?.id === existing.id}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => nav.pop()}
        />
      )}
    </Screen>
  );
}
