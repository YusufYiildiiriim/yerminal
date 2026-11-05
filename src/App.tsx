import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
type LayoutNode = { type: "terminal"; sessionId: string } | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; children: [LayoutNode, LayoutNode] };
type RepositoryInfo = { root: string; branch: string; state: string };
type FileChange = { path: string; kind: string; staged: boolean; unstaged: boolean };
type CommitInfo = { id: string; shortId: string; message: string; author: string; timestamp: number; parents: string[]; branches: string[] };
type CommitFileChange = { path: string; kind: string };

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
  const [toast, setToast] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(() => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = null;
    setToast(null);
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast(message);
    toastTimeoutRef.current = setTimeout(() => {
      toastTimeoutRef.current = null;
      setToast(null);
    }, 5000);
  }, []);

  useEffect(() => () => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
  }, []);

  const createTerminal = useCallback(async (showInTabs = true): Promise<TerminalSession | null> => {
    dismissToast();
    if (!isTauri()) {
      showToast("Install Rust/Cargo and launch the desktop app with npm run tauri dev.");
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
      showToast(String(reason));
      return null;
    }
  }, [dismissToast, repoPath, showToast, terminals.length]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (terminals.length === 0) void createTerminal();
  }, [createTerminal, terminals.length]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<AgentProfile[]>("list_agent_profiles").then(setAgentProfiles).catch((reason: unknown) => showToast(String(reason)));
  }, [showToast]);

  const closeTerminal = useCallback(async (id: string) => {
    if (isTauri()) {
      try { await invoke("close_terminal", { sessionId: id }); }
      catch (reason) { showToast(String(reason)); }
    }
    const next = terminals.filter((terminal) => terminal.id !== id);
    setTerminals(next);
    if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? null);
    setLayout((current) => current ? removeTerminal(current, id) : null);
  }, [activeTerminalId, showToast, terminals]);

  const handleTerminalExit = useCallback((id: string) => {
    setTerminals((current) => current.map((terminal) => terminal.id === id ? { ...terminal, shellLabel: `${terminal.shellLabel} · exited` } : terminal));
  }, []);

  const focusTerminal = useCallback((id: string) => setActiveTerminalId(id), []);

  const splitActiveTerminal = useCallback(async (direction: "horizontal" | "vertical") => {
    if (!activeTerminalId) return;
    const created = await createTerminal(false);
    if (!created) return;
    setLayout((current) => {
      const root = current ?? buildTerminalLayout(terminals.map((terminal) => terminal.id));
      return splitTerminal(root, activeTerminalId, created.id, direction);
    });
  }, [activeTerminalId, createTerminal, terminals]);

  const addTerminalToWorkspace = useCallback(async () => {
    if (!activeTerminalId) {
      await createTerminal();
      return;
    }
    await splitActiveTerminal("horizontal");
  }, [activeTerminalId, createTerminal, splitActiveTerminal]);

  const moveTerminal = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setLayout((current) => current ? swapTerminalPositions(current, sourceId, targetId) : null);
    setActiveTerminalId(sourceId);
  }, []);

  const resizeLayoutSplit = useCallback((splitId: string, ratio: number) => {
    setLayout((current) => current ? updateSplitRatio(current, splitId, ratio) : null);
  }, []);
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
    dismissToast();
  }, [dismissToast, repoPath]);

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
      dismissToast();
      if (isTauri()) {
        const results = await Promise.allSettled(terminals.map((terminal) =>
          invoke("write_terminal", {
            sessionId: terminal.id,
            data: changeDirectoryCommand(terminal.shell, path),
          }),
        ));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") showToast(`Could not change terminal working directory: ${String(failed.reason)}`);
      }
    } catch (reason) {
      setRepoInfo(null);
      showToast(String(reason));
    }
  }, [dismissToast, repoPath, showToast, terminals]);

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
          <section className="tool-content">{activeTool === "changes" ? <GitChanges repoPath={repoPath} repoInfo={repoInfo} onOpenRepository={() => void openRepository()} onError={showToast} /> : <GitGraph repoPath={repoPath} onError={showToast} />}</section>
          <nav className="tool-tabs" aria-label="Developer tools">
            {tools.map((tool) => <button key={tool.id} className={`tool-tab ${activeTool === tool.id ? "selected" : ""}`} onClick={() => setActiveTool(tool.id)} type="button"><span className="tool-icon">{tool.icon}</span>{tool.label}</button>)}
            <button className="tool-tab add-tool" aria-label="Add tool" type="button">＋</button>
          </nav>
        </Panel>
        <PanelResizeHandle className="resize-handle" aria-label="Resize developer tools" />
        <Panel minSize={35} className="terminal-panel">
          <div className="terminal-toolbar">
            <div className="terminal-tabs" role={layout ? undefined : "tablist"} aria-label={layout ? "Terminal workspace actions" : "Terminal sessions"}>
              {!layout && terminals.map((terminal) => <button key={terminal.id} className={`terminal-tab ${terminal.id === activeTerminalId ? "selected" : ""}`} onClick={() => setActiveTerminalId(terminal.id)} onDoubleClick={() => renameTerminal(terminal)} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); void closeTerminal(terminal.id); } }} type="button" role="tab" aria-selected={terminal.id === activeTerminalId}><span className="terminal-dot" />{terminal.name}{terminals.length > 1 && <span className="tab-close" role="button" aria-label={`Close ${terminal.name}`} onClick={(event) => { event.stopPropagation(); void closeTerminal(terminal.id); }}>×</span>}</button>)}
              <button className="icon-button new-terminal" aria-label="Add terminal to workspace" title="Add terminal pane" onClick={() => void addTerminalToWorkspace()} type="button">＋</button>
            </div>
            <div className="toolbar-actions"><button className="toolbar-button" type="button" aria-label="Split horizontally" title="Split side by side" onClick={() => void splitActiveTerminal("horizontal")} disabled={!activeTerminal}>▤</button><button className="toolbar-button" type="button" aria-label="Split vertically" title="Split top and bottom" onClick={() => void splitActiveTerminal("vertical")} disabled={!activeTerminal}>▥</button>{agentProfiles.map((profile) => <button className="agent-launch" key={profile.id} type="button" title={`Launch ${profile.name}`} onClick={() => createAgentTerminal(profile)}>{profile.id === "claude" ? "Claude" : profile.id === "codex" ? "Codex" : profile.name}</button>)}<span className="toolbar-divider" /><button className="toolbar-button" type="button" aria-label="Terminal options" disabled>···</button></div>
          </div>
          <section className="terminal-surface" aria-label="Terminal workspace">
            <TerminalWorkspaceLayout layout={layout} terminals={terminals} activeTerminalId={activeTerminalId} onFocus={focusTerminal} onExit={handleTerminalExit} onClose={closeTerminal} onMove={moveTerminal} onResize={resizeLayoutSplit} />
            {terminals.length === 0 && <div className="terminal-placeholder"><div className="welcome-title">Welcome to <span>yerminal</span></div><p>Create a terminal to begin.</p><button className="primary-button" onClick={() => void createTerminal()} type="button">New Terminal</button></div>}

            <div className="terminal-status"><span className="status-indicator" />{activeTerminal?.shellLabel ?? "No terminal"}<span className="status-separator">·</span>{activeTerminal ? "Running" : "Ready"}</div>
          </section>
          <footer className="statusbar"><span><span className="status-indicator" />{repoInfo ? `${repoInfo.branch} · ${repoInfo.state}` : "No folder opened"}</span><span>UTF-8</span><span>{navigator.userAgent.includes("Windows") ? "Windows" : navigator.platform}</span></footer>
        </Panel>
      </PanelGroup>
      {toast && <div className="app-toast" role="alert" aria-live="assertive" aria-atomic="true"><span>{toast}</span><button aria-label="Dismiss notification" onClick={dismissToast} type="button">×</button></div>}
    </main>
  );
}

