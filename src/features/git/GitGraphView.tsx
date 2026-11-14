import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { changeKindLetter, formatFullDate } from "./gitGraphFormat";
import { DiffViewer } from "./DiffViewer";
import "./git-graph.css";

export type CommitInfo = { id: string; shortId: string; message: string; author: string; timestamp: number; parents: string[]; branches: string[] };
export type CommitFileChange = { path: string; kind: string };
/** A request from the branch panel to show one commit: its files on the right, a file diff in the middle. */
export type CommitFocusRequest = { commit: CommitInfo };

type Props = {
  repoPath: string;
  commitRequest?: CommitFocusRequest | null;
  onError: (message: string) => void;
  onOpenInEditor: (commit: CommitInfo, file: CommitFileChange) => void;
  onCloseCommit?: () => void;
};

/**
 * Git Graph main area. Commits are browsed in the branch panel on the left; the middle shows
 * the selected file's changes and the right shows the commit details and changed files.
 */
export function GitGraphView({ repoPath, commitRequest = null, onError, onOpenInEditor, onCloseCommit }: Props) {
  const detailRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const repoPathRef = useRef(repoPath);
  const onErrorRef = useRef(onError);
  repoPathRef.current = repoPath;
  onErrorRef.current = onError;

  const [selectedCommit, setSelectedCommit] = useState<CommitInfo | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFileChange[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFileChange | null>(null);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const clear = useCallback(() => {
    detailRequestRef.current += 1;
    diffRequestRef.current += 1;
    setSelectedCommit(null);
    setCommitFiles([]);
    setDetailLoading(false);
    setDetailError(null);
    setSelectedFile(null);
    setDiffText("");
    setDiffLoading(false);
    setDiffError(null);
  }, []);

  useEffect(() => { clear(); }, [repoPath, clear]);

  const showFile = useCallback(async (commit: CommitInfo, file: CommitFileChange) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri()) return;
    const requestId = ++diffRequestRef.current;
    setSelectedFile(file);
    setDiffText("");
    setDiffError(null);
    setDiffLoading(true);
    try {
      const diff = await invoke<string>("git_commit_file_diff", { path: requestedPath, commitId: commit.id, filePath: file.path });
      if (requestId !== diffRequestRef.current || repoPathRef.current !== requestedPath) return;
      setDiffText(typeof diff === "string" ? diff : "");
    } catch (reason) {
      if (requestId === diffRequestRef.current && repoPathRef.current === requestedPath) setDiffError(String(reason));
    } finally {
      if (requestId === diffRequestRef.current && repoPathRef.current === requestedPath) setDiffLoading(false);
    }
  }, []);

  const selectCommit = useCallback(async (commit: CommitInfo) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri()) return;
    const requestId = ++detailRequestRef.current;
    diffRequestRef.current += 1;
    setSelectedCommit(commit);
    setCommitFiles([]);
    setDetailError(null);
    setSelectedFile(null);
    setDiffText("");
    setDiffLoading(false);
    setDiffError(null);
    setDetailLoading(true);
    try {
      const response = await invoke<CommitFileChange[]>("git_commit_files", { path: requestedPath, commitId: commit.id });
      if (requestId !== detailRequestRef.current || repoPathRef.current !== requestedPath) return;
      const files = Array.isArray(response) ? response : [];
      setCommitFiles(files);
      if (files.length > 0) void showFile(commit, files[0]);
    } catch (reason) {
      if (requestId === detailRequestRef.current && repoPathRef.current === requestedPath) {
        setDetailError(String(reason));
        onErrorRef.current(String(reason));
      }
    } finally {
      if (requestId === detailRequestRef.current && repoPathRef.current === requestedPath) setDetailLoading(false);
    }
  }, [showFile]);

  useEffect(() => {
    if (commitRequest) void selectCommit(commitRequest.commit);
  }, [commitRequest, selectCommit]);

  const closeCommit = () => {
    clear();
    onCloseCommit?.();
  };

  const messageParts = selectedCommit?.message.split(/\r?\n/) ?? [];
  const subject = messageParts[0] ?? "";
  const description = messageParts.slice(1).join("\n").trim();

  return <section className="git-graph-view" aria-label="Commit graph">
    {!repoPath ? <div className="g-empty-repo">
      <h2>History unavailable</h2>
      <p>Open a Git repository to browse its commit graph.</p>
    </div> : <div className="g-body">
      <div className="g-main">
        {!selectedCommit ? <div className="g-placeholder">
          <p>Select a commit on the left to see its changes.</p>
        </div> : selectedFile ? <>
          <header className="g-diff-head">
            <span className={`k ${changeKindLetter(selectedFile.kind)}`} aria-hidden="true">{changeKindLetter(selectedFile.kind)}</span>
            <span className="p" title={selectedFile.path}>{selectedFile.path}</span>
            <span className="c">{selectedCommit.shortId}</span>
            <button type="button" className="g-open" aria-label={`Open ${selectedFile.path} in editor`} title="Open in editor" onClick={() => onOpenInEditor(selectedCommit, selectedFile)}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
              <span>Open in editor</span>
            </button>
          </header>
          <div className="g-diff-body">
            {diffLoading ? <div className="g-state" role="status">Loading changes…</div>
              : diffError ? <div className="g-state g-error" role="alert"><span>{diffError}</span><button type="button" onClick={() => void showFile(selectedCommit, selectedFile)}>Retry</button></div>
              : <DiffViewer diff={diffText} emptyMessage="No changes in this file." />}
          </div>
        </> : <div className="g-placeholder">
          <p>{detailLoading ? "Loading changed files…" : commitFiles.length === 0 && !detailError ? "No files changed in this commit." : "Pick a file on the right."}</p>
        </div>}
      </div>
      {selectedCommit && <section className="g-details" aria-label="Commit details">
        <header className="g-details-head">
          <div className="g-details-title">
            <h2 title={subject}>{subject}</h2>
            {description && <p className="g-desc">{description}</p>}
          </div>
          <button className="g-close" type="button" aria-label="Close commit details" title="Close details" onClick={closeCommit}>×</button>
        </header>
        <dl className="g-meta">
          <div><dt>Author</dt><dd>{selectedCommit.author}</dd></div>
          <div><dt>Date</dt><dd>{formatFullDate(selectedCommit.timestamp)}</dd></div>
          <div><dt>Commit</dt><dd><code>{selectedCommit.shortId}</code></dd></div>
        </dl>
        <h3 className="g-files-head">Changed files <span>{detailLoading ? "…" : commitFiles.length}</span></h3>
        <div className="g-files">
          {detailLoading ? <div className="g-state" role="status">Loading changed files…</div>
            : detailError ? <div className="g-state g-error" role="alert"><span>{detailError}</span><button type="button" onClick={() => void selectCommit(selectedCommit)}>Retry</button></div>
            : commitFiles.length === 0 ? <div className="g-state">No files changed in this commit.</div>
            : commitFiles.map((file) => {
              const letter = changeKindLetter(file.kind);
              const active = selectedFile?.path === file.path;
              return <button type="button" key={file.path} className={`g-file${active ? " on" : ""}`} aria-pressed={active} onClick={() => void showFile(selectedCommit, file)}>
                <span className={`k ${letter}`} aria-hidden="true">{letter}</span>
                <span className="p">{file.path}</span>
              </button>;
            })}
        </div>
      </section>}
    </div>}
  </section>;
}
