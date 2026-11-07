import { useCallback, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import "./workspace-view-layout.css";

export type WorkspacePanelPreferences = {
  terminalPanel: "separate" | "bottom";
  terminalPanelHeight: number;
};

const STORAGE_KEY = "yerminal.workspace-panel-preferences.v1";
const DEFAULTS: WorkspacePanelPreferences = { terminalPanel: "bottom", terminalPanelHeight: 32 };
const clampHeight = (height: number) => Math.max(18, Math.min(65, height));

function readPreferences(): Record<string, WorkspacePanelPreferences> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<WorkspacePanelPreferences>;
      return [[key, {
        terminalPanel: candidate.terminalPanel === "separate" ? "separate" : "bottom",
        terminalPanelHeight: typeof candidate.terminalPanelHeight === "number" && Number.isFinite(candidate.terminalPanelHeight)
          ? clampHeight(candidate.terminalPanelHeight) : DEFAULTS.terminalPanelHeight,
      }]];
    }));
  } catch {
    return {};
  }
}

export function useWorkspacePanelPreferences(workspaceId: string) {
  const [allPreferences, setAllPreferences] = useState(readPreferences);
  const preferences = allPreferences[workspaceId] ?? DEFAULTS;
  const updatePreferences = useCallback((change: Partial<WorkspacePanelPreferences>) => {
    if (!workspaceId) return;
    setAllPreferences((current) => {
      const previous = current[workspaceId] ?? DEFAULTS;
      const next = { ...current, [workspaceId]: {
        terminalPanel: change.terminalPanel ?? previous.terminalPanel,
        terminalPanelHeight: clampHeight(change.terminalPanelHeight ?? previous.terminalPanelHeight),
      } };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Retain settings in memory. */ }
      return next;
    });
  }, [workspaceId]);
  return { preferences, updatePreferences };
}

type Props = {
  activeView: "code" | "terminals";
  preferences: WorkspacePanelPreferences;
  onHeightChange: (height: number) => void;
  code: ReactNode;
  terminal: ReactNode;
};

export function WorkspaceViewLayout({ activeView, preferences, onHeightChange, code, terminal }: Props) {
  const integrated = activeView === "code" && preferences.terminalPanel === "bottom";
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (bounds && bounds.height > 0) onHeightChange(clampHeight((bounds.bottom - event.clientY) / bounds.height * 100));
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onHeightChange(clampHeight(preferences.terminalPanelHeight + (event.key === "ArrowUp" ? 2 : -2)));
  };
  return <div className="workspace-view-layout">
    <div className="workspace-view-code" hidden={activeView !== "code"}>{code}</div>
    {integrated && <div className="workspace-view-resize" role="separator" aria-label="Resize terminal panel" aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={65} aria-valuenow={Math.round(preferences.terminalPanelHeight)} tabIndex={0} onPointerDown={(event) => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={resize} onKeyDown={resizeWithKeyboard} />}
    <div className="workspace-view-terminal" hidden={activeView === "code" && !integrated} style={integrated ? { flex: `0 0 ${preferences.terminalPanelHeight}%` } : undefined}>{terminal}</div>
  </div>;
}
