import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { highlightCode } from "./highlighter";
import { CommitSnapshotBanner } from "./CommitSnapshotBanner";
import { DiffView } from "../git/DiffView";
import { useFloatingEditorLayout, type EditorLayoutMode, type EditorResizeDirection } from "./floatingEditorLayout";
import "./floating-editor-layout.css";

export type EditorFileTab = {
  id: string;
  root: string;
  path: string;
  name: string;
  status: "loading" | "ready" | "error";
  content: string | null;
  savedContent: string | null;
  error: string | null;
  sourceLabel: string | null;
  sourceCommitId: string | null;
  view?: "text" | "diff";
  diffStaged?: boolean | null;
  snapshot: { shortId: string; message: string; changeKind: string; author: string; timestamp: number } | null;
  isSaving: boolean;
  saveError: string | null;
};

export type EditorGroupState = {
  id: string;
  name: string;
  tabIds: string[];
  activeTabId: string | null;
};

type CodeWorkspaceProps = {
  workspaceId: string;
  tabs: EditorFileTab[];
  groups: EditorGroupState[];
  activeGroupId: string;
  onSelect: (groupId: string, tabId: string) => void;
  onActivateGroup: (groupId: string) => void;
  onClose: (tabId: string) => void;
  onChange: (tabId: string, content: string) => void;
  onSave: (tabId: string) => void;
  onMoveTab: (tabId: string, groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onModeState: (mode: EditorLayoutMode, setMode: (mode: EditorLayoutMode) => void) => void;
};

type EditorGroupPaneProps = {
  layoutMode: EditorLayoutMode;
  groupStyle: CSSProperties;
  dragging: boolean;
  resizing: boolean;
  onStartDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onMoveDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onEndDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onCancelDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onStartResize: (groupId: string, direction: EditorResizeDirection, event: ReactPointerEvent<HTMLElement>) => void;
  onMoveResize: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onEndResize: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onCancelResize: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onNudgeResize: (groupId: string, direction: EditorResizeDirection, key: string) => boolean;
  group: EditorGroupState;
  groups: EditorGroupState[];
  tabs: EditorFileTab[];
  isActive: boolean;
  onSelect: (groupId: string, tabId: string) => void;
  onActivateGroup: (groupId: string) => void;
  onClose: (tabId: string) => void;
  onChange: (tabId: string, content: string) => void;
  onSave: (tabId: string) => void;
  onMoveTab: (tabId: string, groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
};

function normalizeNewlines(content: string | null): string {
  return (content ?? "").replace(/\r\n/g, "\n");
}

const languageByExtension: Record<string, { id: string; label: string }> = {
  bash: { id: "bash", label: "Bash" }, c: { id: "c", label: "C" }, cc: { id: "cpp", label: "C++" }, cpp: { id: "cpp", label: "C++" },
  cs: { id: "csharp", label: "C#" }, css: { id: "css", label: "CSS" }, cts: { id: "typescript", label: "TypeScript" }, cxx: { id: "cpp", label: "C++" },
  go: { id: "go", label: "Go" }, h: { id: "c", label: "C" }, hpp: { id: "cpp", label: "C++" }, htm: { id: "html", label: "HTML" }, html: { id: "html", label: "HTML" },
  java: { id: "java", label: "Java" }, js: { id: "javascript", label: "JavaScript" }, jsx: { id: "jsx", label: "JavaScript React" }, json: { id: "json", label: "JSON" },
  jsonc: { id: "jsonc", label: "JSON with Comments" }, kt: { id: "kotlin", label: "Kotlin" }, lua: { id: "lua", label: "Lua" }, md: { id: "markdown", label: "Markdown" },
  mjs: { id: "javascript", label: "JavaScript" }, mts: { id: "typescript", label: "TypeScript" }, php: { id: "php", label: "PHP" }, ps1: { id: "powershell", label: "PowerShell" },
  psm1: { id: "powershell", label: "PowerShell" }, py: { id: "python", label: "Python" }, rb: { id: "ruby", label: "Ruby" }, rs: { id: "rust", label: "Rust" },
  scss: { id: "scss", label: "SCSS" }, sh: { id: "bash", label: "Shell" }, sql: { id: "sql", label: "SQL" }, swift: { id: "swift", label: "Swift" }, toml: { id: "toml", label: "TOML" },
  ts: { id: "typescript", label: "TypeScript" }, tsx: { id: "tsx", label: "TypeScript React" }, txt: { id: "plaintext", label: "Plain Text" }, xml: { id: "xml", label: "XML" },
  yaml: { id: "yaml", label: "YAML" }, yml: { id: "yaml", label: "YAML" },
};

function detectLanguage(path: string): { id: string | null; label: string } {
  const fileName = path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) return { id: "dockerfile", label: "Dockerfile" };
  if (fileName === "makefile" || fileName === "gnumakefile") return { id: "makefile", label: "Makefile" };
  if (fileName === ".gitignore" || fileName === ".dockerignore") return { id: null, label: "Ignore" };
  if (fileName === ".env" || fileName.startsWith(".env.")) return { id: "dotenv", label: "Environment" };
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return languageByExtension[extension] ?? { id: null, label: "Plain Text" };
}

function EditorGroupPane({ layoutMode, groupStyle, dragging, resizing, onStartDrag, onMoveDrag, onEndDrag, onCancelDrag, onStartResize, onMoveResize, onEndResize, onCancelResize, onNudgeResize, group, groups, tabs, isActive, onSelect, onActivateGroup, onClose, onChange, onSave, onMoveTab, onCloseGroup }: EditorGroupPaneProps) {
  const groupTabs = group.tabIds.map((id) => tabs.find((tab) => tab.id === id)).filter((tab): tab is EditorFileTab => Boolean(tab));
  const activeTab = groupTabs.find((tab) => tab.id === group.activeTabId) ?? null;
  const language = useMemo(() => activeTab ? detectLanguage(activeTab.path) : null, [activeTab?.path]);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [highlighting, setHighlighting] = useState(false);
  const editorContentRef = useRef<HTMLDivElement>(null);
  const [editorViewport, setEditorViewport] = useState({ top: 0, size: 1 });
  const isReadOnly = Boolean(activeTab?.sourceCommitId) || activeTab?.view === "diff";
  const isDirty = Boolean(activeTab && activeTab.content !== null && normalizeNewlines(activeTab.content) !== normalizeNewlines(activeTab.savedContent));
  useEffect(() => {
    const element = editorContentRef.current;
    if (!element) return;
    const updateViewport = () => setEditorViewport({
      top: element.scrollTop / Math.max(1, element.scrollHeight),
      size: Math.min(1, element.clientHeight / Math.max(1, element.scrollHeight)),
    });
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeTab?.id, activeTab?.content, activeTab?.status]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const resizeHandle = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".editor-group-resize-handle") : null;
    const resizeDirection = resizeHandle?.dataset.direction as EditorResizeDirection | undefined;
    if (layoutMode === "free" && resizeHandle && resizeDirection && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (onNudgeResize(group.id, resizeDirection, event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && activeTab && !isReadOnly) {
      event.preventDefault();
      onSave(activeTab.id);
    }
  };

  useEffect(() => {
    let current = true;
    setHighlightedHtml(null);
    if (!activeTab || activeTab.status !== "ready" || activeTab.content === null || activeTab.view === "diff" || !language?.id || language.id === "plaintext") {
      setHighlighting(false);
      return () => { current = false; };
    }
    setHighlighting(true);
    void highlightCode(activeTab.content, language.id)
      .then((html) => { if (current) setHighlightedHtml(html); })
      .catch(() => { if (current) setHighlightedHtml(null); })
      .finally(() => { if (current) setHighlighting(false); });
    return () => { current = false; };
  }, [activeTab?.content, activeTab?.id, activeTab?.status, language?.id]);

  return <section
    className={"editor-group-pane" + (isActive ? " active" : "") + (layoutMode === "free" ? " free" : "")}
    style={layoutMode === "free" ? groupStyle : undefined}
    data-dragging={dragging ? "true" : "false"}
    data-resizing={resizing ? "true" : undefined}
    aria-label={group.name}
    onMouseDown={() => onActivateGroup(group.id)}
    onKeyDown={handleKeyDown}
  >
    {layoutMode === "free" && (["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] as const).map((direction) => <div
      key={direction}
      data-direction={direction}
      className={`editor-group-resize-handle ${direction}`}
      role="separator"
      tabIndex={0}
      aria-orientation={direction.includes("-") ? undefined : direction === "left" || direction === "right" ? "vertical" : "horizontal"}
      aria-label={`Resize ${group.name} ${direction}`}
      aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
      title="Drag to resize · Alt+Shift+Arrow to adjust while focused"
      onFocus={() => onActivateGroup(group.id)}
      onPointerDown={(event) => { onActivateGroup(group.id); onStartResize(group.id, direction, event); }}
      onPointerMove={(event) => onMoveResize(group.id, event)}
      onPointerUp={(event) => onEndResize(group.id, event)}
      onPointerCancel={(event) => onCancelResize(group.id, event)}
    />)}
    {(layoutMode === "free" || groups.length > 1) && <header
      className={"editor-group-heading" + (layoutMode === "free" ? " free" : "")}
      onPointerDown={layoutMode === "free" ? (event) => {
        if (event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest("button, select, input, textarea, [contenteditable=true], .editor-group-resize-handle")) return;
        onActivateGroup(group.id);
        onStartDrag(group.id, event);
      } : undefined}
      onPointerMove={layoutMode === "free" ? (event) => onMoveDrag(group.id, event) : undefined}
      onPointerUp={layoutMode === "free" ? (event) => onEndDrag(group.id, event) : undefined}
      onPointerCancel={layoutMode === "free" ? (event) => onCancelDrag(group.id, event) : undefined}
    >
      <div className="editor-group-title"><span className="editor-group-indicator" aria-hidden="true" />{group.name}<span className="editor-group-count">{groupTabs.length}</span></div>
      <div className="editor-group-actions">
        {activeTab && groups.length > 1 && <select className="editor-group-move" aria-label={"Move " + activeTab.name + " to editor group"} value="" onChange={(event) => { const targetGroupId = event.currentTarget.value; if (targetGroupId) onMoveTab(activeTab.id, targetGroupId); }}>
          <option value="">Move file…</option>
          {groups.filter((candidate) => candidate.id !== group.id).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
        </select>}
        {groups.length > 1 && <button className="editor-group-close" type="button" title={"Close " + group.name + " and move its tabs"} aria-label={"Close " + group.name + " and move its tabs"} onClick={() => onCloseGroup(group.id)}>×</button>}
      </div>
    </header>}
    <nav className="editor-file-tabs" role="tablist" aria-label={group.name + " open files"}>
      {groupTabs.map((tab) => <div className={"editor-file-tab" + (group.activeTabId === tab.id ? " selected" : "")} key={tab.id} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); onClose(tab.id); }}>
        <button className="editor-file-tab-select" role="tab" aria-selected={group.activeTabId === tab.id} onClick={() => onSelect(group.id, tab.id)} type="button" title={tab.path + " · Middle-click to close"}>
          <span className="editor-file-tab-icon" aria-hidden="true">{tab.name.split(".").pop()?.slice(0, 2).toUpperCase() ?? "·"}</span>
          <span>{tab.name}</span>
          {tab.sourceCommitId ? <span className="editor-file-tab-readonly-mark" aria-label="Read only" title="Commit snapshot">◉</span> : tab.content !== null && normalizeNewlines(tab.content) !== normalizeNewlines(tab.savedContent) ? <span className="editor-file-tab-dirty-mark" aria-label="Unsaved changes" title="Unsaved changes">●</span> : null}
          {tab.status === "loading" && <span className="editor-file-tab-loading" aria-label="Loading" />}
        </button>
        <button className="editor-file-tab-close" aria-label={"Close " + tab.name} title={"Close " + tab.name} onClick={() => onClose(tab.id)} type="button">×</button>
      </div>)}
      {groupTabs.length === 0 && <span className="editor-tabs-empty">No open files</span>}
    </nav>
    {activeTab ? <>
      {isReadOnly && activeTab.snapshot && <CommitSnapshotBanner snapshot={activeTab.snapshot} filePath={activeTab.path} />}
      <header className="code-editor-header">
        <div className="code-editor-meta">
          <span>{language?.label ?? "Plain Text"}</span>
          <span className="code-editor-source-label" title={activeTab.sourceLabel ?? "Workspace file"}>{activeTab.sourceLabel ?? "Workspace file"}</span>
          {isReadOnly ? <span className="code-editor-readonly">Read only</span> : <>
            <span className={"code-editor-editable-badge" + (isDirty ? " dirty" : "")}>{isDirty ? "Unsaved changes" : "Editable"}</span>
          </>}
        </div>
      </header>
      <div className="code-editor-layout">
      <div className={"code-editor-content" + (activeTab.view === "diff" ? " is-diff" : "")} key={activeTab.id} ref={editorContentRef} onScroll={(event) => {
        const element = event.currentTarget;
        setEditorViewport({ top: element.scrollTop / Math.max(1, element.scrollHeight), size: Math.min(1, element.clientHeight / Math.max(1, element.scrollHeight)) });
      }}>
        {activeTab.view === "diff" ? activeTab.status === "error" ? <div className="code-editor-message code-editor-error" role="alert"><span className="code-editor-message-icon">!</span><strong>Could not open this diff</strong><span>{activeTab.error}</span></div> : <DiffView diff={activeTab.content ?? ""} path={activeTab.path} root={activeTab.root} staged={activeTab.diffStaged === true} loading={activeTab.status === "loading"} emptyMessage="No diff available for this selection." /> : activeTab.status === "loading" ? <div className="code-editor-message" role="status"><span className="editor-loading-indicator" /><span>Loading file content…</span></div> : activeTab.status === "error" ? <div className="code-editor-message code-editor-error" role="alert"><span className="code-editor-message-icon">!</span><strong>Could not open this file</strong><span>{activeTab.error}</span></div> : isReadOnly ? highlightedHtml ? <div className="code-editor-highlighted" dangerouslySetInnerHTML={{ __html: highlightedHtml }} /> : <pre className={"code-editor-plain" + (highlighting ? " is-highlighting" : "")} tabIndex={0} aria-label={"Contents of " + activeTab.name}><code>{activeTab.content}</code></pre> : <div className="code-editor-editable-surface">
          <div className="code-editor-editable-highlight" aria-hidden="true">{highlightedHtml ? <div className="code-editor-highlighted" dangerouslySetInnerHTML={{ __html: highlightedHtml }} /> : <pre className="code-editor-plain"><code>{activeTab.content}</code></pre>}</div>
          <textarea className="code-editor-input" aria-label={"Edit " + activeTab.name} autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} value={activeTab.content ?? ""} onChange={(event) => onChange(activeTab.id, event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const nextContent = input.value.slice(0, start) + "    " + input.value.slice(end);
            onChange(activeTab.id, nextContent);
            requestAnimationFrame(() => input.setSelectionRange(start + 4, start + 4));
          }} />
        </div>}
      </div>
      {activeTab.status === "ready" && activeTab.content !== null && activeTab.view !== "diff" && <EditorMinimap content={activeTab.content} highlightedHtml={highlightedHtml} viewport={editorViewport} onNavigate={(position) => {
        const element = editorContentRef.current;
        if (!element) return;
        element.scrollTop = position * element.scrollHeight;
      }} />}
      </div>
      <footer className="code-editor-statusbar" aria-live="polite">
        <span className="code-editor-path" title={activeTab.path}>{activeTab.root.split(/[\\/]/).filter(Boolean).pop() ?? activeTab.root}　›　{activeTab.path}</span>
        <span className={activeTab.saveError ? "code-editor-save-error" : ""}>{activeTab.saveError ?? (activeTab.isSaving ? "Saving changes…" : isDirty ? "Unsaved changes" : isReadOnly ? activeTab.view === "diff" ? "Read-only diff" : "Read-only commit snapshot" : activeTab.status === "ready" ? "All changes saved" : activeTab.status === "loading" ? "Loading" : "Unavailable")}</span>
        <span>{activeTab.status === "ready" ? (activeTab.content?.split(/\r?\n/).length ?? 0) + " lines" : ""}</span><span>UTF-8</span>
      </footer>
    </> : <div className="code-editor-empty"><div className="code-editor-empty-icon">⌘</div><h2>Open a file in this group</h2><p>Choose a file from the workspace explorer or Git history. It will open in this editor group.</p></div>}
  </section>;
}

