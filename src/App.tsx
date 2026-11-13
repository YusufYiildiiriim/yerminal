import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { DiffViewer } from "./features/git/DiffViewer";
import { TerminalResourceGraph } from "./features/terminal/TerminalResourceGraph";
import { CodeWorkspace, type EditorFileTab, type EditorGroupState } from "./features/editor/CodeWorkspace";
import { QuickOpenDialog, type QuickOpenFile } from "./features/editor/QuickOpenDialog";
import type { EditorLayoutMode } from "./features/editor/floatingEditorLayout";
import { FloatingTerminalDockGuides, FloatingTerminalModeToggle } from "./features/terminal/FloatingTerminalLayoutControls";
import { useFloatingTerminalLayout, type TerminalDockEdge, type TerminalLayoutMode } from "./features/terminal/floatingTerminalLayout";
import { ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SettingsDialog, type AppSettings } from "./features/settings/SettingsDialog";
import { WorkspaceViewLayout } from "./features/workspace/WorkspaceViewLayout";
import { FolderContextMenu, type FolderContextMenuAction, type FolderContextMenuTarget } from "./features/explorer/FolderContextMenu";
import { appendTerminalToLayout, closeTerminalGroup as closeTerminalGroupState, createInitialTerminalGroups, createTerminalGroup, moveTerminalBetweenGroups, openFolderInNewTerminal, removeTerminalFromGroups, selectTerminalGroup as selectTerminalGroupState, type TerminalGroup } from "./features/terminal/terminalWorkspaceActions";
import "./styles/app.css";
import "./styles/themes.css";
import "./styles/sidebar-ux.css";
import "./styles/workbench-ux.css";
import "./styles/git-ux.css";

const TerminalPane = lazy(() => import("./features/terminal/TerminalPane"));

type TerminalNameEditorProps = {
  terminalName: string;
  value: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  compact?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

function TerminalNameEditor({ terminalName, value, inputRef, compact = false, onChange, onSave, onCancel }: TerminalNameEditorProps) {
  return <form className={`terminal-name-editor ${compact ? "compact" : ""}`} aria-label={`Rename ${terminalName}`} onSubmit={(event) => { event.preventDefault(); onSave(); }} onClick={(event) => event.stopPropagation()}>
    <input ref={inputRef} aria-label={`New name for ${terminalName}`} autoComplete="off" maxLength={60} value={value} onChange={(event) => onChange(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }} />
    <button className="terminal-name-save" type="submit" aria-label={`Save name for ${terminalName}`} title="Save name">✓</button>
    <button className="terminal-name-cancel" type="button" aria-label={`Cancel renaming ${terminalName}`} title="Cancel" onClick={onCancel}>×</button>
  </form>;
}

type ToolId = "explorer" | "changes" | "graph";
type ShellKind = "powershell" | "bash" | "zsh";
type TerminalSession = { id: string; name: string; shell: ShellKind; shellLabel: string; profileId?: string; workingDirectory: string | null };
type LayoutNode = { type: "terminal"; sessionId: string } | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; children: [LayoutNode, LayoutNode] };
type RepositoryInfo = { root: string; branch: string; state: string };
type FileChange = { path: string; kind: string; staged: boolean; unstaged: boolean };
type CommitInfo = { id: string; shortId: string; message: string; author: string; timestamp: number; parents: string[]; branches: string[] };
type CommitFileChange = { path: string; kind: string };
type WorkspaceEntry = { name: string; path: string; isDir: boolean; size: number | null; extension: string | null };
const WORKSPACE_FILE_PREVIEW_LIMIT = 1024 * 1024;
type EditorWorkspaceState = { tabs: EditorFileTab[]; groups: EditorGroupState[]; activeGroupId: string };
type EditorSnapshot = { shortId: string; message: string; changeKind: string; author: string; timestamp: number };
type EditorFileRequest = { id: string; root: string; path: string; name: string; size?: number; sourceCommitId?: string; sourceLabel?: string; snapshot?: EditorSnapshot; view?: "text" | "diff"; diffStaged?: boolean };
const COMMIT_PAGE_SIZE = 50;
type PersistedWorkspace = { folders: string[]; activePath: string };
type TerminalWorkspace = { id: string; name: string; rootPath: string; folderPaths: string[]; terminalIds: string[]; activeTerminalId: string | null; layout: LayoutNode | null; groups: TerminalGroup[]; activeGroupId: string };
type TerminalWorkspaceState = { workspaces: TerminalWorkspace[]; activeId: string };
type PersistedTerminalWorkspace = { id: string; name: string; rootPath: string; folderPaths: string[] };

const DEFAULT_EDITOR_GROUP_ID = "editor-group-default";

function createEmptyEditorWorkspaceState(): EditorWorkspaceState {
  return { tabs: [], groups: [{ id: DEFAULT_EDITOR_GROUP_ID, name: "Editor 1", tabIds: [], activeTabId: null }], activeGroupId: DEFAULT_EDITOR_GROUP_ID };
}

const WORKSPACE_STORAGE_KEY = "yerminal.workspace";
const TERMINAL_WORKSPACES_STORAGE_KEY = "yerminal.terminal-workspaces";
const TOOL_PANEL_AUTO_HIDE_KEY = "yerminal.tool-panel-auto-hide";
const HELP_SHORTCUTS = [
  { keys: "Ctrl/⌘ + Shift + T", label: "New terminal" },
  { keys: "Ctrl/⌘ + Shift + W", label: "Close active terminal" },
  { keys: "Ctrl/⌘ + Shift + H", label: "Split terminal horizontally" },
  { keys: "Ctrl/⌘ + Shift + V", label: "Split terminal vertically" },
  { keys: "Ctrl/⌘ + Shift + G", label: "Open Git Changes" },
  { keys: "Ctrl/⌘ + Shift + B", label: "Open Git Graph" },
  { keys: "Ctrl/⌘ + Tab", label: "Focus next terminal" },
  { keys: "Ctrl/⌘ + Shift + Tab", label: "Focus previous terminal" },
  { keys: "Alt + Shift + Arrow", label: "Resize a Free pane/group (focus a resize edge)" },
  { keys: "Ctrl/⌘ + P", label: "Quick Open files" },
  { keys: "Ctrl/⌘ + S", label: "Save active code file" },
  { keys: "Tab", label: "Insert four spaces in the code editor" },
  { keys: "Esc", label: "Close Help or commit details; cancel terminal rename" },
] as const;

function readWorkspace(): PersistedWorkspace {
  try {
    const value = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!value) return { folders: [], activePath: "" };
    const parsed = JSON.parse(value) as Partial<PersistedWorkspace>;
    const folders = normalizeWorkspaceFolders(parsed.folders);
    return { folders, activePath: typeof parsed.activePath === "string" && folders.includes(parsed.activePath) ? parsed.activePath : folders[0] ?? "" };
  } catch {
    return { folders: [], activePath: "" };
  }
}

function mergeWorkspaceFolders(current: string[], additions: string[]): string[] {
  const isWindows = navigator.userAgent.includes("Windows");
  const key = (path: string) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
    return isWindows ? normalized.toLocaleLowerCase() : normalized;
  };
  const known = new Set(current.map(key));
  return [...current, ...additions.filter((path) => {
    const normalized = key(path);
    if (!normalized || known.has(normalized)) return false;
    known.add(normalized);
    return true;
  })];
}

function normalizeWorkspaceFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return mergeWorkspaceFolders([], value.filter((folder): folder is string => typeof folder === "string" && folder.length > 0));
}

function syncTerminalGroups(workspace: TerminalWorkspace, groups: TerminalGroup[], activeGroupId: string): TerminalWorkspace {
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? createInitialTerminalGroups().groups[0];
  const safeGroups = groups.length > 0 ? groups : [activeGroup];
  return {
    ...workspace,
    groups: safeGroups,
    activeGroupId: activeGroup.id,
    terminalIds: safeGroups.flatMap((group) => group.terminalIds),
    activeTerminalId: activeGroup.activeTerminalId,
    layout: activeGroup.layout,
  };
}

function updateActiveTerminalGroup(workspace: TerminalWorkspace, update: (group: TerminalGroup) => TerminalGroup): TerminalWorkspace {
  const group = workspace.groups.find((item) => item.id === workspace.activeGroupId) ?? workspace.groups[0];
  if (!group) return workspace;
  return syncTerminalGroups(workspace, workspace.groups.map((item) => item.id === group.id ? update(item) : item), group.id);
}

function updateTerminalGroup(workspace: TerminalWorkspace, groupId: string, update: (group: TerminalGroup) => TerminalGroup): TerminalWorkspace {
  if (!workspace.groups.some((group) => group.id === groupId)) return workspace;
  return syncTerminalGroups(workspace, workspace.groups.map((group) => group.id === groupId ? update(group) : group), workspace.activeGroupId);
}

