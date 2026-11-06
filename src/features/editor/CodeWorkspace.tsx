import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { highlightCode } from "./highlighter";
import { CommitSnapshotBanner } from "./CommitSnapshotBanner";
import { useFloatingEditorLayout, type EditorLayoutMode } from "./floatingEditorLayout";
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
  onCreateGroup: () => void;
  onMoveTab: (tabId: string, groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
};

type EditorGroupPaneProps = {
  layoutMode: EditorLayoutMode;
  groupStyle: CSSProperties;
  dragging: boolean;
  onStartDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onMoveDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onEndDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onCancelDrag: (groupId: string, event: ReactPointerEvent<HTMLElement>) => void;
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

function EditorGroupPane({ layoutMode, groupStyle, dragging, onStartDrag, onMoveDrag, onEndDrag, onCancelDrag, group, groups, tabs, isActive, onSelect, onActivateGroup, onClose, onChange, onSave, onMoveTab, onCloseGroup }: EditorGroupPaneProps) {
  const groupTabs = group.tabIds.map((id) => tabs.find((tab) => tab.id === id)).filter((tab): tab is EditorFileTab => Boolean(tab));
  const activeTab = groupTabs.find((tab) => tab.id === group.activeTabId) ?? null;
  const language = useMemo(() => activeTab ? detectLanguage(activeTab.path) : null, [activeTab?.path]);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [highlighting, setHighlighting] = useState(false);
  const isReadOnly = Boolean(activeTab?.sourceCommitId);
  const isDirty = Boolean(activeTab && activeTab.content !== null && normalizeNewlines(activeTab.content) !== normalizeNewlines(activeTab.savedContent));

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && activeTab && !isReadOnly) {
      event.preventDefault();
      onSave(activeTab.id);
    }
  };

  useEffect(() => {
    let current = true;
    setHighlightedHtml(null);
    if (!activeTab || activeTab.status !== "ready" || activeTab.content === null || !language?.id || language.id === "plaintext") {
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
    aria-label={group.name}
    onMouseDown={() => onActivateGroup(group.id)}
    onKeyDown={handleKeyDown}
  >
    <header
      className={"editor-group-heading" + (layoutMode === "free" ? " free" : "")}
      onPointerDown={layoutMode === "free" ? (event) => { onActivateGroup(group.id); onStartDrag(group.id, event); } : undefined}
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
    </header>
    <nav className="editor-file-tabs" role="tablist" aria-label={group.name + " open files"}>
      {groupTabs.map((tab) => <div className={"editor-file-tab" + (group.activeTabId === tab.id ? " selected" : "")} key={tab.id}>
        <button className="editor-file-tab-select" role="tab" aria-selected={group.activeTabId === tab.id} onClick={() => onSelect(group.id, tab.id)} type="button" title={tab.path}>
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
        <div className="code-editor-breadcrumb" title={activeTab.path}><span>{activeTab.root.split(/[\\/]/).filter(Boolean).pop() ?? activeTab.root}</span><span className="code-editor-separator">›</span><strong>{activeTab.path}</strong></div>
        <div className="code-editor-meta"><span>{language?.label ?? "Plain Text"}</span>{activeTab.sourceLabel && <span className="code-editor-source-label" title={activeTab.sourceLabel}>{activeTab.sourceLabel}</span>}{isReadOnly ? <span className="code-editor-readonly">Read only</span> : <><span className={"code-editor-editable-badge" + (isDirty ? " dirty" : "")}>{isDirty ? "Unsaved changes" : "Editable"}</span><button className="code-editor-save" type="button" disabled={activeTab.status !== "ready" || !isDirty || activeTab.isSaving} onClick={() => onSave(activeTab.id)}>{activeTab.isSaving ? "Saving…" : "Save"}<kbd>Ctrl S</kbd></button></>}</div>
      </header>
      <div className="code-editor-content" key={activeTab.id}>
        {activeTab.status === "loading" ? <div className="code-editor-message" role="status"><span className="editor-loading-indicator" /><span>Loading file content…</span></div> : activeTab.status === "error" ? <div className="code-editor-message code-editor-error" role="alert"><span className="code-editor-message-icon">!</span><strong>Could not open this file</strong><span>{activeTab.error}</span></div> : isReadOnly ? highlightedHtml ? <div className="code-editor-highlighted" dangerouslySetInnerHTML={{ __html: highlightedHtml }} /> : <pre className={"code-editor-plain" + (highlighting ? " is-highlighting" : "")} tabIndex={0} aria-label={"Contents of " + activeTab.name}><code>{activeTab.content}</code></pre> : <div className="code-editor-editable-surface">
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
      <footer className="code-editor-statusbar" aria-live="polite"><span className={activeTab.saveError ? "code-editor-save-error" : ""}>{activeTab.saveError ?? (activeTab.isSaving ? "Saving changes…" : isDirty ? "Unsaved changes" : isReadOnly ? "Read-only commit snapshot" : activeTab.status === "ready" ? "All changes saved" : activeTab.status === "loading" ? "Loading" : "Unavailable")}</span><span>{activeTab.status === "ready" ? (activeTab.content?.split(/\r?\n/).length ?? 0) + " lines" : ""}</span><span>UTF-8</span><span>{language?.label ?? "Plain Text"}</span></footer>
    </> : <div className="code-editor-empty"><div className="code-editor-empty-icon">⌘</div><h2>Open a file in this group</h2><p>Choose a file from the workspace explorer or Git history. It will open in this editor group.</p></div>}
  </section>;
}

export function CodeWorkspace({ workspaceId, tabs, groups, activeGroupId, onSelect, onActivateGroup, onClose, onChange, onSave, onCreateGroup, onMoveTab, onCloseGroup }: CodeWorkspaceProps) {
  const layout = useFloatingEditorLayout(workspaceId, groups.map((group) => group.id));
  return <section className="code-workspace" aria-label="Code editor">
    <header className="editor-groups-toolbar">
      <div className="editor-groups-title"><span aria-hidden="true">▤</span>Editor groups<span className="editor-groups-count">{groups.length}</span></div>
      <div className="editor-groups-toolbar-actions">
        <div className="editor-layout-mode-toggle" role="group" aria-label="Editor group layout mode">
          <button className={layout.mode === "tiled" ? "selected" : ""} type="button" aria-pressed={layout.mode === "tiled"} onClick={() => layout.setMode("tiled")} title="Use the default split editor layout">Split</button>
          <button className={layout.mode === "free" ? "selected" : ""} type="button" aria-pressed={layout.mode === "free"} onClick={() => layout.setMode("free")} title="Move editor groups freely around the canvas">Free</button>
        </div>
        <button className="editor-create-group" type="button" onClick={onCreateGroup}><span aria-hidden="true">＋</span>New group</button>
      </div>
    </header>
    <div
      ref={layout.surfaceRef}
      className={"editor-groups-layout" + (layout.mode === "free" ? " free" : "")}
      style={{ "--editor-group-count": groups.length } as CSSProperties & { "--editor-group-count": number }}
    >
      {groups.map((group) => <EditorGroupPane
        key={group.id}
        layoutMode={layout.mode}
        groupStyle={layout.getWindowStyle(group.id)}
        dragging={layout.draggingGroupId === group.id}
        onStartDrag={layout.startDrag}
        onMoveDrag={layout.moveDrag}
        onEndDrag={layout.endDrag}
        onCancelDrag={layout.cancelDrag}
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
      />)}
      {layout.dockTarget && <div className="editor-group-dock-guides" aria-hidden="true">
        <div className={"editor-group-dock-guide left" + (layout.dockTarget === "left" ? " active" : "")} />
        <div className={"editor-group-dock-guide right" + (layout.dockTarget === "right" ? " active" : "")} />
        <div className={"editor-group-dock-guide top" + (layout.dockTarget === "top" ? " active" : "")} />
        <div className={"editor-group-dock-guide bottom" + (layout.dockTarget === "bottom" ? " active" : "")} />
      </div>}
    </div>
  </section>;
}
