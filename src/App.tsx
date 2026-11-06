import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { DiffViewer } from "./features/git/DiffViewer";
import { TerminalResourceGraph } from "./features/terminal/TerminalResourceGraph";
import { CodeWorkspace, type EditorFileTab, type EditorGroupState } from "./features/editor/CodeWorkspace";
import { FloatingTerminalDockGuides, FloatingTerminalModeToggle } from "./features/terminal/FloatingTerminalLayoutControls";
import { useFloatingTerminalLayout, type TerminalDockEdge, type TerminalLayoutMode } from "./features/terminal/floatingTerminalLayout";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import "./styles/app.css";

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

type ToolId = "changes" | "graph";
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
type EditorFileRequest = { id: string; root: string; path: string; name: string; size?: number; sourceCommitId?: string; sourceLabel?: string; snapshot?: EditorSnapshot };
const COMMIT_PAGE_SIZE = 50;
type PersistedWorkspace = { folders: string[]; activePath: string };
type TerminalWorkspace = { id: string; name: string; rootPath: string; folderPaths: string[]; terminalIds: string[]; activeTerminalId: string | null; layout: LayoutNode | null };
type TerminalWorkspaceState = { workspaces: TerminalWorkspace[]; activeId: string };
type PersistedTerminalWorkspace = { id: string; name: string; rootPath: string; folderPaths: string[] };

const DEFAULT_EDITOR_GROUP_ID = "editor-group-default";

function createEmptyEditorWorkspaceState(): EditorWorkspaceState {
  return { tabs: [], groups: [{ id: DEFAULT_EDITOR_GROUP_ID, name: "Editor 1", tabIds: [], activeTabId: null }], activeGroupId: DEFAULT_EDITOR_GROUP_ID };
}

const WORKSPACE_STORAGE_KEY = "yerminal.workspace";
const TERMINAL_WORKSPACES_STORAGE_KEY = "yerminal.terminal-workspaces";

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
    workspaces: [{ id, name: "Workspace 1", rootPath, folderPaths, terminalIds: [], activeTerminalId: null, layout: null }],
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

function preserveEditorLineEndings(content: string, original: string): string {
  return original.includes("\r\n") ? content.replace(/\r?\n/g, "\r\n") : content.replace(/\r\n/g, "\n");
}