function readTerminalWorkspaceState(): TerminalWorkspaceState {
  const legacyWorkspace = readWorkspace();
  try {
    const value = localStorage.getItem(TERMINAL_WORKSPACES_STORAGE_KEY);
    const parsed: unknown = value ? JSON.parse(value) : null;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const workspaces: TerminalWorkspace[] = [];
      const folderStateIds = new Set<string>();
      const seenIds = new Set<string>();
      const rows: unknown[] = Array.isArray(record.workspaces) ? record.workspaces : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const workspace = row as Record<string, unknown>;
        const id = typeof workspace.id === "string" ? workspace.id.trim() : "";
        const name = typeof workspace.name === "string" ? workspace.name.trim() : "";
        const savedRootPath = typeof workspace.rootPath === "string" ? workspace.rootPath : "";
        const hasFolderState = Array.isArray(workspace.folderPaths);
        const folderPaths = hasFolderState ? normalizeWorkspaceFolders(workspace.folderPaths) : [];
        if (!id || !name || seenIds.has(id)) continue;
        seenIds.add(id);
        if (hasFolderState) folderStateIds.add(id);
        workspaces.push({
          id,
          name,
          rootPath: hasFolderState && savedRootPath && !folderPaths.includes(savedRootPath) ? "" : savedRootPath,
          folderPaths,
          terminalIds: [],
          activeTerminalId: null,
          layout: null,
          ...createInitialTerminalGroups(),
        });
      }
      if (workspaces.length > 0) {
        const activeId = typeof record.activeId === "string" && workspaces.some((workspace) => workspace.id === record.activeId)
          ? record.activeId
          : workspaces[0].id;
        const migratedWorkspaces = workspaces.map((workspace) => {
          if (folderStateIds.has(workspace.id)) return workspace;
          if (workspace.id === activeId) {
            const folderPaths = mergeWorkspaceFolders(legacyWorkspace.folders, workspace.rootPath ? [workspace.rootPath] : []);
            const rootPath = legacyWorkspace.activePath && folderPaths.includes(legacyWorkspace.activePath)
              ? legacyWorkspace.activePath
              : workspace.rootPath && folderPaths.includes(workspace.rootPath)
                ? workspace.rootPath
                : folderPaths[0] ?? "";
            return { ...workspace, folderPaths, rootPath };
          }
          const folderPaths = workspace.rootPath ? [workspace.rootPath] : [];
          return { ...workspace, folderPaths, rootPath: folderPaths[0] ?? "" };
        });
        return { workspaces: migratedWorkspaces, activeId };
      }
    }
  } catch {
    // Invalid or unavailable local storage falls back to the legacy workspace root.
  }
  const id = crypto.randomUUID();
  const folderPaths = legacyWorkspace.folders;
  const rootPath = legacyWorkspace.activePath && folderPaths.includes(legacyWorkspace.activePath)
    ? legacyWorkspace.activePath
    : folderPaths[0] ?? "";
  return {
    workspaces: [{ id, name: "Workspace 1", rootPath, folderPaths, terminalIds: [], activeTerminalId: null, layout: null, ...createInitialTerminalGroups() }],
    activeId: id,
  };
}
function changeDirectoryCommand(shell: ShellKind, path: string): string {
  if (shell === "powershell") {
    const escapedPath = path.replace(/'/g, "''");
    return `Set-Location -LiteralPath '${escapedPath}'\r`;
  }
  const escapedPath = path.replace(/'/g, "'\\''");
  return `cd -- '${escapedPath}'\n`;
}

function joinWorkspacePath(parentPath: string, name: string): string {
  const separator = parentPath.includes("\\") ? "\\" : "/";
  return parentPath.endsWith(separator) ? `${parentPath}${name}` : `${parentPath}${separator}${name}`;
}

function editorOperationKey(workspaceId: string, tabId: string): string {
  return JSON.stringify([workspaceId, tabId]);
}

function editorResourceKey(path: string): string {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const key = normalize(path);
  return navigator.userAgent.includes("Windows") ? key.toLowerCase() : key;
}

function normalizeEditorNewlines(content: string | null): string {
  return (content ?? "").replace(/\r\n/g, "\n");
}

function isEditorTabUnsaved(tab: EditorFileTab): boolean {
  return tab.content !== null && normalizeEditorNewlines(tab.content) !== normalizeEditorNewlines(tab.savedContent);
}

function preserveEditorLineEndings(content: string, original: string): string {
  return original.includes("\r\n") ? content.replace(/\r?\n/g, "\r\n") : content.replace(/\r\n/g, "\n");
}

const tools: { id: ToolId; label: string; icon: string }[] = [
  { id: "explorer", label: "Explorer", icon: "▤" },
  { id: "changes", label: "Git Changes", icon: "◫" },
  { id: "graph", label: "Git Graph", icon: "⌘" },
];

const SETTINGS_KEY = "yerminal.app-settings.v1";
const DEFAULT_SETTINGS: AppSettings = { theme: "obsidian", editorFontFamily: '"Cascadia Code", Consolas, monospace', editorFontSize: 13, terminalFontFamily: '"Cascadia Code", Consolas, monospace', terminalFontSize: 13, quickOpenScope: "active", collapseOtherFolders: false, autoSave: false };
function readAppSettings(): AppSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return {
      theme: raw.theme === "nordic" || raw.theme === "foundry" ? raw.theme : "obsidian",
      editorFontFamily: typeof raw.editorFontFamily === "string" && raw.editorFontFamily.trim() ? raw.editorFontFamily : DEFAULT_SETTINGS.editorFontFamily,
      terminalFontFamily: typeof raw.terminalFontFamily === "string" && raw.terminalFontFamily.trim() ? raw.terminalFontFamily : DEFAULT_SETTINGS.terminalFontFamily,
      editorFontSize: typeof raw.editorFontSize === "number" && Number.isFinite(raw.editorFontSize) ? Math.max(8, Math.min(40, raw.editorFontSize)) : DEFAULT_SETTINGS.editorFontSize,
      terminalFontSize: typeof raw.terminalFontSize === "number" && Number.isFinite(raw.terminalFontSize) ? Math.max(8, Math.min(40, raw.terminalFontSize)) : DEFAULT_SETTINGS.terminalFontSize,
      quickOpenScope: raw.quickOpenScope === "all" ? "all" : "active",
      collapseOtherFolders: raw.collapseOtherFolders === true,
      autoSave: raw.autoSave === true,
    };
  } catch { return DEFAULT_SETTINGS; }
}
function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("explorer");
  const [toolPanelAutoHide, setToolPanelAutoHide] = useState(() => {
    try {
      return localStorage.getItem(TOOL_PANEL_AUTO_HIDE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toolsPanelRef = useRef<ImperativePanelHandle>(null);
  const [toolsPanelCollapsed, setToolsPanelCollapsed] = useState(false);
  const toolClickRef = useRef<{ toolId: ToolId; initiallyCollapsed: boolean } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [activeMainView, setActiveMainView] = useState<"code" | "terminals">("terminals");
  const [terminalLayoutMode, setTerminalLayoutMode] = useState<TerminalLayoutMode>("tiled");
  const [editorLayoutMode, setEditorLayoutMode] = useState<EditorLayoutMode>("tiled");
  const [terminalViews, setTerminalViews] = useState<Record<string, string | null>>({});
  const [terminalWorkspaceState, setTerminalWorkspaceState] = useState<TerminalWorkspaceState>(() => readTerminalWorkspaceState());
  const [editorWorkspaces, setEditorWorkspaces] = useState<Record<string, EditorWorkspaceState>>({});
  const editorOperationIdsRef = useRef(new Map<string, number>());
  const nextEditorOperationIdRef = useRef(0);
  const savingEditorFilesRef = useRef(new Set<string>());
  const pendingEditorSavesRef = useRef(new Map<string, Promise<void>>());
  const autoSaveTimersRef = useRef(new Map<string, { content: string; timer: ReturnType<typeof setTimeout> | null }>());
  const autoSaveQueuedRef = useRef(new Set<string>());

  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [terminalNameDraft, setTerminalNameDraft] = useState("");
  const terminalNameInputRef = useRef<HTMLInputElement>(null);
  const terminalDirectoryTargetsRef = useRef(new Map<string, string>());
  const terminalDirectoryWritesRef = useRef(new Map<string, Promise<void>>());
  const terminalTabsRef = useRef<HTMLDivElement>(null);
  const terminalTabScrollTargetRef = useRef<{ workspaceId: string; terminalId: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [workspaceFolderRefresh, setWorkspaceFolderRefresh] = useState<{ root: string; path: string; nonce: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [terminalUsageOpen, setTerminalUsageOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [settings, setSettings] = useState<AppSettings>(readAppSettings);
  const initializedWorkspaceIdsRef = useRef(new Set<string>());
  const floatingModeSetterRef = useRef<((mode: TerminalLayoutMode) => void) | null>(null);
  const editorModeSetterRef = useRef<((mode: EditorLayoutMode) => void) | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTerminalWorkspace = terminalWorkspaceState.workspaces.find((workspace) => workspace.id === terminalWorkspaceState.activeId) ?? terminalWorkspaceState.workspaces[0];
  const selectedTerminalView = terminalViews[activeTerminalWorkspace?.id ?? ""] ?? null;
  const focusedTerminalView = selectedTerminalView && activeTerminalWorkspace?.terminalIds.includes(selectedTerminalView) ? selectedTerminalView : null;
  const selectTerminalView = (id: string | null) => {
    if (activeTerminalWorkspace) {
      setTerminalViews((current) => ({ ...current, [activeTerminalWorkspace.id]: id }));
      const group = activeTerminalWorkspace.groups.find((item) => item.id === activeTerminalWorkspace.activeGroupId) ?? activeTerminalWorkspace.groups[0];
      if (!id && group && !group.layout && group.terminalIds.length > 1) {
        updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => updateActiveTerminalGroup(workspace, (active) => ({ ...active, layout: active.layout ?? buildTerminalLayout(active.terminalIds) })));
      }
    }
    if (id) focusTerminal(id);
  };
  const workspaceFolders = activeTerminalWorkspace?.folderPaths ?? [];
  const activeWorkspaceTerminalIds = activeTerminalWorkspace?.terminalIds ?? [];
  const activeTerminalGroup = activeTerminalWorkspace?.groups.find((group) => group.id === activeTerminalWorkspace.activeGroupId) ?? activeTerminalWorkspace?.groups[0] ?? null;
  const activeGroupTerminalIds = activeTerminalGroup?.terminalIds ?? [];
  const activeWorkspaceTerminals = terminals.filter((terminal) => activeWorkspaceTerminalIds.includes(terminal.id));
  const activeGroupTerminals = activeWorkspaceTerminals.filter((terminal) => activeGroupTerminalIds.includes(terminal.id));
  const repoPath = activeTerminalWorkspace?.rootPath ?? "";
  const activeTerminalId = activeTerminalWorkspace?.activeTerminalId ?? null;
  const layout = activeTerminalWorkspace?.layout ?? null;
  const activeEditorWorkspace = editorWorkspaces[activeTerminalWorkspace?.id ?? ""] ?? createEmptyEditorWorkspaceState();

  const handleToolClick = (toolId: ToolId, clickCount: number) => {
    setActiveTool(toolId);
    const firstClick = toolClickRef.current;
    if (clickCount >= 2 && firstClick?.toolId === toolId) {
      if (firstClick.initiallyCollapsed) {
        toolsPanelRef.current?.expand();
        setToolsPanelCollapsed(false);
      } else {
        toolsPanelRef.current?.collapse();
        setToolsPanelCollapsed(true);
      }
      toolClickRef.current = null;
      return;
    }
    toolClickRef.current = { toolId, initiallyCollapsed: toolsPanelCollapsed };
    if (toolsPanelCollapsed) {
      toolsPanelRef.current?.expand();
      setToolsPanelCollapsed(false);
    }
  };

  useEffect(() => {
    const tabs = terminalTabsRef.current;
    const workspaceId = activeTerminalWorkspace?.id;
    if (!tabs || activeMainView !== "terminals" || !workspaceId) return;

    const pendingTarget = terminalTabScrollTargetRef.current;
    if (pendingTarget && pendingTarget.workspaceId !== workspaceId) terminalTabScrollTargetRef.current = null;
    const terminalId = pendingTarget?.workspaceId === workspaceId
      ? pendingTarget.terminalId
      : focusedTerminalView ?? activeTerminalId;
    if (!terminalId) return;
    const target = Array.from(tabs.querySelectorAll<HTMLElement>("[data-terminal-id]"))
      .find((element) => element.dataset.terminalId === terminalId);
    if (!target) return;

    let frameId = 0;
    const scrollTargetIntoView = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const tabsBounds = tabs.getBoundingClientRect();
        const targetBounds = target.getBoundingClientRect();
        if (targetBounds.left < tabsBounds.left) {
          tabs.scrollBy({ left: targetBounds.left - tabsBounds.left, behavior: "smooth" });
        } else if (targetBounds.right > tabsBounds.right) {
          tabs.scrollBy({ left: targetBounds.right - tabsBounds.right, behavior: "smooth" });
        }
        if (terminalTabScrollTargetRef.current?.terminalId === terminalId) terminalTabScrollTargetRef.current = null;
      });
    };
    const observer = new ResizeObserver(scrollTargetIntoView);
    observer.observe(tabs);
    scrollTargetIntoView();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
    };
  }, [activeMainView, activeTerminalId, activeTerminalWorkspace?.id, activeWorkspaceTerminalIds.join("\u0000"), focusedTerminalView]);

  useEffect(() => {
    try {
      localStorage.setItem(TOOL_PANEL_AUTO_HIDE_KEY, String(toolPanelAutoHide));
    } catch {
      // Keep the setting available for the current session when storage is unavailable.
    }
  }, [toolPanelAutoHide]);

  useEffect(() => {
    if (toolPanelAutoHide) {
      toolsPanelRef.current?.collapse();
      setToolsPanelCollapsed(true);
    } else {
      toolsPanelRef.current?.expand();
      setToolsPanelCollapsed(false);
    }
  }, [toolPanelAutoHide]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--editor-font-family", settings.editorFontFamily);
    root.style.setProperty("--editor-font-size", settings.editorFontSize + "px");
    root.style.setProperty("--terminal-font-family", settings.terminalFontFamily);
    root.style.setProperty("--terminal-font-size", settings.terminalFontSize + "px");
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Retain settings in memory. */ }
  }, [settings]);

  const openEditorFile = useCallback(async (request: EditorFileRequest, targetWorkspaceId?: string) => {
    const workspaceId = targetWorkspaceId ?? activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    const tabId = request.id;
    const operationKey = editorOperationKey(workspaceId, tabId);
    const resourceKey = editorResourceKey(request.path);
    setActiveMainView("code");
    const workspace = editorWorkspaces[workspaceId] ?? createEmptyEditorWorkspaceState();
    const existing = workspace.tabs.find((tab) => tab.id === tabId);
    const isDiffRequest = request.view === "diff";
    // Diff tabs reload on every open so the patch never goes stale.
    const shouldLoad = !existing || existing.status === "error" || (isDiffRequest && existing.view === "diff");
    const operationId = shouldLoad ? ++nextEditorOperationIdRef.current : null;
    if (operationId !== null) editorOperationIdsRef.current.set(operationKey, operationId);
    setEditorWorkspaces((current) => {
      const currentWorkspace = current[workspaceId] ?? workspace;
      const currentTab = currentWorkspace.tabs.find((tab) => tab.id === tabId);
      const currentGroup = currentWorkspace.groups.find((group) => group.tabIds.includes(tabId));
      const targetGroupId = currentGroup?.id ?? currentWorkspace.activeGroupId;
      const groups = currentWorkspace.groups.map((group) => {
        if (group.id !== targetGroupId) return group;
        return {
          ...group,
          tabIds: currentTab ? group.tabIds : [...group.tabIds, tabId],
          activeTabId: tabId,
        };
      });
      const tabs = currentTab
        ? currentWorkspace.tabs.map((tab) => tab.id === tabId && (tab.status === "error" || (isDiffRequest && tab.view === "diff")) ? { ...tab, status: "loading" as const, error: null } : tab)
        : [...currentWorkspace.tabs, { id: tabId, root: request.root, path: request.path, name: request.name, status: "loading" as const, content: null, savedContent: null, error: null, sourceLabel: request.sourceLabel ?? null, sourceCommitId: request.sourceCommitId ?? null, snapshot: request.snapshot ?? null, view: request.view, diffStaged: request.diffStaged ?? null, isSaving: false, saveError: null }];
      return { ...current, [workspaceId]: { ...currentWorkspace, tabs, groups, activeGroupId: targetGroupId } };
    });
    if (!shouldLoad || operationId === null) return;

    const isCurrentOperation = () => editorOperationIdsRef.current.get(operationKey) === operationId;
    const updateTab = (update: (tab: EditorFileTab) => EditorFileTab) => {
      if (!isCurrentOperation()) return;
      setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace) return current;
      return { ...current, [workspaceId]: { ...workspace, tabs: workspace.tabs.map((tab) => tab.id === tabId ? update(tab) : tab) } };
      });
    };

    if (request.size !== undefined && request.size > WORKSPACE_FILE_PREVIEW_LIMIT) {
      updateTab((tab) => ({ ...tab, status: "error", error: "This file exceeds the 1 MiB preview limit." }));
      return;
    }
    if (!isTauri()) {
      updateTab((tab) => ({ ...tab, status: "error", error: "File preview is available in the desktop app." }));
      return;
    }

    if (request.view === "diff") {
      try {
        const diff = await invoke<string>("git_diff", { path: request.root, filePath: request.path, staged: request.diffStaged });
        if (!isCurrentOperation()) return;
        if (diff.length > WORKSPACE_FILE_PREVIEW_LIMIT) {
          updateTab((tab) => ({ ...tab, status: "error", error: "This diff exceeds the 1 MiB preview limit." }));
          return;
        }
        updateTab((tab) => ({ ...tab, status: "ready", content: diff, savedContent: diff, sourceLabel: request.diffStaged ? "Index snapshot" : "Working tree snapshot", sourceCommitId: null, snapshot: null, saveError: null }));
      } catch (reason) {
        updateTab((tab) => ({ ...tab, status: "error", error: String(reason) }));
      }
      return;
    }

    try {
      const pendingSave = pendingEditorSavesRef.current.get(resourceKey);
      if (pendingSave) await pendingSave.catch(() => undefined);
      if (!isCurrentOperation()) return;
      const result = request.sourceCommitId
        ? await invoke<{ content: string; sourceLabel: string }>("git_commit_file_content", { path: request.root, commitId: request.sourceCommitId, filePath: request.path })
        : { content: await invoke<string>("read_workspace_text_file", { root: request.root, path: request.path }), sourceLabel: "Workspace file" };
      updateTab((tab) => ({ ...tab, status: "ready", content: result.content, savedContent: result.content, sourceLabel: result.sourceLabel, sourceCommitId: request.sourceCommitId ?? null, snapshot: request.snapshot ?? null, saveError: null }));
    } catch (reason) {
      const message = String(reason);
      const normalized = message.toLowerCase();
      const error = normalized.includes("binary")
        ? "Binary file preview is unavailable."
        : normalized.includes("utf-8")
          ? "This file isn't UTF-8 text and can't be previewed."
          : normalized.includes("too large")
            ? "This file exceeds the 1 MiB preview limit."
            : message;
      updateTab((tab) => ({ ...tab, status: "error", error }));
    }
  }, [activeTerminalWorkspace?.id, editorWorkspaces]);

  const updateEditorFileContent = useCallback((tabId: string, content: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace) return current;
      return {
        ...current,
        [workspaceId]: {
          ...workspace,
          tabs: workspace.tabs.map((tab) => tab.id === tabId && !tab.sourceCommitId && tab.view !== "diff"
            ? { ...tab, content, saveError: null }
            : tab),
        },
      };
    });
  }, [activeTerminalWorkspace?.id]);

  const saveEditorFile = useCallback(async (tabId: string, targetWorkspaceId?: string) => {
    const workspaceId = targetWorkspaceId ?? activeTerminalWorkspace?.id;
    if (!workspaceId || !isTauri()) return;
    const tab = editorWorkspaces[workspaceId]?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.status !== "ready" || tab.sourceCommitId || tab.view === "diff" || tab.content === null || tab.savedContent === null) return;
    if (normalizeEditorNewlines(tab.content) === normalizeEditorNewlines(tab.savedContent)) return;

    const operationKey = editorOperationKey(workspaceId, tabId);
    const resourceKey = editorResourceKey(tab.path);
    if (savingEditorFilesRef.current.has(resourceKey)) return;
    const operationId = ++nextEditorOperationIdRef.current;
    editorOperationIdsRef.current.set(operationKey, operationId);
    savingEditorFilesRef.current.add(resourceKey);
    const contentToSave = preserveEditorLineEndings(tab.content, tab.savedContent);
    const expectedContent = tab.savedContent;
    const isCurrentOperation = () => editorOperationIdsRef.current.get(operationKey) === operationId;
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace) return current;
      return { ...current, [workspaceId]: { ...workspace, tabs: workspace.tabs.map((item) => item.id === tabId ? { ...item, isSaving: true, saveError: null } : item) } };
    });

    let pendingSave: Promise<void> | null = null;
    try {
      pendingSave = invoke<void>("write_workspace_text_file", { root: tab.root, path: tab.path, content: contentToSave, expectedContent });
      pendingEditorSavesRef.current.set(resourceKey, pendingSave);
      await pendingSave;
      if (!isCurrentOperation()) return;
      setEditorWorkspaces((current) => {
        const workspace = current[workspaceId];
        if (!workspace) return current;
        return {
          ...current,
          [workspaceId]: {
            ...workspace,
            tabs: workspace.tabs.map((item) => item.id === tabId ? { ...item, savedContent: contentToSave, isSaving: false, saveError: null } : item),
          },
        };
      });
    } catch (reason) {
      if (!isCurrentOperation()) return;
      const message = String(reason);
      const normalized = message.toLowerCase();
      const saveError = normalized.includes("changed on disk")
        ? "The file changed on disk. Your edits remain here; copy them before closing the tab and reopening the latest version."
        : normalized.includes("outside")
          ? "This file is outside the included workspace folder and cannot be saved."
          : normalized.includes("binary") || normalized.includes("utf-8")
            ? "This file is not supported for text editing."
            : normalized.includes("too large")
              ? "This file exceeds the 1 MiB editing limit."
              : message;
      setEditorWorkspaces((current) => {
        const workspace = current[workspaceId];
        if (!workspace) return current;
        return { ...current, [workspaceId]: { ...workspace, tabs: workspace.tabs.map((item) => item.id === tabId ? { ...item, isSaving: false, saveError } : item) } };
      });
    } finally {
      savingEditorFilesRef.current.delete(resourceKey);
      if (pendingSave && pendingEditorSavesRef.current.get(resourceKey) === pendingSave) {
        pendingEditorSavesRef.current.delete(resourceKey);
      }
    }
  }, [activeTerminalWorkspace?.id, editorWorkspaces]);

  const saveEditorFileRef = useRef(saveEditorFile);
  saveEditorFileRef.current = saveEditorFile;

  useEffect(() => {
    const timers = autoSaveTimersRef.current;
    if (!settings.autoSave || !isTauri()) {
      for (const entry of timers.values()) if (entry.timer) clearTimeout(entry.timer);
      timers.clear();
      autoSaveQueuedRef.current.clear();
      return;
    }

    const dirtyFiles = new Map<string, { workspaceId: string; tabId: string; path: string; content: string; isSaving: boolean }>();
    for (const [workspaceId, workspace] of Object.entries(editorWorkspaces)) {
      for (const tab of workspace.tabs) {
        if (tab.status !== "ready" || tab.sourceCommitId || tab.view === "diff" || tab.content === null || tab.savedContent === null) continue;
        if (normalizeEditorNewlines(tab.content) === normalizeEditorNewlines(tab.savedContent)) continue;
        dirtyFiles.set(editorOperationKey(workspaceId, tab.id), { workspaceId, tabId: tab.id, path: tab.path, content: tab.content, isSaving: tab.isSaving });
      }
    }

    for (const [key, entry] of timers) {
      if (dirtyFiles.has(key)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      timers.delete(key);
      autoSaveQueuedRef.current.delete(key);
    }
    for (const key of autoSaveQueuedRef.current) if (!dirtyFiles.has(key)) autoSaveQueuedRef.current.delete(key);
    for (const [key, file] of dirtyFiles) {
      const existing = timers.get(key);
      const retryQueued = autoSaveQueuedRef.current.has(key);
      if (retryQueued && file.isSaving) continue;
      if (retryQueued) autoSaveQueuedRef.current.delete(key);
      if (existing?.content === file.content && !retryQueued) continue;
      if (existing?.timer) clearTimeout(existing.timer);
      const entry = { content: file.content, timer: null as ReturnType<typeof setTimeout> | null };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const resourceKey = editorResourceKey(file.path);
        if (savingEditorFilesRef.current.has(resourceKey)) {
          autoSaveQueuedRef.current.add(key);
          return;
        }
        void saveEditorFileRef.current(file.tabId, file.workspaceId);
      }, 1000);
      timers.set(key, entry);
    }
  }, [editorWorkspaces, settings.autoSave]);

  useEffect(() => () => {
    for (const entry of autoSaveTimersRef.current.values()) if (entry.timer) clearTimeout(entry.timer);
    autoSaveTimersRef.current.clear();
    autoSaveQueuedRef.current.clear();
  }, []);

  const hasUnsavedEditorTabs = useMemo(
    () => Object.values(editorWorkspaces).some((workspace) => workspace.tabs.some((tab) => tab.isSaving || isEditorTabUnsaved(tab))),
    [editorWorkspaces],
  );

  useEffect(() => {
    if (!hasUnsavedEditorTabs) return;
    const blockUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers only show the prompt when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", blockUnload);
    return () => window.removeEventListener("beforeunload", blockUnload);
  }, [hasUnsavedEditorTabs]);

  const createEditorGroup = useCallback(() => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    setActiveMainView("code");
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId] ?? createEmptyEditorWorkspaceState();
      let nextIndex = workspace.groups.length + 1;
      while (workspace.groups.some((group) => group.name === "Editor " + nextIndex)) nextIndex += 1;
      const group: EditorGroupState = { id: "editor-group-" + crypto.randomUUID(), name: "Editor " + nextIndex, tabIds: [], activeTabId: null };
      return { ...current, [workspaceId]: { ...workspace, groups: [...workspace.groups, group], activeGroupId: group.id } };
    });
  }, [activeTerminalWorkspace?.id]);

  const registerEditorLayoutControl = useCallback((mode: EditorLayoutMode, setMode: (mode: EditorLayoutMode) => void) => {
    editorModeSetterRef.current = setMode;
    setEditorLayoutMode((current) => current === mode ? current : mode);
  }, []);

  const changeEditorLayoutMode = useCallback((mode: EditorLayoutMode) => {
    editorModeSetterRef.current?.(mode);
  }, []);

  const activateEditorGroup = useCallback((groupId: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace || workspace.activeGroupId === groupId || !workspace.groups.some((group) => group.id === groupId)) return current;
      return { ...current, [workspaceId]: { ...workspace, activeGroupId: groupId } };
    });
  }, [activeTerminalWorkspace?.id]);

  const moveEditorTab = useCallback((tabId: string, targetGroupId: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace || !workspace.groups.some((group) => group.id === targetGroupId)) return current;
      const groups = workspace.groups.map((group) => {
        if (group.id === targetGroupId) {
          return { ...group, tabIds: group.tabIds.includes(tabId) ? group.tabIds : [...group.tabIds, tabId], activeTabId: tabId };
        }
        const tabIds = group.tabIds.filter((id) => id !== tabId);
        return { ...group, tabIds, activeTabId: group.activeTabId === tabId ? tabIds[tabIds.length - 1] ?? null : group.activeTabId };
      });
      return { ...current, [workspaceId]: { ...workspace, groups, activeGroupId: targetGroupId } };
    });
  }, [activeTerminalWorkspace?.id]);

  const closeEditorGroup = useCallback((groupId: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace || workspace.groups.length <= 1) return current;
      const closingIndex = workspace.groups.findIndex((group) => group.id === groupId);
      if (closingIndex < 0) return current;
      const destinationIndex = closingIndex > 0 ? closingIndex - 1 : 1;
      const closingGroup = workspace.groups[closingIndex];
      const destination = workspace.groups[destinationIndex];
      const groups = workspace.groups
        .filter((group) => group.id !== groupId)
        .map((group) => group.id === destination.id
          ? { ...group, tabIds: [...group.tabIds, ...closingGroup.tabIds.filter((id) => !group.tabIds.includes(id))], activeTabId: closingGroup.activeTabId ?? group.activeTabId }
          : group);
      return { ...current, [workspaceId]: { ...workspace, groups, activeGroupId: workspace.activeGroupId === groupId ? destination.id : workspace.activeGroupId } };
    });
  }, [activeTerminalWorkspace?.id]);

  const selectEditorTab = useCallback((groupId: string, tabId: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace) return current;
      const targetGroup = workspace.groups.find((group) => group.id === groupId && group.tabIds.includes(tabId));
      if (!targetGroup) return current;
      return {
        ...current,
        [workspaceId]: {
          ...workspace,
          activeGroupId: groupId,
          groups: workspace.groups.map((group) => group.id === groupId ? { ...group, activeTabId: tabId } : group),
        },
      };
    });
  }, [activeTerminalWorkspace?.id]);

  const closeEditorTab = useCallback((tabId: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    const tab = editorWorkspaces[workspaceId]?.tabs.find((item) => item.id === tabId);
    const name = tab?.name ?? "this file";
    // A tab whose write is still in flight may look clean while the disk is about to change.
    const prompt = tab?.isSaving
      ? `${name} is still saving. Close it anyway? The save will finish in the background.`
      : tab && isEditorTabUnsaved(tab) ? `Discard unsaved changes to ${name}?` : null;
    if (prompt && !window.confirm(prompt)) return;
    editorOperationIdsRef.current.delete(editorOperationKey(workspaceId, tabId));
    setEditorWorkspaces((current) => {
      const workspace = current[workspaceId];
      if (!workspace) return current;
      const groups = workspace.groups.map((group) => {
        const removedIndex = group.tabIds.indexOf(tabId);
        if (removedIndex < 0) return group;
        const tabIds = group.tabIds.filter((id) => id !== tabId);
        const activeTabId = group.activeTabId === tabId
          ? tabIds[Math.min(removedIndex, tabIds.length - 1)] ?? null
          : group.activeTabId;
        return { ...group, tabIds, activeTabId };
      });
      return { ...current, [workspaceId]: { ...workspace, tabs: workspace.tabs.filter((tab) => tab.id !== tabId), groups } };
    });
  }, [activeTerminalWorkspace?.id, editorWorkspaces]);

  const updateTerminalWorkspace = useCallback((workspaceId: string, update: (workspace: TerminalWorkspace) => TerminalWorkspace) => {
    setTerminalWorkspaceState((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => workspace.id === workspaceId ? update(workspace) : workspace),
    }));
  }, []);

  const addTerminalGroup = useCallback(() => {
    const workspace = activeTerminalWorkspace;
    if (!workspace) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const next = createTerminalGroup({ groups: current.groups, activeGroupId: current.activeGroupId });
      return syncTerminalGroups(current, next.groups, next.activeGroupId);
    });
    setTerminalViews((current) => ({ ...current, [workspace.id]: null }));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const chooseTerminalGroup = useCallback((groupId: string) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace || groupId === workspace.activeGroupId) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const next = selectTerminalGroupState({ groups: current.groups, activeGroupId: current.activeGroupId }, groupId);
      return syncTerminalGroups(current, next.groups, next.activeGroupId);
    });
    setTerminalViews((current) => ({ ...current, [workspace.id]: null }));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const moveTerminalToGroup = useCallback((sessionId: string, groupId: string) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const next = moveTerminalBetweenGroups({ groups: current.groups, activeGroupId: current.activeGroupId }, sessionId, groupId);
      return syncTerminalGroups(current, next.groups, next.activeGroupId);
    });
    setTerminalViews((current) => ({ ...current, [workspace.id]: null }));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const closeTerminalGroup = useCallback((groupId: string) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const next = closeTerminalGroupState({ groups: current.groups, activeGroupId: current.activeGroupId }, groupId);
      return next === current || next.groups === current.groups ? current : syncTerminalGroups(current, next.groups, next.activeGroupId);
    });
    setTerminalViews((current) => ({ ...current, [workspace.id]: null }));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const dockTerminalToTiledLayout = useCallback((sessionId: string, edge: TerminalDockEdge) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    updateTerminalWorkspace(workspaceId, (workspace) => {
      const group = workspace.groups.find((item) => item.id === workspace.activeGroupId);
      if (!group?.terminalIds.includes(sessionId)) return workspace;
      const remainingIds = group.terminalIds.filter((id) => id !== sessionId);
      const remainingLayout = group.layout
        ? removeTerminal(group.layout, sessionId)
        : remainingIds.length > 0 ? buildTerminalLayout(remainingIds) : null;
      const terminalNode: LayoutNode = { type: "terminal", sessionId };
      const direction = edge === "left" || edge === "right" ? "horizontal" : "vertical";
      const before = edge === "left" || edge === "top";
      const layout: LayoutNode = remainingLayout
        ? { type: "split", id: crypto.randomUUID(), direction, ratio: 0.5, children: before ? [terminalNode, remainingLayout] : [remainingLayout, terminalNode] }
        : terminalNode;
      return updateTerminalGroup(workspace, group.id, (current) => ({ ...current, layout }));
    });
  }, [activeTerminalWorkspace?.id, updateTerminalWorkspace]);

  const changeTerminalLayoutMode = useCallback((mode: TerminalLayoutMode) => {
    const workspace = activeTerminalWorkspace;
    if (mode === "floating" && workspace) {
      setTerminalViews((current) => ({ ...current, [workspace.id]: null }));
    }
    const group = workspace?.groups.find((item) => item.id === workspace.activeGroupId) ?? workspace?.groups[0];
    if (mode === "tiled" && workspace && group && !group.layout && group.terminalIds.length > 1) {
      updateTerminalWorkspace(workspace.id, (current) => updateActiveTerminalGroup(current, (active) => ({ ...active, layout: buildTerminalLayout(active.terminalIds) })));
    }
    floatingModeSetterRef.current?.(mode);
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const registerFloatingLayoutControl = useCallback((mode: TerminalLayoutMode, setMode: (mode: TerminalLayoutMode) => void) => {
    setTerminalLayoutMode(mode);
    floatingModeSetterRef.current = setMode;
  }, []);

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

  useEffect(() => {
    try {
      localStorage.setItem(TERMINAL_WORKSPACES_STORAGE_KEY, JSON.stringify({
        workspaces: terminalWorkspaceState.workspaces.map(({ id, name, rootPath, folderPaths }) => ({ id, name, rootPath, folderPaths } satisfies PersistedTerminalWorkspace)),
        activeId: terminalWorkspaceState.activeId,
      }));
    } catch (reason) {
      showToast(`Could not save terminal workspaces: ${String(reason)}`);
    }
  }, [showToast, terminalWorkspaceState]);

  useEffect(() => {
    if (!repoPath || !isTauri()) { setRepoInfo(null); return; }
    let cancelled = false;
    void invoke<RepositoryInfo>("git_repository_info", { path: repoPath })
      .then((info) => { if (!cancelled) setRepoInfo(info); })
      .catch(() => { if (!cancelled) setRepoInfo(null); });
    return () => { cancelled = true; };
  }, [activeTerminalWorkspace?.id, repoPath]);

  useEffect(() => () => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (editingTerminalId) {
      terminalNameInputRef.current?.focus();
      terminalNameInputRef.current?.select();
    }
  }, [editingTerminalId]);

  const createTerminal = useCallback(async (showInTabs = true, workingDirectory?: string): Promise<TerminalSession | null> => {
    dismissToast();
    if (!isTauri()) {
      showToast("Install Rust/Cargo and launch the desktop app with npm run tauri dev.");
      return null;
    }
    try {
      const shell: ShellKind = navigator.userAgent.includes("Windows") ? "powershell" : "bash";
      const id = crypto.randomUUID();
      if (activeTerminalWorkspace) terminalTabScrollTargetRef.current = { workspaceId: activeTerminalWorkspace.id, terminalId: id };
      const terminal: TerminalSession = {
        id,
        name: activeWorkspaceTerminalIds.length === 0 ? (shell === "powershell" ? "PowerShell" : shell) : `Terminal ${activeWorkspaceTerminalIds.length + 1}`,
        shell,
        shellLabel: shell === "powershell" ? "PowerShell" : shell,
        workingDirectory: workingDirectory ?? (repoPath || null),
      };
      setTerminals((current) => [...current, terminal]);
      if (activeTerminalWorkspace) updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => updateActiveTerminalGroup(workspace, (group) => ({
        ...group,
        terminalIds: [...group.terminalIds, id],
        activeTerminalId: id,
        layout: showInTabs && group.terminalIds.length > 0 ? (workingDirectory ? appendTerminalToLayout(group.layout ?? buildTerminalLayout(group.terminalIds), id) : buildTerminalLayout([...group.terminalIds, id])) : group.layout,
      })));
      return terminal;
    } catch (reason) {
      showToast(String(reason));
      return null;
    }
  }, [activeTerminalWorkspace, activeWorkspaceTerminalIds.length, dismissToast, repoPath, showToast, updateTerminalWorkspace]);

  useEffect(() => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId || activeWorkspaceTerminalIds.length > 0 || initializedWorkspaceIdsRef.current.has(workspaceId)) return;
    initializedWorkspaceIdsRef.current.add(workspaceId);
    void createTerminal();
  }, [activeTerminalWorkspace?.id, activeWorkspaceTerminalIds.length, createTerminal]);

  const closeTerminal = useCallback(async (id: string) => {
    if (isTauri()) {
      try { await invoke("close_terminal", { sessionId: id }); }
      catch (reason) { showToast(String(reason)); }
    }
    setTerminals((current) => current.filter((terminal) => terminal.id !== id));
    setEditingTerminalId((current) => current === id ? null : current);
    setTerminalWorkspaceState((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (!workspace.terminalIds.includes(id)) return workspace;
        const next = removeTerminalFromGroups({ groups: workspace.groups, activeGroupId: workspace.activeGroupId }, id);
        return syncTerminalGroups(workspace, next.groups, next.activeGroupId);
      }),
    }));
    setTerminalViews((current) => Object.fromEntries(Object.entries(current).map(([workspaceId, selectedId]) => [workspaceId, selectedId === id ? null : selectedId])));
  }, [showToast]);

  const handleTerminalExit = useCallback((id: string) => {
    setTerminals((current) => current.map((terminal) => terminal.id === id ? { ...terminal, shellLabel: `${terminal.shellLabel} · exited` } : terminal));
  }, []);

  const focusTerminal = useCallback((id: string) => {
    const owner = terminalWorkspaceState.workspaces.find((workspace) => workspace.terminalIds.includes(id));
    if (owner) {
      const group = owner.groups.find((item) => item.terminalIds.includes(id));
      if (group) updateTerminalWorkspace(owner.id, (workspace) => updateTerminalGroup(workspace, group.id, (current) => ({ ...current, activeTerminalId: id })));
    }
  }, [terminalWorkspaceState.workspaces, updateTerminalWorkspace]);

  const splitActiveTerminal = useCallback(async (direction: "horizontal" | "vertical") => {
    const workspace = activeTerminalWorkspace;
    const activeId = workspace?.activeTerminalId;
    if (!workspace || !activeId) return;
    const created = await createTerminal(false);
    if (!created) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const group = current.groups.find((item) => item.id === current.activeGroupId);
      if (!group) return current;
      const existingIds = group.terminalIds.filter((id) => id !== created.id);
      const root = group.layout ?? buildTerminalLayout(existingIds);
      return updateTerminalGroup(current, group.id, (active) => ({ ...active, layout: splitTerminal(root, activeId, created.id, direction) }));
    });
  }, [activeTerminalWorkspace, createTerminal, updateTerminalWorkspace]);

  const addTerminalToWorkspace = useCallback(async () => {
    const workspace = activeTerminalWorkspace;
    if (!workspace) {
      await createTerminal();
      return;
    }
    const created = await createTerminal(false);
    if (!created) return;
    updateTerminalWorkspace(workspace.id, (current) => updateActiveTerminalGroup(current, (group) => ({ ...group, layout: buildTerminalLayout(group.terminalIds) })));
  }, [activeTerminalWorkspace, createTerminal, updateTerminalWorkspace]);

  const moveTerminal = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId || !activeTerminalWorkspace) return;
    updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => updateActiveTerminalGroup(workspace, (group) => ({
      ...group,
      layout: group.layout ? swapTerminalPositions(group.layout, sourceId, targetId) : null,
      activeTerminalId: sourceId,
    })));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const resizeLayoutSplit = useCallback((splitId: string, ratio: number) => {
    if (!activeTerminalWorkspace) return;
    updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => updateActiveTerminalGroup(workspace, (group) => ({
      ...group,
      layout: group.layout ? updateSplitRatio(group.layout, splitId, ratio) : null,
    })));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const beginRenameTerminal = useCallback((terminal: TerminalSession) => {
    setEditingTerminalId(terminal.id);
    setTerminalNameDraft(terminal.name);
  }, []);

  const saveTerminalName = useCallback(() => {
    if (!editingTerminalId) return;
    const name = terminalNameDraft.trim();
    if (name) setTerminals((current) => current.map((terminal) => terminal.id === editingTerminalId ? { ...terminal, name } : terminal));
    setEditingTerminalId(null);
  }, [editingTerminalId, terminalNameDraft]);

  const cancelTerminalRename = useCallback(() => setEditingTerminalId(null), []);

  const activateWorkspace = useCallback((id: string) => {
    if (!terminalWorkspaceState.workspaces.some((workspace) => workspace.id === id)) return;
    setEditingTerminalId(null);
    setTerminalWorkspaceState((current) => ({ ...current, activeId: id }));
    setRepoInfo(null);
  }, [terminalWorkspaceState.workspaces]);

  const sendTerminalDirectoryCommand = useCallback((workspaceId: string, terminal: TerminalSession, path: string) => {
    const sessionKey = JSON.stringify([workspaceId, terminal.id]);
    const normalizedPath = navigator.userAgent.includes("Windows") ? path.replace(/\//g, "\\").toLocaleLowerCase() : path;
    const targets = terminalDirectoryTargetsRef.current;
    const writes = terminalDirectoryWritesRef.current;
    if (targets.get(sessionKey) === normalizedPath) return writes.get(sessionKey) ?? Promise.resolve();

    targets.set(sessionKey, normalizedPath);
    const previousWrite = writes.get(sessionKey) ?? Promise.resolve();
    const write = previousWrite.catch(() => undefined).then(async () => {
      if (targets.get(sessionKey) !== normalizedPath) return;
      await invoke<void>("write_terminal", { sessionId: terminal.id, data: changeDirectoryCommand(terminal.shell, path) });
    });
    writes.set(sessionKey, write);
    void write.then(
      () => { if (writes.get(sessionKey) === write) writes.delete(sessionKey); },
      () => {
        if (targets.get(sessionKey) === normalizedPath) targets.delete(sessionKey);
        if (writes.get(sessionKey) === write) writes.delete(sessionKey);
      },
    );
    return write;
  }, []);

  const activateWorkspaceFolder = useCallback(async (path: string, additions: string[] = [], options: { changeTerminalDirectory?: boolean } = {}) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace) return;
    const rootChanged = workspace.rootPath !== path;
    updateTerminalWorkspace(workspace.id, (current) => {
      const folderPaths = mergeWorkspaceFolders(current.folderPaths, [...additions, ...(path ? [path] : [])]);
      return { ...current, folderPaths, rootPath: path && folderPaths.includes(path) ? path : "" };
    });
    setRepoInfo(null);
    if (!path || !rootChanged || options.changeTerminalDirectory === false || !isTauri()) return;
    const terminal = terminals.find((item) => item.id === workspace.activeTerminalId && workspace.terminalIds.includes(item.id));
    if (!terminal) return;
    try {
      await sendTerminalDirectoryCommand(workspace.id, terminal, path);
    } catch (reason) {
      showToast(`Could not change terminal working directory: ${String(reason)}`);
    }
  }, [activeTerminalWorkspace, sendTerminalDirectoryCommand, showToast, terminals, updateTerminalWorkspace]);
  const createWorkspace = useCallback(() => {
    const ordinal = terminalWorkspaceState.workspaces.length + 1;
    const name = window.prompt("Workspace name", `Workspace ${ordinal}`)?.trim();
    if (!name) return;
    if (terminalWorkspaceState.workspaces.some((workspace) => workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showToast("Choose a unique workspace name.");
      return;
    }
    const workspace: TerminalWorkspace = {
      id: crypto.randomUUID(),
      name,
      rootPath: "",
      folderPaths: [],
      terminalIds: [],
      activeTerminalId: null,
      layout: null,
      ...createInitialTerminalGroups(),
    };
    setTerminalWorkspaceState((current) => ({ workspaces: [...current.workspaces, workspace], activeId: workspace.id }));
    setRepoInfo(null);
  }, [showToast, terminalWorkspaceState.workspaces]);

  const renameWorkspace = useCallback(() => {
    if (!activeTerminalWorkspace) return;
    const name = window.prompt("Workspace name", activeTerminalWorkspace.name)?.trim();
    if (!name) return;
    if (terminalWorkspaceState.workspaces.some((workspace) => workspace.id !== activeTerminalWorkspace.id && workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showToast("Choose a unique workspace name.");
      return;
    }
    updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => ({ ...workspace, name }));
  }, [activeTerminalWorkspace, showToast, terminalWorkspaceState.workspaces, updateTerminalWorkspace]);

  const deleteWorkspace = useCallback(async () => {
    const target = activeTerminalWorkspace;
    if (!target || terminalWorkspaceState.workspaces.length <= 1) return;
    const unsavedTabs = (editorWorkspaces[target.id]?.tabs ?? []).filter(isEditorTabUnsaved);
    const unsavedWarning = unsavedTabs.length > 0
      ? ` Unsaved changes in ${unsavedTabs.map((tab) => tab.name).join(", ")} will be discarded.`
      : "";
    if (!window.confirm(`Delete workspace "${target.name}" and close its terminals?${unsavedWarning}`)) return;
    for (const key of [...editorOperationIdsRef.current.keys()]) {
      if ((JSON.parse(key) as [string, string])[0] === target.id) editorOperationIdsRef.current.delete(key);
    }
    setEditorWorkspaces((current) => {
      if (!(target.id in current)) return current;
      const { [target.id]: _removed, ...rest } = current;
      return rest;
    });

    const closeResults = await Promise.allSettled(target.terminalIds.map((id) => isTauri() ? invoke("close_terminal", { sessionId: id }) : Promise.resolve()));
    const failed = closeResults.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") showToast(`Could not close a workspace terminal: ${String(failed.reason)}`);
    setTerminals((current) => current.filter((terminal) => !target.terminalIds.includes(terminal.id)));
    setEditingTerminalId(null);
    setTerminalWorkspaceState((current) => {
      const workspaces = current.workspaces.filter((workspace) => workspace.id !== target.id);
      return { workspaces, activeId: current.activeId === target.id ? workspaces[0]?.id ?? "" : current.activeId };
    });
    setRepoInfo(null);
  }, [activeTerminalWorkspace, editorWorkspaces, showToast, terminalWorkspaceState.workspaces]);

  const addWorkspaceFolders = useCallback(async () => {
    if (!isTauri()) {
      showToast("Launch the desktop app to add workspace folders.");
      return;
    }
    if (!activeTerminalWorkspace) return;
    const selection = await open({
      directory: true,
      multiple: true,
      title: "Add Workspace Folders",
      defaultPath: repoPath || undefined,
    });
    const additions = selection === null ? [] : typeof selection === "string" ? [selection] : selection;
    if (additions.length === 0) return;
    dismissToast();
    await activateWorkspaceFolder(additions[additions.length - 1], additions, { changeTerminalDirectory: false });
  }, [activeTerminalWorkspace, activateWorkspaceFolder, dismissToast, repoPath, showToast]);

  const removeWorkspaceFolder = useCallback((path: string) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace || !workspace.folderPaths.includes(path)) return;
    const folderPaths = workspace.folderPaths.filter((folder) => folder !== path);
    const rootPath = workspace.rootPath === path ? folderPaths[folderPaths.length - 1] ?? "" : workspace.rootPath;
    updateTerminalWorkspace(workspace.id, (current) => ({
      ...current,
      folderPaths: current.folderPaths.filter((folder) => folder !== path),
      rootPath: current.rootPath === path ? rootPath : current.rootPath,
    }));
    if (workspace.rootPath !== path) return;
    setRepoInfo(null);
    if (!rootPath || !isTauri()) return;
    const terminal = terminals.find((item) => item.id === workspace.activeTerminalId && workspace.terminalIds.includes(item.id));
    if (!terminal) return;
    void sendTerminalDirectoryCommand(workspace.id, terminal, rootPath).catch((reason) => {
      showToast(`Could not change terminal working directory: ${String(reason)}`);
    });
  }, [activeTerminalWorkspace, sendTerminalDirectoryCommand, showToast, terminals, updateTerminalWorkspace]);

  const createWorkspaceFile = useCallback(async (root: string, parentPath: string, name: string) => {
    if (!isTauri()) {
      showToast("Launch the desktop app to create files.");
      return;
    }
    try {
      await invoke<void>("write_workspace_text_file", { root, path: joinWorkspacePath(parentPath, name), content: "", expectedContent: "" });
      setWorkspaceFolderRefresh({ root, path: parentPath, nonce: Date.now() });
    } catch (reason) {
      showToast(String(reason));
    }
  }, [showToast]);

  const createWorkspaceFolder = useCallback(async (root: string, parentPath: string, name: string) => {
    if (!isTauri()) {
      showToast("Launch the desktop app to create folders.");
      return;
    }
    try {
      await invoke<void>("create_workspace_directory", { root, path: joinWorkspacePath(parentPath, name) });
      setWorkspaceFolderRefresh({ root, path: parentPath, nonce: Date.now() });
    } catch (reason) {
      showToast(String(reason));
    }
  }, [showToast]);

  const openTerminalAt = useCallback((root: string, folderPath: string) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace || !workspace.folderPaths.includes(root)) return;
    void openFolderInNewTerminal({
      isDesktop: isTauri(),
      folderPath,
      createTerminalAt: (path) => createTerminal(true, path),
      activateTerminal: (id) => {
        setTerminalViews((current) => ({ ...current, [workspace.id]: id }));
        setActiveMainView("terminals");
      },
      onDesktopRequired: () => showToast("Install Rust/Cargo and launch the desktop app with npm run tauri dev."),
    }).catch((reason: unknown) => {
      showToast(`Could not open terminal: ${String(reason)}`);
    });
  }, [activeTerminalWorkspace, createTerminal, showToast]);

  const revealInFileExplorer = useCallback((root: string, folderPath: string) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace || !workspace.folderPaths.includes(root)) return;
    if (!isTauri()) {
      showToast("Launch the desktop app to reveal folders.");
      return;
    }
    void revealItemInDir(folderPath).catch((reason) => {
      showToast(`Could not reveal folder: ${String(reason)}`);
    });
  }, [activeTerminalWorkspace, showToast]);

  const copyWorkspacePath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {
      showToast("Could not copy the path to the clipboard.");
    });
  }, [showToast]);

  const handleFolderContextAction = useCallback((action: FolderContextMenuAction, target: { root: string; path: string; isWorkspaceRoot: boolean }) => {
    switch (action) {
      case "new-file": {
        const name = window.prompt(`New file in ${target.path}`)?.trim();
        if (name) void createWorkspaceFile(target.root, target.path, name);
        return;
      }
      case "new-folder": {
        const name = window.prompt(`New folder in ${target.path}`)?.trim();
        if (name) void createWorkspaceFolder(target.root, target.path, name);
        return;
      }
      case "open-terminal":
        openTerminalAt(target.root, target.path);
        return;
      case "reveal":
        revealInFileExplorer(target.root, target.path);
        return;
      case "copy-path":
        copyWorkspacePath(target.path);
        return;
      case "remove-folder":
        removeWorkspaceFolder(target.path);
        return;
    }
  }, [copyWorkspacePath, createWorkspaceFile, createWorkspaceFolder, openTerminalAt, removeWorkspaceFolder, revealInFileExplorer]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "p") {
        event.preventDefault();
        if (!settingsOpen && !quickOpenOpen) setQuickOpenOpen(true);
        return;
      }
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && key === "t") { event.preventDefault(); void createTerminal(); }
      else if (event.shiftKey && key === "w" && activeTerminalId) { event.preventDefault(); void closeTerminal(activeTerminalId); }
      else if (event.shiftKey && key === "h") { event.preventDefault(); void splitActiveTerminal("horizontal"); }
      else if (event.shiftKey && key === "v") { event.preventDefault(); void splitActiveTerminal("vertical"); }
      else if (event.shiftKey && key === "g") { event.preventDefault(); setActiveTool("changes"); }
      else if (event.shiftKey && key === "b") { event.preventDefault(); setActiveTool("graph"); }
      else if (key === "tab" && activeGroupTerminals.length > 1) {
        event.preventDefault();
        const index = activeGroupTerminals.findIndex((terminal) => terminal.id === activeTerminalId);
        const direction = event.shiftKey ? -1 : 1;
        const next = (index + direction + activeGroupTerminals.length) % activeGroupTerminals.length;
        const nextId = activeGroupTerminals[next].id;
        focusTerminal(nextId);
        if (focusedTerminalView && activeTerminalWorkspace) setTerminalViews((current) => ({ ...current, [activeTerminalWorkspace.id]: nextId }));
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeTerminalId, activeTerminalWorkspace, activeGroupTerminals, closeTerminal, createTerminal, focusTerminal, focusedTerminalView, quickOpenOpen, settingsOpen, splitActiveTerminal]);

  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.id === activeTerminalId),
    [activeTerminalId, terminals],
  );

  return (
    <main className="app-shell" data-theme={settings.theme} style={{ "--editor-font-family": settings.editorFontFamily, "--editor-font-size": settings.editorFontSize + "px", "--terminal-font-family": settings.terminalFontFamily, "--terminal-font-size": settings.terminalFontSize + "px" } as CSSProperties}>
      <header className="titlebar">
        <span className="brand-name">yerminal</span>
        <span className="title-divider" />
        <div className="workspace-switcher">
                <span className="workspace-switcher-icon" aria-hidden="true">▣</span>
                <select className="workspace-name-select" aria-label="Active terminal workspace" value={activeTerminalWorkspace?.id ?? ""} onChange={(event) => activateWorkspace(event.currentTarget.value)}>
                  {terminalWorkspaceState.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
                <button className="workspace-action" type="button" aria-label="Create workspace" title="Create workspace" onClick={createWorkspace}>＋</button>
                <button className="workspace-action" type="button" aria-label="Rename workspace" title="Rename workspace" onClick={renameWorkspace} disabled={!activeTerminalWorkspace}>✎</button>
                <button className="workspace-action delete" type="button" aria-label="Delete workspace" title={terminalWorkspaceState.workspaces.length <= 1 ? "Keep at least one workspace" : "Delete workspace"} onClick={() => void deleteWorkspace()} disabled={terminalWorkspaceState.workspaces.length <= 1}>×</button>
              </div>
        <nav className="workspace-view-tabs" role="tablist" aria-label="Workspace views">
          <button className={`workspace-view-tab ${activeMainView === "terminals" ? "selected" : ""}`} role="tab" aria-selected={activeMainView === "terminals"} onClick={() => setActiveMainView("terminals")} type="button">Terminal</button>
          <button className={`workspace-view-tab ${activeMainView === "code" ? "selected" : ""}`} role="tab" aria-selected={activeMainView === "code"} onClick={() => setActiveMainView("code")} type="button">Editor</button>
        </nav>
        <div className="titlebar-spacer" />
        <div className="titlebar-layout-controls">
          {activeMainView === "terminals" ? <>
            <div className="terminal-group-toolbar" role="tablist" aria-label="Terminal groups">
              {activeTerminalWorkspace?.groups.map((group) => <div key={group.id} className={`terminal-group-tab-item ${group.id === activeTerminalWorkspace.activeGroupId ? "selected" : ""}`}>
                <button className="terminal-group-tab" type="button" role="tab" aria-selected={group.id === activeTerminalWorkspace.activeGroupId} onClick={() => chooseTerminalGroup(group.id)}>{group.name}<span>{group.terminalIds.length}</span></button>
                {activeTerminalWorkspace.groups.length > 1 && <button className="terminal-group-close" type="button" aria-label={`Close ${group.name} and move its terminals`} title={`Close ${group.name} and move its terminals`} onClick={() => closeTerminalGroup(group.id)}>×</button>}
              </div>)}
              <button className="terminal-group-create" type="button" aria-label="New terminal group" title="New terminal group" onClick={addTerminalGroup}>＋</button>
            </div>
            <FloatingTerminalModeToggle mode={terminalLayoutMode} onChange={changeTerminalLayoutMode} />
            <button className="icon-button titlebar-new-terminal" aria-label="Add terminal to group" title="Add terminal to group" onClick={() => { selectTerminalView(null); void addTerminalToWorkspace(); }} type="button">＋</button>
          </> : <>
            <div className="layout-mode-toggle editor-layout-mode-toggle floating-editor-mode-toggle" role="group" aria-label="Editor group layout mode">
              <button className={editorLayoutMode === "tiled" ? "selected" : ""} type="button" aria-pressed={editorLayoutMode === "tiled"} onClick={() => changeEditorLayoutMode("tiled")} title="Use the default split editor layout">Split</button>
              <button className={editorLayoutMode === "free" ? "selected" : ""} type="button" aria-pressed={editorLayoutMode === "free"} onClick={() => changeEditorLayoutMode("free")} title="Move editor groups freely around the canvas">Free</button>
            </div>
            <button className="editor-create-group" type="button" onClick={createEditorGroup}><span aria-hidden="true">＋</span>New group</button>
          </>}
        </div>
        {activeMainView === "terminals" && <button className="titlebar-resource-button" type="button" aria-expanded={terminalUsageOpen} aria-controls="terminal-resource-panel" onClick={() => setTerminalUsageOpen((open) => !open)}>CPU / RAM</button>}
        <button className="titlebar-help-button" type="button" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">Help &amp; Settings</button>
      </header>

      <PanelGroup direction="horizontal" className="workspace">
        <Panel ref={toolsPanelRef} defaultSize={16} minSize={14} maxSize={38} collapsible collapsedSize={5000 / Math.max(920, viewportWidth)} className="tools-panel" data-autohide-collapsed={toolsPanelCollapsed ? "true" : "false"} onBlurCapture={(event) => {
          if (!toolPanelAutoHide || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          toolsPanelRef.current?.collapse();
          setToolsPanelCollapsed(true);
        }}>
          <div className="workspace-tool-layout">
            <nav className="tool-sidebar" aria-label="Workspace tools">
              {tools.map((tool) => <button key={tool.id} className={`tool-sidebar-item ${activeTool === tool.id ? "selected" : ""}`} onClick={(event) => handleToolClick(tool.id, event.detail)} type="button" aria-label={tool.label} aria-pressed={activeTool === tool.id} title={`${tool.label} · Double-click to toggle panel`}>
                <span className="tool-sidebar-icon" aria-hidden="true">{tool.icon}</span>
                <span className="tool-sidebar-label">{tool.label}</span>
              </button>)}
              <button className="tool-sidebar-autohide" type="button" aria-label={toolPanelAutoHide ? "Disable automatic hiding of workspace panel" : "Automatically hide workspace panel"} aria-pressed={toolPanelAutoHide} title={toolPanelAutoHide ? "Keep workspace panel visible" : "Automatically hide workspace panel"} onClick={() => setToolPanelAutoHide((enabled) => !enabled)}>
                <span aria-hidden="true">{toolPanelAutoHide ? "⌖" : "◧"}</span>
                <span className="tool-sidebar-autohide-label">{toolPanelAutoHide ? "Pinned" : "Auto-hide"}</span>
              </button>
            </nav>
            <div className="workspace-sidebar-content">
            <section className="tool-content" aria-label={tools.find((tool) => tool.id === activeTool)?.label}>
              {activeTool === "explorer" ? <WorkspacePanel key={activeTerminalWorkspace?.id ?? ""} folders={workspaceFolders} activePath={repoPath} onAdd={() => void addWorkspaceFolders()} onActivate={(path) => void activateWorkspaceFolder(path, [], { changeTerminalDirectory: false })} onRemove={removeWorkspaceFolder} collapseOtherFolders={settings.collapseOtherFolders} onOpenFile={(root, entry) => void openEditorFile({ id: `workspace:${root}:${entry.path}`, root, path: entry.path, name: entry.name, size: entry.size ?? undefined })} onFolderContextAction={handleFolderContextAction} refreshRequest={workspaceFolderRefresh} /> : activeTool === "changes" ? <GitChanges key={activeTerminalWorkspace?.id ?? ""} repoPaths={workspaceFolders} onOpenRepository={() => void addWorkspaceFolders()} onOpenDiff={(change, staged) => void openEditorFile({ id: `gitdiff:${repoPath}:${staged ? "index" : "worktree"}:${change.path}`, root: repoPath, path: change.path, name: change.path.split(/[\\/]/).pop() ?? change.path, view: "diff", diffStaged: staged })} onError={showToast} /> : <GitGraph key={activeTerminalWorkspace?.id ?? ""} repoPath={repoInfo ? repoPath : ""} onError={showToast} onOpenInEditor={(commit, file) => void openEditorFile({ id: `commit:${commit.id}:${file.path}`, root: repoPath, path: file.path, name: file.path.split(/[\\/]/).pop() ?? file.path, sourceCommitId: commit.id, sourceLabel: `${commit.shortId} · ${file.kind}`, snapshot: { shortId: commit.shortId, message: commit.message, changeKind: file.kind, author: commit.author, timestamp: commit.timestamp } })} />}
            </section>
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" aria-label="Resize developer tools" />
        <Panel minSize={35} className="terminal-panel">
          <div className={"terminal-toolbar" + (activeMainView === "code" ? " editor-mode" : "") + (activeMainView === "terminals" && terminalLayoutMode === "floating" ? " floating-mode" : "")}>
            {activeMainView === "terminals" && terminalLayoutMode === "tiled" && <div className="terminal-session-toolbar">
              {focusedTerminalView && <button className="terminal-show-all" type="button" aria-label="Show all terminals" title="Show all terminals" onClick={() => selectTerminalView(null)}>Show all</button>}
              <div className="terminal-tabs" ref={terminalTabsRef} role="tablist" aria-label="Terminal sessions">
                {activeGroupTerminals.map((terminal) => <div key={terminal.id} data-terminal-id={terminal.id} className={`terminal-tab-item ${terminal.id === focusedTerminalView ? "selected" : ""} ${editingTerminalId === terminal.id ? "editing" : ""}`} role="presentation">
                  {editingTerminalId === terminal.id ? <TerminalNameEditor terminalName={terminal.name} value={terminalNameDraft} inputRef={terminalNameInputRef} compact onChange={setTerminalNameDraft} onSave={saveTerminalName} onCancel={cancelTerminalRename} /> : <>
                    <button className={`terminal-tab ${terminal.id === focusedTerminalView ? "selected" : ""}`} onClick={() => selectTerminalView(terminal.id)} onDoubleClick={() => beginRenameTerminal(terminal)} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); void closeTerminal(terminal.id); } }} type="button" role="tab" aria-selected={terminal.id === focusedTerminalView} aria-label={`${terminal.name}. Double-click to rename.`} title={terminal.name}><span className="terminal-tab-name">{terminal.name}</span>{terminal.id === activeTerminalId && <span className="terminal-active-label" aria-hidden="true">Active</span>}</button>
                    <button className="terminal-tab-rename" type="button" aria-label={`Rename ${terminal.name}`} title="Rename terminal" onClick={() => beginRenameTerminal(terminal)}>✎</button>
                    {activeTerminalWorkspace && activeTerminalWorkspace.groups.length > 1 && <select className="terminal-tab-move" aria-label={`Move ${terminal.name} to terminal group`} value="" onChange={(event) => { const groupId = event.currentTarget.value; if (groupId) moveTerminalToGroup(terminal.id, groupId); }}><option value="" disabled>Move to…</option>{activeTerminalWorkspace.groups.filter((group) => group.id !== activeTerminalWorkspace.activeGroupId).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>}
                    {activeGroupTerminals.length > 1 && <button className="tab-close" type="button" aria-label={`Close ${terminal.name}`} title={`Close ${terminal.name}`} onClick={() => void closeTerminal(terminal.id)}>×</button>}
                  </>}
                </div>)}
              </div>
            </div>}
          </div>
          <WorkspaceViewLayout activeView={activeMainView} code={<CodeWorkspace
            key={activeTerminalWorkspace?.id ?? ""}
            workspaceId={activeTerminalWorkspace?.id ?? ""}
            tabs={activeEditorWorkspace.tabs}
            groups={activeEditorWorkspace.groups}
            activeGroupId={activeEditorWorkspace.activeGroupId}
            onSelect={selectEditorTab}
            onActivateGroup={activateEditorGroup}
            onClose={closeEditorTab}
            onChange={updateEditorFileContent}
            onSave={(tabId) => void saveEditorFile(tabId)}
            onMoveTab={moveEditorTab}
            onCloseGroup={closeEditorGroup}
            onModeState={registerEditorLayoutControl}
          />} terminal={<div className={`terminal-workspace-view${terminalUsageOpen ? " has-terminal-usage" : ""}`}>
          <section className="terminal-surface" aria-label="Terminal workspace">
            <TerminalWorkspaceLayout layout={layout} focusedTerminalId={focusedTerminalView && activeGroupTerminalIds.includes(focusedTerminalView) ? focusedTerminalView : null} terminals={activeWorkspaceTerminals} visibleTerminalIds={activeGroupTerminalIds} workspaceId={`${activeTerminalWorkspace?.id ?? ""}:${activeTerminalGroup?.id ?? ""}`} onDockToTiledLayout={dockTerminalToTiledLayout} onModeState={registerFloatingLayoutControl} activeTerminalId={activeTerminalId} onLinkHint={showToast} onFocus={focusTerminal} onExit={handleTerminalExit} onClose={closeTerminal} onMove={moveTerminal} onResize={resizeLayoutSplit} />
            {activeGroupTerminalIds.length === 0 && <div className="terminal-placeholder"><div className="welcome-title">Terminal group is empty</div><p>Add a terminal to get started.</p><button className="primary-button" onClick={() => void addTerminalToWorkspace()} type="button">New Terminal</button></div>}

            <div className="terminal-status" aria-live="polite" aria-atomic="true"><span className="status-indicator" /><strong>{activeTerminal?.name ?? "No terminal"}</strong>{activeTerminal && <span className="terminal-status-active">Active</span>}<span className="status-separator">·</span><span>{activeTerminal?.shellLabel ?? "Ready"}</span></div>
          </section>
          {terminalUsageOpen && <div id="terminal-resource-panel" className="terminal-resource-panel"><TerminalResourceGraph enabled={true} workspaceName={activeTerminalWorkspace?.name ?? "Workspace"} terminals={activeWorkspaceTerminals} activeTerminalId={activeTerminalId} onFocusTerminal={(id) => {
            if (activeMainView !== "terminals") setActiveMainView("terminals");
            if (focusedTerminalView && focusedTerminalView !== id) selectTerminalView(id);
            else if (id !== activeTerminalId) focusTerminal(id);
          }} /></div>}
          </div>} />
        </Panel>
      </PanelGroup>
      {quickOpenOpen && <QuickOpenDialog
        workspaces={terminalWorkspaceState.workspaces}
        activeWorkspaceId={activeTerminalWorkspace?.id ?? null}
        scope={settings.quickOpenScope}
        onClose={() => setQuickOpenOpen(false)}
        onOpen={(file: QuickOpenFile) => {
          const workspaceExists = terminalWorkspaceState.workspaces.some((workspace) => workspace.id === file.workspaceId);
          if (!workspaceExists) return;
          activateWorkspace(file.workspaceId);
          setQuickOpenOpen(false);
          void openEditorFile({ id: `workspace:${file.root}:${file.path}`, root: file.root, path: file.path, name: file.name, size: file.size ?? undefined }, file.workspaceId);
        }}
      />}
      {settingsOpen && <SettingsDialog settings={settings} shortcuts={HELP_SHORTCUTS} onSettingsChange={setSettings} onClose={closeSettings} />}
      {toast && <div className="app-toast" role="alert" aria-live="assertive" aria-atomic="true"><span>{toast}</span><button aria-label="Dismiss notification" onClick={dismissToast} type="button">×</button></div>}
    </main>
  );
}

