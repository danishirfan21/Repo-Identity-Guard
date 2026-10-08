import { useRef, useState, type PointerEvent } from 'react';
import { DevPanel } from './dev/DevPanel';
import { Sidebar } from './Sidebar';
import { AppProvider } from './state/AppState';

const MIN_W = 240;
const MAX_W = 420;
const clamp = (w: number) => Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));

/** Decorative VS Code activity bar so the frame reads as a sidebar. */
function ActivityBar() {
  const items = ['description', 'search', 'commit', 'verified_user'];
  return (
    <div className="w-12 shrink-0 bg-[#18181f] border-r border-black/40 flex flex-col items-center pt-2 gap-1">
      {items.map((icon) => {
        const active = icon === 'verified_user';
        return (
          <span
            key={icon}
            className={`relative h-10 w-12 flex items-center justify-center ${active ? 'text-on-surface' : 'text-outline/50'}`}
            title={active ? 'Repo Identity Guard' : undefined}
          >
            {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-on-surface" />}
            <span className="material-symbols-outlined" style={{ fontSize: 22 }} aria-hidden="true">
              {icon}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export default function App() {
  const [width, setWidth] = useState(320);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startW: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(clamp(drag.current.startW + e.clientX - drag.current.startX));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <AppProvider>
      <div className="min-h-full flex flex-wrap items-start justify-center gap-8 p-6">
        <div className="flex flex-col items-start gap-2 max-w-full">
          <div className="text-[11px] text-zinc-500 font-mono">Simulated VS Code sidebar · {width}px · drag the right edge</div>
          <div
            className="flex rounded-md border border-zinc-700 shadow-2xl shadow-black/60 overflow-hidden max-w-full"
            style={{ height: 'min(760px, calc(100vh - 80px))', minHeight: 480 }}
          >
            <ActivityBar />
            <div className="relative shrink-0" style={{ width }}>
              <Sidebar />
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-primary-container/60 active:bg-primary-container z-50"
              />
            </div>
          </div>
        </div>
        <DevPanel width={width} onWidthChange={(w) => setWidth(clamp(w))} />
      </div>
    </AppProvider>
  );
}
