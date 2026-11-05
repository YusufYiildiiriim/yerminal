import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import "./styles/app.css";

const TerminalPane = lazy(() => import("./features/terminal/TerminalPane"));

type ToolId = "changes" | "graph";
type ShellKind = "powershell" | "bash" | "zsh";
type TerminalSession = { id: string; name: string; shell: ShellKind; shellLabel: string };
type LayoutNode = { type: "terminal"; sessionId: string } | { type: "split"; id: string; direction: "horizontal" | "vertical"; children: [LayoutNode, LayoutNode] };

const tools: { id: ToolId; label: string; icon: string }[] = [
  { id: "changes", label: "Git Changes", icon: "◫" },
  { id: "graph", label: "Git Graph", icon: "⌘" },
];

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("changes");
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const createTerminal = useCallback(async (showInTabs = true): Promise<TerminalSession | null> => {
    setError(null);
    if (!isTauri()) {
      setError("Install Rust/Cargo and launch the desktop app with npm run tauri dev.");
      return null;
    }
    try {
      const shell: ShellKind = navigator.userAgent.includes("Windows") ? "powershell" : "bash";
      const id = crypto.randomUUID();
      const terminal: TerminalSession = {
        id,
        name: terminals.length === 0 ? (shell === "powershell" ? "PowerShell" : shell) : `Terminal ${terminals.length + 1}`,
        shell,
        shellLabel: shell === "powershell" ? "PowerShell" : shell,
      };
      setTerminals((current) => [...current, terminal]);
      setActiveTerminalId(id);
      if (showInTabs) setLayout(null);
      return terminal;
    } catch (reason) {
      setError(String(reason));
      return null;
    }
  }, [terminals.length]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (terminals.length === 0 && !error) void createTerminal();
  }, [createTerminal, error, terminals.length]);

  const closeTerminal = useCallback(async (id: string) => {
    if (isTauri()) {
      try { await invoke("close_terminal", { sessionId: id }); }
      catch (reason) { setError(String(reason)); }
    }
    const next = terminals.filter((terminal) => terminal.id !== id);
    setTerminals(next);
    if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? null);
    setLayout((current) => current ? removeTerminal(current, id) : null);
  }, [activeTerminalId, terminals]);

  const handleTerminalExit = useCallback((id: string) => {
    setTerminals((current) => current.map((terminal) => terminal.id === id ? { ...terminal, shellLabel: `${terminal.shellLabel} · exited` } : terminal));
  }, []);

  const focusTerminal = useCallback((id: string) => setActiveTerminalId(id), []);

  const splitActiveTerminal = useCallback(async (direction: "horizontal" | "vertical") => {
    if (!activeTerminalId) return;
    const created = await createTerminal(false);
    if (!created) return;
    setLayout((current) => {
      const root = current ?? { type: "terminal" as const, sessionId: activeTerminalId };
      return splitTerminal(root, activeTerminalId, created.id, direction);
    });
  }, [activeTerminalId, createTerminal]);

  const renameTerminal = useCallback((terminal: TerminalSession) => {
    const name = window.prompt("Terminal name", terminal.name)?.trim();
    if (!name) return;
    setTerminals((current) => current.map((item) => item.id === terminal.id ? { ...item, name } : item));
  }, []);

  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.id === activeTerminalId),
    [activeTerminalId, terminals],
  );

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
          <section className="tool-content">{activeTool === "changes" ? <GitChanges /> : <GitGraph />}</section>
          <nav className="tool-tabs" aria-label="Developer tools">
            {tools.map((tool) => <button key={tool.id} className={`tool-tab ${activeTool === tool.id ? "selected" : ""}`} onClick={() => setActiveTool(tool.id)} type="button"><span className="tool-icon">{tool.icon}</span>{tool.label}</button>)}
            <button className="tool-tab add-tool" aria-label="Add tool" type="button">＋</button>
          </nav>
        </Panel>
        <PanelResizeHandle className="resize-handle" aria-label="Resize developer tools" />
        <Panel minSize={35} className="terminal-panel">
          <div className="terminal-toolbar">
            <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
              {terminals.map((terminal) => <button key={terminal.id} className={`terminal-tab ${terminal.id === activeTerminalId ? "selected" : ""}`} onClick={() => setActiveTerminalId(terminal.id)} onDoubleClick={() => renameTerminal(terminal)} type="button" role="tab" aria-selected={terminal.id === activeTerminalId}><span className="terminal-dot" />{terminal.name}{terminals.length > 1 && <span className="tab-close" role="button" aria-label={`Close ${terminal.name}`} onClick={(event) => { event.stopPropagation(); void closeTerminal(terminal.id); }}>×</span>}</button>)}
              <button className="icon-button new-terminal" aria-label="New terminal" onClick={() => void createTerminal()} type="button">＋</button>
            </div>
            <div className="toolbar-actions"><button className="toolbar-button" type="button" aria-label="Split horizontally" title="Split side by side" onClick={() => void splitActiveTerminal("horizontal")} disabled={!activeTerminal}>▤</button><button className="toolbar-button" type="button" aria-label="Split vertically" title="Split top and bottom" onClick={() => void splitActiveTerminal("vertical")} disabled={!activeTerminal}>▥</button><span className="toolbar-divider" /><button className="toolbar-button" type="button" aria-label="Terminal options" disabled>···</button></div>
          </div>
          <section className="terminal-surface" aria-label="Terminal workspace">
            {layout
              ? <TerminalLayout node={layout} terminals={terminals} activeTerminalId={activeTerminalId} onFocus={focusTerminal} onExit={handleTerminalExit} />
              : terminals.map((terminal) => <Suspense key={terminal.id} fallback={<div className="terminal-placeholder">Loading terminal…</div>}><TerminalPane sessionId={terminal.id} shell={terminal.shell} active={terminal.id === activeTerminalId} visible={terminal.id === activeTerminalId} onFocus={focusTerminal} onExit={handleTerminalExit} /></Suspense>)}
            {terminals.length === 0 && <div className="terminal-placeholder"><div className="welcome-title">Welcome to <span>yerminal</span></div><p>{error ?? "Create a terminal to begin."}</p><button className="primary-button" onClick={() => void createTerminal()} type="button">New Terminal</button></div>}
            {error && terminals.length > 0 && <div className="terminal-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError(null)} type="button">×</button></div>}
            <div className="terminal-status"><span className="status-indicator" />{activeTerminal?.shellLabel ?? "No terminal"}<span className="status-separator">·</span>{activeTerminal ? "Running" : "Ready"}</div>
          </section>
          <footer className="statusbar"><span><span className="status-indicator" />No folder opened</span><span>UTF-8</span><span>Windows</span></footer>
        </Panel>
      </PanelGroup>
    </main>
  );
}

