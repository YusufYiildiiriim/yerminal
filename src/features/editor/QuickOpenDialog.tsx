import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./quick-open.css";

type SearchWorkspace = { id: string; name: string; folderPaths: string[] };
type WorkspaceEntry = { name: string; path: string; isDir: boolean; size: number | null; extension: string | null };
export type QuickOpenScope = "active" | "all";
export type QuickOpenFile = WorkspaceEntry & { root: string; workspaceId: string; workspaceName: string };

type Props = {
  workspaces: SearchWorkspace[];
  activeWorkspaceId: string | null;
  scope: QuickOpenScope;
  onOpen: (file: QuickOpenFile) => void;
  onClose: () => void;
};

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return path.slice(normalizedRoot.length).replace(/^[\\/]+/, "");
}

function matchScore(file: QuickOpenFile, query: string): number {
  const needle = query.toLowerCase().replace(/\\/g, "/");
  const name = file.name.toLowerCase();
  const path = relativePath(file.root, file.path).toLowerCase().replace(/\\/g, "/");
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return path.includes(needle) ? 3 : 4;
}

export function QuickOpenDialog({ workspaces, activeWorkspaceId, scope, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<QuickOpenFile[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const searchTerm = query.trim();
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
    const orderedWorkspaces = scope === "all"
      ? [activeWorkspace, ...workspaces.filter((workspace) => workspace.id !== activeWorkspaceId)].filter((workspace): workspace is SearchWorkspace => Boolean(workspace))
      : activeWorkspace ? [activeWorkspace] : [];
    const rootTargets = new Map<string, { root: string; workspaceId: string; workspaceName: string }>();
    for (const workspace of orderedWorkspaces) {
      for (const root of workspace.folderPaths) {
        const key = root.toLowerCase();
        if (!rootTargets.has(key)) rootTargets.set(key, { root, workspaceId: workspace.id, workspaceName: workspace.name });
      }
    }

    if (!searchTerm) {
      searchRequestRef.current += 1;
      setFiles([]);
      setLoading(false);
      setError(null);
      setActiveIndex(0);
      return;
    }
    if (!isTauri()) {
      setFiles([]);
      setLoading(false);
      setError("Quick Open is available in the desktop app.");
      return;
    }
    if (rootTargets.size === 0) {
      setFiles([]);
      setLoading(false);
      setError("Add a folder to the selected workspace to search its files.");
      return;
    }

    const requestId = ++searchRequestRef.current;
    setLoading(true);
    setError(null);
    setFiles([]);
    setActiveIndex(0);
    const timeout = window.setTimeout(() => {
      void Promise.allSettled(Array.from(rootTargets.values()).map(async (target) => {
        const entries = await invoke<WorkspaceEntry[]>("search_workspace_files", { root: target.root, query: searchTerm, limit: 100 });
        return entries.map((entry) => ({ ...entry, ...target }));
      })).then((outcomes) => {
        if (requestId !== searchRequestRef.current) return;
        const successful = outcomes.filter((outcome): outcome is PromiseFulfilledResult<QuickOpenFile[]> => outcome.status === "fulfilled");
        const found = successful.flatMap((outcome) => outcome.value)
          .sort((left, right) => matchScore(left, searchTerm) - matchScore(right, searchTerm)
            || relativePath(left.root, left.path).localeCompare(relativePath(right.root, right.path))
            || left.workspaceName.localeCompare(right.workspaceName))
          .slice(0, 200);
        setFiles(found);
        setActiveIndex(0);
        if (successful.length === 0) setError("Could not search the workspace folders.");
      }).finally(() => {
        if (requestId === searchRequestRef.current) setLoading(false);
      });
    }, 140);

    return () => {
      window.clearTimeout(timeout);
      if (searchRequestRef.current === requestId) searchRequestRef.current += 1;
    };
  }, [activeWorkspaceId, query, scope, workspaces]);

  useEffect(() => {
    document.getElementById(`quick-open-result-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, files]);

  const openActiveFile = () => {
    const file = files[activeIndex];
    if (file) onOpen(file);
  };

  return <div className="quick-open-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="quick-open-dialog" role="dialog" aria-modal="true" aria-label="Quick Open">
      <div className="quick-open-search-row">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={files.length > 0}
          aria-controls="quick-open-results"
          aria-activedescendant={files.length > 0 ? `quick-open-result-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search files by name or path…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
            else if (event.key === "ArrowDown" && files.length > 0) { event.preventDefault(); setActiveIndex((index) => (index + 1) % files.length); }
            else if (event.key === "ArrowUp" && files.length > 0) { event.preventDefault(); setActiveIndex((index) => (index - 1 + files.length) % files.length); }
            else if (event.key === "Enter") { event.preventDefault(); openActiveFile(); }
          }}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="quick-open-meta"><span>{scope === "all" ? "All workspaces" : "Active workspace"}</span><span>{loading ? "Searching…" : query.trim() ? `${files.length} files` : "Type to search files"}</span></div>
      <div className="quick-open-results" id="quick-open-results" role="listbox" aria-label="Matching workspace files">
        {error ? <div className="quick-open-message" role="status">{error}</div>
          : loading && files.length === 0 ? <div className="quick-open-message" role="status">Searching workspace files…</div>
            : files.length === 0 ? <div className="quick-open-message">{query.trim() ? "No matching files." : "Type a file name or path to begin."}</div>
              : files.map((file, index) => <button
                id={`quick-open-result-${index}`}
                key={`${file.workspaceId}:${file.root}:${file.path}`}
                className={`quick-open-result${index === activeIndex ? " active" : ""}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                title={`${file.path} · ${file.workspaceName}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onOpen(file)}
              >
                <span className={`quick-open-file-icon ext-${(file.extension ?? "file").replace(/[^a-z0-9]/gi, "").toLowerCase()}`} aria-hidden="true">{(file.extension ?? "F").slice(0, 2).toUpperCase()}</span>
                <span className="quick-open-file-info"><span className="quick-open-file-name">{file.name}</span><span className="quick-open-file-path">{relativePath(file.root, file.path)}</span></span>
                <span className="quick-open-location">{scope === "all" ? file.workspaceName : folderName(file.root)}</span>
              </button>)}
      </div>
      <footer className="quick-open-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
    </section>
  </div>;
}
