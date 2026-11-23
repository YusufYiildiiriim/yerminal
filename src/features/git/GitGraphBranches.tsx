import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { BranchInfo, CommitFileChange, CommitInfo } from "./gitTypes";
import { changeKindLetter, formatFullDate, formatRelativeTime } from "./gitGraphFormat";
import { LoadingState } from "../../components/LoadingState";
import "./git-graph.css";

export type { BranchInfo };

type Props = {
  repoPath: string;
  currentBranch?: string;
  reloadKey?: number;
  onError: (message: string) => void;
  onOpenFile: (commit: CommitInfo, file: CommitFileChange) => void;
};

type BranchCommits = { commits: CommitInfo[]; hasMore: boolean; loading: boolean; error: string | null };
type CommitDetails = { files: CommitFileChange[]; loading: boolean; error: string | null };

const BRANCH_PAGE_SIZE = 30;

/**
 * Git Graph side panel: branches expand to their commits; a commit expands in place to show its
 * message, author, date and changed files; a file opens in the editor.
 */
export function GitGraphBranches({ repoPath, currentBranch = "", reloadKey = 0, onError, onOpenFile }: Props) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [expanded, setExpanded] = useState<Record<string, BranchCommits>>({});
  const [openCommit, setOpenCommit] = useState<{ branch: string; id: string } | null>(null);
  const [details, setDetails] = useState<Record<string, CommitDetails>>({});
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const detailsRequestRef = useRef(0);

  useEffect(() => {
    setBranches([]);
    setExpanded({});
    setOpenCommit(null);
    setDetails({});
    detailsRequestRef.current += 1;
    if (!repoPath || !isTauri()) return;
    let cancelled = false;
    invoke<BranchInfo[]>("git_branches", { path: repoPath })
      .then((list) => {
        if (!cancelled) setBranches(Array.isArray(list) ? list : []);
      })
      .catch((reason) => {
        if (!cancelled) onErrorRef.current(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, reloadKey]);

  const loadBranch = async (name: string, append: boolean) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri()) return;
    const existing = append ? expandedRef.current[name]?.commits ?? [] : [];
    setExpanded((current) => ({ ...current, [name]: { commits: existing, hasMore: current[name]?.hasMore ?? true, loading: true, error: null } }));
    try {
      const page = await invoke<CommitInfo[]>("git_history", { path: requestedPath, skip: existing.length, limit: BRANCH_PAGE_SIZE + 1, branch: name });
      if (repoPathRef.current !== requestedPath) return;
      const list = Array.isArray(page) ? page : [];
      setExpanded((current) => {
        if (!current[name]) return current;
        const merged = [...existing, ...list.slice(0, BRANCH_PAGE_SIZE).filter((commit) => !existing.some((loaded) => loaded.id === commit.id))];
        return { ...current, [name]: { commits: merged, hasMore: list.length > BRANCH_PAGE_SIZE, loading: false, error: null } };
      });
    } catch (reason) {
      if (repoPathRef.current !== requestedPath) return;
      setExpanded((current) => current[name] ? { ...current, [name]: { ...current[name], loading: false, error: String(reason) } } : current);
    }
  };

  // Open the checked-out branch once its list arrives, so commits are visible right away.
  const autoExpandedRef = useRef("");
  useEffect(() => {
    const key = repoPath + "|" + currentBranch;
    if (!currentBranch || autoExpandedRef.current === key || !branches.some((branch) => branch.name === currentBranch)) return;
    autoExpandedRef.current = key;
    if (!expandedRef.current[currentBranch]) void loadBranch(currentBranch, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches, currentBranch, repoPath]);

  const toggleBranch = (name: string) => {
    if (expandedRef.current[name]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      if (openCommit?.branch === name) setOpenCommit(null);
      return;
    }
    void loadBranch(name, false);
  };

  const loadDetails = async (commit: CommitInfo) => {
    const requestedPath = repoPathRef.current;
    if (!requestedPath || !isTauri()) return;
    const requestId = ++detailsRequestRef.current;
    setDetails((current) => ({ ...current, [commit.id]: { files: [], loading: true, error: null } }));
    try {
      const response = await invoke<CommitFileChange[]>("git_commit_files", { path: requestedPath, commitId: commit.id });
      if (repoPathRef.current !== requestedPath) return;
      setDetails((current) => ({ ...current, [commit.id]: { files: Array.isArray(response) ? response : [], loading: false, error: null } }));
    } catch (reason) {
      if (repoPathRef.current !== requestedPath) return;
      setDetails((current) => ({ ...current, [commit.id]: { files: [], loading: false, error: String(reason) } }));
      if (requestId === detailsRequestRef.current) onErrorRef.current(String(reason));
    }
  };

  const toggleCommit = (branch: string, commit: CommitInfo, event?: MouseEvent) => {
    event?.preventDefault();
    if (openCommit?.branch === branch && openCommit.id === commit.id) {
      if (event?.type !== "contextmenu") setOpenCommit(null);
      return;
    }
    setOpenCommit({ branch, id: commit.id });
    const known = details[commit.id];
    if (!known || known.error) void loadDetails(commit);
  };

  if (!repoPath) {
    return <div className="g-empty-repo">
      <h2>History unavailable</h2>
      <p>Open a Git repository to browse its commit graph.</p>
    </div>;
  }

  const local = branches.filter((branch) => !branch.isRemote);
  const remote = branches.filter((branch) => branch.isRemote);

  const renderDetails = (commit: CommitInfo) => {
    const state = details[commit.id];
    const lines = commit.message.split(/\r?\n/);
    const subject = lines[0] ?? "";
    const body = lines.slice(1).join("\n").trim();
    return <section className="gb-detail" aria-label={`Details for ${subject}`}>
      {body && <p className="gb-detail-body">{body}</p>}
      <dl className="gb-detail-meta">
        <div><dt>Author</dt><dd>{commit.author}</dd></div>
        <div><dt>Date</dt><dd>{formatFullDate(commit.timestamp)}</dd></div>
        <div><dt>Commit</dt><dd><code>{commit.shortId}</code></dd></div>
      </dl>
      <div className="gb-detail-files-head"><span>Changed files</span><span>{state?.loading ? "…" : state?.files.length ?? 0}</span></div>
      {!state || state.loading ? <LoadingState label="Loading changed files…" centered />
        : state.error ? <div className="gb-note gb-error" role="alert"><span>{state.error}</span> <button type="button" className="gb-retry" onClick={() => void loadDetails(commit)}>Retry</button></div>
        : state.files.length === 0 ? <div className="gb-note">No files changed in this commit.</div>
        : <ul className="gb-files" aria-label={`Changed files in ${commit.shortId}`}>
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
        </ul>}
    </section>;
  };

  const renderBranch = (branch: BranchInfo) => {
    const state = expanded[branch.name];
    return <div className="gb-branch" key={branch.name}>
      <button type="button" className={`gb-row${branch.isHead ? " on" : ""}`} title={branch.name} aria-label={branch.name} aria-expanded={Boolean(state)} onClick={() => toggleBranch(branch.name)}>
        <svg className={`gb-chev${state ? " open" : ""}`} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 3.5-3 6-8 6" /></svg>
        <span className="label">{branch.name}</span>
        {!branch.isRemote && <span className="meta">{aheadBehindLabel(branch)}</span>}
      </button>
      {state && <ul className="gb-commits" aria-label={`Commits on ${branch.name}`}>
        {state.commits.map((commit) => {
          const open = openCommit?.branch === branch.name && openCommit.id === commit.id;
          return <li key={commit.id} className={open ? "open" : undefined}>
            <button type="button" className={`gb-commit${open ? " on" : ""}`} aria-expanded={open} aria-description={formatFullDate(commit.timestamp)} onClick={(event) => toggleCommit(branch.name, commit, event)} onContextMenu={(event) => toggleCommit(branch.name, commit, event)}>
              <span className="gb-msg" title={commit.message.split(/\r?\n/)[0]}>{commit.message.split(/\r?\n/)[0]}</span>
              <span className="gb-sub"><span className="gb-hash">{commit.shortId.slice(0, 7)}</span><span aria-hidden="true">·</span><span className="gb-time">{formatRelativeTime(commit.timestamp)}</span></span>
            </button>
            {open && renderDetails(commit)}
          </li>;
        })}
        {state.loading && <li><LoadingState label="Loading commits…" centered /></li>}
        {state.error && <li className="gb-note gb-error" role="alert">{state.error}</li>}
        {!state.loading && !state.error && state.commits.length === 0 && <li className="gb-note">No commits</li>}
        {!state.loading && state.hasMore && state.commits.length > 0 && <li><button type="button" className="gb-more" onClick={() => void loadBranch(branch.name, true)}>Load more</button></li>}
      </ul>}
    </div>;
  };

  return <div className="gb-panel">
    <div className="gb-sec"><span>Branches</span><span className="gb-count">{local.length}</span></div>
    {local.map(renderBranch)}
    <div className="gb-sec"><span>Remotes</span><span className="gb-count">{remote.length}</span></div>
    {remote.map(renderBranch)}
    {branches.length === 0 && <div className="gb-empty">No branches found.</div>}
  </div>;
}

function aheadBehindLabel(branch: BranchInfo): string {
  if (branch.ahead === null || branch.behind === null) return "";
  const parts: string[] = [];
  if (branch.ahead > 0) parts.push(`${branch.ahead} ahead`);
  if (branch.behind > 0) parts.push(`${branch.behind} behind`);
  return parts.length > 0 ? parts.join(" · ") : "in sync";
}
