import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CommitFileChange, CommitInfo } from "./gitTypes";
import { changeKindLetter, formatFullDate, formatRelativeTime } from "./gitGraphFormat";
import { GitCard } from "./GitCard";
import "./git-graph.css";

type Props = {
  repoPath: string;
  refreshKey?: number;
  onError: (message: string) => void;
  onOpenFile: (commit: CommitInfo, file: CommitFileChange) => void;
};

type CommitDetails = { files: CommitFileChange[]; loading: boolean; error: string | null };

/**
 * Commits the checked-out branch has not pushed yet. Renders nothing when the branch has no upstream or is in sync.
 * A commit expands to its changed files; a file opens that commit's diff in the editor, as in Git Graph.
 */
export function OutgoingCommits({ repoPath, refreshKey = 0, onError, onOpenFile }: Props) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CommitDetails>>({});
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;

  useEffect(() => {
    setOpenId(null);
    setDetails({});
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath || !isTauri()) {
      setCommits([]);
      return;
    }
    let cancelled = false;
    invoke<CommitInfo[]>("git_outgoing_commits", { path: repoPath })
      .then((list) => { if (!cancelled) setCommits(Array.isArray(list) ? list : []); })
      .catch((reason) => {
        if (cancelled) return;
        setCommits([]);
        onErrorRef.current(String(reason));
      });
    return () => { cancelled = true; };
  }, [repoPath, refreshKey]);

  const loadDetails = async (commit: CommitInfo) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri()) return;
    setDetails((current) => ({ ...current, [commit.id]: { files: [], loading: true, error: null } }));
    try {
      const response = await invoke<CommitFileChange[]>("git_commit_files", { path: requestedPath, commitId: commit.id });
      if (repoPathRef.current !== requestedPath) return;
      setDetails((current) => ({ ...current, [commit.id]: { files: Array.isArray(response) ? response : [], loading: false, error: null } }));
    } catch (reason) {
      if (repoPathRef.current !== requestedPath) return;
      setDetails((current) => ({ ...current, [commit.id]: { files: [], loading: false, error: String(reason) } }));
      onErrorRef.current(String(reason));
    }
  };

  const toggleCommit = (commit: CommitInfo, event?: MouseEvent) => {
    event?.preventDefault();
    if (openId === commit.id) {
      setOpenId(null);
      return;
    }
    setOpenId(commit.id);
    const known = details[commit.id];
    if (!known || known.error) void loadDetails(commit);
  };

  if (commits.length === 0) return null;

  const renderFiles = (commit: CommitInfo) => {
    const state = details[commit.id];
    if (!state || state.loading) return <div className="gb-note" role="status">Loading changed files…</div>;
    if (state.error) return <div className="gb-note gb-error" role="alert"><span>{state.error}</span> <button type="button" className="gb-retry" onClick={() => void loadDetails(commit)}>Retry</button></div>;
    if (state.files.length === 0) return <div className="gb-note">No files changed in this commit.</div>;
    return <div className="gb-files-scroll"><ul className="gb-files" aria-label={`Changed files in ${commit.shortId}`}>
      {state.files.map((file) => {
        const letter = changeKindLetter(file.kind);
        const name = file.path.split(/[\\/]/).pop() ?? file.path;
        const folder = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));
        return <li key={file.path}>
          <button type="button" className="gb-file" aria-label={file.path} onClick={() => onOpenFile(commit, file)}>
            <span className={`k ${letter}`} aria-hidden="true">{letter}</span>
            <span className="n">{name}</span>
            {folder && <span className="d">{folder}</span>}
          </button>
        </li>;
      })}
    </ul></div>;
  };

  return <GitCard label="Outgoing commits" title="Outgoing commits" count={commits.length} className="outgoing-commits">
    <ul className="gb-commits" aria-label="Commits not pushed yet">
      {commits.map((commit) => {
        const open = openId === commit.id;
        return <li key={commit.id} className={open ? "open" : undefined}>
          <button type="button" className={`gb-commit${open ? " on" : ""}`} aria-expanded={open} aria-description={formatFullDate(commit.timestamp)} onClick={(event) => toggleCommit(commit, event)}>
            <span className="gb-msg" title={commit.message.split(/\r?\n/)[0]}>{commit.message.split(/\r?\n/)[0]}</span>
            <span className="gb-sub"><span className="gb-hash">{commit.shortId.slice(0, 7)}</span><span aria-hidden="true">·</span><span>{commit.author}</span><span aria-hidden="true">·</span><span className="gb-time">{formatRelativeTime(commit.timestamp)}</span></span>
          </button>
          {open && <section className="gb-detail" aria-label={`Changed files for ${commit.shortId}`}>{renderFiles(commit)}</section>}
        </li>;
      })}
    </ul>
  </GitCard>;
}
