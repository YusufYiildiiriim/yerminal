import { Fragment, useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { MonacoCodeEditor } from "./MonacoCodeEditor";
import { DEFAULT_LANGUAGES, type EditorLanguageId } from "./editorLanguages";
import type { AppSettings } from "../settings/SettingsDialog";
import { DiffView } from "../git/DiffView";
import type { DiffVersions } from "../git/diffEditorModel";
import { useFloatingEditorLayout, type EditorLayoutMode, type EditorResizeDirection } from "./floatingEditorLayout";
import { PointerMenu, type PointerMenuTarget } from "../workspace/PointerMenu";
import { editorTabMenuItems } from "./editorTabMenu";
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
  diffVersions?: DiffVersions | null;
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
  settings?: AppSettings;
  onChooseLanguages?: () => void;
  onConfirmLanguages?: () => void;
  tabs: EditorFileTab[];
  groups: EditorGroupState[];
  activeGroupId: string;
  onSelect: (groupId: string, tabId: string) => void;
  onActivateGroup: (groupId: string) => void;
  onClose: (tabId: string) => void | Promise<void>;
  onChange: (tabId: string, content: string) => void;
  onSave: (tabId: string) => void;
  onMoveTab: (tabId: string, groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onModeState: (mode: EditorLayoutMode, setMode: (mode: EditorLayoutMode) => void) => void;
};

type EditorGroupPaneProps = {
  enabledLanguages: readonly EditorLanguageId[];
  fontFamily: string;
  fontSize: number;
  minimap: boolean;
  theme: AppSettings["theme"];
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
  onClose: (tabId: string) => void | Promise<void>;
  onChange: (tabId: string, content: string) => void;
  onSave: (tabId: string) => void;
  onMoveTab: (tabId: string, groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
};

function normalizeNewlines(content: string | null): string {
  return (content ?? "").replace(/\r\n/g, "\n");
}

function EditorGroupPane({ enabledLanguages, fontFamily, fontSize, minimap, theme, layoutMode, groupStyle, dragging, resizing, onStartDrag, onMoveDrag, onEndDrag, onCancelDrag, onStartResize, onMoveResize, onEndResize, onCancelResize, onNudgeResize, group, groups, tabs, isActive, onSelect, onActivateGroup, onClose, onChange, onSave, onMoveTab, onCloseGroup }: EditorGroupPaneProps) {
  const groupTabs = group.tabIds.map((id) => tabs.find((tab) => tab.id === id)).filter((tab): tab is EditorFileTab => Boolean(tab));
  const activeTab = groupTabs.find((tab) => tab.id === group.activeTabId) ?? null;
  const isReadOnly = Boolean(activeTab?.sourceCommitId) || activeTab?.view === "diff";
  const isDirty = Boolean(activeTab && activeTab.content !== null && normalizeNewlines(activeTab.content) !== normalizeNewlines(activeTab.savedContent));
  const [tabMenu, setTabMenu] = useState<PointerMenuTarget | null>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  // One at a time: each close can stop at its own unsaved-changes prompt, and a cancelled prompt must not skip the rest.
  const closeTabs = async (tabIds: readonly string[]) => {
    for (const tabId of tabIds) await onClose(tabId);
  };
  const openTabMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const tabElement = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tab-id]") : null;
    const tabId = tabElement?.dataset.tabId ?? null;
    const groupTabIds = groupTabs.map((tab) => tab.id);
    setTabMenu({ x: event.clientX, y: event.clientY, label: "Editor tab actions", items: editorTabMenuItems({ tabId, groupTabIds }, { closeTabs }) });
  };

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
    <PointerMenu target={tabMenu} onClose={closeTabMenu} />
    <nav className="editor-file-tabs" role="tablist" aria-label={group.name + " open files"} onContextMenu={openTabMenu}>
      {groupTabs.map((tab) => <div className={"editor-file-tab" + (group.activeTabId === tab.id ? " selected" : "")} key={tab.id} data-tab-id={tab.id} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); onClose(tab.id); }}>
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
      <div className="code-editor-layout">
      <div className={"code-editor-content" + (activeTab.view === "diff" ? " is-diff" : " is-monaco")}>
        {activeTab.view === "diff" ? activeTab.status === "error" ? <div className="code-editor-message code-editor-error" role="alert"><span className="code-editor-message-icon">!</span><strong>Could not open this diff</strong><span>{activeTab.error}</span></div> : <DiffView diff={activeTab.content ?? ""} path={activeTab.path} root={activeTab.root} staged={activeTab.diffStaged === true} sideLabel={activeTab.sourceCommitId ? activeTab.snapshot?.shortId ?? activeTab.sourceCommitId.slice(0, 8) : undefined} loading={activeTab.status === "loading"} emptyMessage="No diff available for this selection." versions={activeTab.diffVersions ?? null} enabledLanguages={enabledLanguages} theme={theme} fontFamily={fontFamily} fontSize={fontSize} /> : activeTab.status === "loading" ? <div className="code-editor-message" role="status"><span className="editor-loading-indicator" /><span>Loading file content…</span></div> : activeTab.status === "error" ? <div className="code-editor-message code-editor-error" role="alert"><span className="code-editor-message-icon">!</span><strong>Could not open this file</strong><span>{activeTab.error}</span></div> : <MonacoCodeEditor key={activeTab.id} id={activeTab.id} path={activeTab.path} name={activeTab.name} value={activeTab.content ?? ""} readOnly={isReadOnly} enabledLanguages={enabledLanguages} fontFamily={fontFamily} fontSize={fontSize} minimap={minimap} theme={theme} onChange={(content) => onChange(activeTab.id, content)} onSave={() => onSave(activeTab.id)} />}
      </div>
      </div>
      <footer className="code-editor-statusbar" aria-live="polite">
        <span className={activeTab.saveError ? "code-editor-save-error" : ""}>{activeTab.saveError ?? (activeTab.isSaving ? "Saving changes…" : isDirty ? "Unsaved changes" : isReadOnly ? activeTab.view === "diff" ? "Read-only diff" : "Read-only commit snapshot" : activeTab.status === "ready" ? "All changes saved" : activeTab.status === "loading" ? "Loading" : "Unavailable")}</span>
        <span>{activeTab.status === "ready" ? (activeTab.content?.split(/\r?\n/).length ?? 0) + " lines" : ""}</span><span>UTF-8</span>
      </footer>
    </> : <div className="code-editor-empty"><h2>No file open</h2><p>Open a file from the explorer or Git history.</p></div>}
  </section>;
}

export function CodeWorkspace({ workspaceId, settings, onChooseLanguages, onConfirmLanguages, tabs, groups, activeGroupId, onSelect, onActivateGroup, onClose, onChange, onSave, onMoveTab, onCloseGroup, onModeState }: CodeWorkspaceProps) {
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
        enabledLanguages={settings?.enabledLanguages ?? DEFAULT_LANGUAGES}
        fontFamily={settings?.editorFontFamily ?? '"Cascadia Code", Consolas, monospace'}
        fontSize={settings?.editorFontSize ?? 13}
        minimap={settings?.editorMinimap !== false}
        theme={settings?.theme ?? "obsidian"}
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
    {settings && !settings.languageSetupComplete && tabs.length > 0 && <div className="editor-language-welcome"><span>Choose the languages you use. You can change them later in Settings.</span><button type="button" onClick={onChooseLanguages}>Choose languages</button><button type="button" onClick={onConfirmLanguages}>Use defaults</button></div>}
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