function GitChanges({ repoPath, repoInfo, onOpenRepository, onError }: { repoPath: string; repoInfo: RepositoryInfo | null; onOpenRepository: () => void; onError: (message: string) => void }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [diff, setDiff] = useState("");

  const refresh = useCallback(async () => {
    if (!repoPath || !isTauri()) return;
    try { setChanges(await invoke<FileChange[]>("git_status", { path: repoPath })); }
    catch (reason) { onError(String(reason)); }
  }, [onError, repoPath]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setSelected(null); setSelectedStaged(false); }, [repoPath]);
  useEffect(() => {
    if (!selected || !repoPath || !isTauri()) { setDiff(""); return; }
    void invoke<string>("git_diff", { path: repoPath, filePath: selected.path, staged: selectedStaged })
      .then(setDiff).catch((reason: unknown) => onError(String(reason)));
  }, [onError, repoPath, selected, selectedStaged]);

  return <div className="tool-view">
    <header className="tool-header"><div><h1>Git Changes</h1><p>{repoInfo ? `${repoInfo.branch} · ${changes.length} changed` : "Review your working tree"}</p></div><button className="icon-button refresh-button" aria-label="Refresh changes" onClick={() => void refresh()} type="button">↻</button></header>
    {!repoInfo ? <div className="empty-repository"><div className="empty-icon">⌂</div><h2>No repository opened</h2><p>Open a folder to view its changes.</p><button className="primary-button" onClick={onOpenRepository} type="button">Open Folder</button></div> : <>

      <div className="change-list">{changes.length === 0 ? <div className="change-empty">Working tree clean</div> : changes.map((change) => <button key={change.path} className={`change-row ${selected?.path === change.path ? "selected" : ""}`} onClick={() => { setSelected(change); setSelectedStaged(change.staged && !change.unstaged); }} type="button"><span className={`change-kind ${change.kind}`}>{change.kind === "modified" ? "M" : change.kind === "deleted" ? "D" : change.kind === "untracked" ? "?" : change.kind === "renamed" ? "R" : "A"}</span><span className="change-path" title={change.path}>{change.path}</span>{change.staged && <span className="change-badge">S</span>}{change.unstaged && <span className="change-badge unstaged">U</span>}</button>)}</div>
      {selected && <section className="diff-view"><div className="diff-heading"><span>{selected.path}</span>{selected.staged && selected.unstaged && <div className="diff-sides"><button className={selectedStaged ? "active" : ""} onClick={() => setSelectedStaged(true)} type="button">Index</button><button className={!selectedStaged ? "active" : ""} onClick={() => setSelectedStaged(false)} type="button">Working Tree</button></div>}<button onClick={() => setSelected(null)} aria-label="Close diff" type="button">×</button></div><DiffViewer diff={diff} emptyMessage="No diff available for this selection." /></section>}
    </>}
    <div className="panel-footnote"><span className="read-only-mark">◉</span> Read-only Git tools</div>
  </div>;
}

