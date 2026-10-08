import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

interface IconButtonProps {
  icon: string;
  label: string;
  onClick?: () => void;
  active?: boolean;
}

export function IconButton({ icon, label, onClick, active = false }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary ${
        active
          ? 'bg-surface-container-highest text-on-surface'
          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
      }`}
    >
      <Icon name={icon} />
    </button>
  );
}

export interface MenuItem {
  label: string;
  icon: string;
  onSelect: () => void;
  danger?: boolean;
}

/** "more_horiz" button with a small dropdown, used in headers and on note cards. */
export function OverflowMenu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <IconButton icon="more_horiz" label={label} active={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-30 min-w-[168px] py-1 rounded-lg bg-surface-container-highest border border-outline-variant shadow-xl shadow-black/40"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`w-full flex items-center gap-2 px-2.5 h-7 text-left font-body-sm text-body-sm hover:bg-surface-bright ${
                item.danger ? 'text-error' : 'text-on-surface'
              }`}
            >
              <Icon name={item.icon} size={16} className={item.danger ? 'text-error' : 'text-on-surface-variant'} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface HeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: ReactNode;
}

/** Fixed top bar: back + title/subtitle on the left, optional actions on the right. */
export function Header({ title, subtitle, onBack, actions }: HeaderProps) {
  return (
    <header className="h-12 shrink-0 flex items-center gap-1 px-1.5 border-b border-outline-variant/50 bg-surface-container-low">
      {onBack ? <IconButton icon="arrow_back" label="Back" onClick={onBack} /> : <span className="w-1" />}
      <div className="min-w-0 flex-1 px-1">
        <h1 className="font-headline-sm text-headline-sm text-on-surface truncate">{title}</h1>
        {subtitle && <p className="font-label-sm text-label-sm text-on-surface-variant truncate">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </header>
  );
}
