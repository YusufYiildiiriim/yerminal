import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { DiffViewer } from "./features/git/DiffViewer";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import "./styles/app.css";

const TerminalPane = lazy(() => import("./features/terminal/TerminalPane"));

type ToolId = "changes" | "graph";
type ShellKind = "powershell" | "bash" | "zsh";
type TerminalSession = { id: string; name: string; shell: ShellKind; shellLabel: string; profileId?: string; workingDirectory: string | null };
type AgentProfile = { id: string; name: string };
type LayoutNode = { type: "terminal"; sessionId: string } | { type: "split"; id: string; direction: "horizontal" | "vertical"; children: [LayoutNode, LayoutNode] };
type RepositoryInfo = { root: string; branch: string; state: string };
type FileChange = { path: string; kind: string; staged: boolean; unstaged: boolean };
type CommitInfo = { id: string; shortId: string; message: string; author: string; timestamp: number; parents: string[]; branches: string[] };

function changeDirectoryCommand(shell: ShellKind, path: string): string {
  if (shell === "powershell") {
    const escapedPath = path.replace(/'/g, "''");
    return `Set-Location -LiteralPath '${escapedPath}'\r`;
  }
  const escapedPath = path.replace(/'/g, "'\\''");
  return `cd -- '${escapedPath}'\n`;
}

const tools: { id: ToolId; label: string; icon: string }[] = [
  { id: "changes", label: "Git Changes", icon: "◫" },
  { id: "graph", label: "Git Graph", icon: "⌘" },
];

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("changes");
  const [repoPath, setRepoPath] = useState("");
  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
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
        workingDirectory: repoPath || null,
      };
      setTerminals((current) => [...current, terminal]);
      setActiveTerminalId(id);
      if (showInTabs) setLayout(null);
      return terminal;
    } catch (reason) {
      setError(String(reason));
      return null;
    }
  }, [repoPath, terminals.length]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (terminals.length === 0 && !error) void createTerminal();
  }, [createTerminal, error, terminals.length]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<AgentProfile[]>("list_agent_profiles").then(setAgentProfiles).catch((reason: unknown) => setError(String(reason)));
  }, []);

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

  const addTerminalToWorkspace = useCallback(async () => {
    if (!activeTerminalId) {
      await createTerminal();
      return;
    }
    await splitActiveTerminal("horizontal");
  }, [activeTerminalId, createTerminal, splitActiveTerminal]);

  const createAgentTerminal = useCallback((profile: AgentProfile) => {
    const id = crypto.randomUUID();
    const terminal: TerminalSession = {
      id,
      name: profile.name,
      shell: navigator.userAgent.includes("Windows") ? "powershell" : "bash",
      shellLabel: profile.name,
      profileId: profile.id,
      workingDirectory: repoPath || null,
    };
    setTerminals((current) => [...current, terminal]);
    setActiveTerminalId(id);
    setLayout(null);
    setError(null);
  }, [repoPath]);

  const renameTerminal = useCallback((terminal: TerminalSession) => {
    const name = window.prompt("Terminal name", terminal.name)?.trim();
    if (!name) return;
    setTerminals((current) => current.map((item) => item.id === terminal.id ? { ...item, name } : item));
  }, []);

  const openRepository = useCallback(async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: "Open Working Tree",
      defaultPath: repoPath || undefined,
    });
    if (typeof selection !== "string") return;
    const path = selection;
    try {
      const info = await invoke<RepositoryInfo>("git_repository_info", { path });
      setRepoPath(path);
      setRepoInfo(info);
      setError(null);
      if (isTauri()) {
        const results = await Promise.allSettled(terminals.map((terminal) =>
          invoke("write_terminal", {
            sessionId: terminal.id,
            data: changeDirectoryCommand(terminal.shell, path),
          }),
        ));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") setError(`Could not change terminal working directory: ${String(failed.reason)}`);
      }
    } catch (reason) {
      setRepoInfo(null);
      setError(String(reason));
    }
  }, [repoPath, terminals]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "t") { event.preventDefault(); void createTerminal(); }
      else if (event.shiftKey && key === "w" && activeTerminalId) { event.preventDefault(); void closeTerminal(activeTerminalId); }
      else if (event.shiftKey && key === "h") { event.preventDefault(); void splitActiveTerminal("horizontal"); }
      else if (event.shiftKey && key === "v") { event.preventDefault(); void splitActiveTerminal("vertical"); }
      else if (event.shiftKey && key === "g") { event.preventDefault(); setActiveTool("changes"); }
      else if (event.shiftKey && key === "b") { event.preventDefault(); setActiveTool("graph"); }
      else if (key === "tab" && terminals.length > 1) {
        event.preventDefault();
        const index = terminals.findIndex((terminal) => terminal.id === activeTerminalId);
        const direction = event.shiftKey ? -1 : 1;
        const next = (index + direction + terminals.length) % terminals.length;
        setActiveTerminalId(terminals[next].id);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeTerminalId, closeTerminal, createTerminal, splitActiveTerminal, terminals]);

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
        <button className="repo-select" type="button" onClick={() => void openRepository()}><span className="repo-glyph">⌂</span> {repoInfo ? `${repoInfo.root} · ${repoInfo.branch}` : "Open a folder"} <span className="chevron">⌄</span></button>
        <div className="titlebar-spacer" />
        <span className="window-caption">Agent Workspace</span>
      </header>

      <PanelGroup direction="horizontal" className="workspace">
        <Panel defaultSize={27} minSize={18} maxSize={46} className="tools-panel">
          <section className="tool-content">{activeTool === "changes" ? <GitChanges repoPath={repoPath} repoInfo={repoInfo} onOpenRepository={() => void openRepository()} /> : <GitGraph repoPath={repoPath} />}</section>
          <nav className="tool-tabs" aria-label="Developer tools">
            {tools.map((tool) => <button key={tool.id} className={`tool-tab ${activeTool === tool.id ? "selected" : ""}`} onClick={() => setActiveTool(tool.id)} type="button"><span className="tool-icon">{tool.icon}</span>{tool.label}</button>)}
            <button className="tool-tab add-tool" aria-label="Add tool" type="button">＋</button>
          </nav>
        </Panel>
        <PanelResizeHandle className="resize-handle" aria-label="Resize developer tools" />
        <Panel minSize={35} className="terminal-panel">
          <div className="terminal-toolbar">
            <div className="terminal-tabs" role={layout ? undefined : "tablist"} aria-label={layout ? "Terminal workspace actions" : "Terminal sessions"}>
              {!layout && terminals.map((terminal) => <button key={terminal.id} className={`terminal-tab ${terminal.id === activeTerminalId ? "selected" : ""}`} onClick={() => setActiveTerminalId(terminal.id)} onDoubleClick={() => renameTerminal(terminal)} type="button" role="tab" aria-selected={terminal.id === activeTerminalId}><span className="terminal-dot" />{terminal.name}{terminals.length > 1 && <span className="tab-close" role="button" aria-label={`Close ${terminal.name}`} onClick={(event) => { event.stopPropagation(); void closeTerminal(terminal.id); }}>×</span>}</button>)}
              <button className="icon-button new-terminal" aria-label="Add terminal to workspace" title="Add terminal pane" onClick={() => void addTerminalToWorkspace()} type="button">＋</button>
            </div>
            <div className="toolbar-actions"><button className="toolbar-button" type="button" aria-label="Split horizontally" title="Split side by side" onClick={() => void splitActiveTerminal("horizontal")} disabled={!activeTerminal}>▤</button><button className="toolbar-button" type="button" aria-label="Split vertically" title="Split top and bottom" onClick={() => void splitActiveTerminal("vertical")} disabled={!activeTerminal}>▥</button>{agentProfiles.map((profile) => <button className="agent-launch" key={profile.id} type="button" title={`Launch ${profile.name}`} onClick={() => createAgentTerminal(profile)}>{profile.id === "claude" ? "Claude" : profile.id === "codex" ? "Codex" : profile.name}</button>)}<span className="toolbar-divider" /><button className="toolbar-button" type="button" aria-label="Terminal options" disabled>···</button></div>
          </div>
          <section className="terminal-surface" aria-label="Terminal workspace">
            {layout
              ? <TerminalLayout node={layout} terminals={terminals} activeTerminalId={activeTerminalId} onFocus={focusTerminal} onExit={handleTerminalExit} />
              : terminals.map((terminal) => <Suspense key={terminal.id} fallback={<div className="terminal-placeholder">Loading terminal…</div>}><TerminalPane sessionId={terminal.id} shell={terminal.shell} profileId={terminal.profileId} workingDirectory={terminal.workingDirectory} active={terminal.id === activeTerminalId} visible={terminal.id === activeTerminalId} onFocus={focusTerminal} onExit={handleTerminalExit} /></Suspense>)}
            {terminals.length === 0 && <div className="terminal-placeholder"><div className="welcome-title">Welcome to <span>yerminal</span></div><p>{error ?? "Create a terminal to begin."}</p><button className="primary-button" onClick={() => void createTerminal()} type="button">New Terminal</button></div>}
            {error && terminals.length > 0 && <div className="terminal-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError(null)} type="button">×</button></div>}
            <div className="terminal-status"><span className="status-indicator" />{activeTerminal?.shellLabel ?? "No terminal"}<span className="status-separator">·</span>{activeTerminal ? "Running" : "Ready"}</div>
          </section>
          <footer className="statusbar"><span><span className="status-indicator" />{repoInfo ? `${repoInfo.branch} · ${repoInfo.state}` : "No folder opened"}</span><span>UTF-8</span><span>{navigator.userAgent.includes("Windows") ? "Windows" : navigator.platform}</span></footer>
        </Panel>
      </PanelGroup>
    </main>
  );
}

