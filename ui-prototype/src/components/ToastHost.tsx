import { useEffect } from 'react';
import { useApp } from '../state/AppState';
import { Icon } from './Icon';

/** Bottom-anchored transient feedback inside the simulated sidebar. */
export function ToastHost() {
  const { toast, dismissToast } = useApp();

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(dismissToast, toast.action ? 5000 : 2600);
    return () => window.clearTimeout(t);
  }, [toast, dismissToast]);

  if (!toast) return null;
  const success = toast.tone !== 'info';

  return (
    <div className="absolute left-2 right-2 bottom-2 z-40" role="status" aria-live="polite">
      <div
        key={toast.id}
        className="flex items-center gap-2 min-h-9 pl-2.5 pr-1 py-1.5 rounded-lg bg-surface-container-highest border border-outline-variant shadow-xl shadow-black/50 animate-[rig-toast-in_160ms_ease-out]"
      >
        <Icon
          name={toast.icon ?? (success ? 'check_circle' : 'info')}
          size={16}
          filled={success}
          className={success ? 'text-secondary' : 'text-on-surface-variant'}
        />
        <span className="flex-1 min-w-0 font-body-sm text-body-sm text-on-surface">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action!.run();
              dismissToast();
            }}
            className="h-6 px-2 rounded-lg font-label-sm text-label-sm text-primary hover:bg-surface-bright"
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismissToast}
          className="h-6 w-6 inline-flex items-center justify-center rounded-lg text-outline hover:text-on-surface hover:bg-surface-bright"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
