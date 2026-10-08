import type { ReactNode } from 'react';

interface ScreenProps {
  header: ReactNode;
  children: ReactNode;
  /** Optional quiet footer pinned below the scrolling body. */
  footer?: ReactNode;
}

/** A full sidebar screen: fixed header, vertically scrolling body, optional footer. */
export function Screen({ header, children, footer }: ScreenProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      <main className="rig-scroll flex-1 min-h-0 overflow-y-auto px-margin py-space-md">
        <div className="flex flex-col gap-space-md pb-14">{children}</div>
      </main>
      {footer && (
        <footer className="shrink-0 px-margin py-2 border-t border-outline-variant/40 font-label-sm text-label-sm text-outline">
          {footer}
        </footer>
      )}
    </div>
  );
}