function GitChanges({ repoPath, repoInfo, onOpenRepository }: { repoPath: string; repoInfo: RepositoryInfo | null; onOpenRepository: () => void }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoPath || !isTauri()) return;
    try { setChanges(await invoke<FileChange[]>("git_status", { path: repoPath })); setError(null); }
    catch (reason) { setError(String(reason)); }
  }, [repoPath]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setSelected(null); setSelectedStaged(false); }, [repoPath]);
  useEffect(() => {
    if (!selected || !repoPath || !isTauri()) { setDiff(""); return; }
    void invoke<string>("git_diff", { path: repoPath, filePath: selected.path, staged: selectedStaged })
      .then(setDiff).catch((reason: unknown) => setError(String(reason)));
  }, [repoPath, selected, selectedStaged]);

  return <div className="tool-view">
    <header className="tool-header"><div><h1>Git Changes</h1><p>{repoInfo ? `${repoInfo.branch} · ${changes.length} changed` : "Review your working tree"}</p></div><button className="icon-button refresh-button" aria-label="Refresh changes" onClick={() => void refresh()} type="button">↻</button></header>
    {!repoInfo ? <div className="empty-repository"><div className="empty-icon">⌂</div><h2>No repository opened</h2><p>Open a folder to view its changes.</p><button className="primary-button" onClick={onOpenRepository} type="button">Open Folder</button></div> : <>
      {error && <div className="git-error" role="alert">{error}</div>}
      <div className="change-list">{changes.length === 0 ? <div className="change-empty">Working tree clean</div> : changes.map((change) => <button key={change.path} className={`change-row ${selected?.path === change.path ? "selected" : ""}`} onClick={() => { setSelected(change); setSelectedStaged(change.staged && !change.unstaged); }} type="button"><span className={`change-kind ${change.kind}`}>{change.kind === "modified" ? "M" : change.kind === "deleted" ? "D" : change.kind === "untracked" ? "?" : change.kind === "renamed" ? "R" : "A"}</span><span className="change-path" title={change.path}>{change.path}</span>{change.staged && <span className="change-badge">S</span>}{change.unstaged && <span className="change-badge unstaged">U</span>}</button>)}</div>
      {selected && <section className="diff-view"><div className="diff-heading"><span>{selected.path}</span>{selected.staged && selected.unstaged && <div className="diff-sides"><button className={selectedStaged ? "active" : ""} onClick={() => setSelectedStaged(true)} type="button">Index</button><button className={!selectedStaged ? "active" : ""} onClick={() => setSelectedStaged(false)} type="button">Working Tree</button></div>}<button onClick={() => setSelected(null)} aria-label="Close diff" type="button">×</button></div><DiffViewer diff={diff} emptyMessage="No diff available for this selection." /></section>}
    </>}
    <div className="panel-footnote"><span className="read-only-mark">◉</span> Read-only Git tools</div>
  </div>;
}