const tools: { id: ToolId; label: string; icon: string }[] = [
  { id: "changes", label: "Git Changes", icon: "◫" },
  { id: "graph", label: "Git Graph", icon: "⌘" },
];

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("changes");
  const [activeMainView, setActiveMainView] = useState<"code" | "terminals" | "graph">("terminals");
  const [terminalLayoutMode, setTerminalLayoutMode] = useState<TerminalLayoutMode>("tiled");
  const [terminalWorkspaceState, setTerminalWorkspaceState] = useState<TerminalWorkspaceState>(() => readTerminalWorkspaceState());
  const [editorWorkspaces, setEditorWorkspaces] = useState<Record<string, EditorWorkspaceState>>({});
  const editorOperationIdsRef = useRef(new Map<string, number>());
  const nextEditorOperationIdRef = useRef(0);
  const savingEditorFilesRef = useRef(new Set<string>());
  const pendingEditorSavesRef = useRef(new Map<string, Promise<void>>());

  const [repoInfo, setRepoInfo] = useState<RepositoryInfo | null>(null);
  const [terminals, setTerminals] = useState<TerminalSession[]>([]);
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [terminalNameDraft, setTerminalNameDraft] = useState("");
  const terminalNameInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  const initializedWorkspaceIdsRef = useRef(new Set<string>());
  const floatingModeSetterRef = useRef<((mode: TerminalLayoutMode) => void) | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTerminalWorkspace = terminalWorkspaceState.workspaces.find((workspace) => workspace.id === terminalWorkspaceState.activeId) ?? terminalWorkspaceState.workspaces[0];
  const workspaceFolders = activeTerminalWorkspace?.folderPaths ?? [];
  const activeWorkspaceTerminalIds = activeTerminalWorkspace?.terminalIds ?? [];
  const activeWorkspaceTerminals = terminals.filter((terminal) => activeWorkspaceTerminalIds.includes(terminal.id));
  const repoPath = activeTerminalWorkspace?.rootPath ?? "";
  const activeTerminalId = activeTerminalWorkspace?.activeTerminalId ?? null;
  const layout = activeTerminalWorkspace?.layout ?? null;
  const activeEditorWorkspace = editorWorkspaces[activeTerminalWorkspace?.id ?? ""] ?? createEmptyEditorWorkspaceState();

  const openEditorFile = useCallback(async (request: EditorFileRequest) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    const tabId = request.id;
    const operationKey = editorOperationKey(workspaceId, tabId);
    const resourceKey = editorResourceKey(request.path);
    setActiveMainView("code");
    const workspace = editorWorkspaces[workspaceId] ?? createEmptyEditorWorkspaceState();
    const existing = workspace.tabs.find((tab) => tab.id === tabId);
    const shouldLoad = !existing || existing.status === "error";
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
        ? currentWorkspace.tabs.map((tab) => tab.id === tabId && tab.status === "error" ? { ...tab, status: "loading" as const, error: null } : tab)
        : [...currentWorkspace.tabs, { id: tabId, root: request.root, path: request.path, name: request.name, status: "loading" as const, content: null, savedContent: null, error: null, sourceLabel: request.sourceLabel ?? null, sourceCommitId: request.sourceCommitId ?? null, snapshot: request.snapshot ?? null, isSaving: false, saveError: null }];
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
          tabs: workspace.tabs.map((tab) => tab.id === tabId && !tab.sourceCommitId
            ? { ...tab, content, saveError: null }
            : tab),
        },
      };
    });
  }, [activeTerminalWorkspace?.id]);

  const saveEditorFile = useCallback(async (tabId: string) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId || !isTauri()) return;
    const tab = editorWorkspaces[workspaceId]?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.status !== "ready" || tab.sourceCommitId || tab.content === null || tab.savedContent === null) return;
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
    const isDirty = Boolean(tab && tab.content !== null && normalizeEditorNewlines(tab.content) !== normalizeEditorNewlines(tab.savedContent));
    if (isDirty && !window.confirm(`Discard unsaved changes to ${tab?.name ?? "this file"}?`)) return;
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

  const dockTerminalToTiledLayout = useCallback((sessionId: string, edge: TerminalDockEdge) => {
    const workspaceId = activeTerminalWorkspace?.id;
    if (!workspaceId) return;
    updateTerminalWorkspace(workspaceId, (workspace) => {
      if (!workspace.terminalIds.includes(sessionId)) return workspace;
      const remainingIds = workspace.terminalIds.filter((id) => id !== sessionId);
      const remainingLayout = workspace.layout
        ? removeTerminal(workspace.layout, sessionId)
        : remainingIds.length > 0 ? buildTerminalLayout(remainingIds) : null;
      const terminalNode: LayoutNode = { type: "terminal", sessionId };
      const direction = edge === "left" || edge === "right" ? "horizontal" : "vertical";
      const before = edge === "left" || edge === "top";
      const layout: LayoutNode = remainingLayout
        ? { type: "split", id: crypto.randomUUID(), direction, ratio: 0.5, children: before ? [terminalNode, remainingLayout] : [remainingLayout, terminalNode] }
        : terminalNode;
      return { ...workspace, layout };
    });
  }, [activeTerminalWorkspace?.id, updateTerminalWorkspace]);

  const changeTerminalLayoutMode = useCallback((mode: TerminalLayoutMode) => {
    const workspace = activeTerminalWorkspace;
    if (mode === "tiled" && workspace && !workspace.layout && workspace.terminalIds.length > 1) {
      updateTerminalWorkspace(workspace.id, (current) => ({ ...current, layout: buildTerminalLayout(current.terminalIds) }));
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
        name: activeWorkspaceTerminalIds.length === 0 ? (shell === "powershell" ? "PowerShell" : shell) : `Terminal ${activeWorkspaceTerminalIds.length + 1}`,
        shell,
        shellLabel: shell === "powershell" ? "PowerShell" : shell,
        workingDirectory: repoPath || null,
      };
      setTerminals((current) => [...current, terminal]);
      if (activeTerminalWorkspace) updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => ({
        ...workspace,
        terminalIds: [...workspace.terminalIds, id],
        activeTerminalId: id,
        layout: showInTabs ? null : workspace.layout,
      }));
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
        const terminalIds = workspace.terminalIds.filter((sessionId) => sessionId !== id);
        return {
          ...workspace,
          terminalIds,
          activeTerminalId: workspace.activeTerminalId === id ? terminalIds[0] ?? null : workspace.activeTerminalId,
          layout: workspace.layout ? removeTerminal(workspace.layout, id) : null,
        };
      }),
    }));
  }, [showToast]);

  const handleTerminalExit = useCallback((id: string) => {
    setTerminals((current) => current.map((terminal) => terminal.id === id ? { ...terminal, shellLabel: `${terminal.shellLabel} · exited` } : terminal));
  }, []);

  const focusTerminal = useCallback((id: string) => {
    const owner = terminalWorkspaceState.workspaces.find((workspace) => workspace.terminalIds.includes(id));
    if (owner) updateTerminalWorkspace(owner.id, (workspace) => ({ ...workspace, activeTerminalId: id }));
  }, [terminalWorkspaceState.workspaces, updateTerminalWorkspace]);

  const splitActiveTerminal = useCallback(async (direction: "horizontal" | "vertical") => {
    const workspace = activeTerminalWorkspace;
    const activeId = workspace?.activeTerminalId;
    if (!workspace || !activeId) return;
    const created = await createTerminal(false);
    if (!created) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const existingIds = current.terminalIds.filter((id) => id !== created.id);
      const root = current.layout ?? buildTerminalLayout(existingIds);
      return { ...current, layout: splitTerminal(root, activeId, created.id, direction) };
    });
  }, [activeTerminalWorkspace, createTerminal, updateTerminalWorkspace]);

  const addTerminalToWorkspace = useCallback(async () => {
    if (!activeTerminalId) {
      await createTerminal();
      return;
    }
    await splitActiveTerminal("horizontal");
  }, [activeTerminalId, createTerminal, splitActiveTerminal]);

  const moveTerminal = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId || !activeTerminalWorkspace) return;
    updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => ({
      ...workspace,
      layout: workspace.layout ? swapTerminalPositions(workspace.layout, sourceId, targetId) : null,
      activeTerminalId: sourceId,
    }));
  }, [activeTerminalWorkspace, updateTerminalWorkspace]);

  const resizeLayoutSplit = useCallback((splitId: string, ratio: number) => {
    if (!activeTerminalWorkspace) return;
    updateTerminalWorkspace(activeTerminalWorkspace.id, (workspace) => ({
      ...workspace,
      layout: workspace.layout ? updateSplitRatio(workspace.layout, splitId, ratio) : null,
    }));
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

  const activateWorkspaceFolder = useCallback(async (path: string, additions: string[] = []) => {
    const workspace = activeTerminalWorkspace;
    if (!workspace) return;
    updateTerminalWorkspace(workspace.id, (current) => {
      const folderPaths = mergeWorkspaceFolders(current.folderPaths, [...additions, ...(path ? [path] : [])]);
      return { ...current, folderPaths, rootPath: path && folderPaths.includes(path) ? path : "" };
    });
    setRepoInfo(null);
    if (!path || !isTauri()) return;
    const activeIds = new Set(workspace.terminalIds);
    const workspaceTerminals = terminals.filter((terminal) => activeIds.has(terminal.id));
    const results = await Promise.allSettled(workspaceTerminals.map((terminal) =>
      invoke("write_terminal", { sessionId: terminal.id, data: changeDirectoryCommand(terminal.shell, path) }),
    ));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") showToast(`Could not change terminal working directory: ${String(failed.reason)}`);
  }, [activeTerminalWorkspace, showToast, terminals, updateTerminalWorkspace]);
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
    if (!window.confirm(`Delete workspace "${target.name}" and close its terminals?`)) return;

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
  }, [activeTerminalWorkspace, showToast, terminalWorkspaceState.workspaces]);

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
    await activateWorkspaceFolder(additions[additions.length - 1], additions);
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
    const terminalIds = new Set(workspace.terminalIds);
    void Promise.allSettled(terminals.filter((terminal) => terminalIds.has(terminal.id)).map((terminal) =>
      invoke("write_terminal", { sessionId: terminal.id, data: changeDirectoryCommand(terminal.shell, rootPath) }),
    )).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") showToast(`Could not change terminal working directory: ${String(failed.reason)}`);
    });
  }, [activeTerminalWorkspace, showToast, terminals, updateTerminalWorkspace]);
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
      else if (key === "tab" && activeWorkspaceTerminals.length > 1) {
        event.preventDefault();
        const index = activeWorkspaceTerminals.findIndex((terminal) => terminal.id === activeTerminalId);
        const direction = event.shiftKey ? -1 : 1;
        const next = (index + direction + activeWorkspaceTerminals.length) % activeWorkspaceTerminals.length;
        focusTerminal(activeWorkspaceTerminals[next].id);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeTerminalId, activeWorkspaceTerminals, closeTerminal, createTerminal, focusTerminal, splitActiveTerminal]);

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
        <div className="titlebar-spacer" />
        <span className="window-caption">Agent Workspace</span>
      </header>

      <PanelGroup direction="horizontal" className="workspace">
        <Panel defaultSize={27} minSize={18} maxSize={46} className="tools-panel">
          <section className="workspace-navigation" aria-label="Workspace navigation">
            <div className="workspace-navigation-controls">
              <div className="workspace-switcher">
                <span className="workspace-switcher-icon" aria-hidden="true">▣</span>
                <select className="workspace-name-select" aria-label="Active terminal workspace" value={activeTerminalWorkspace?.id ?? ""} onChange={(event) => activateWorkspace(event.currentTarget.value)}>
                  {terminalWorkspaceState.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
                <button className="workspace-action" type="button" aria-label="Create workspace" title="Create workspace" onClick={createWorkspace}>＋</button>
                <button className="workspace-action" type="button" aria-label="Rename workspace" title="Rename workspace" onClick={renameWorkspace} disabled={!activeTerminalWorkspace}>✎</button>
                <button className="workspace-action delete" type="button" aria-label="Delete workspace" title={terminalWorkspaceState.workspaces.length <= 1 ? "Keep at least one workspace" : "Delete workspace"} onClick={() => void deleteWorkspace()} disabled={terminalWorkspaceState.workspaces.length <= 1}>×</button>
              </div>
              <label className="workspace-root-picker" title={repoInfo ? repoInfo.root + " · " + repoInfo.branch : repoPath || "Set a project folder for this workspace"}>
                <span className="workspace-root-label" aria-hidden="true">⌂</span>
                <select aria-label="Workspace project folder" value={repoPath} onChange={(event) => void activateWorkspaceFolder(event.currentTarget.value)}>
                  <option value="">Choose project folder</option>
                  {workspaceFolders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
                </select>
                <button className="workspace-action add-folder" type="button" aria-label="Add folders to workspace" title="Add folders" onClick={() => void addWorkspaceFolders()}>＋</button>
              </label>
            </div>
            <div className="workspace-navigation-explorer">
              <WorkspacePanel key={activeTerminalWorkspace?.id ?? ""} folders={workspaceFolders} activePath={repoPath} onAdd={() => void addWorkspaceFolders()} onActivate={(path) => void activateWorkspaceFolder(path)} onRemove={removeWorkspaceFolder} onOpenFile={(root, entry) => void openEditorFile({ id: "workspace:" + root + ":" + entry.path, root, path: entry.path, name: entry.name, size: entry.size ?? undefined })} />
            </div>
          </section>
          <section className="tool-content">{activeTool === "changes" ? <GitChanges key={activeTerminalWorkspace?.id ?? ""} repoPath={repoPath} repoInfo={repoInfo} onOpenRepository={() => void addWorkspaceFolders()} onError={showToast} /> : activeTool === "graph" ? <GitGraph key={activeTerminalWorkspace?.id ?? ""} repoPath={repoInfo ? repoPath : ""} onError={showToast} onOpenInEditor={(commit, file) => void openEditorFile({ id: `commit:${commit.id}:${file.path}`, root: repoPath, path: file.path, name: file.path.split(/[\\/]/).pop() ?? file.path, sourceCommitId: commit.id, sourceLabel: `${commit.shortId} · ${file.kind}`, snapshot: { shortId: commit.shortId, message: commit.message, changeKind: file.kind, author: commit.author, timestamp: commit.timestamp } })} /> : <WorkspacePanel key={activeTerminalWorkspace?.id ?? ""} folders={workspaceFolders} activePath={repoPath} onAdd={() => void addWorkspaceFolders()} onActivate={(path) => void activateWorkspaceFolder(path)} onRemove={removeWorkspaceFolder} onOpenFile={(root, entry) => void openEditorFile({ id: `workspace:${root}:${entry.path}`, root, path: entry.path, name: entry.name, size: entry.size ?? undefined })} />}</section>
          <nav className="tool-tabs" aria-label="Developer tools">
            {tools.map((tool) => <button key={tool.id} className={`tool-tab ${activeTool === tool.id ? "selected" : ""}`} onClick={() => setActiveTool(tool.id)} type="button"><span className="tool-icon">{tool.icon}</span>{tool.label}</button>)}
          </nav>
        </Panel>
        <PanelResizeHandle className="resize-handle" aria-label="Resize developer tools" />
        <Panel minSize={35} className="terminal-panel">
          <div className="terminal-toolbar">
            <nav className="workspace-view-tabs" role="tablist" aria-label="Workspace views">
              <button className={`workspace-view-tab ${activeMainView === "code" ? "selected" : ""}`} role="tab" aria-selected={activeMainView === "code"} onClick={() => setActiveMainView("code")} type="button"><span aria-hidden="true">⌘</span> Code{activeEditorWorkspace.tabs.length > 0 && <small>{activeEditorWorkspace.tabs.length}</small>}</button>
              <button className={`workspace-view-tab ${activeMainView === "terminals" ? "selected" : ""}`} role="tab" aria-selected={activeMainView === "terminals"} onClick={() => setActiveMainView("terminals")} type="button"><span aria-hidden="true">▣</span> Terminals{activeWorkspaceTerminals.length > 0 && <small>{activeWorkspaceTerminals.length}</small>}</button>
              <button className={activeMainView === "graph" ? "workspace-view-tab selected" : "workspace-view-tab"} role="tab" aria-selected={activeMainView === "graph"} onClick={() => setActiveMainView("graph")} type="button"><span aria-hidden="true">▤</span> Graph{activeWorkspaceTerminals.length > 0 && <small>{activeWorkspaceTerminals.length}</small>}</button>
            </nav>
            {activeMainView === "terminals" && <div className="terminal-session-toolbar">
              <div className="terminal-tabs" role={layout || activeWorkspaceTerminalIds.length <= 1 ? undefined : "tablist"} aria-label={layout || activeWorkspaceTerminalIds.length <= 1 ? "Terminal workspace actions" : "Terminal sessions"}>
                {!layout && activeWorkspaceTerminalIds.length > 1 && activeWorkspaceTerminals.map((terminal) => <div key={terminal.id} className={`terminal-tab-item ${terminal.id === activeTerminalId ? "selected" : ""}`} role="presentation">
                  {editingTerminalId === terminal.id ? <TerminalNameEditor terminalName={terminal.name} value={terminalNameDraft} inputRef={terminalNameInputRef} compact onChange={setTerminalNameDraft} onSave={saveTerminalName} onCancel={cancelTerminalRename} /> : <>
                    <button className={`terminal-tab ${terminal.id === activeTerminalId ? "selected" : ""}`} onClick={() => focusTerminal(terminal.id)} onDoubleClick={() => beginRenameTerminal(terminal)} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); void closeTerminal(terminal.id); } }} type="button" role="tab" aria-selected={terminal.id === activeTerminalId} aria-label={`${terminal.name}. Double-click to rename.`} title={terminal.name}><span className="terminal-dot" /><span className="terminal-tab-name">{terminal.name}</span>{terminal.id === activeTerminalId && <span className="terminal-active-label" aria-hidden="true">Active</span>}</button>
                    <button className="terminal-tab-rename" type="button" aria-label={`Rename ${terminal.name}`} title="Rename terminal" onClick={() => beginRenameTerminal(terminal)}>✎</button>
                    {activeWorkspaceTerminals.length > 1 && <button className="tab-close" type="button" aria-label={`Close ${terminal.name}`} title={`Close ${terminal.name}`} onClick={() => void closeTerminal(terminal.id)}>×</button>}
                  </>}
                </div>)}
                <button className="icon-button new-terminal" aria-label="Add terminal to workspace" title="Add terminal pane" onClick={() => void addTerminalToWorkspace()} type="button">＋</button>
              </div>
              <div className="toolbar-actions"><FloatingTerminalModeToggle mode={terminalLayoutMode} onChange={changeTerminalLayoutMode} /></div>
            </div>}
          </div>
          {activeMainView === "graph" && <TerminalResourceGraph workspaceName={activeTerminalWorkspace?.name ?? "Workspace"} terminals={activeWorkspaceTerminals} activeTerminalId={activeTerminalId} />}
          {activeMainView === "code" && <CodeWorkspace
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
            onCreateGroup={createEditorGroup}
            onMoveTab={moveEditorTab}
            onCloseGroup={closeEditorGroup}
          />}
          <div className="terminal-workspace-view" hidden={activeMainView !== "terminals"}>
          <section className="terminal-surface" aria-label="Terminal workspace">
            <TerminalWorkspaceLayout layout={layout} terminals={terminals} visibleTerminalIds={activeWorkspaceTerminalIds} workspaceId={activeTerminalWorkspace?.id ?? ""} onDockToTiledLayout={dockTerminalToTiledLayout} onModeState={registerFloatingLayoutControl} activeTerminalId={activeTerminalId} editingTerminalId={editingTerminalId} terminalNameDraft={terminalNameDraft} terminalNameInputRef={terminalNameInputRef} onRename={beginRenameTerminal} onNameChange={setTerminalNameDraft} onNameSave={saveTerminalName} onNameCancel={cancelTerminalRename} onFocus={focusTerminal} onExit={handleTerminalExit} onClose={closeTerminal} onMove={moveTerminal} onResize={resizeLayoutSplit} />
            {activeWorkspaceTerminals.length === 0 && <div className="terminal-placeholder"><div className="welcome-title">Welcome to <span>yerminal</span></div><p>Create a terminal to begin.</p><button className="primary-button" onClick={() => void createTerminal()} type="button">New Terminal</button></div>}

            <div className="terminal-status" aria-live="polite" aria-atomic="true"><span className="status-indicator" /><strong>{activeTerminal?.name ?? "No terminal"}</strong>{activeTerminal && <span className="terminal-status-active">Active</span>}<span className="status-separator">·</span><span>{activeTerminal?.shellLabel ?? "Ready"}</span></div>
          </section>
          <footer className="statusbar"><span><span className="status-indicator" />{repoInfo ? `${repoInfo.branch} · ${repoInfo.state}` : "No folder opened"}</span><span>UTF-8</span><span>{navigator.userAgent.includes("Windows") ? "Windows" : navigator.platform}</span></footer>
          </div>
        </Panel>
      </PanelGroup>
      {toast && <div className="app-toast" role="alert" aria-live="assertive" aria-atomic="true"><span>{toast}</span><button aria-label="Dismiss notification" onClick={dismissToast} type="button">×</button></div>}
    </main>
  );
}

