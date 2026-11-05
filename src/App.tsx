import { useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import "./styles/app.css";

type ToolId = "changes" | "graph";
type Terminal = { id: number; name: string; shell: string };

const tools: { id: ToolId; label: string; icon: string }[] = [
  { id: "changes", label: "Git Changes", icon: "◫" },
  { id: "graph", label: "Git Graph", icon: "⌘" },
];

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("changes");
  const [terminals, setTerminals] = useState<Terminal[]>([{ id: 1, name: "PowerShell", shell: "powershell" }]);
  const [activeTerminalId, setActiveTerminalId] = useState(1);
  const [nextId, setNextId] = useState(2);
  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0],
    [activeTerminalId, terminals],
  );

  function createTerminal() {
    const terminal = { id: nextId, name: `Terminal ${nextId}`, shell: "powershell" };
    setTerminals((current) => [...current, terminal]);
    setActiveTerminalId(nextId);
    setNextId((current) => current + 1);
  }

  function closeTerminal(id: number) {
    setTerminals((current) => {
      const next = current.filter((terminal) => terminal.id !== id);
      if (next.length === 0) {
        const replacement = { id: nextId, name: `Terminal ${nextId}`, shell: "powershell" };
        setNextId((value) => value + 1);
        setActiveTerminalId(replacement.id);
        return [replacement];
      }
      if (activeTerminalId === id) setActiveTerminalId(next[0].id);
      return next;
    });
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand-mark">y</div>
        <span className="brand-name">yerminal</span>
        <span className="title-divider" />
        <button className="repo-select" type="button"><span className="repo-glyph">⌂</span> Open a folder <span className="chevron">⌄</span></button>
        <div className="titlebar-spacer" />
        <span className="window-caption">Agent Workspace</span>
        <button className="icon-button window-control" aria-label="Minimize" type="button">−</button>
        <button className="icon-button window-control" aria-label="Maximize" type="button">□</button>
        <button className="icon-button window-control close-control" aria-label="Close" type="button">×</button>
      </header>

      <PanelGroup direction="horizontal" className="workspace">
        <Panel defaultSize={27} minSize={18} maxSize={46} className="tools-panel">
          <section className="tool-content">
            {activeTool === "changes" ? <GitChanges /> : <GitGraph />}
          </section>
          <nav className="tool-tabs" aria-label="Developer tools">
            {tools.map((tool) => (
              <button key={tool.id} className={`tool-tab ${activeTool === tool.id ? "selected" : ""}`} onClick={() => setActiveTool(tool.id)} type="button">
                <span className="tool-icon">{tool.icon}</span>{tool.label}
              </button>
            ))}
            <button className="tool-tab add-tool" aria-label="Add tool" type="button">＋</button>
          </nav>
        </Panel>
        <PanelResizeHandle className="resize-handle" aria-label="Resize developer tools" />
        <Panel minSize={35} className="terminal-panel">
          <div className="terminal-toolbar">
            <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
              {terminals.map((terminal) => (
                <button key={terminal.id} className={`terminal-tab ${terminal.id === activeTerminalId ? "selected" : ""}`} onClick={() => setActiveTerminalId(terminal.id)} type="button" role="tab" aria-selected={terminal.id === activeTerminalId}>
                  <span className="terminal-dot" />{terminal.name}
                  {terminals.length > 1 && <span className="tab-close" role="button" aria-label={`Close ${terminal.name}`} onClick={(event) => { event.stopPropagation(); closeTerminal(terminal.id); }}>×</span>}
                </button>
              ))}
              <button className="icon-button new-terminal" aria-label="New terminal" onClick={createTerminal} type="button">＋</button>
            </div>
            <div className="toolbar-actions">
              <button className="toolbar-button" type="button" aria-label="Split horizontally" title="Split horizontally">▤</button>
              <button className="toolbar-button" type="button" aria-label="Split vertically" title="Split vertically">▥</button>
              <span className="toolbar-divider" />
              <button className="toolbar-button" type="button" aria-label="Terminal options">···</button>
            </div>
          </div>
          <section className="terminal-surface" aria-label="Terminal workspace">
            <div className="terminal-placeholder">
              <div className="shell-prompt"><span className="prompt-user">yusuf</span><span className="prompt-separator">@</span><span className="prompt-host">workspace</span><span className="prompt-path"> ~</span></div>
              <div className="welcome-title">Welcome to <span>yerminal</span></div>
              <p>Your terminal workspace is ready.</p>
              <div className="shell-line"><span className="prompt-symbol">›</span><span className="shell-name">{activeTerminal?.shell ?? "powershell"}</span><span className="cursor" /></div>
            </div>
            <div className="terminal-status"><span className="status-indicator" />{activeTerminal?.shell ?? "powershell"}<span className="status-separator">·</span>Ready</div>
          </section>
          <footer className="statusbar"><span><span className="status-indicator" />No folder opened</span><span>UTF-8</span><span>Windows</span></footer>
        </Panel>
      </PanelGroup>
    </main>
  );
}

function GitChanges() {
  return (
    <div className="tool-view">
      <header className="tool-header"><div><h1>Git Changes</h1><p>Review your working tree</p></div><button className="icon-button refresh-button" aria-label="Refresh changes" type="button">↻</button></header>
      <div className="empty-repository">
        <div className="empty-icon">⌂</div>
        <h2>No repository opened</h2>
        <p>Open a folder to view its changes.</p>
        <button className="primary-button" type="button">Open Folder</button>
      </div>
      <div className="panel-footnote"><span className="read-only-mark">◉</span> Read-only Git tools</div>
    </div>
  );
}

function GitGraph() {
  return (
    <div className="tool-view">
      <header className="tool-header"><div><h1>Git Graph</h1><p>Repository commit history</p></div><button className="icon-button refresh-button" aria-label="Refresh history" type="button">↻</button></header>
      <div className="empty-repository graph-empty"><div className="graph-preview"><span /><span /><span /></div><h2>History unavailable</h2><p>Open a Git repository to browse its commit graph.</p></div>
      <div className="panel-footnote"><span className="read-only-mark">◉</span> Incremental history loading</div>
    </div>
  );
}

export default App;