function GitGraph({ repoPath, onError }: { repoPath: string; onError: (message: string) => void }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<CommitInfo | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const load = useCallback(async (append: boolean) => {
    if (!repoPath || !isTauri() || loading) return;
    setLoading(true);
    try {
      const more = await invoke<CommitInfo[]>("git_history", { path: repoPath, skip: append ? commits.length : 0, limit: 50 });
      setCommits((current) => append ? [...current, ...more] : more);

    } catch (reason) { onError(String(reason)); }
    finally { setLoading(false); }
  }, [commits.length, loading, onError, repoPath]);
  useEffect(() => { setCommits([]); void load(false); }, [repoPath]);

  const selectCommit = useCallback(async (commit: CommitInfo) => {
    if (!repoPath || !isTauri()) return;
    setSelectedCommit(commit);
    setCommitFiles([]);
    setSelectedFile(null);
    setFileDiff("");
    setDetailLoading(true);
    try {
      setCommitFiles(await invoke<CommitFileChange[]>("git_commit_files", { path: repoPath, commitId: commit.id }));
    } catch (reason) { onError(String(reason)); }
    finally { setDetailLoading(false); }
  }, [onError, repoPath]);

  const selectFile = useCallback(async (filePath: string) => {
    if (!repoPath || !selectedCommit || !isTauri()) return;
    setSelectedFile(filePath);
    setFileDiff("");
    try {
      setFileDiff(await invoke<string>("git_commit_file_diff", { path: repoPath, commitId: selectedCommit.id, filePath }));
    } catch (reason) { onError(String(reason)); }
  }, [onError, repoPath, selectedCommit]);

  useEffect(() => {
    setSelectedCommit(null);
    setCommitFiles([]);
    setSelectedFile(null);
    setFileDiff("");
  }, [repoPath]);

  return <div className="tool-view">
    <header className="tool-header"><div><h1>Git Graph</h1><p>{repoPath ? `${commits.length} commits loaded` : "Repository commit history"}</p></div><button className="icon-button refresh-button" aria-label="Refresh history" onClick={() => void load(false)} type="button">↻</button></header>
    {!repoPath ? <div className="empty-repository graph-empty"><div className="graph-preview"><span /><span /><span /></div><h2>History unavailable</h2><p>Open a Git repository to browse its commit graph.</p></div> : <>
      <div className="commit-list">{commits.map((commit) => <button className={`commit-row ${selectedCommit?.id === commit.id ? "selected" : ""}`} key={commit.id} onClick={() => void selectCommit(commit)} type="button" aria-pressed={selectedCommit?.id === commit.id}><span className="commit-rail"><svg aria-hidden="true"><line x1="10" y1="0" x2="10" y2="100%" className="commit-line" /></svg><span className="commit-node" /></span><span className="commit-info"><span className="commit-message" title={commit.message}>{commit.message}</span><span className="commit-meta"><code>{commit.shortId}</code><span>{commit.author}</span><time>{new Date(commit.timestamp * 1000).toLocaleDateString()}</time></span>{commit.branches.map((branch) => <span className="branch-label" key={branch}>{branch}</span>)}</span></button>)}
        {commits.length === 0 && !loading && <div className="change-empty">No commits found.</div>}
      </div>
      {selectedCommit && <section className="commit-details"><div className="diff-heading"><span>{selectedCommit.message}</span><button onClick={() => { setSelectedCommit(null); setCommitFiles([]); setSelectedFile(null); setFileDiff(""); }} aria-label="Close commit details" type="button">×</button></div>{detailLoading ? <div className="change-empty">Loading changed files…</div> : <div className="commit-file-list">{commitFiles.length ? commitFiles.map((file) => <button className={`change-row ${selectedFile === file.path ? "selected" : ""}`} key={file.path} onClick={() => void selectFile(file.path)} type="button"><span className={`change-kind ${file.kind}`}>{file.kind === "deleted" ? "D" : file.kind === "added" ? "A" : file.kind === "renamed" ? "R" : "M"}</span><span className="change-path" title={file.path}>{file.path}</span></button>) : <div className="change-empty">No files changed in this commit.</div>}</div>}{selectedFile && <pre className="commit-file-diff">{fileDiff || "Loading diff…"}</pre>}</section>}
      {commits.length > 0 && <button className="load-more" onClick={() => void load(true)} disabled={loading} type="button">{loading ? "Loading…" : "Load more commits"}</button>}
    </>}
    <div className="panel-footnote"><span className="read-only-mark">◉</span> Incremental history loading</div>
  </div>;
}

