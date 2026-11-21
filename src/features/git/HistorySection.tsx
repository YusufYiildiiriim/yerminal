import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CommitFileChange, CommitInfo } from "./gitTypes";
import { changeKindLetter, formatFullDate, formatRelativeTime } from "./gitGraphFormat";
import { readOpenHistory, setHistoryOpen, writeOpenHistory } from "./historyExpansion";
import "./git-graph.css";

export const HISTORY_PAGE_SIZE = 20;

type HistoryPage = { upstream: string | null; commits: CommitInfo[] };
type HistoryList = {
  stamp: string | null;
  status: "idle" | "loading" | "ready" | "error";
  upstream: string | null;
  commits: CommitInfo[];
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
};
type CommitDetails = { files: CommitFileChange[]; loading: boolean; error: string | null };

const EMPTY_LIST: HistoryList = { stamp: null, status: "idle", upstream: null, commits: [], hasMore: false, loadingMore: false, error: null };

type Props = {
  repoPath: string;
  /** Stable key for the repository (see repoExpansionKey) that remembers whether History is open. */
  repoKey: string;
  branch: string;
  refreshKey?: number;
  onError: (message: string) => void;
  onOpenFile: (commit: CommitInfo, file: CommitFileChange) => void;
};

/**
 * Commits this branch has already pushed, read from its upstream. Collapsed by default and loaded on first open,
 * then 20 at a time. A commit expands to its changed files; a file opens that commit's diff, as in Outgoing commits.
 */
export function HistorySection({ repoPath, repoKey, branch, refreshKey = 0, onError, onOpenFile }: Props) {
  const [open, setOpen] = useState(() => readOpenHistory().has(repoKey));
  const [list, setList] = useState<HistoryList>(EMPTY_LIST);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CommitDetails>>({});
  const stamp = `${repoPath}\n${branch}\n${refreshKey}`;
  const stampRef = useRef(stamp);
  stampRef.current = stamp;
  const requestRef = useRef(0);
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    setOpenId(null);
    setDetails({});
  }, [repoPath, branch]);

  const requestPage = useCallback(async (skip: number) => {
    if (!isTauri()) return;
    const requestedStamp = stampRef.current;
    const requestedPath = repoPath;
    const id = ++requestRef.current;
    setList((current) => (skip === 0
      ? { ...EMPTY_LIST, stamp: requestedStamp, status: "loading" }
      : { ...current, loadingMore: true, error: null }));
    try {
      const page = await invoke<HistoryPage>("git_pushed_history", { path: requestedPath, skip, limit: HISTORY_PAGE_SIZE });
      if (id !== requestRef.current) return;
      const received = Array.isArray(page?.commits) ? page.commits : [];
      setList((current) => ({
        stamp: requestedStamp,
        status: "ready",
        upstream: page?.upstream ?? null,
        commits: skip === 0 ? received : [...current.commits, ...received],
        hasMore: received.length === HISTORY_PAGE_SIZE,
        loadingMore: false,
        error: null,
      }));
    } catch (reason) {
      if (id !== requestRef.current) return;
      setList((current) => ({ ...current, stamp: requestedStamp, status: "error", loadingMore: false, error: String(reason) }));
    }
  }, [repoPath]);

  // Lazy: nothing is read until the section opens, and a list read for another branch, repository or refresh is read again.
  useEffect(() => {
    if (open && list.stamp !== stamp) void requestPage(0);
  }, [open, stamp, list.stamp, requestPage]);

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

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    writeOpenHistory(setHistoryOpen(readOpenHistory(), repoKey, next));
  };

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

  const renderCommit = (commit: CommitInfo) => {
    const isOpen = openId === commit.id;
    return <li key={commit.id} className={isOpen ? "open" : undefined}>
      <button type="button" className={`gb-commit${isOpen ? " on" : ""}`} aria-expanded={isOpen} aria-description={formatFullDate(commit.timestamp)} onClick={(event) => toggleCommit(commit, event)}>
        <span className="gb-msg">{commit.message.split(/\r?\n/)[0]}</span>
        <span className="gb-sub"><span className="gb-hash">{commit.shortId.slice(0, 7)}</span><span aria-hidden="true">·</span><span className="gb-time">{formatRelativeTime(commit.timestamp)}</span></span>
      </button>
      {isOpen && <section className="gb-detail" aria-label={`Changed files for ${commit.shortId}`}>{renderFiles(commit)}</section>}
    </li>;
  };

  const renderBody = () => {
    if (list.status === "idle") return null;
    if (list.status === "loading" && list.commits.length === 0) return <div className="gb-note" role="status">Loading history…</div>;
    if (list.status === "error" && list.commits.length === 0) return <div className="gb-note gb-error" role="alert"><span>{list.error}</span> <button type="button" className="gb-retry" onClick={() => void requestPage(0)}>Retry</button></div>;
    if (list.upstream === null) return <div className="up-note">No upstream for this branch. Publish it from the sync bar to start tracking; pushed history shows here after that.</div>;
    if (list.commits.length === 0) return <div className="gb-note">No pushed commits on {list.upstream}.</div>;
    // The list and Load more share one capped scroll box, so Load more stays at the end of the list.
    return <div className="hist-list-scroll">
      <ul className="gb-commits" aria-label="Pushed commits">{list.commits.map(renderCommit)}</ul>
      {list.status === "error" && <div className="gb-note gb-error" role="alert"><span>{list.error}</span> <button type="button" className="gb-retry" onClick={() => void requestPage(list.commits.length)}>Retry</button></div>}
      {list.hasMore && <div className="more-wrap"><button type="button" className="gb-more" disabled={list.loadingMore} onClick={() => void requestPage(list.commits.length)}>{list.loadingMore ? "Loading…" : "Load more"}</button></div>}
    </div>;
  };

  const showsUpstream = list.status === "ready" && list.upstream !== null;
  const count = showsUpstream ? `${list.commits.length}${list.hasMore ? "+" : ""}` : null;

  return <section className="hist-section" aria-label="History">
    <button type="button" className="hist-toggle" aria-expanded={open} onClick={toggleOpen}>
      <span className={`hist-chev${open ? " open" : ""}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></span>
      <span>History</span>
      {count !== null && <span className="gb-count">{count}</span>}
    </button>
    {open && <>
      {showsUpstream && <div className="hist-branch" title={`${branch || "Detached HEAD"} tracks ${list.upstream}`}>{branch || "Detached HEAD"} ↔ {list.upstream}</div>}
      {renderBody()}
    </>}
  </section>;
}
