import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CommitInfo } from "./GitGraphView";
import { formatFullDate, formatRelativeTime } from "./gitGraphFormat";

export type BranchInfo = { name: string; isRemote: boolean; isHead: boolean; ahead: number | null; behind: number | null };

type Props = {
  repoPath: string;
  onError: (message: string) => void;
  onSelectBranch: (name: string) => void;
  onSelectCommit: (commit: CommitInfo) => void;
};

type BranchCommits = { commits: CommitInfo[]; hasMore: boolean; loading: boolean; error: string | null };

const BRANCH_PAGE_SIZE = 30;

/** Side panel for Git Graph: branches expand to their own commits; a commit click shows its changes on the right. */
export function GitGraphBranches({ repoPath, onError, onSelectBranch, onSelectCommit }: Props) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [expanded, setExpanded] = useState<Record<string, BranchCommits>>({});
  const [selectedCommitId, setSelectedCommitId] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    setBranches([]);
    setExpanded({});
    setSelectedCommitId(null);
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
  }, [repoPath]);

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

  const toggleBranch = (name: string) => {
    onSelectBranch(name);
    if (expandedRef.current[name]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      return;
    }
    void loadBranch(name, false);
  };

  const chooseCommit = (commit: CommitInfo, event?: MouseEvent) => {
    event?.preventDefault();
    setSelectedCommitId(commit.id);
    onSelectCommit(commit);
  };

  if (!repoPath) {
    return <div className="g-empty-repo">
      <h2>History unavailable</h2>
      <p>Open a Git repository to browse its commit graph.</p>
    </div>;
  }

  const local = branches.filter((branch) => !branch.isRemote);
  const remote = branches.filter((branch) => branch.isRemote);

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
        {state.commits.map((commit) => <li key={commit.id}>
          <button type="button" className={`gb-commit${selectedCommitId === commit.id ? " on" : ""}`} aria-pressed={selectedCommitId === commit.id} title={`${commit.shortId} · ${commit.message} · ${formatFullDate(commit.timestamp)}`} onClick={(event) => chooseCommit(commit, event)} onContextMenu={(event) => chooseCommit(commit, event)}>
            <span className="gb-hash">{commit.shortId.slice(0, 7)}</span>
            <span className="gb-msg">{commit.message}</span>
            <span className="gb-time">{formatRelativeTime(commit.timestamp)}</span>
          </button>
        </li>)}
        {state.loading && <li className="gb-note" role="status">Loading commits…</li>}
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