type LayoutRect = { x: number; y: number; width: number; height: number };
type LayoutDividerInfo = { id: string; direction: "horizontal" | "vertical"; ratio: number; rect: LayoutRect };
type LayoutGeometry = { panes: Map<string, LayoutRect>; dividers: LayoutDividerInfo[] };
type TerminalWorkspaceLayoutProps = {
  layout: LayoutNode | null;
  terminals: TerminalSession[];
  activeTerminalId: string | null;
  onFocus: (sessionId: string) => void;
  onExit: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
};

function TerminalWorkspaceLayout({ layout, terminals, activeTerminalId, onFocus, onExit, onClose, onMove, onResize }: TerminalWorkspaceLayoutProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const paneDragRef = useRef<{ sourceId: string; pointerId: number; startX: number; startY: number; started: boolean } | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const geometry = useMemo(() => {
    if (layout) return getLayoutGeometry(layout);
    const panes = new Map<string, LayoutRect>();
    if (activeTerminalId) panes.set(activeTerminalId, { x: 0, y: 0, width: 100, height: 100 });
    return { panes, dividers: [] };
  }, [activeTerminalId, layout]);

  const findPaneAtPoint = (clientX: number, clientY: number, sourceId: string) => {
    for (const [paneId, pane] of paneRefs.current) {
      if (paneId === sourceId || !geometry.panes.has(paneId)) continue;
      const bounds = pane.getBoundingClientRect();
      if (clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom) return paneId;
    }
    return null;
  };

  const finishPaneDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = paneDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const targetId = drag.started ? findPaneAtPoint(event.clientX, event.clientY, drag.sourceId) : null;
    paneDragRef.current = null;
    setDraggingPaneId(null);
    setDropTargetPaneId(null);
    if (drag.started && targetId) onMove(drag.sourceId, targetId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className="terminal-layout-surface" ref={surfaceRef} data-pane-dragging={draggingPaneId ? "true" : undefined}>
    {terminals.map((terminal) => {
      const rect = geometry.panes.get(terminal.id);
      const style: CSSProperties = rect
        ? { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }
        : { display: "none" };
      return <div
        key={terminal.id}
        className={`terminal-pane-frame ${rect && layout ? "layout-pane" : ""}`}
        style={style}
        ref={(element) => {
          if (element) paneRefs.current.set(terminal.id, element);
          else paneRefs.current.delete(terminal.id);
        }}
        data-drag-over={dropTargetPaneId === terminal.id ? "true" : undefined}
        data-drag-source={draggingPaneId === terminal.id ? "true" : undefined}
      >
        {layout && rect && <header className="terminal-pane-header">
          <button
            className="pane-drag-handle"
            type="button"
            aria-label={`Drag ${terminal.name} to swap pane positions`}
            title="Drag onto another pane to swap positions"
            onMouseDown={() => onFocus(terminal.id)}
            onPointerDown={(event) => {
              if (event.button !== 0 || !layout) return;
              event.preventDefault();
              onFocus(terminal.id);
              paneDragRef.current = { sourceId: terminal.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = paneDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
              drag.started = true;
              setDraggingPaneId(drag.sourceId);
              setDropTargetPaneId(findPaneAtPoint(event.clientX, event.clientY, drag.sourceId));
            }}
            onPointerUp={finishPaneDrag}
            onPointerCancel={(event) => {
              if (paneDragRef.current?.pointerId !== event.pointerId) return;
              paneDragRef.current = null;
              setDraggingPaneId(null);
              setDropTargetPaneId(null);
            }}
          >⠿</button>
          <span className="terminal-pane-title" title={terminal.name}>{terminal.name}</span>
          <button className="pane-close" type="button" aria-label={`Close ${terminal.name}`} onClick={() => onClose(terminal.id)}>×</button>
        </header>}
        <div className="terminal-pane-body">
          <Suspense key={terminal.id} fallback={<div className="terminal-placeholder">Loading terminal…</div>}>
            <TerminalPane sessionId={terminal.id} shell={terminal.shell} profileId={terminal.profileId} workingDirectory={terminal.workingDirectory} active={terminal.id === activeTerminalId} visible={Boolean(rect)} onFocus={onFocus} onExit={onExit} />
          </Suspense>
        </div>
      </div>;
    })}
    {geometry.dividers.map((divider) => <LayoutDivider key={divider.id} divider={divider} surfaceRef={surfaceRef} onResize={onResize} />)}
  </div>;
}

function LayoutDivider({ divider, surfaceRef, onResize }: { divider: LayoutDividerInfo; surfaceRef: React.RefObject<HTMLDivElement | null>; onResize: (splitId: string, ratio: number) => void }) {
  const style: CSSProperties = divider.direction === "horizontal"
    ? { left: `calc(${divider.rect.x + divider.rect.width * divider.ratio}% - 3px)`, top: `${divider.rect.y}%`, width: 6, height: `${divider.rect.height}%` }
    : { left: `${divider.rect.x}%`, top: `calc(${divider.rect.y + divider.rect.height * divider.ratio}% - 3px)`, width: `${divider.rect.width}%`, height: 6 };

  const updateRatio = (event: React.PointerEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current;
    if (!surface || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = surface.getBoundingClientRect();
    const ratio = divider.direction === "horizontal"
      ? ((event.clientX - bounds.left) / bounds.width * 100 - divider.rect.x) / divider.rect.width
      : ((event.clientY - bounds.top) / bounds.height * 100 - divider.rect.y) / divider.rect.height;
    onResize(divider.id, Math.max(0.15, Math.min(0.85, ratio)));
  };

  return <div
    className={`layout-divider ${divider.direction}`}
    style={style}
    role="separator"
    aria-orientation={divider.direction === "horizontal" ? "vertical" : "horizontal"}
    aria-label="Resize terminal panes"
    onPointerDown={(event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      updateRatio(event);
    }}
    onPointerMove={updateRatio}
    onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
  />;
}
function buildTerminalLayout(sessionIds: string[], depth = 0): LayoutNode {
  if (sessionIds.length === 0) throw new Error("A terminal layout requires at least one session.");
  if (sessionIds.length === 1) return { type: "terminal", sessionId: sessionIds[0] };
  const middle = Math.ceil(sessionIds.length / 2);
  const direction = depth % 2 === 0 ? "horizontal" : "vertical";
  return {
    type: "split",
    id: crypto.randomUUID(),
    direction,
    ratio: middle / sessionIds.length,
    children: [buildTerminalLayout(sessionIds.slice(0, middle), depth + 1), buildTerminalLayout(sessionIds.slice(middle), depth + 1)],
  };
}
function splitTerminal(node: LayoutNode, sessionId: string, newSessionId: string, direction: "horizontal" | "vertical"): LayoutNode {
  if (node.type === "terminal") {
    if (node.sessionId !== sessionId) return node;
    return { type: "split", id: crypto.randomUUID(), direction, ratio: 0.5, children: [node, { type: "terminal", sessionId: newSessionId }] };
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

function swapTerminalPositions(node: LayoutNode, sourceId: string, targetId: string): LayoutNode {
  if (node.type === "terminal") {
    if (node.sessionId === sourceId) return { ...node, sessionId: targetId };
    if (node.sessionId === targetId) return { ...node, sessionId: sourceId };
    return node;
  }
  return { ...node, children: [swapTerminalPositions(node.children[0], sourceId, targetId), swapTerminalPositions(node.children[1], sourceId, targetId)] };
}

function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "terminal") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, children: [updateSplitRatio(node.children[0], splitId, ratio), updateSplitRatio(node.children[1], splitId, ratio)] };
}

function getLayoutGeometry(root: LayoutNode): LayoutGeometry {
  const panes = new Map<string, LayoutRect>();
  const dividers: LayoutDividerInfo[] = [];
  const visit = (node: LayoutNode, rect: LayoutRect) => {
    if (node.type === "terminal") {
      panes.set(node.sessionId, rect);
      return;
    }
    dividers.push({ id: node.id, direction: node.direction, ratio: node.ratio, rect });
    if (node.direction === "horizontal") {
      const firstWidth = rect.width * node.ratio;
      visit(node.children[0], { ...rect, width: firstWidth });
      visit(node.children[1], { ...rect, x: rect.x + firstWidth, width: rect.width - firstWidth });
    } else {
      const firstHeight = rect.height * node.ratio;
      visit(node.children[0], { ...rect, height: firstHeight });
      visit(node.children[1], { ...rect, y: rect.y + firstHeight, height: rect.height - firstHeight });
    }
  };
  visit(root, { x: 0, y: 0, width: 100, height: 100 });
  return { panes, dividers };
}
export default App;