function normalizeTreePath(path: string) {
  const normalized = path.replace(/[\\/]+/g, "\\").toLowerCase();
  return normalized.length > 3 ? normalized.replace(/\\+$/, "") : normalized;
}

function isSameOrDescendantTreePath(parent: string, child: string) {
  const normalizedParent = normalizeTreePath(parent);
  const normalizedChild = normalizeTreePath(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent.endsWith("\\") ? normalizedParent : `${normalizedParent}\\`);
}

// Must stay in sync with the marker emitted by src-tauri/src/workspace_fs.rs
// when a path no longer exists on disk: the explorer silently drops tree
// entries carrying it instead of showing an inline error banner.
const WORKSPACE_ITEM_MISSING_MARKER = "Workspace item no longer exists";

function isWorkspaceItemMissing(reason: unknown): boolean {
  return String(reason).includes(WORKSPACE_ITEM_MISSING_MARKER);
}

function WorkspacePanel({ folders, activePath, onAdd, onActivate, onRemove, onOpenFile, onFolderContextAction, refreshRequest, collapseOtherFolders }: { folders: string[]; activePath: string; onAdd: () => void; onActivate: (path: string) => void; onRemove: (path: string) => void; onOpenFile: (root: string, entry: WorkspaceEntry) => void; onFolderContextAction: (action: FolderContextMenuAction, target: { root: string; path: string; isWorkspaceRoot: boolean }) => void; refreshRequest: { root: string; path: string; nonce: number } | null; collapseOtherFolders: boolean }) {
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [errorsByPath, setErrorsByPath] = useState<Record<string, string>>({});
  const [contextTarget, setContextTarget] = useState<FolderContextMenuTarget | null>(null);
  const loadedPathsRef = useRef(new Set<string>());
  const pendingPathsRef = useRef(new Set<string>());
  const treeGenerationRef = useRef(0);
  const metaByPathRef = useRef(new Map<string, { root: string; parentPath: string | null }>());
  const expandedPathsRef = useRef(expandedPaths);
  const folderSignature = folders.join("\u0000");

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  // Silently removes a tree entry that no longer exists on disk, together
  // with its cached state, so the tree mirrors the disk without an error.
  const dropMissingPath = useCallback((path: string) => {
    const meta = metaByPathRef.current.get(path);
    metaByPathRef.current.delete(path);
    loadedPathsRef.current.delete(path);
    pendingPathsRef.current.delete(path);
    setEntriesByPath((current) => {
      const next = { ...current };
      if (meta?.parentPath && next[meta.parentPath]) {
        next[meta.parentPath] = next[meta.parentPath].filter((entry) => entry.path !== path);
      }
      delete next[path];
      return next;
    });
    setExpandedPaths((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setLoadingPaths((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setErrorsByPath((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const loadDirectory = useCallback(async (root: string, path: string, options: { parentPath?: string; force?: boolean } = {}) => {
    if (!isTauri()) {
      setErrorsByPath((current) => ({ ...current, [path]: "File browsing is available in the desktop app." }));
      return;
    }
    if (pendingPathsRef.current.has(path)) return;
    if (!options.force && loadedPathsRef.current.has(path)) return;
    const generation = treeGenerationRef.current;
    metaByPathRef.current.set(path, { root, parentPath: options.parentPath ?? null });
    pendingPathsRef.current.add(path);
    setLoadingPaths((current) => ({ ...current, [path]: true }));
    setErrorsByPath((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    try {
      const entries = await invoke<WorkspaceEntry[]>("list_workspace_directory", { root, path });
      if (generation !== treeGenerationRef.current) return;
      setEntriesByPath((current) => ({ ...current, [path]: entries }));
      loadedPathsRef.current.add(path);
    } catch (reason) {
      if (generation !== treeGenerationRef.current) return;
      if (isWorkspaceItemMissing(reason) && options.parentPath) {
        dropMissingPath(path);
        return;
      }
      setErrorsByPath((current) => ({ ...current, [path]: String(reason) }));
    } finally {
      pendingPathsRef.current.delete(path);
      if (generation === treeGenerationRef.current) setLoadingPaths((current) => ({ ...current, [path]: false }));
    }
  }, [dropMissingPath]);

  // Re-reads every currently expanded directory so the tree reflects disk
  // changes that happened outside the app (focus regain, fs watcher events).
  const refreshExpandedDirectories = useCallback(() => {
    for (const [path, expanded] of Object.entries(expandedPathsRef.current)) {
      if (!expanded) continue;
      const meta = metaByPathRef.current.get(path);
      void loadDirectory(meta?.root ?? path, path, { force: true, parentPath: meta?.parentPath ?? undefined });
    }
  }, [loadDirectory]);

  useEffect(() => {
    treeGenerationRef.current += 1;
    loadedPathsRef.current.clear();
    pendingPathsRef.current.clear();
    metaByPathRef.current.clear();
    setExpandedPaths({});
    setEntriesByPath({});
    setLoadingPaths({});
    setErrorsByPath({});
  }, [folderSignature]);

  // Watch the workspace roots so external changes (deletes, renames, creates
  // from other apps) refresh the tree without manual interaction.
  useEffect(() => {
    if (!isTauri() || folders.length === 0) return;
    void invoke("watch_workspace_roots", { roots: folders }).catch(() => {});
  }, [folderSignature]);

  useEffect(() => {
    if (!activePath || !folders.includes(activePath)) return;
    setExpandedPaths((current) => collapseOtherFolders ? { [activePath]: true } : ({ ...current, [activePath]: true }));
    void loadDirectory(activePath, activePath);
  }, [activePath, collapseOtherFolders, folderSignature, loadDirectory]);

  const toggleDirectory = useCallback((root: string, path: string, parentPath: string | null) => {
    const expand = !expandedPaths[path];
    setExpandedPaths((current) => {
      if (!expand) return { ...current, [path]: false };
      if (!collapseOtherFolders) return { ...current, [path]: true };
      const ancestors = Object.keys(current).filter((candidate) =>
        current[candidate] && isSameOrDescendantTreePath(root, candidate) && isSameOrDescendantTreePath(candidate, path),
      );
      return Object.fromEntries([...ancestors, path].map((candidate) => [candidate, true]));
    });
    // Re-read on every expand so a folder that disappeared or changed while
    // collapsed is reconciled with the disk before its children are shown.
    if (expand) void loadDirectory(root, path, { force: true, parentPath: parentPath ?? undefined });
  }, [collapseOtherFolders, expandedPaths, loadDirectory]);

  useEffect(() => {
    if (!refreshRequest) return;
    void loadDirectory(refreshRequest.root, refreshRequest.path, { force: true });
  }, [loadDirectory, refreshRequest]);

  // The backend batches raw fs events; a single trailing refresh per burst is
  // enough since every refresh re-reads the current disk state.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    let debounceTimer: number | undefined;
    const scheduleRefresh = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => refreshExpandedDirectories(), 250);
    };
    void (async () => {
      try {
        const unlistenFsChanged = await listen<string[]>("workspace-fs-changed", (event) => {
          if (event.payload.length > 0) scheduleRefresh();
        });
        if (cancelled) {
          unlistenFsChanged();
          return;
        }
        unlisteners.push(unlistenFsChanged);
        const unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) refreshExpandedDirectories();
        });
        if (cancelled) {
          unlistenFocus();
          return;
        }
        unlisteners.push(unlistenFocus);
      } catch {
        // Refresh listeners are best effort; expand-time re-reads still cover
        // the core reconciliation.
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refreshExpandedDirectories]);

  const openFolderContextMenu = useCallback((root: string, path: string, isWorkspaceRoot: boolean, event: React.MouseEvent) => {
    event.preventDefault();
    setContextTarget({ root, path, isWorkspaceRoot, x: event.clientX, y: event.clientY });
  }, []);

  const renderEntries = (entries: WorkspaceEntry[], root: string, depth: number, parentPath: string | null): ReactElement[] => entries.map((entry) => {
    const expanded = Boolean(expandedPaths[entry.path]);
    const children = entriesByPath[entry.path] ?? [];
    return <WorkspaceTreeNode
      key={entry.path}
      entry={entry}

      depth={depth}
      expanded={expanded}
      children={children}
      loading={Boolean(loadingPaths[entry.path])}
      error={errorsByPath[entry.path] ?? null}
      onToggle={() => toggleDirectory(root, entry.path, parentPath)}
      onRetry={() => void loadDirectory(root, entry.path, { force: true, parentPath: parentPath ?? undefined })}
      onOpen={() => onOpenFile(root, entry)}
      onContextMenu={entry.isDir ? (event) => openFolderContextMenu(root, entry.path, false, event) : undefined}
      renderChildren={(childEntries, childDepth) => renderEntries(childEntries, root, childDepth, entry.path)}
    />;
  });

  return <div className="tool-view workspace-view">
    <header className="tool-header workspace-explorer-header"><div><h1>Explorer</h1><p>{folders.length} {folders.length === 1 ? "folder" : "folders"} in this workspace</p></div><button className="icon-button refresh-button" aria-label="Add folders to this workspace" title="Add folders" onClick={onAdd} type="button">＋</button></header>
    <div className="workspace-explorer-tree" role="tree" aria-label="Workspace files">
      {folders.length === 0 ? <div className="workspace-empty"><div className="empty-icon">▣</div><h2>No folders in this workspace</h2><p>Add folders here to browse their files. Each workspace keeps its own folders.</p><button className="primary-button" onClick={onAdd} type="button">Add Folder</button></div> : folders.map((folder) => {
        const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
        const selected = folder === activePath;
        const expanded = Boolean(expandedPaths[folder]);
        const entries = entriesByPath[folder] ?? [];
        return <section className={`workspace-root ${selected ? "selected" : ""}`} key={folder}>
          <div className="workspace-root-row" role="treeitem" aria-level={1} aria-expanded={expanded} onContextMenu={(event) => openFolderContextMenu(folder, folder, true, event)}>
            <button className="workspace-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`} aria-expanded={expanded} onClick={() => toggleDirectory(folder, folder, null)} type="button">{expanded ? "⌄" : "›"}</button>
            <button className="workspace-folder-select" onClick={() => { onActivate(folder); if (selected) toggleDirectory(folder, folder, null); }} type="button" aria-pressed={selected} title={folder}>
              <span className="workspace-folder-icon" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M1.75 4.5a1 1 0 0 1 1-1h3.1l1.4 1.5h5.9a1 1 0 0 1 1 1v6.4H1.75z" /></svg></span>
              <span className="workspace-folder-label"><strong>{name}</strong><small>{folder}</small></span>
            </button>
            <button className="workspace-folder-remove" aria-label={`Remove ${name} from this workspace`} title="Remove folder" onClick={() => onRemove(folder)} type="button">×</button>
          </div>
          {expanded && <div className="workspace-tree-children" role="group">
            {loadingPaths[folder] && <div className="workspace-tree-message">Loading folder…</div>}
            {errorsByPath[folder] && <div className="workspace-tree-error"><span>{errorsByPath[folder]}</span><button onClick={() => void loadDirectory(folder, folder, { force: true })} type="button">Retry</button></div>}
            {!loadingPaths[folder] && !errorsByPath[folder] && entries.length === 0 && loadedPathsRef.current.has(folder) && <div className="workspace-tree-message">This folder is empty.</div>}
            {renderEntries(entries, folder, 1, folder)}
          </div>}
        </section>;
      })}
    </div>
    <div className="panel-footnote workspace-explorer-footnote"><span className="read-only-mark">⌂</span> Right-click folders for actions</div>
    <FolderContextMenu
      target={contextTarget}
      onClose={() => setContextTarget(null)}
      onAction={(action) => {
        if (contextTarget) onFolderContextAction(action, { root: contextTarget.root, path: contextTarget.path, isWorkspaceRoot: contextTarget.isWorkspaceRoot });
      }}
    />
  </div>;
}

function WorkspaceTreeNode({ entry, depth, expanded, children, loading, error, onToggle, onRetry, onOpen, onContextMenu, renderChildren }: {
  entry: WorkspaceEntry;

  depth: number;
  expanded: boolean;
  children: WorkspaceEntry[];
  loading: boolean;
  error: string | null;
  onToggle: () => void;
  onRetry: () => void;
  onOpen: (button: HTMLButtonElement) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  renderChildren: (entries: WorkspaceEntry[], depth: number) => ReactElement[];
}) {
  const extension = entry.extension ?? entry.name.split(".").pop() ?? "file";
  const fileBadge = entry.isDir ? "" : extension.slice(0, 2).toUpperCase();
  return <div className="workspace-tree-node" role="treeitem" aria-level={depth + 1} aria-expanded={entry.isDir ? expanded : undefined}>
    <div className={`workspace-tree-row ${entry.isDir ? "directory" : "file"}`} style={{ paddingLeft: (depth + 1) * 16, "--tree-guide-width": `${depth * 16}px`, "--tree-branch-start": `${depth * 16 - 1}px` } as CSSProperties} onContextMenu={entry.isDir ? onContextMenu : undefined}>
      {entry.isDir ? <button className="workspace-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`} aria-expanded={expanded} onClick={onToggle} type="button">{expanded ? "⌄" : "›"}</button> : <span className="workspace-tree-toggle-spacer" />}
      {entry.isDir ? <button className="workspace-tree-entry" onClick={onToggle} title={entry.path} type="button"><span className="workspace-tree-file-icon folder" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M1.75 4.5a1 1 0 0 1 1-1h3.1l1.4 1.5h5.9a1 1 0 0 1 1 1v6.4H1.75z" /></svg></span><span className="workspace-tree-name">{entry.name}</span></button> : <button className="workspace-tree-entry" onClick={(event) => onOpen(event.currentTarget)} title={entry.path} type="button"><span className={`workspace-tree-file-icon ext-${extension.replace(/[^a-z0-9]/gi, "").toLowerCase()}`} aria-hidden="true">{fileBadge || "F"}</span><span className="workspace-tree-name">{entry.name}</span><span className="workspace-tree-size">{entry.size === null ? "" : formatFileSize(entry.size)}</span></button>}
    </div>
    {entry.isDir && expanded && <div className="workspace-tree-children" role="group">
      {loading && <div className="workspace-tree-message" style={{ paddingLeft: 25 + depth * 12 }}>Loading folder…</div>}
      {error && <div className="workspace-tree-error" style={{ paddingLeft: 25 + depth * 12 }}><span>{error}</span><button onClick={onRetry} type="button">Retry</button></div>}
      {!loading && !error && children.length === 0 && <div className="workspace-tree-message" style={{ paddingLeft: 25 + depth * 12 }}>This folder is empty.</div>}
      {renderChildren(children, depth + 1)}
    </div>}
  </div>;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function GitChanges({ repoPaths, onOpenRepository, onOpenDiff, onError }: { repoPaths: string[]; onOpenRepository: () => void; onOpenDiff: (change: FileChange, staged: boolean) => void; onError: (message: string) => void }) {
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!isTauri() || repoPaths.length === 0) { setRepositories([]); return; }
    const paths = [...new Set(repoPaths.filter(Boolean))];
    void Promise.all(paths.map((path) => invoke<RepositoryInfo>("git_repository_info", { path }).catch(() => null)))
      .then((infos) => {
        if (cancelled) return;
        const unique = new Map<string, RepositoryInfo>();
        for (const info of infos) {
          if (!info?.root) continue;
          const key = info.root.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
          if (!unique.has(key)) unique.set(key, info);
        }
        setRepositories([...unique.values()]);
      });
    return () => { cancelled = true; };
  }, [refreshNonce, repoPaths]);

  return <div className="tool-view git-changes-view">
    <header className="tool-header"><div><h1>Git Changes</h1><p>{repositories.length > 0 ? `${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}` : repoPaths.length ? "Searching opened folders for Git repositories" : "Review your working trees"}</p></div><button className="icon-button refresh-button" aria-label="Refresh repositories and changes" onClick={() => setRefreshNonce((value) => value + 1)} type="button">↻</button></header>
    {repositories.length === 0 ? <div className="empty-repository"><div className="empty-icon">⌂</div><h2>{repoPaths.length ? "No Git repository found" : "No repository opened"}</h2><p>{repoPaths.length ? "Add a folder that belongs to a Git repository to view its changes." : "Open a folder to view its changes."}</p><button className="primary-button" onClick={onOpenRepository} type="button">Open Folder</button></div> : <div className="git-repository-list" aria-label="Git repositories">
      {repositories.map((repoInfo) => <GitRepositoryChanges key={repoInfo.root.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase()} repoInfo={repoInfo} refreshNonce={refreshNonce} onOpenDiff={onOpenDiff} onError={onError} />)}
    </div>}
    <div className="panel-footnote"><span className="read-only-mark">◇</span> Stage, unstage, discard, and commit changes</div>
  </div>;
}

function GitRepositoryChanges({ repoInfo, refreshNonce, onOpenDiff, onError }: { repoInfo: RepositoryInfo; refreshNonce: number; onOpenDiff: (change: FileChange, staged: boolean) => void; onError: (message: string) => void }) {
  const repoPath = repoInfo.root;
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [fileAction, setFileAction] = useState<{ path: string; action: string } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const stagedChanges = changes.filter((change) => change.staged);
  const unstagedChanges = changes.filter((change) => change.unstaged);

  const refresh = useCallback(async () => {
    if (!repoPath || !repoInfo || !isTauri()) return;
    try { setChanges(await invoke<FileChange[]>("git_status", { path: repoPath })); }
    catch (reason) { onError(String(reason)); }
  }, [onError, repoInfo, repoPath]);

  const runFileAction = async (action: "stage" | "unstage" | "discard", filePath: string) => {
    if (!repoPath || !repoInfo || fileAction) return;
    const command = action === "stage" ? "git_stage_file" : action === "unstage" ? "git_unstage_file" : "git_discard_worktree_file";
    setFileAction({ path: filePath, action });
    try {
      await invoke<void>(command, { path: repoPath, filePath });
      await refresh();
    } catch (reason) {
      onError(String(reason));
    } finally {
      setFileAction(null);
    }
  };

  const commitStaged = async () => {
    if (!repoPath || !repoInfo || stagedChanges.length === 0 || !commitMessage.trim() || isCommitting) return;
    setIsCommitting(true);
    try {
      const commitId = await invoke<string>("git_commit_staged", { path: repoPath, message: commitMessage });
      setCommitMessage("");
      await refresh();
      onError(`Created commit ${commitId.slice(0, 7)}`);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setIsCommitting(false);
    }
  };

  useEffect(() => { void refresh(); }, [refresh, refreshNonce]);
  useEffect(() => { setCommitMessage(""); setDiscardTarget(null); }, [repoPath]);

  const renderChangeRow = (change: FileChange, staged: boolean) => <div className="change-row" key={`${staged ? "staged" : "unstaged"}:${change.path}`}>
    <button className="change-main-row" onClick={() => onOpenDiff(change, staged)} type="button" title={change.path}>
      <span className={`change-kind ${change.kind}`}>{change.kind === "modified" ? "M" : change.kind === "deleted" ? "D" : change.kind === "untracked" ? "?" : change.kind === "renamed" ? "R" : "A"}</span>
      <span className="change-path">{change.path}</span>
      {staged && <span className="change-badge">S</span>}
      {!staged && <span className="change-badge unstaged">U</span>}
    </button>
    <div className="change-row-actions">
      <button className={`change-action ${staged ? "unstage" : "stage"}`} aria-label={`${staged ? "Unstage" : "Stage"} ${change.path}`} title={`${staged ? "Unstage" : "Stage"} change`} disabled={Boolean(fileAction)} onClick={() => void runFileAction(staged ? "unstage" : "stage", change.path)} type="button">
        <span aria-hidden="true">{fileAction?.path === change.path && fileAction.action === (staged ? "unstage" : "stage") ? "…" : staged ? "−" : "+"}</span>
      </button>
      {!staged && <button className="change-action discard" aria-label={`Discard working tree changes to ${change.path}`} title="Discard working tree changes" disabled={Boolean(fileAction)} onClick={() => setDiscardTarget(change.path)} type="button"><span aria-hidden="true">↶</span></button>}
    </div>
  </div>;

  const repoName = repoInfo.root.split(/[\\/]/).filter(Boolean).pop() ?? repoInfo.root;
  const toggleExpanded = () => setExpanded((current) => !current);

  return <section className={`git-repository-section${expanded ? " is-expanded" : ""}`}>
    <header className="git-repository-heading">
      <button className="git-repository-toggle" aria-expanded={expanded} onClick={toggleExpanded} type="button" title={repoInfo.root}>
        <span className="git-repository-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
        <span className="git-repository-name"><strong>{repoName}</strong></span>
        <span className="git-repository-branch" title="Current branch">{repoInfo.branch || "Detached HEAD"}</span>
        <span className="git-repository-counts">{stagedChanges.length} staged · {unstagedChanges.length} changes</span>
      </button>
      <button className="icon-button refresh-button git-repository-refresh" aria-label={`Refresh ${repoName} changes`} title="Refresh repository" onClick={() => void refresh()} type="button">↻</button>
    </header>
    <div className="git-repository-body" hidden={!expanded}>
      {changes.length > 0 && <section className="git-commit-box" aria-label="Commit staged changes">
        <textarea aria-label="Commit message" placeholder="Message (required)" rows={2} maxLength={65536} value={commitMessage} onChange={(event) => setCommitMessage(event.currentTarget.value)} />
        <button className="git-commit-button" onClick={() => void commitStaged()} disabled={isCommitting || Boolean(fileAction) || stagedChanges.length === 0 || !commitMessage.trim()} type="button"><span aria-hidden="true">✓</span><span>{isCommitting ? "Committing…" : "Commit staged"}</span><small>{stagedChanges.length}</small></button>
      </section>}
      <div className="change-list" aria-label="Repository changes">
        {changes.length === 0 ? <div className="change-empty">Working tree clean</div> : <>
          {stagedChanges.length > 0 && <section className="change-group" aria-label="Staged changes">
            <header className="change-group-heading"><span>Staged Changes</span><span>{stagedChanges.length}</span></header>
            {stagedChanges.map((change) => renderChangeRow(change, true))}
          </section>}
          {unstagedChanges.length > 0 && <section className="change-group" aria-label="Changes">
            <header className="change-group-heading"><span>Changes</span><span>{unstagedChanges.length}</span></header>
            {unstagedChanges.map((change) => renderChangeRow(change, false))}
          </section>}
        </>}
      </div>
      {discardTarget && createPortal(
        <div className="git-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDiscardTarget(null); }}>
          <section className="git-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description">
            <div className="git-confirm-heading"><span aria-hidden="true">↶</span><div><h2 id="discard-title">Discard working tree changes?</h2><p id="discard-description">This permanently removes the unstaged version. Staged content is kept.</p></div></div>
            <code className="git-confirm-path" title={discardTarget}>{discardTarget}</code>
            <footer><button type="button" onClick={() => setDiscardTarget(null)}>Cancel</button><button className="git-confirm-danger" type="button" disabled={Boolean(fileAction)} onClick={() => { const path = discardTarget; setDiscardTarget(null); void runFileAction("discard", path); }}>Discard changes</button></footer>
          </section>
        </div>,
        document.body,
      )}
    </div>
  </section>;
}

function GitGraph({ repoPath, onError, onOpenInEditor }: { repoPath: string; onError: (message: string) => void; onOpenInEditor: (commit: CommitInfo, file: CommitFileChange) => void }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const commitsRef = useRef<CommitInfo[]>([]);
  const hasMoreRef = useRef(true);
  const [hasMore, setHasMore] = useState(true);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  const detailRequestRef = useRef(0);
  const fileDiffRequestRef = useRef(0);
  const repoPathRef = useRef(repoPath);
  const onErrorRef = useRef(onError);
  repoPathRef.current = repoPath;
  onErrorRef.current = onError;
  const [selectedCommit, setSelectedCommit] = useState<CommitInfo | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [commitFiles, setCommitFiles] = useState<CommitFileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fileDiffError, setFileDiffError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastCommitButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (append: boolean) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri() || loadingRef.current || (append && !hasMoreRef.current)) return;
    const requestId = ++requestIdRef.current;
    const existing = append ? commitsRef.current : [];
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await invoke<CommitInfo[]>("git_history", { path: requestedPath, skip: existing.length, limit: COMMIT_PAGE_SIZE + 1 });
      if (requestId !== requestIdRef.current || repoPathRef.current !== requestedPath) return;
      const hasNextPage = page.length > COMMIT_PAGE_SIZE;
      const nextCommits = append
        ? [...existing, ...page.slice(0, COMMIT_PAGE_SIZE).filter((commit) => !existing.some((loaded) => loaded.id === commit.id))]
        : page.slice(0, COMMIT_PAGE_SIZE);
      commitsRef.current = nextCommits;
      hasMoreRef.current = hasNextPage;
      setCommits(nextCommits);
      setHasMore(hasNextPage);
    } catch (reason) {
      if (requestId === requestIdRef.current && repoPathRef.current === requestedPath) onErrorRef.current(String(reason));
    } finally {
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    loadingRef.current = false;
    commitsRef.current = [];
    hasMoreRef.current = true;
    setLoading(false);
    setCommits([]);
    setHasMore(true);
    void load(false);
  }, [repoPath, load]);

  const selectCommit = useCallback(async (commit: CommitInfo) => {
    const requestedPath = repoPath;
    if (!requestedPath || !isTauri()) return;
    const requestId = ++detailRequestRef.current;
    fileDiffRequestRef.current += 1;
    setSelectedCommit(commit);
    setCommitFiles([]);
    setSelectedFile(null);
    setFileDiff("");
    setFileDiffLoading(false);
    setDetailError(null);
    setFileDiffError(null);
    setDetailLoading(true);
    try {
      const files = await invoke<CommitFileChange[]>("git_commit_files", { path: requestedPath, commitId: commit.id });
      if (requestId !== detailRequestRef.current || repoPathRef.current !== requestedPath) return;
      setCommitFiles(files);
    } catch (reason) {
      if (requestId === detailRequestRef.current && repoPathRef.current === requestedPath) { setDetailError(String(reason)); onError(String(reason)); }
    } finally {
      if (requestId === detailRequestRef.current && repoPathRef.current === requestedPath) setDetailLoading(false);
    }
  }, [onError, repoPath]);

  const selectFile = useCallback(async (filePath: string) => {
    const requestedPath = repoPath;
    const commit = selectedCommit;
    if (!requestedPath || !commit || !isTauri()) return;
    const requestId = ++fileDiffRequestRef.current;
    const requestedCommitId = commit.id;
    setSelectedFile(filePath);
    setFileDiff("");
    setFileDiffError(null);
    setFileDiffLoading(true);
    try {
      const diff = await invoke<string>("git_commit_file_diff", { path: requestedPath, commitId: requestedCommitId, filePath });
      if (requestId !== fileDiffRequestRef.current || repoPathRef.current !== requestedPath) return;
      setFileDiff(diff);
    } catch (reason) {
      if (requestId === fileDiffRequestRef.current && repoPathRef.current === requestedPath) { setFileDiffError(String(reason)); onError(String(reason)); }
    } finally {
      if (requestId === fileDiffRequestRef.current && repoPathRef.current === requestedPath) setFileDiffLoading(false);
    }
  }, [onError, repoPath, selectedCommit]);

  const closeCommitDetails = useCallback((restoreFocus = true) => {
    setDetailsOpen(false);
    if (restoreFocus) requestAnimationFrame(() => lastCommitButtonRef.current?.focus());
  }, []);

  const commitMessageParts = selectedCommit?.message.split(/\r?\n/) ?? [];
  const commitSubject = commitMessageParts[0] ?? "";
  const commitDescription = commitMessageParts.slice(1).join("\n").trim();

  useEffect(() => {
    detailRequestRef.current += 1;
    fileDiffRequestRef.current += 1;
    setDetailsOpen(false);
    setSelectedCommit(null);
    setCommitFiles([]);
    setSelectedFile(null);
    setFileDiff("");
    setDetailLoading(false);
    setFileDiffLoading(false);
  }, [repoPath]);

  useEffect(() => {
    if (!detailsOpen || !selectedCommit) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCommitDetails();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeCommitDetails, detailsOpen, selectedCommit]);

  return <div className="tool-view">
    <header className="tool-header"><div><h1>Git Graph</h1><p>{repoPath ? `${commits.length} commits loaded` : "Repository commit history"}</p></div><button className="icon-button refresh-button" aria-label="Refresh history" onClick={() => void load(false)} type="button">↻</button></header>
    {!repoPath ? <div className="empty-repository graph-empty"><div className="graph-preview"><span /><span /><span /></div><h2>History unavailable</h2><p>Open a Git repository to browse its commit graph.</p></div> : <>
      <div className="commit-list">{commits.map((commit) => <button className={`commit-row ${selectedCommit?.id === commit.id ? "selected" : ""}`} key={commit.id} onClick={(event) => { lastCommitButtonRef.current = event.currentTarget; setDetailsOpen(false); void selectCommit(commit); }} type="button" aria-pressed={selectedCommit?.id === commit.id}><span className="commit-rail"><svg aria-hidden="true"><line x1="10" y1="0" x2="10" y2="100%" className="commit-line" /></svg><span className="commit-node" /></span><span className="commit-info"><span className="commit-message" title={commit.message}>{commit.message}</span><span className="commit-meta"><code>{commit.shortId}</code><span>{commit.author}</span><time>{new Date(commit.timestamp * 1000).toLocaleDateString()}</time></span>{commit.branches.map((branch) => <span className="branch-label" key={branch}>{branch}</span>)}</span></button>)}
        {commits.length === 0 && !loading && <div className="change-empty">No commits found.</div>}
      </div>
      {commits.length > 0 && hasMore && <button className="load-more" onClick={() => void load(true)} disabled={loading} type="button">{loading ? "Loading…" : "Load more commits"}</button>}
      {selectedCommit ? <section className="graph-change-panel" aria-label="Selected commit changed files">
        <header className="graph-change-header">
          <div className="graph-change-heading"><span>Commit <code>{selectedCommit.shortId}</code></span><strong title={commitSubject}>{commitSubject}</strong></div>
          <button className="graph-change-details" type="button" onClick={() => setDetailsOpen(true)}>View details <span aria-hidden="true">↗</span></button>
        </header>
        <div className="graph-change-meta"><span>{selectedCommit.author}</span><time>{new Date(selectedCommit.timestamp * 1000).toLocaleString()}</time><span>{detailLoading ? "Loading files…" : detailError ? "Files unavailable" : `${commitFiles.length} changed ${commitFiles.length === 1 ? "file" : "files"}`}</span></div>
        <div className="graph-change-files">
          {detailLoading ? <div className="graph-change-state" role="status">Loading changed files…</div> : detailError ? <div className="graph-change-state graph-change-error" role="alert"><span>{detailError}</span><button type="button" onClick={() => void selectCommit(selectedCommit)}>Retry</button></div> : commitFiles.length === 0 ? <div className="graph-change-state">No files changed in this commit.</div> : commitFiles.map((file) => <div className="graph-change-file" key={file.path}>
            <button className="graph-change-open" type="button" onClick={() => onOpenInEditor(selectedCommit, file)} title={`Open ${file.path} in the Code view`}><span className={`change-kind ${file.kind}`}>{file.kind === "deleted" ? "D" : file.kind === "added" ? "A" : file.kind === "renamed" ? "R" : "M"}</span><span className="graph-change-path" title={file.path}>{file.path}</span><span className="graph-change-kind">{file.kind}</span><span className="graph-change-open-icon" aria-hidden="true">↗</span></button>
            <button className="graph-change-diff" type="button" onClick={() => { setDetailsOpen(true); void selectFile(file.path); }} title={`Review ${file.path} diff`} aria-label={`Review diff for ${file.path}`}>Diff</button>
          </div>)}
        </div>
      </section> : <div className="graph-change-panel graph-change-empty"><span className="read-only-mark" aria-hidden="true">◉</span><span>Select a commit to see its changed files here.</span></div>}
    </>}
    <div className="panel-footnote"><span className="read-only-mark">◉</span> Incremental history loading</div>
    {detailsOpen && selectedCommit && createPortal(
      <div className="commit-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCommitDetails(); }}>
        <section className="commit-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="commit-preview-title" aria-describedby="commit-preview-summary" onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
          <header className="commit-preview-header">
            <div className="commit-preview-heading">
              <div className="commit-preview-kicker"><span className="commit-preview-dot" />Commit <code>{selectedCommit.shortId}</code></div>
              <h2 id="commit-preview-title" title={commitSubject}>{commitSubject}</h2>
              {commitDescription ? <p className="commit-preview-description" id="commit-preview-summary">{commitDescription}</p> : <p className="commit-preview-description" id="commit-preview-summary">Changes introduced by this commit.</p>}

              <div className="commit-preview-meta"><span>{selectedCommit.author}</span><span>{new Date(selectedCommit.timestamp * 1000).toLocaleString()}</span><code title={selectedCommit.id}>{selectedCommit.id}</code></div>
              {selectedCommit.branches.length > 0 && <div className="commit-preview-branches" aria-label="Branches">{selectedCommit.branches.map((branch) => <span className="branch-label" key={branch}>{branch}</span>)}</div>}
            </div>
            <button ref={closeButtonRef} className="commit-preview-close" onClick={() => closeCommitDetails()} aria-label="Close commit details" title="Close details (Esc)" type="button">×</button>
          </header>
          <div className="commit-preview-body">
            <aside className="commit-preview-files" aria-label="Changed files">
              <div className="commit-preview-files-heading"><h3>Changed files</h3><span>{detailLoading ? "…" : commitFiles.length}</span></div>
              <div className="commit-preview-file-list">
                {detailLoading ? <div className="commit-preview-state" role="status">Loading changed files…</div> : detailError ? <div className="commit-preview-state commit-preview-error" role="alert"><span>{detailError}</span><button type="button" onClick={() => void selectCommit(selectedCommit)}>Retry loading files</button></div> : commitFiles.length === 0 ? <div className="commit-preview-state">No files changed in this commit.</div> : commitFiles.map((file) => <button className="commit-preview-file" key={file.path} onClick={() => { onOpenInEditor(selectedCommit, file); closeCommitDetails(false); }} type="button" title={`Open ${file.path} in the Code view`}>
                  <span className={`change-kind ${file.kind}`}>{file.kind === "deleted" ? "D" : file.kind === "added" ? "A" : file.kind === "renamed" ? "R" : "M"}</span><span className="commit-preview-file-path">{file.path}</span><span className="commit-preview-file-kind">{file.kind}</span>
                </button>)}
              </div>
            </aside>
            <section className="commit-preview-diff" aria-label="Selected file diff">
              <div className="commit-preview-file-heading">
                {selectedFile ? <><span className={`change-kind ${commitFiles.find((file) => file.path === selectedFile)?.kind ?? "modified"}`}>{commitFiles.find((file) => file.path === selectedFile)?.kind === "deleted" ? "D" : commitFiles.find((file) => file.path === selectedFile)?.kind === "added" ? "A" : commitFiles.find((file) => file.path === selectedFile)?.kind === "renamed" ? "R" : "M"}</span><span title={selectedFile}>{selectedFile}</span></> : <span>Select a file to inspect its changes</span>}
                {selectedFile && <button className="commit-open-editor" type="button" onClick={() => { const file = commitFiles.find((entry) => entry.path === selectedFile); if (file) { onOpenInEditor(selectedCommit, file); closeCommitDetails(false); } }} title="Open this commit version in the Code view">Open in editor <span aria-hidden="true">↗</span></button>}
              </div>
              <div className="commit-preview-diff-content">
                {detailLoading ? <div className="commit-preview-state" role="status">Loading commit details…</div> : !selectedFile ? <div className="commit-preview-state">Choose a changed file from the list to view its patch.</div> : fileDiffLoading ? <div className="commit-preview-state" role="status">Loading diff…</div> : fileDiffError ? <div className="commit-preview-state commit-preview-error" role="alert"><span>{fileDiffError}</span><button type="button" onClick={() => void selectFile(selectedFile)}>Retry loading diff</button></div> : <DiffViewer diff={fileDiff} emptyMessage="No diff available for this file in the selected commit." />}
              </div>
            </section>
          </div>
          <footer className="commit-preview-footer"><span>{detailLoading ? "Loading files…" : `${commitFiles.length} changed ${commitFiles.length === 1 ? "file" : "files"}`}</span><span>{fileDiffLoading ? "Loading patch…" : fileDiff ? `${fileDiff.split(/\r?\n/).length} lines` : "Read-only commit details"}</span><span>Press Esc to close</span></footer>
        </section>
      </div>,
      document.body,
    )}
  </div>;
}
type LayoutRect = { x: number; y: number; width: number; height: number };
type LayoutDividerInfo = { id: string; direction: "horizontal" | "vertical"; ratio: number; rect: LayoutRect };
type LayoutGeometry = { panes: Map<string, LayoutRect>; dividers: LayoutDividerInfo[] };
type TerminalWorkspaceLayoutProps = {
  layout: LayoutNode | null;
  focusedTerminalId: string | null;
  terminals: TerminalSession[];
  visibleTerminalIds: string[];
  workspaceId: string;
  onDockToTiledLayout: (sessionId: string, edge: TerminalDockEdge) => void;
  onModeState: (mode: TerminalLayoutMode, setMode: (mode: TerminalLayoutMode) => void) => void;
  activeTerminalId: string | null;
  onLinkHint?: (message: string) => void;
  onFocus: (sessionId: string) => void;
  onExit: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
};

function TerminalWorkspaceLayout({ layout, focusedTerminalId, terminals, visibleTerminalIds, workspaceId, onDockToTiledLayout, onModeState, activeTerminalId, onLinkHint, onFocus, onExit, onClose, onMove, onResize }: TerminalWorkspaceLayoutProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scrollportRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const paneDragRef = useRef<{ sourceId: string; pointerId: number; startX: number; startY: number; started: boolean } | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const floatingLayout = useFloatingTerminalLayout(workspaceId, visibleTerminalIds, onDockToTiledLayout);
  useEffect(() => onModeState(floatingLayout.mode, floatingLayout.setMode), [floatingLayout.mode, floatingLayout.setMode, onModeState]);
  const tiledAllTerminals = !focusedTerminalId && floatingLayout.mode === "tiled" && Boolean(layout);
  const minimumTiledWidth = layout ? getMinimumTerminalLayoutWidth(layout) : 0;
  const geometry = useMemo(() => {
    if (focusedTerminalId && visibleTerminalIds.includes(focusedTerminalId)) return { panes: new Map([[focusedTerminalId, { x: 0, y: 0, width: 100, height: 100 }]]), dividers: [] };
    if (floatingLayout.mode === "floating") {
      const panes = new Map<string, LayoutRect>();
      for (const terminalId of visibleTerminalIds) {
        const rect = floatingLayout.positions[terminalId];
        if (rect) panes.set(terminalId, rect);
      }
      return { panes, dividers: [] };
    }
    if (layout) return getLayoutGeometry(layout);
    const panes = new Map<string, LayoutRect>();
    if (activeTerminalId) panes.set(activeTerminalId, { x: 0, y: 0, width: 100, height: 100 });
    return { panes, dividers: [] };
  }, [activeTerminalId, focusedTerminalId, floatingLayout.mode, floatingLayout.positions, layout, visibleTerminalIds.join("\u0000")]);

  const activePaneVisible = Boolean(activeTerminalId && geometry.panes.has(activeTerminalId));

  useEffect(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport || !tiledAllTerminals || !activeTerminalId || !activePaneVisible) return;

    const revealActivePane = () => {
      const pane = paneRefs.current.get(activeTerminalId);
      if (!pane) return;
      const viewport = scrollport.getBoundingClientRect();
      const bounds = pane.getBoundingClientRect();
      if (bounds.left < viewport.left) {
        scrollport.scrollBy({ left: bounds.left - viewport.left, behavior: "smooth" });
      } else if (bounds.right > viewport.right) {
        scrollport.scrollBy({ left: bounds.right - viewport.right, behavior: "smooth" });
      }
    };

    const frameId = window.requestAnimationFrame(revealActivePane);
    const observer = new ResizeObserver(() => window.requestAnimationFrame(revealActivePane));
    observer.observe(scrollport);
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [activeTerminalId, activePaneVisible, tiledAllTerminals]);

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

  return <div className={`terminal-layout-scrollport${tiledAllTerminals ? " is-tiled" : ""}`} ref={scrollportRef}>
  <div className={`terminal-layout-surface ${floatingLayout.mode === "floating" ? "floating-terminal-canvas" : ""}${tiledAllTerminals ? " tiled-scroll-canvas" : ""}`} style={tiledAllTerminals ? { "--terminal-layout-min-width": `${minimumTiledWidth}px` } as CSSProperties : undefined} ref={(element) => { surfaceRef.current = element; floatingLayout.surfaceRef.current = element; }} data-mode={floatingLayout.mode} data-pane-dragging={draggingPaneId || floatingLayout.draggingSessionId ? "true" : undefined}>
    {terminals.map((terminal) => {
      const rect = geometry.panes.get(terminal.id);
      const isFloating = !focusedTerminalId && floatingLayout.mode === "floating" && visibleTerminalIds.includes(terminal.id);
      const isSingleTerminal = focusedTerminalId === terminal.id || (!layout && floatingLayout.mode === "tiled" && visibleTerminalIds.length === 1 && visibleTerminalIds[0] === terminal.id);
      const hasPaneHeader = Boolean(rect && !focusedTerminalId && (isFloating || (visibleTerminalIds.length > 1 && layout)));
      const style: CSSProperties = rect
        ? { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }
        : { display: "none" };
      return <div
        key={terminal.id}
        className={`terminal-pane-frame ${rect && layout ? "layout-pane" : ""} ${isSingleTerminal ? "single-terminal-pane" : ""} ${isFloating ? "floating-terminal-window" : ""}`}
        style={style}
        ref={(element) => {
          if (element) paneRefs.current.set(terminal.id, element);
          else paneRefs.current.delete(terminal.id);
        }}
        data-active={terminal.id === activeTerminalId ? "true" : undefined}
        data-drag-over={dropTargetPaneId === terminal.id ? "true" : undefined}
        data-drag-source={draggingPaneId === terminal.id ? "true" : undefined}
        data-dragging={floatingLayout.draggingSessionId === terminal.id ? "true" : undefined}
        data-resizing={floatingLayout.resizingSessionId === terminal.id ? "true" : undefined}
      >
      {isFloating && (["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] as const).map((direction) => <div
          key={direction}
        className={`floating-terminal-resize-handle ${direction.includes("-") ? "corner" : "edge"} ${direction}`}
          role="separator"
          tabIndex={0}
        aria-orientation={direction === "left" || direction === "right" ? "vertical" : direction === "top" || direction === "bottom" ? "horizontal" : undefined}
          aria-label={`Resize ${terminal.name} ${direction}`}
          aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
          title="Drag to resize · Alt+Shift+Arrow to adjust while focused"
          onFocus={() => onFocus(terminal.id)}
          onKeyDown={(event) => {
            if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
            if (floatingLayout.nudgeResize(terminal.id, direction, event.key)) {
              event.preventDefault();
              event.stopPropagation();
              onFocus(terminal.id);
            }
          }}
          onPointerDown={(event) => { onFocus(terminal.id); floatingLayout.startResize(terminal.id, direction, event); }}
          onPointerMove={(event) => floatingLayout.moveResize(terminal.id, event)}
          onPointerUp={(event) => floatingLayout.endResize(terminal.id, event)}
          onPointerCancel={(event) => floatingLayout.cancelResize(terminal.id, event)}
        />)}
        {hasPaneHeader && <header
          className={`terminal-pane-header ${isSingleTerminal ? "single-terminal-pane-header" : ""}`}
          onPointerDown={isFloating ? (event) => {
            if (event.button !== 0) return;
            if (event.target instanceof Element && event.target.closest(".pane-rename, .pane-close, input, textarea, [contenteditable=true], button:not(.pane-drag-handle), .floating-terminal-resize-handle")) return;
            onFocus(terminal.id);
            floatingLayout.startDrag(terminal.id, event);
          } : undefined}
          onPointerMove={isFloating ? (event) => floatingLayout.moveDrag(terminal.id, event) : undefined}
          onPointerUp={isFloating ? (event) => floatingLayout.endDrag(terminal.id, event) : undefined}
          onPointerCancel={isFloating ? (event) => floatingLayout.cancelDrag(terminal.id, event) : undefined}
          onMouseDown={(event) => {
            if (!isFloating || visibleTerminalIds.length <= 1 || event.button !== 1) return;
            if (event.target instanceof Element && event.target.closest(".pane-rename, .pane-close, input, textarea, [contenteditable=true], button:not(.pane-drag-handle)")) return;
            event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (!isFloating || visibleTerminalIds.length <= 1 || event.button !== 1) return;
            if (event.target instanceof Element && event.target.closest(".pane-rename, .pane-close, input, textarea, [contenteditable=true], button:not(.pane-drag-handle)")) return;
            event.preventDefault();
            event.stopPropagation();
            onClose(terminal.id);
          }}
        >
          {((layout && !focusedTerminalId) || isFloating) && <button
            className={`pane-drag-handle ${isFloating ? "floating-terminal-window-handle" : ""}`}
            type="button"
            aria-label={isFloating ? `Move ${terminal.name} around the free terminal canvas` : `Drag ${terminal.name} to swap pane positions`}
            title={isFloating ? "Drag this terminal freely; drop near an edge to return to the split layout" : "Drag onto another pane to swap positions"}
            onMouseDown={() => onFocus(terminal.id)}
            onPointerDown={(event) => {
              if (isFloating) {
                if (event.button !== 0) return;
                onFocus(terminal.id);
                return;
              }
              if (event.button !== 0 || !layout) return;
              event.preventDefault();
              onFocus(terminal.id);
              paneDragRef.current = { sourceId: terminal.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (isFloating) return;
              const drag = paneDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
              drag.started = true;
              setDraggingPaneId(drag.sourceId);
              setDropTargetPaneId(findPaneAtPoint(event.clientX, event.clientY, drag.sourceId));
            }}
            onPointerUp={(event) => { if (!isFloating) finishPaneDrag(event); }}
            onPointerCancel={(event) => {
              if (isFloating) return;
              if (paneDragRef.current?.pointerId !== event.pointerId) return;
              paneDragRef.current = null;
              setDraggingPaneId(null);
              setDropTargetPaneId(null);
            }}
          >⠿</button>}
          <span className="terminal-pane-title" title={terminal.name}>{terminal.name}</span>
          {visibleTerminalIds.length > 1 && <button className="pane-close" type="button" aria-label={`Close ${terminal.name}`} onClick={() => onClose(terminal.id)}>×</button>}
        </header>}
        <div className="terminal-pane-body">
          <Suspense key={terminal.id} fallback={<div className="terminal-placeholder">Loading terminal…</div>}>
            <TerminalPane sessionId={terminal.id} shell={terminal.shell} profileId={terminal.profileId} workingDirectory={terminal.workingDirectory} active={terminal.id === activeTerminalId} visible={Boolean(rect)} onLinkHint={onLinkHint} onFocus={onFocus} onExit={onExit} />
          </Suspense>
        </div>
      </div>;
    })}
    {!focusedTerminalId && floatingLayout.mode === "floating" && <FloatingTerminalDockGuides activeEdge={floatingLayout.dockTarget} />}
    {floatingLayout.mode === "tiled" && geometry.dividers.map((divider) => <LayoutDivider key={divider.id} divider={divider} surfaceRef={surfaceRef} onResize={onResize} />)}
  </div>
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
function buildTerminalLayout(sessionIds: string[]): LayoutNode {
  if (sessionIds.length === 0) throw new Error("A terminal layout requires at least one session.");
  if (sessionIds.length === 1) return { type: "terminal", sessionId: sessionIds[0] };
  const count = sessionIds.length;
  return {
    type: "split",
    id: crypto.randomUUID(),
    direction: "horizontal",
    ratio: 1 / count,
    children: [{ type: "terminal", sessionId: sessionIds[0] }, buildTerminalLayout(sessionIds.slice(1))],
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

const MIN_TILED_TERMINAL_WIDTH = 280;
function getMinimumTerminalLayoutWidth(node: LayoutNode): number {
  if (node.type === "terminal") return MIN_TILED_TERMINAL_WIDTH;
  const firstWidth = getMinimumTerminalLayoutWidth(node.children[0]);
  const secondWidth = getMinimumTerminalLayoutWidth(node.children[1]);
  if (node.direction === "vertical") return Math.max(firstWidth, secondWidth);
  const ratio = Math.max(0.01, Math.min(0.99, node.ratio));
  return Math.max(firstWidth / ratio, secondWidth / (1 - ratio));
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
