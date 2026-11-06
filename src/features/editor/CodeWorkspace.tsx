import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { highlightCode } from "./highlighter";
import { CommitSnapshotBanner } from "./CommitSnapshotBanner";

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

type CodeWorkspaceProps = {
  tabs: EditorFileTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onChange: (tabId: string, content: string) => void;
  onSave: (tabId: string) => void;
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

export function CodeWorkspace({ tabs, activeTabId, onSelect, onClose, onChange, onSave }: CodeWorkspaceProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
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

  return <section className="code-workspace" aria-label="Code editor" onKeyDown={handleKeyDown}>
    <nav className="editor-file-tabs" role="tablist" aria-label="Open files">
      {tabs.map((tab) => <div className={`editor-file-tab ${activeTabId === tab.id ? "selected" : ""}`} key={tab.id}>
        <button className="editor-file-tab-select" role="tab" aria-selected={activeTabId === tab.id} onClick={() => onSelect(tab.id)} type="button" title={tab.path}>
          <span className="editor-file-tab-icon" aria-hidden="true">{tab.name.split(".").pop()?.slice(0, 2).toUpperCase() ?? "·"}</span>
          <span>{tab.name}</span>
          {tab.sourceCommitId ? <span className="editor-file-tab-readonly-mark" aria-label="Read only" title="Commit snapshot">◉</span> : tab.content !== null && normalizeNewlines(tab.content) !== normalizeNewlines(tab.savedContent) ? <span className="editor-file-tab-dirty-mark" aria-label="Unsaved changes" title="Unsaved changes">●</span> : null}
          {tab.status === "loading" && <span className="editor-file-tab-loading" aria-label="Loading" />}
        </button>
        <button className="editor-file-tab-close" aria-label={`Close ${tab.name}`} title={`Close ${tab.name}`} onClick={() => onClose(tab.id)} type="button">×</button>
      </div>)}
      {tabs.length === 0 && <span className="editor-tabs-empty">No open files</span>}
    </nav>
    {activeTab ? <>
      {isReadOnly && activeTab.snapshot && <CommitSnapshotBanner snapshot={activeTab.snapshot} filePath={activeTab.path} />}
      <header className="code-editor-header">
        <div className="code-editor-breadcrumb" title={activeTab.path}><span>{activeTab.root.split(/[\\/]/).filter(Boolean).pop() ?? activeTab.root}</span><span className="code-editor-separator">›</span><strong>{activeTab.path}</strong></div>
        <div className="code-editor-meta"><span>{language?.label ?? "Plain Text"}</span>{activeTab.sourceLabel && <span className="code-editor-source-label" title={activeTab.sourceLabel}>{activeTab.sourceLabel}</span>}{isReadOnly ? <span className="code-editor-readonly">Read only</span> : <><span className={`code-editor-editable-badge ${isDirty ? "dirty" : ""}`}>{isDirty ? "Unsaved changes" : "Editable"}</span><button className="code-editor-save" type="button" disabled={activeTab.status !== "ready" || !isDirty || activeTab.isSaving} onClick={() => onSave(activeTab.id)}>{activeTab.isSaving ? "Saving…" : "Save"}<kbd>Ctrl S</kbd></button></>}</div>
      </header>
      <div className="code-editor-content" key={activeTab.id}>
        {activeTab.status === "loading" ? <div className="code-editor-message" role="status"><span className="editor-loading-indicator" /><span>Loading file content…</span></div> : activeTab.status === "error" ? <div className="code-editor-message code-editor-error" role="alert"><span className="code-editor-message-icon">!</span><strong>Could not open this file</strong><span>{activeTab.error}</span></div> : isReadOnly ? highlightedHtml ? <div className="code-editor-highlighted" dangerouslySetInnerHTML={{ __html: highlightedHtml }} /> : <pre className={`code-editor-plain ${highlighting ? "is-highlighting" : ""}`} tabIndex={0} aria-label={`Contents of ${activeTab.name}`}><code>{activeTab.content}</code></pre> : <div className="code-editor-editable-surface">
          <div className="code-editor-editable-highlight" aria-hidden="true">{highlightedHtml ? <div className="code-editor-highlighted" dangerouslySetInnerHTML={{ __html: highlightedHtml }} /> : <pre className="code-editor-plain"><code>{activeTab.content}</code></pre>}</div>
          <textarea className="code-editor-input" aria-label={`Edit ${activeTab.name}`} autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} value={activeTab.content ?? ""} onChange={(event) => onChange(activeTab.id, event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const nextContent = `${input.value.slice(0, start)}    ${input.value.slice(end)}`;
            onChange(activeTab.id, nextContent);
            requestAnimationFrame(() => input.setSelectionRange(start + 4, start + 4));
          }} />
        </div>}
      </div>
      <footer className="code-editor-statusbar" aria-live="polite"><span className={activeTab.saveError ? "code-editor-save-error" : ""}>{activeTab.saveError ?? (activeTab.isSaving ? "Saving changes…" : isDirty ? "Unsaved changes" : isReadOnly ? "Read-only commit snapshot" : activeTab.status === "ready" ? "All changes saved" : activeTab.status === "loading" ? "Loading" : "Unavailable")}</span><span>{activeTab.status === "ready" ? `${activeTab.content?.split(/\r?\n/).length ?? 0} lines` : ""}</span><span>UTF-8</span><span>{language?.label ?? "Plain Text"}</span></footer>
    </> : <div className="code-editor-empty"><div className="code-editor-empty-icon">⌘</div><h2>Open a file to start</h2><p>Choose a file from the workspace explorer or open a changed file from Git history.</p></div>}
  </section>;
}