function WorkspacePanel({ folders, activePath, onAdd, onActivate, onRemove, onOpenFile }: { folders: string[]; activePath: string; onAdd: () => void; onActivate: (path: string) => void; onRemove: (path: string) => void; onOpenFile: (root: string, entry: WorkspaceEntry) => void }) {
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [errorsByPath, setErrorsByPath] = useState<Record<string, string>>({});
  const loadedPathsRef = useRef(new Set<string>());
  const pendingPathsRef = useRef(new Set<string>());
  const treeGenerationRef = useRef(0);

  const loadDirectory = useCallback(async (root: string, path: string) => {
    if (!isTauri()) {
      setErrorsByPath((current) => ({ ...current, [path]: "File browsing is available in the desktop app." }));
      return;
    }
    if (loadedPathsRef.current.has(path) || pendingPathsRef.current.has(path)) return;
    const generation = treeGenerationRef.current;
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
      if (generation === treeGenerationRef.current) setErrorsByPath((current) => ({ ...current, [path]: String(reason) }));
    } finally {
      pendingPathsRef.current.delete(path);
      if (generation === treeGenerationRef.current) setLoadingPaths((current) => ({ ...current, [path]: false }));
    }
  }, []);

  useEffect(() => {
    treeGenerationRef.current += 1;
    loadedPathsRef.current.clear();
    pendingPathsRef.current.clear();
    setExpandedPaths({});
    setEntriesByPath({});
    setLoadingPaths({});
    setErrorsByPath({});
  }, [folders]);

  useEffect(() => {
    if (!activePath || !folders.includes(activePath)) return;
    setExpandedPaths((current) => ({ ...current, [activePath]: true }));
    void loadDirectory(activePath, activePath);
  }, [activePath, folders, loadDirectory]);

  const toggleDirectory = useCallback((root: string, path: string) => {
    const expand = !expandedPaths[path];
    setExpandedPaths((current) => ({ ...current, [path]: expand }));
    if (expand) void loadDirectory(root, path);
  }, [expandedPaths, loadDirectory]);

  const renderEntries = (entries: WorkspaceEntry[], root: string, depth: number): ReactElement[] => entries.map((entry) => {
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
      onToggle={() => toggleDirectory(root, entry.path)}
      onRetry={() => void loadDirectory(root, entry.path)}
      onOpen={() => onOpenFile(root, entry)}
      renderChildren={(childEntries, childDepth) => renderEntries(childEntries, root, childDepth)}
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
          <div className="workspace-root-row" role="treeitem" aria-level={1} aria-expanded={expanded}>
            <button className="workspace-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`} aria-expanded={expanded} onClick={() => toggleDirectory(folder, folder)} type="button">{expanded ? "⌄" : "›"}</button>
            <button className="workspace-folder-select" onClick={() => onActivate(folder)} type="button" aria-pressed={selected} title={folder}>
              <span className="workspace-folder-icon" aria-hidden="true">▣</span>
              <span className="workspace-folder-label"><strong>{name}</strong><small>{folder}</small></span>
            </button>
            <button className="workspace-folder-remove" aria-label={`Remove ${name} from this workspace`} title="Remove folder" onClick={() => onRemove(folder)} type="button">×</button>
          </div>
          {expanded && <div className="workspace-tree-children" role="group">
            {loadingPaths[folder] && <div className="workspace-tree-message">Loading folder…</div>}
            {errorsByPath[folder] && <div className="workspace-tree-error"><span>{errorsByPath[folder]}</span><button onClick={() => void loadDirectory(folder, folder)} type="button">Retry</button></div>}
            {!loadingPaths[folder] && !errorsByPath[folder] && entries.length === 0 && loadedPathsRef.current.has(folder) && <div className="workspace-tree-message">This folder is empty.</div>}
            {renderEntries(entries, folder, 1)}
          </div>}
        </section>;
      })}
    </div>
    <div className="panel-footnote workspace-explorer-footnote"><span className="read-only-mark">⌂</span> Read-only file explorer</div>
  </div>;
}

