import type { TerminalDockEdge, TerminalLayoutMode } from "./floatingTerminalLayout";
import "./floating-terminal-canvas.css";

export function FloatingTerminalModeToggle({ mode, onChange }: { mode: TerminalLayoutMode; onChange: (mode: TerminalLayoutMode) => void }) {
  return <div className="layout-mode-toggle floating-terminal-mode-toggle" role="group" aria-label="Terminal layout mode">
    <button type="button" aria-pressed={mode === "tiled"} onClick={() => onChange("tiled")} title="Use the default split layout">Split</button>
    <button type="button" aria-pressed={mode === "floating"} onClick={() => onChange("floating")} title="Move terminals freely around the canvas">Free</button>
  </div>;
}

export function FloatingTerminalDockGuides({ activeEdge }: { activeEdge: TerminalDockEdge | null }) {
  if (!activeEdge) return null;
  return <div className="floating-terminal-dock-guides" aria-hidden="true">
    <div className={`floating-terminal-dock-guide left${activeEdge === "left" ? " active" : ""}`} />
    <div className={`floating-terminal-dock-guide right${activeEdge === "right" ? " active" : ""}`} />
    <div className={`floating-terminal-dock-guide top${activeEdge === "top" ? " active" : ""}`} />
    <div className={`floating-terminal-dock-guide bottom${activeEdge === "bottom" ? " active" : ""}`} />
  </div>;
}
