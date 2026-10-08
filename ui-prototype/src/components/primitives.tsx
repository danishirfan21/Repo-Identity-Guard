import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: string;
  loading?: boolean;
  block?: boolean;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-primary-container text-on-primary-container hover:brightness-110 disabled:hover:brightness-100',
  secondary: 'bg-surface-container-high text-on-surface border border-outline-variant hover:bg-surface-container-highest',
  ghost: 'text-primary hover:bg-surface-container-high',
  danger: 'bg-error-container text-on-error-container hover:brightness-110',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  block = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[filter,background-color] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:opacity-50 disabled:cursor-not-allowed ${
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]'
      } ${block ? 'w-full' : ''} ${variantClass[variant]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Icon name="progress_activity" size={16} className="animate-spin" />
      ) : (
        icon && <Icon name={icon} size={16} />
      )}
      {children}
    </button>
  );
}

/** Tiny icon + label action used on note cards ("Copy", "Edit"). */
export function InlineAction({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 h-7 px-1.5 rounded-lg font-label-sm text-label-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primary"
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}

/** Text-only link-style button ("Manage identities"). */
export function LinkButton({ children, onClick, icon }: { children: ReactNode; onClick: () => void; icon?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 font-body-sm text-body-sm text-primary hover:underline underline-offset-2 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primary"
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl bg-surface-container border border-outline-variant/40 p-space-md ${className}`}>
      {children}
    </section>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-0.5 -mb-1">
      <h2 className="font-label-sm text-label-sm uppercase tracking-wider text-outline">{children}</h2>
      {action}
    </div>
  );
}

/** Square icon tile used at the start of cards and nav rows. */
export function IconTile({ icon, tone = 'neutral' }: { icon: string; tone?: Tone }) {
  return (
    <span className={`h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg ${toneTile[tone]}`}>
      <Icon name={icon} size={18} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

const toneTile: Record<Tone, string> = {
  success: 'bg-secondary/10 text-secondary',
  warning: 'bg-tertiary/10 text-tertiary',
  error: 'bg-error/10 text-error',
  neutral: 'bg-surface-container-highest text-on-surface-variant',
  info: 'bg-primary/10 text-primary',
};

const toneBadge: Record<Tone, { pill: string; dot: string }> = {
  success: { pill: 'bg-secondary/10 text-secondary border-secondary/20', dot: 'bg-secondary' },
  warning: { pill: 'bg-tertiary/10 text-tertiary border-tertiary/25', dot: 'bg-tertiary' },
  error: { pill: 'bg-error/10 text-error border-error/25', dot: 'bg-error' },
  neutral: { pill: 'bg-surface-container-highest text-on-surface-variant border-outline-variant', dot: 'bg-outline' },
  info: { pill: 'bg-primary/10 text-primary border-primary/20', dot: 'bg-primary' },
};

export const toneDot = (tone: Tone) => toneBadge[tone].dot;

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const t = toneBadge[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-5 px-2 rounded-full border whitespace-nowrap font-label-sm text-label-sm ${t.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Groups rows inside one card with hairline separators. */
export function ListGroup({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-container border border-outline-variant/40 overflow-hidden divide-y divide-outline-variant/40">
      {children}
    </div>
  );
}

interface NavRowProps {
  icon: string;
  label: string;
  subtitle?: ReactNode;
  onClick: () => void;
  tone?: Tone;
  /** Hide the chevron for rows that act rather than navigate. */
  chevron?: boolean;
  quiet?: boolean;
  large?: boolean;
}

/** Label + chevron_right row for drill-down navigation. */
export function NavRow({ icon, label, subtitle, onClick, tone = 'neutral', chevron = true, quiet = false, large = false }: NavRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-space-md text-left hover:bg-surface-container-high transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primary ${
        large ? 'py-2.5' : 'py-2'
      }`}
    >
      {large ? (
        <IconTile icon={icon} tone={tone} />
      ) : (
        <Icon name={icon} size={18} className={quiet ? 'text-outline' : 'text-on-surface-variant'} />
      )}
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${large ? 'font-title-md text-title-md' : 'font-body-md text-body-md'} ${quiet ? 'text-on-surface-variant' : 'text-on-surface'}`}>
          {label}
        </span>
        {subtitle && <span className="block truncate font-body-sm text-body-sm text-on-surface-variant">{subtitle}</span>}
      </span>
      {chevron && <Icon name="chevron_right" size={18} className="text-outline" />}
    </button>
  );
}

/** Dashed "+ Add …" row. */
export function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full h-9 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-outline-variant text-on-surface-variant font-body-md text-body-md hover:bg-surface-container hover:text-on-surface hover:border-outline"
    >
      <Icon name="add" size={16} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Key/value + details
// ---------------------------------------------------------------------------

interface KeyValueListProps {
  rows: { k: string; v: ReactNode; mono?: boolean }[];
  /** Stack label above value — for sentence-length values. */
  stacked?: boolean;
  className?: string;
}

export function KeyValueList({ rows, stacked = false, className = '' }: KeyValueListProps) {
  return (
    <dl className={`rounded-lg bg-surface-container-lowest border border-outline-variant/30 px-2.5 py-1.5 ${className}`}>
      {rows.map((r) => (
        <div
          key={r.k}
          className={stacked ? 'flex flex-col gap-0.5 py-1' : 'flex items-baseline justify-between gap-3 py-1'}
        >
          <dt className="shrink-0 font-label-sm text-label-sm text-outline">{r.k}</dt>
          <dd
            className={`min-w-0 break-words text-on-surface ${stacked ? '' : 'text-right'} ${
              r.mono ? 'font-code-sm text-code-sm' : 'font-body-sm text-body-sm'
            }`}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Collapsed-by-default "Details" drawer. */
export function Collapsible({ label = 'Details', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full h-8 flex items-center gap-1.5 px-2.5 font-body-sm text-body-sm text-on-surface-variant hover:text-on-surface"
      >
        <Icon name="info" size={16} />
        <span className="flex-1 text-left">{label}</span>
        <Icon name="expand_more" size={18} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-2.5 pb-2.5 flex flex-col gap-2">{children}</div>}
    </div>
  );
}