function GitGraph({ repoPath }: { repoPath: string }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (append: boolean) => {
    if (!repoPath || !isTauri() || loading) return;
    setLoading(true);
    try {
      const more = await invoke<CommitInfo[]>("git_history", { path: repoPath, skip: append ? commits.length : 0, limit: 50 });
      setCommits((current) => append ? [...current, ...more] : more);
      setError(null);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }, [commits.length, loading, repoPath]);
  useEffect(() => { setCommits([]); void load(false); }, [repoPath]);

  return <div className="tool-view">
    <header className="tool-header"><div><h1>Git Graph</h1><p>{repoPath ? `${commits.length} commits loaded` : "Repository commit history"}</p></div><button className="icon-button refresh-button" aria-label="Refresh history" onClick={() => void load(false)} type="button">↻</button></header>
    {!repoPath ? <div className="empty-repository graph-empty"><div className="graph-preview"><span /><span /><span /></div><h2>History unavailable</h2><p>Open a Git repository to browse its commit graph.</p></div> : <>
      {error && <div className="git-error" role="alert">{error}</div>}
      <div className="commit-list">{commits.map((commit) => <div className="commit-row" key={commit.id}><div className="commit-rail"><svg aria-hidden="true"><line x1="10" y1="0" x2="10" y2="100%" className="commit-line" /></svg><span className="commit-node" /></div><div className="commit-info"><div className="commit-message" title={commit.message}>{commit.message}</div><div className="commit-meta"><code>{commit.shortId}</code><span>{commit.author}</span><time>{new Date(commit.timestamp * 1000).toLocaleDateString()}</time></div>{commit.branches.map((branch) => <span className="branch-label" key={branch}>{branch}</span>)}</div></div>)}
        {commits.length === 0 && !loading && <div className="change-empty">No commits found.</div>}
      </div>
      {commits.length > 0 && <button className="load-more" onClick={() => void load(true)} disabled={loading} type="button">{loading ? "Loading…" : "Load more commits"}</button>}
    </>}
    <div className="panel-footnote"><span className="read-only-mark">◉</span> Incremental history loading</div>
  </div>;
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
    return <Suspense fallback={<div className="terminal-placeholder">Loading terminal…</div>}><TerminalPane sessionId={terminal.id} shell={terminal.shell} profileId={terminal.profileId} workingDirectory={terminal.workingDirectory} active={terminal.id === activeTerminalId} visible onFocus={onFocus} onExit={onExit} /></Suspense>;
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

