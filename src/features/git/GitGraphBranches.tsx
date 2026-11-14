import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type BranchInfo = { name: string; isRemote: boolean; isHead: boolean; ahead: number | null; behind: number | null };

type Props = {
  repoPath: string;
  onError: (message: string) => void;
  onSelectBranch: (name: string) => void;
};

/** Side panel for Git Graph: local branches with upstream counts, then remotes. */
export function GitGraphBranches({ repoPath, onError, onSelectBranch }: Props) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    setBranches([]);
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

  if (!repoPath) {
    return <div className="g-empty-repo">
      <h2>History unavailable</h2>
      <p>Open a Git repository to browse its commit graph.</p>
    </div>;
  }

  const local = branches.filter((branch) => !branch.isRemote);
  const remote = branches.filter((branch) => branch.isRemote);

  const renderRow = (branch: BranchInfo) => <button type="button" key={branch.name} className={`gb-row${branch.isHead ? " on" : ""}`} title={branch.name} onClick={() => onSelectBranch(branch.name)}>
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 3.5-3 6-8 6" /></svg>
    <span className="label">{branch.name}</span>
    {!branch.isRemote && <span className="meta">{aheadBehindLabel(branch)}</span>}
  </button>;

  return <div className="gb-panel">
    <div className="gb-sec"><span>Branches</span><span className="gb-count">{local.length}</span></div>
    {local.map(renderRow)}
    <div className="gb-sec"><span>Remotes</span><span className="gb-count">{remote.length}</span></div>
    {remote.map(renderRow)}
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
