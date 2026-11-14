import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { changeKindLetter, formatFullDate, formatRelativeTime } from "./gitGraphFormat";
import { DiffViewer } from "./DiffViewer";
import "./git-graph.css";

export type CommitInfo = { id: string; shortId: string; message: string; author: string; timestamp: number; parents: string[]; branches: string[] };
export type CommitFileChange = { path: string; kind: string };
/** A request from the branch panel to select a branch tip in the commit list. */
export type BranchFocusRequest = { name: string };

const COMMIT_PAGE_SIZE = 50;
const LOAD_MORE_THRESHOLD_PX = 160;

type Props = {
  repoPath: string;
  branch: string;
  focusRequest: BranchFocusRequest | null;
  onError: (message: string) => void;
  onOpenInEditor: (commit: CommitInfo, file: CommitFileChange) => void;
};

export function GitGraphView({ repoPath, branch, focusRequest, onError, onOpenInEditor }: Props) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const commitsRef = useRef<CommitInfo[]>([]);
  const hasMoreRef = useRef(true);
  const [hasMore, setHasMore] = useState(true);
  const loadingRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  // Set after a failed page load; scroll-triggered paging stays off until Load more or Refresh.
  const pagingBlockedRef = useRef(false);
  const detailRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const repoPathRef = useRef(repoPath);
  const onErrorRef = useRef(onError);
  repoPathRef.current = repoPath;
  onErrorRef.current = onError;
  const listRef = useRef<HTMLDivElement>(null);
  const handledFocusRef = useRef<BranchFocusRequest | null>(null);
  const [remoteNames, setRemoteNames] = useState<Set<string>>(() => new Set());

  const [selectedCommit, setSelectedCommit] = useState<CommitInfo | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [commitFiles, setCommitFiles] = useState<CommitFileChange[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [branchNote, setBranchNote] = useState<string | null>(null);

  const load = useCallback(async (append: boolean, manual = false) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri() || loadingRef.current || (append && !hasMoreRef.current)) return;
    if (append && !manual && pagingBlockedRef.current) return;
    const requestId = ++requestIdRef.current;
    const existing = append ? commitsRef.current : [];
    loadingRef.current = true;
    setLoading(true);
    try {
      const response = await invoke<CommitInfo[]>("git_history", { path: requestedPath, skip: existing.length, limit: COMMIT_PAGE_SIZE + 1 });
      if (requestId !== requestIdRef.current || repoPathRef.current !== requestedPath) return;
      const page = Array.isArray(response) ? response : [];
      const hasNextPage = page.length > COMMIT_PAGE_SIZE;
      const nextCommits = append
        ? [...existing, ...page.slice(0, COMMIT_PAGE_SIZE).filter((commit) => !existing.some((loaded) => loaded.id === commit.id))]
        : page.slice(0, COMMIT_PAGE_SIZE);
      commitsRef.current = nextCommits;
      hasMoreRef.current = hasNextPage;
      pagingBlockedRef.current = false;
      setCommits(nextCommits);
      setHasMore(hasNextPage);
    } catch (reason) {
      if (requestId === requestIdRef.current && repoPathRef.current === requestedPath) {
        pagingBlockedRef.current = true;
        onErrorRef.current(String(reason));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  const loadBranches = useCallback(async () => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri()) return;
    try {
      const list = await invoke<{ name: string; isRemote: boolean }[]>("git_branches", { path: requestedPath });
      if (repoPathRef.current !== requestedPath) return;
      setRemoteNames(new Set(Array.isArray(list) ? list.filter((item) => item.isRemote).map((item) => item.name) : []));
    } catch {
      // Remote styling is cosmetic; the branch panel reports branch errors.
    }
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    detailRequestRef.current += 1;
    diffRequestRef.current += 1;
    loadingRef.current = false;
    pagingBlockedRef.current = false;
    commitsRef.current = [];
    hasMoreRef.current = true;
    handledFocusRef.current = null;
    setLoading(false);
    setCommits([]);
    setHasMore(true);
    setSelectedCommit(null);
    setDetailsOpen(false);
    setCommitFiles([]);
    setDetailLoading(false);
    setDetailError(null);
    setDiffPath(null);
    setDiffText("");
    setDiffLoading(false);
    setDiffError(null);
    setBranchNote(null);
    setRemoteNames(new Set());
    void load(false);
    void loadBranches();
  }, [repoPath, load, loadBranches]);

  const selectCommit = useCallback(async (commit: CommitInfo) => {
    const requestedPath = repoPath;
    if (!requestedPath || !isTauri()) return;
    const requestId = ++detailRequestRef.current;
    diffRequestRef.current += 1;
    setSelectedCommit(commit);
    setDetailsOpen(true);
    setCommitFiles([]);
    setDetailError(null);
    setDiffPath(null);
    setDiffText("");
    setDiffLoading(false);
    setDiffError(null);
    setDetailLoading(true);
    try {
      const files = await invoke<CommitFileChange[]>("git_commit_files", { path: requestedPath, commitId: commit.id });
      if (requestId !== detailRequestRef.current || repoPathRef.current !== requestedPath) return;
      setCommitFiles(Array.isArray(files) ? files : []);
    } catch (reason) {
      if (requestId === detailRequestRef.current && repoPathRef.current === requestedPath) {
        setDetailError(String(reason));
        onErrorRef.current(String(reason));
      }
    } finally {
      if (requestId === detailRequestRef.current && repoPathRef.current === requestedPath) setDetailLoading(false);
    }
  }, [repoPath]);

  const showDiff = useCallback(async (commit: CommitInfo, file: CommitFileChange) => {
    const requestedPath = repoPath;
    if (!requestedPath || !isTauri()) return;
    const requestId = ++diffRequestRef.current;
    setDiffPath(file.path);
    setDiffText("");
    setDiffError(null);
    setDiffLoading(true);
    try {
      const diff = await invoke<string>("git_commit_file_diff", { path: requestedPath, commitId: commit.id, filePath: file.path });
      if (requestId !== diffRequestRef.current || repoPathRef.current !== requestedPath) return;
      setDiffText(typeof diff === "string" ? diff : "");
    } catch (reason) {
      if (requestId === diffRequestRef.current && repoPathRef.current === requestedPath) {
        setDiffError(String(reason));
      }
    } finally {
      if (requestId === diffRequestRef.current && repoPathRef.current === requestedPath) setDiffLoading(false);
    }
  }, [repoPath]);

  const selectCommitRef = useRef(selectCommit);
  selectCommitRef.current = selectCommit;

  // Branch panel asks for a tip: select the first loaded commit that carries the branch name.
  // If it is not loaded yet, keep the request pending so Load more can resolve it.
  useEffect(() => {
    if (!focusRequest || handledFocusRef.current === focusRequest || commits.length === 0) return;
    const tip = commits.find((commit) => commit.branches.includes(focusRequest.name));
    if (!tip) {
      setBranchNote("Tip not in loaded history");
      if (!hasMore) handledFocusRef.current = focusRequest;
      return;
    }
    handledFocusRef.current = focusRequest;
    setBranchNote(null);
    void selectCommitRef.current(tip);
    listRef.current?.querySelector<HTMLElement>(`[data-commit-id="${tip.id}"]`)?.scrollIntoView({ block: "center" });
  }, [focusRequest, commits, hasMore]);

  const focusRowAt = (rows: HTMLButtonElement[], index: number) => {
    const next = rows[index];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    const commit = commitsRef.current.find((item) => item.id === next.dataset.commitId);
    if (commit) void selectCommit(commit);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".g-row") ?? []);
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || rows.length === 0) return;
    event.preventDefault();
    if (event.key === "Home") return focusRowAt(rows, 0);
    if (event.key === "End") return focusRowAt(rows, rows.length - 1);
    const nextIndex = Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    if (nextIndex !== index) focusRowAt(rows, nextIndex);
  };

  const handleRootKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !detailsOpen || !selectedCommit) return;
    event.preventDefault();
    const rowId = selectedCommit.id;
    setDetailsOpen(false);
    listRef.current?.querySelector<HTMLElement>(`[data-commit-id="${rowId}"]`)?.focus();
  };

  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < LOAD_MORE_THRESHOLD_PX) void load(true);
  };

  const refresh = () => {
    pagingBlockedRef.current = false;
    void load(false, true);
    void loadBranches();
  };

  const commitMessageParts = selectedCommit?.message.split(/\r?\n/) ?? [];
  const commitSubject = commitMessageParts[0] ?? "";
  const commitDescription = commitMessageParts.slice(1).join("\n").trim();

  return <section className="git-graph-view" aria-label="Commit graph" onKeyDown={handleRootKeyDown}>
    <header className="g-head">
      <span>{branch || "Git Graph"}</span>
      {repoPath && <span className="g-sub">{`${commits.length}${hasMore ? "+" : ""} commits`}</span>}
      {repoPath && <button className="g-refresh" type="button" aria-label="Refresh history" title="Refresh history" onClick={refresh}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
      </button>}
    </header>
    {!repoPath ? <div className="g-empty-repo">
      <h2>History unavailable</h2>
      <p>Open a Git repository to browse its commit graph.</p>
    </div> : <div className="g-body">
      <div className="g-main">
        {branchNote && <p className="g-note" role="status">{branchNote}</p>}
        <div className="g-list" ref={listRef} onKeyDown={handleListKeyDown} onScroll={handleListScroll}>
          {commits.map((commit) => {
            const selected = selectedCommit?.id === commit.id;
            const isHead = branch !== "" && commit.branches.includes(branch);
            const fullDate = formatFullDate(commit.timestamp);
            return <button type="button" key={commit.id} data-commit-id={commit.id} className={`g-row${isHead ? " head" : ""}${selected ? " on" : ""}`} aria-pressed={selected} onClick={() => void selectCommit(commit)} title={`${commit.shortId} · ${fullDate}`}>
              <span className="lane" aria-hidden="true" />
              <span className="h">{commit.shortId}</span>
              <span className="m">{commit.branches.map((name) => <span className={`tag${remoteNames.has(name) ? " remote" : ""}`} key={name}>{name}</span>)}<span className="msg">{commit.message}</span></span>
              <span className="a">{commit.author}</span>
              <span className="t" title={fullDate}>{formatRelativeTime(commit.timestamp)}</span>
            </button>;
          })}
          {commits.length === 0 && !loading && <div className="g-state">No commits found.</div>}
        </div>
        {commits.length > 0 && hasMore && <button className="g-more" onClick={() => void load(true, true)} disabled={loading} type="button">{loading ? "Loading…" : "Load more commits"}</button>}
      </div>
      {detailsOpen && selectedCommit && <section className="g-details" aria-label="Commit details">
        <header className="g-details-head">
          <div className="g-details-title">
            <h2 title={commitSubject}>{commitSubject}</h2>
            {commitDescription && <p className="g-desc">{commitDescription}</p>}
          </div>
          <button className="g-close" type="button" aria-label="Close commit details" title="Close details" onClick={() => setDetailsOpen(false)}>×</button>
        </header>
        <dl className="g-meta">
          <div><dt>Author</dt><dd>{selectedCommit.author}</dd></div>
          <div><dt>Date</dt><dd>{formatFullDate(selectedCommit.timestamp)}</dd></div>
          <div><dt>Commit</dt><dd><code title={selectedCommit.id}>{selectedCommit.shortId}</code></dd></div>
        </dl>
        <h3 className="g-files-head">Changed files <span>{detailLoading ? "…" : commitFiles.length}</span></h3>
        <div className="g-files">
          {detailLoading ? <div className="g-state" role="status">Loading changed files…</div>
            : detailError ? <div className="g-state g-error" role="alert"><span>{detailError}</span><button type="button" onClick={() => void selectCommit(selectedCommit)}>Retry</button></div>
            : commitFiles.length === 0 ? <div className="g-state">No files changed in this commit.</div>
            : commitFiles.map((file) => {
              const letter = changeKindLetter(file.kind);
              return <div className="g-file-row" key={file.path}>
                <button type="button" className="g-file" title={`Open ${file.path}`} onClick={() => onOpenInEditor(selectedCommit, file)}>
                  <span className={`k ${letter}`} aria-hidden="true">{letter}</span>
                  <span className="p">{file.path}</span>
                </button>
                <button type="button" className="g-file-diff" aria-label={`Show diff for ${file.path}`} title={`Show diff for ${file.path}`} onClick={() => void showDiff(selectedCommit, file)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 5v6M9 8h6M9 17h6" /><rect x="4" y="3" width="16" height="18" rx="2" /></svg>
                </button>
              </div>;
            })}
        </div>
        {diffPath && <div className="g-diff">
          <div className="g-diff-head"><span title={diffPath}>{diffPath}</span></div>
          {diffLoading ? <div className="g-state" role="status">Loading diff…</div>
            : diffError ? <div className="g-state g-error" role="alert"><span>{diffError}</span></div>
            : <DiffViewer diff={diffText} emptyMessage="No changes in this file." />}
        </div>}
      </section>}
    </div>}
  </section>;
}
