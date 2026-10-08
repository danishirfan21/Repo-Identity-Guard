import type { ReactNode } from 'react';
import type { Identity } from '../state/types';
import { Icon } from './Icon';

export function IdentityAvatar({ identity, size = 32 }: { identity: Pick<Identity, 'label'>; size?: number }) {
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center rounded-full bg-surface-container-highest text-primary font-title-md text-title-md"
      style={{ width: size, height: size }}
    >
      {identity.label.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

interface IdentityCardProps {
  identity: Identity;
  onClick?: () => void;
  /** Show the git name line (Manage Identities / confirmation summary). */
  showGitName?: boolean;
  trailing?: ReactNode;
  compact?: boolean;
}

/** Identity summary card: label, git email, "GitHub · username". */
export function IdentityCard({ identity, onClick, showGitName = false, trailing, compact = false }: IdentityCardProps) {
  const body = (
    <>
      <IdentityAvatar identity={identity} size={compact ? 26 : 32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-title-md text-title-md text-on-surface" title={identity.label}>
          {identity.label}
        </span>
        {showGitName && (
          <span className="block truncate font-body-sm text-body-sm text-on-surface-variant" title={identity.gitName}>
            {identity.gitName}
          </span>
        )}
        <span className="block truncate font-code-sm text-code-sm text-on-surface-variant" title={identity.gitEmail}>
          {identity.gitEmail}
        </span>
        {!compact && (
          <span className="block truncate font-label-sm text-label-sm text-outline" title={`GitHub · ${identity.githubUsername || 'not set'}`}>
            GitHub · {identity.githubUsername || 'not set'}
          </span>
        )}
      </span>
      {trailing ?? (onClick && <Icon name="chevron_right" size={18} className="text-outline" />)}
    </>
  );

  const cls = `w-full flex items-center gap-2.5 text-left rounded-xl border border-outline-variant/40 ${
    compact ? 'px-2.5 py-2 bg-surface-container-low' : 'p-space-md bg-surface-container'
  }`;

  if (!onClick) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${cls} hover:bg-surface-container-high hover:border-outline-variant transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary`}
    >
      {body}
    </button>
  );
}