function EditorMinimap({ content, highlightedHtml, viewport, onNavigate }: { content: string; highlightedHtml: string | null; viewport: { top: number; size: number }; onNavigate: (position: number) => void }) {
  const renderHighlightedPreview = Boolean(highlightedHtml && content.length <= 120_000);
  const minimapRef = useRef<HTMLElement>(null);
  const draggingPointerRef = useRef<number | null>(null);
  const [previewMetrics, setPreviewMetrics] = useState({ fontSize: 2, lineHeight: 2.5, height: 0 });
  let lineCount = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lineCount += 1;
  }

  useEffect(() => {
    const minimap = minimapRef.current;
    if (!minimap) return;
    const updatePreviewMetrics = () => {
      const bounds = minimap.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const height = Math.min(bounds.height, lineCount * 2.5);
      const lineHeight = height / lineCount;
      setPreviewMetrics({ fontSize: Math.min(2, lineHeight * 0.78), lineHeight, height });
    };
    updatePreviewMetrics();
    const observer = new ResizeObserver(updatePreviewMetrics);
    observer.observe(minimap);
    return () => observer.disconnect();
  }, [content, lineCount]);

  const navigateAt = (clientY: number) => {
    const bounds = minimapRef.current?.getBoundingClientRect();
    if (!bounds || !previewMetrics.height) return;
    const documentPosition = Math.min(1, Math.max(0, (clientY - bounds.top) / previewMetrics.height));
    const top = documentPosition - viewport.size / 2;
    onNavigate(Math.max(0, Math.min(1 - viewport.size, top)));
  };

  return <aside
    ref={minimapRef}
    className="code-editor-minimap"
    aria-label="Editor minimap"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      draggingPointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      navigateAt(event.clientY);
    }}
    onPointerMove={(event) => { if (draggingPointerRef.current === event.pointerId) navigateAt(event.clientY); }}
    onPointerUp={(event) => {
      if (draggingPointerRef.current !== event.pointerId) return;
      draggingPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={(event) => { if (draggingPointerRef.current === event.pointerId) draggingPointerRef.current = null; }}
  >
    <div className="code-editor-minimap-code" style={{ fontSize: `${previewMetrics.fontSize}px`, lineHeight: `${previewMetrics.lineHeight}px` }} aria-hidden="true">
      {renderHighlightedPreview && highlightedHtml
        ? <div className="code-editor-minimap-highlighted" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        : <pre className="code-editor-minimap-plain"><code>{content}</code></pre>}
    </div>
    <span className="code-editor-minimap-window" style={{ top: `${viewport.top * previewMetrics.height}px`, height: `${Math.max(1, viewport.size * previewMetrics.height)}px` }} />
  </aside>;
}

export function CodeWorkspace({ workspaceId, tabs, groups, activeGroupId, onSelect, onActivateGroup, onClose, onChange, onSave, onMoveTab, onCloseGroup, onModeState }: CodeWorkspaceProps) {
  const layout = useFloatingEditorLayout(workspaceId, groups.map((group) => group.id));
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  useEffect(() => onModeState(layout.mode, layout.setMode), [workspaceId, layout.mode, layout.setMode, onModeState]);
  useEffect(() => {
    const surface = layout.surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(([entry]) => setSurfaceWidth(entry.contentRect.width));
    observer.observe(surface);
    return () => observer.disconnect();
  }, [layout.surfaceRef]);
  const minGroupWidth = 320;
  const minPanelSize = 100 * minGroupWidth / Math.max(surfaceWidth, groups.length * minGroupWidth, 1);
  const groupViews = groups.map((group, index) => {
    const pane = <EditorGroupPane
        layoutMode={layout.mode}
        groupStyle={layout.getWindowStyle(group.id)}
        dragging={layout.draggingGroupId === group.id}
        resizing={layout.resizingGroupId === group.id}
        onStartDrag={layout.startDrag}
        onMoveDrag={layout.moveDrag}
        onEndDrag={layout.endDrag}
        onCancelDrag={layout.cancelDrag}
        onStartResize={layout.startResize}
        onMoveResize={layout.moveResize}
        onEndResize={layout.endResize}
        onCancelResize={layout.cancelResize}
        onNudgeResize={layout.nudgeResize}
        group={group}
        groups={groups}
        tabs={tabs}
        isActive={activeGroupId === group.id}
        onSelect={onSelect}
        onActivateGroup={onActivateGroup}
        onClose={onClose}
        onChange={onChange}
        onSave={onSave}
        onMoveTab={onMoveTab}
        onCloseGroup={onCloseGroup}
      />;
    return layout.mode === "tiled" ? <Fragment key={group.id}>
      <Panel id={group.id} order={index} minSize={minPanelSize} defaultSize={100 / groups.length} className="editor-split-panel">{pane}</Panel>
      {index < groups.length - 1 && <PanelResizeHandle className="editor-split-resize" aria-label={`Resize between ${group.name} and ${groups[index + 1].name}`} />}
    </Fragment> : <Fragment key={group.id}>{pane}</Fragment>;
  });
  return <section className="code-workspace" aria-label="Code editor">
    <div
      ref={layout.surfaceRef}
      className={"editor-groups-layout" + (layout.mode === "free" ? " free" : "")}
      style={{ "--editor-group-count": groups.length } as CSSProperties & { "--editor-group-count": number }}
    >
      {layout.mode === "tiled" ? <PanelGroup
        key={workspaceId}
        direction="horizontal"
        className="editor-split-group"
        autoSaveId={`yerminal.editor-split.${workspaceId}.${groups.map((group) => group.id).join(".")}`}
        style={{ minWidth: groups.length * minGroupWidth }}
      >{groupViews}</PanelGroup> : groupViews}
      {layout.dockTarget && <div className="editor-group-dock-guides" aria-hidden="true">
        <div className={"editor-group-dock-guide left" + (layout.dockTarget === "left" ? " active" : "")} />
        <div className={"editor-group-dock-guide right" + (layout.dockTarget === "right" ? " active" : "")} />
        <div className={"editor-group-dock-guide top" + (layout.dockTarget === "top" ? " active" : "")} />
        <div className={"editor-group-dock-guide bottom" + (layout.dockTarget === "bottom" ? " active" : "")} />
      </div>}
    </div>
  </section>;
}
