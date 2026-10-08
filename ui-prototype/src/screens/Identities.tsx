import { useEffect, useState, type FormEvent } from 'react';
import { Field } from '../components/Field';
import { Header } from '../components/Header';
import { Icon } from '../components/Icon';
import { IdentityCard } from '../components/IdentityCard';
import { AddRow, Button, SectionLabel } from '../components/primitives';
import { Screen } from '../components/Screen';
import { useApp } from '../state/AppState';
import type { Identity } from '../state/types';

/** Global identity list. Not repo-scoped, so the header carries no repo name. */
export function ManageIdentitiesScreen() {
  const { identities, nav } = useApp();
  return (
    <Screen
      header={<Header title="Identities" onBack={nav.pop} />}
      footer="Identities are shared by every repository on this machine."
    >
      <SectionLabel>Configured identities</SectionLabel>
      <div className="flex flex-col gap-2">
        {identities.map((identity) => (
          <IdentityCard
            key={identity.id}
            identity={identity}
            showGitName
            onClick={() => nav.push({ name: 'editIdentity', identityId: identity.id })}
          />
        ))}
        <AddRow label="Add identity" onClick={() => nav.push({ name: 'addIdentity' })} />
      </div>
    </Screen>
  );
}

type Draft = Omit<Identity, 'id'>;

const emptyDraft: Draft = { label: '', gitName: '', gitEmail: '', githubUsername: '', sshProfile: '' };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'identity';

/** Add Identity (no identityId) and Edit Identity share one form. */
export function IdentityFormScreen({ identityId }: { identityId?: string }) {
  const { identities, actions, nav, showToast } = useApp();
  const existing = identityId ? identities.find((i) => i.id === identityId) : undefined;
  const isEdit = !!identityId;

  const [draft, setDraft] = useState<Draft>(() => (existing ? { ...existing } : emptyDraft));
  const [submitted, setSubmitted] = useState(false);
  const [sshHelpOpen, setSshHelpOpen] = useState(false);

  useEffect(() => {
    if (isEdit && !existing) nav.pop();
  }, [isEdit, existing, nav]);

  const set = (key: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!draft.label.trim()) errors.label = 'Give this identity a name.';
  if (!draft.gitEmail.trim()) errors.gitEmail = 'Git email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.gitEmail.trim())) errors.gitEmail = 'Enter a valid email address.';
  const shown = submitted ? errors : {};

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

  return (
    <Screen
      header={<Header title={isEdit ? 'Edit identity' : 'Add identity'} subtitle={existing?.label} onBack={nav.pop} />}
    >
      <form className="flex flex-col gap-space-md" onSubmit={save} noValidate>
        <Field
          label="Name"
          icon="badge"
          placeholder="Work"
          value={draft.label}
          onChange={set('label')}
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
          placeholder="jane@company.com"
          value={draft.gitEmail}
          onChange={set('gitEmail')}
          error={shown.gitEmail}
        />
        <Field
          label="GitHub username"
          icon="account_tree"
          mono
          placeholder="jane-company"
          value={draft.githubUsername}
          onChange={set('githubUsername')}
          autoCapitalize="off"
          spellCheck={false}
        />
        <Field
          label="SSH profile"
          icon="key"
          mono
          placeholder="github-work"
          value={draft.sshProfile}
          onChange={set('sshProfile')}
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

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={nav.pop}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="check">
            Save
          </Button>
        </div>
      </form>
    </Screen>
  );
}
