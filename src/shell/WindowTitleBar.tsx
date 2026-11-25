import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BrandMark } from "../brand/BrandMark";

// The native title bar is off (decorations: false), so this row draws the brand, the location text and the window buttons.
// Close goes through window.close(), which fires close-requested; App's guard still asks before unsaved or running work is lost.
export function WindowTitleBar({ breadcrumb }: { breadcrumb: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const stop = await appWindow.onResized(() => {
          void appWindow.isMaximized().then((value) => {
            if (!cancelled) setMaximized(value);
          });
        });
        if (cancelled) stop();
        else unlisten = stop;
        const current = await appWindow.isMaximized();
        if (!cancelled) setMaximized(current);
      } catch {
        // Without the state listener the maximize icon keeps its last value; the buttons still work.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const runWindowAction = (action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
    if (!isTauri()) return;
    action(getCurrentWindow()).catch((reason: unknown) => console.error("Window action failed", reason));
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <BrandMark className="brand-logo" />
        <span className="brand-name" data-tauri-drag-region>yerminal</span>
      </div>
      <span className="titlebar-breadcrumb" data-tauri-drag-region>{breadcrumb}</span>
      <div className="window-controls">
        <button className="window-control" type="button" aria-label="Minimize window" title="Minimize" onClick={() => runWindowAction((appWindow) => appWindow.minimize())}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M3 8h10" /></svg>
        </button>
        <button className="window-control" type="button" aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => runWindowAction((appWindow) => appWindow.toggleMaximize())}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.2">
            {maximized
              ? <><path d="M5.5 3.5h7v7" /><rect x="3.5" y="5.5" width="7" height="7" /></>
              : <rect x="3.5" y="3.5" width="9" height="9" />}
          </svg>
        </button>
        <button className="window-control window-control-close" type="button" aria-label="Close window" title="Close" onClick={() => runWindowAction((appWindow) => appWindow.close())}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    </header>
  );
}