function GitChanges() {
  return <div className="tool-view"><header className="tool-header"><div><h1>Git Changes</h1><p>Review your working tree</p></div><button className="icon-button refresh-button" aria-label="Refresh changes" type="button">↻</button></header><div className="empty-repository"><div className="empty-icon">⌂</div><h2>No repository opened</h2><p>Open a folder to view its changes.</p><button className="primary-button" type="button">Open Folder</button></div><div className="panel-footnote"><span className="read-only-mark">◉</span> Read-only Git tools</div></div>;
}

function GitGraph() {
  return <div className="tool-view"><header className="tool-header"><div><h1>Git Graph</h1><p>Repository commit history</p></div><button className="icon-button refresh-button" aria-label="Refresh history" type="button">↻</button></header><div className="empty-repository graph-empty"><div className="graph-preview"><span /><span /><span /></div><h2>History unavailable</h2><p>Open a Git repository to browse its commit graph.</p></div><div className="panel-footnote"><span className="read-only-mark">◉</span> Incremental history loading</div></div>;
}

type TerminalLayoutProps = {
  node: LayoutNode;
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onFocus: (sessionId: string) => void;
  onExit: (sessionId: string) => void;
};

function TerminalLayout({ node, terminals, activeTerminalId, onFocus, onExit }: TerminalLayoutProps) {
  if (node.type === "terminal") {
    const terminal = terminals.find((item) => item.id === node.sessionId);
    if (!terminal) return null;
    return <Suspense fallback={<div className="terminal-placeholder">Loading terminal…</div>}><TerminalPane sessionId={terminal.id} shell={terminal.shell} active={terminal.id === activeTerminalId} visible onFocus={onFocus} onExit={onExit} /></Suspense>;
  }

  return (
    <PanelGroup direction={node.direction} className="terminal-split">
      <Panel defaultSize={50} minSize={15} className="terminal-split-panel"><TerminalLayout node={node.children[0]} terminals={terminals} activeTerminalId={activeTerminalId} onFocus={onFocus} onExit={onExit} /></Panel>
      <PanelResizeHandle className={node.direction === "horizontal" ? "split-handle horizontal" : "split-handle vertical"} aria-label="Resize terminal panes" />
      <Panel defaultSize={50} minSize={15} className="terminal-split-panel"><TerminalLayout node={node.children[1]} terminals={terminals} activeTerminalId={activeTerminalId} onFocus={onFocus} onExit={onExit} /></Panel>
    </PanelGroup>
  );
}

function splitTerminal(node: LayoutNode, sessionId: string, newSessionId: string, direction: "horizontal" | "vertical"): LayoutNode {
  if (node.type === "terminal") {
    if (node.sessionId !== sessionId) return node;
    return { type: "split", id: crypto.randomUUID(), direction, children: [node, { type: "terminal", sessionId: newSessionId }] };
  }
  return {
    ...node,
    children: [
      splitTerminal(node.children[0], sessionId, newSessionId, direction),
      splitTerminal(node.children[1], sessionId, newSessionId, direction),
    ],
  };
}

function removeTerminal(node: LayoutNode, sessionId: string): LayoutNode | null {
  if (node.type === "terminal") return node.sessionId === sessionId ? null : node;
  const first = removeTerminal(node.children[0], sessionId);
  const second = removeTerminal(node.children[1], sessionId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, children: [first, second] };
}

export default App;