function WorkspaceTreeNode({ entry, depth, expanded, children, loading, error, onToggle, onRetry, onOpen, renderChildren }: {
  entry: WorkspaceEntry;

  depth: number;
  expanded: boolean;
  children: WorkspaceEntry[];
  loading: boolean;
  error: string | null;
  onToggle: () => void;
  onRetry: () => void;
  onOpen: (button: HTMLButtonElement) => void;
  renderChildren: (entries: WorkspaceEntry[], depth: number) => ReactElement[];
}) {
  const extension = entry.extension ?? entry.name.split(".").pop() ?? "file";
  const fileBadge = entry.isDir ? "▣" : extension.slice(0, 2).toUpperCase();
  return <div className="workspace-tree-node" role="treeitem" aria-level={depth + 1} aria-expanded={entry.isDir ? expanded : undefined}>
    <div className={`workspace-tree-row ${entry.isDir ? "directory" : "file"}`} style={{ paddingLeft: (depth + 1) * 12 }}>
      {entry.isDir ? <button className="workspace-tree-toggle" aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`} aria-expanded={expanded} onClick={onToggle} type="button">{expanded ? "⌄" : "›"}</button> : <span className="workspace-tree-toggle-spacer" />}
      {entry.isDir ? <button className="workspace-tree-entry" onClick={onToggle} title={entry.path} type="button"><span className="workspace-tree-file-icon folder" aria-hidden="true">{fileBadge}</span><span className="workspace-tree-name">{entry.name}</span></button> : <button className="workspace-tree-entry" onClick={(event) => onOpen(event.currentTarget)} title={entry.path} type="button"><span className={`workspace-tree-file-icon ext-${extension.replace(/[^a-z0-9]/gi, "").toLowerCase()}`} aria-hidden="true">{fileBadge || "F"}</span><span className="workspace-tree-name">{entry.name}</span><span className="workspace-tree-size">{entry.size === null ? "" : formatFileSize(entry.size)}</span></button>}
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
function GitChanges({ repoPath, repoInfo, onOpenRepository, onError }: { repoPath: string; repoInfo: RepositoryInfo | null; onOpenRepository: () => void; onError: (message: string) => void }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState<FileChange | null>(null);
  const [selectedStaged, setSelectedStaged] = useState(false);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [fileAction, setFileAction] = useState<{ path: string; action: string } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRowRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setSelected(null); setSelectedStaged(false); setCommitMessage(""); setDiscardTarget(null); }, [repoPath]);
  useEffect(() => {
    if (!selected || !repoInfo || !repoPath || !isTauri()) { setDiff(""); setDiffLoading(false); return; }
    let active = true;
    setDiff("");
    setDiffLoading(true);
    void invoke<string>("git_diff", { path: repoPath, filePath: selected.path, staged: selectedStaged })
      .then((result) => { if (active) setDiff(result); })
      .catch((reason: unknown) => { if (active) onError(String(reason)); })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; };
  }, [onError, repoInfo, repoPath, selected, selectedStaged]);
  useEffect(() => {
    if (!selected) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      lastFocusedRowRef.current?.focus();
    };
  }, [selected]);

  const renderChangeRow = (change: FileChange, staged: boolean) => <div className={`change-row ${selected?.path === change.path && selectedStaged === staged ? "selected" : ""}`} key={`${staged ? "staged" : "unstaged"}:${change.path}`}>
    <button className="change-main-row" onClick={(event) => { lastFocusedRowRef.current = event.currentTarget; setSelected(change); setSelectedStaged(staged); }} type="button" title={change.path}>
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

  return <div className="tool-view">
    <header className="tool-header"><div><h1>Git Changes</h1><p>{repoInfo ? `${repoInfo.branch} · ${stagedChanges.length} staged · ${unstagedChanges.length} unstaged` : "Review your working tree"}</p></div><button className="icon-button refresh-button" aria-label="Refresh changes" onClick={() => void refresh()} type="button">↻</button></header>
    {!repoInfo ? <div className="empty-repository"><div className="empty-icon">⌂</div><h2>No repository opened</h2><p>Open a folder to view its changes.</p><button className="primary-button" onClick={onOpenRepository} type="button">Open Folder</button></div> : <>
      <section className="git-commit-box" aria-label="Commit staged changes">
        <div className="git-commit-box-heading"><span>Commit staged changes</span><span className="git-staged-count">{stagedChanges.length}</span></div>
        <textarea aria-label="Commit message" placeholder="Message (required)" rows={2} maxLength={65536} value={commitMessage} onChange={(event) => setCommitMessage(event.currentTarget.value)} />
        <button className="git-commit-button" onClick={() => void commitStaged()} disabled={isCommitting || Boolean(fileAction) || stagedChanges.length === 0 || !commitMessage.trim()} type="button"><span aria-hidden="true">✓</span><span>{isCommitting ? "Committing…" : "Commit staged"}</span><small>{stagedChanges.length}</small></button>
      </section>
      <div className="change-list" aria-label="Repository changes">
        {changes.length === 0 ? <div className="change-empty">Working tree clean</div> : <>
          <section className="change-group" aria-label="Staged changes">
            <header className="change-group-heading"><span>Staged Changes</span><span>{stagedChanges.length}</span></header>
            {stagedChanges.length === 0 ? <div className="change-group-empty">No staged changes</div> : stagedChanges.map((change) => renderChangeRow(change, true))}
          </section>
          <section className="change-group" aria-label="Changes">
            <header className="change-group-heading"><span>Changes</span><span>{unstagedChanges.length}</span></header>
            {unstagedChanges.length === 0 ? <div className="change-group-empty">No unstaged changes</div> : unstagedChanges.map((change) => renderChangeRow(change, false))}
          </section>
        </>}
      </div>
      {selected && createPortal(
        <div className="diff-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <section className="diff-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="diff-preview-title" aria-describedby="diff-preview-description" onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }}>
            <header className="diff-preview-header">
              <div className="diff-preview-file-icon">{selected.kind === "deleted" ? "−" : selected.kind === "untracked" || selected.kind === "added" ? "+" : "±"}</div>
              <div className="diff-preview-heading">
                <h2 id="diff-preview-title" title={selected.path}>{selected.path}</h2>
                <p id="diff-preview-description"><span>{repoInfo?.root}</span><span className="diff-preview-separator">/</span>{selectedStaged ? "Index snapshot" : "Working tree snapshot"}</p>
              </div>
              <div className="diff-preview-header-actions">
                {selected.staged && <span className="diff-preview-badge staged">Staged</span>}
                {selected.unstaged && <span className="diff-preview-badge unstaged">Unstaged</span>}
                {selected.staged && selected.unstaged && <div className="diff-sides" aria-label="Diff version">
                  <button className={selectedStaged ? "active" : ""} onClick={() => setSelectedStaged(true)} type="button">Index</button>
                  <button className={!selectedStaged ? "active" : ""} onClick={() => setSelectedStaged(false)} type="button">Working Tree</button>
                </div>}
                <button ref={closeButtonRef} className="diff-preview-close" onClick={() => setSelected(null)} aria-label="Close diff preview" title="Close preview (Esc)" type="button">×</button>
              </div>
            </header>
            <div className="diff-preview-content">
              {diffLoading ? <div className="diff-preview-loading">Loading file changes…</div> : <DiffViewer diff={diff} emptyMessage="No diff available for this selection." />}
            </div>
            <footer className="diff-preview-footer"><span>{diffLoading ? "Loading diff…" : `${diff ? diff.split(/\r?\n/).length : 0} lines`}</span><span>Press Esc to close</span></footer>
          </section>
        </div>,
        document.body,
      )}
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
    </>}
    <div className="panel-footnote"><span className="read-only-mark">◇</span> Stage, unstage, discard, and commit changes</div>
  </div>;
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
                {detailLoading ? <div className="commit-preview-state" role="status">Loading changed files…</div> : detailError ? <div className="commit-preview-state commit-preview-error" role="alert"><span>{detailError}</span><button type="button" onClick={() => void selectCommit(selectedCommit)}>Retry loading files</button></div> : commitFiles.length === 0 ? <div className="commit-preview-state">No files changed in this commit.</div> : commitFiles.map((file) => <button className={`commit-preview-file ${selectedFile === file.path ? "selected" : ""}`} key={file.path} onClick={() => void selectFile(file.path)} type="button" aria-pressed={selectedFile === file.path} title={file.path}>
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
  terminals: TerminalSession[];
  visibleTerminalIds: string[];
  workspaceId: string;
  onDockToTiledLayout: (sessionId: string, edge: TerminalDockEdge) => void;
  onModeState: (mode: TerminalLayoutMode, setMode: (mode: TerminalLayoutMode) => void) => void;
  activeTerminalId: string | null;
  editingTerminalId: string | null;
  terminalNameDraft: string;
  terminalNameInputRef: React.RefObject<HTMLInputElement | null>;
  onRename: (terminal: TerminalSession) => void;
  onNameChange: (value: string) => void;
  onNameSave: () => void;
  onNameCancel: () => void;
  onFocus: (sessionId: string) => void;
  onExit: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
};

function TerminalWorkspaceLayout({ layout, terminals, visibleTerminalIds, workspaceId, onDockToTiledLayout, onModeState, activeTerminalId, editingTerminalId, terminalNameDraft, terminalNameInputRef, onRename, onNameChange, onNameSave, onNameCancel, onFocus, onExit, onClose, onMove, onResize }: TerminalWorkspaceLayoutProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const paneDragRef = useRef<{ sourceId: string; pointerId: number; startX: number; startY: number; started: boolean } | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null);
  const floatingLayout = useFloatingTerminalLayout(workspaceId, visibleTerminalIds, onDockToTiledLayout);
  useEffect(() => onModeState(floatingLayout.mode, floatingLayout.setMode), [floatingLayout.mode, floatingLayout.setMode, onModeState]);
  const geometry = useMemo(() => {
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
  }, [activeTerminalId, floatingLayout.mode, floatingLayout.positions, layout, visibleTerminalIds.join("\u0000")]);

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

  return <div className={`terminal-layout-surface ${floatingLayout.mode === "floating" ? "floating-terminal-canvas" : ""}`} ref={(element) => { surfaceRef.current = element; floatingLayout.surfaceRef.current = element; }} data-mode={floatingLayout.mode} data-pane-dragging={draggingPaneId || floatingLayout.draggingSessionId ? "true" : undefined}>
    {terminals.map((terminal) => {
      const rect = geometry.panes.get(terminal.id);
      const isFloating = floatingLayout.mode === "floating" && visibleTerminalIds.includes(terminal.id);
      const isSingleTerminal = !layout && floatingLayout.mode === "tiled" && visibleTerminalIds.length === 1 && visibleTerminalIds[0] === terminal.id;
      const hasPaneHeader = Boolean(rect && (layout || isFloating || isSingleTerminal));
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
      >
        {hasPaneHeader && <header className={`terminal-pane-header ${isSingleTerminal ? "single-terminal-pane-header" : ""}`}>
          {(layout || isFloating) && <button
            className={`pane-drag-handle ${isFloating ? "floating-terminal-window-handle" : ""}`}
            type="button"
            aria-label={isFloating ? `Move ${terminal.name} around the free terminal canvas` : `Drag ${terminal.name} to swap pane positions`}
            title={isFloating ? "Drag this terminal freely; drop near an edge to return to the split layout" : "Drag onto another pane to swap positions"}
            onMouseDown={() => onFocus(terminal.id)}
            onPointerDown={(event) => {
              if (isFloating) {
                onFocus(terminal.id);
                floatingLayout.startDrag(terminal.id, event);
                return;
              }
              if (event.button !== 0 || !layout) return;
              event.preventDefault();
              onFocus(terminal.id);
              paneDragRef.current = { sourceId: terminal.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (isFloating) {
                floatingLayout.moveDrag(terminal.id, event);
                return;
              }
              const drag = paneDragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
              drag.started = true;
              setDraggingPaneId(drag.sourceId);
              setDropTargetPaneId(findPaneAtPoint(event.clientX, event.clientY, drag.sourceId));
            }}
            onPointerUp={(event) => isFloating ? floatingLayout.endDrag(terminal.id, event) : finishPaneDrag(event)}
            onPointerCancel={(event) => {
              if (isFloating) {
                floatingLayout.cancelDrag(terminal.id, event);
                return;
              }
              if (paneDragRef.current?.pointerId !== event.pointerId) return;
              paneDragRef.current = null;
              setDraggingPaneId(null);
              setDropTargetPaneId(null);
            }}
          >⠿</button>}
          {editingTerminalId === terminal.id ? <TerminalNameEditor terminalName={terminal.name} value={terminalNameDraft} inputRef={terminalNameInputRef} compact onChange={onNameChange} onSave={onNameSave} onCancel={onNameCancel} /> : <><span className="terminal-pane-title" title={terminal.name}>{terminal.name}</span><button className="pane-rename" type="button" aria-label={`Rename ${terminal.name}`} title="Rename terminal" onClick={() => onRename(terminal)}>✎</button></>}{terminal.id === activeTerminalId && <span className="terminal-active-label pane-active-label" aria-hidden="true">Active</span>}
          {visibleTerminalIds.length > 1 && <button className="pane-close" type="button" aria-label={`Close ${terminal.name}`} onClick={() => onClose(terminal.id)}>×</button>}
        </header>}
        <div className="terminal-pane-body">
          <Suspense key={terminal.id} fallback={<div className="terminal-placeholder">Loading terminal…</div>}>
            <TerminalPane sessionId={terminal.id} shell={terminal.shell} profileId={terminal.profileId} workingDirectory={terminal.workingDirectory} active={terminal.id === activeTerminalId} visible={Boolean(rect)} onFocus={onFocus} onExit={onExit} />
          </Suspense>
        </div>
      </div>;
    })}
    {floatingLayout.mode === "floating" && <FloatingTerminalDockGuides activeEdge={floatingLayout.dockTarget} />}
    {floatingLayout.mode === "tiled" && geometry.dividers.map((divider) => <LayoutDivider key={divider.id} divider={divider} surfaceRef={surfaceRef} onResize={onResize} />)}
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

