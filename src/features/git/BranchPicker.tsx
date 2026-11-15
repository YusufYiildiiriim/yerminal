import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { BranchInfo } from "./gitTypes";
import "./branch-picker.css";

type MergeOutcome = { result: "upToDate" | "fastForward" | "merged" | "conflicts"; conflicts: string[] };

function describeMerge(outcome: MergeOutcome, name: string): string {
  switch (outcome.result) {
    case "upToDate": return `Already up to date with ${name}`;
    case "fastForward": return `Fast-forwarded to ${name}`;
    case "merged": return `Merged ${name}`;
    default: return `Merge conflicts in ${outcome.conflicts.length} ${outcome.conflicts.length === 1 ? "file" : "files"}. Resolve them in Git Changes`;
  }
}

type Props = {
  repoPath: string;
  currentBranch: string;
  onChanged: () => void;
  onError: (message: string) => void;
};

/**
 * Branch switcher for one repository: search, switch (remote branches create a tracking branch),
 * create from the current branch, rename and delete. All Git work happens in the Rust commands.
 */
export function BranchPicker({ repoPath, currentBranch, onChanged, onError }: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [confirmForce, setConfirmForce] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const label = currentBranch || "Detached HEAD";

  const loadBranches = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const list = await invoke<BranchInfo[]>("git_branches", { path: repoPath });
      setBranches(Array.isArray(list) ? list : []);
    } catch (reason) {
      onErrorRef.current(String(reason));
    }
  }, [repoPath]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCreating(null);
    setRenaming(null);
    setConfirmForce(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadBranches();
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, loadBranches, close]);

  const run = async (action: () => Promise<unknown>, options: { keepOpen?: boolean } = {}) => {
    setBusy(true);
    try {
      await action();
      onChanged();
      if (options.keepOpen) await loadBranches(); else close();
    } catch (reason) {
      onErrorRef.current(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const merge = (name: string) => run(async () => {
    const outcome = await invoke<MergeOutcome>("git_merge_branch", { path: repoPath, name });
    onErrorRef.current(describeMerge(outcome, name));
  });
  const checkout = (name: string) => run(() => invoke("git_checkout_branch", { path: repoPath, name }));
  const create = (name: string) => run(() => invoke("git_create_branch", { path: repoPath, name, from: null, checkout: true }));
  const rename = (oldName: string, newName: string) => run(async () => {
    await invoke("git_rename_branch", { path: repoPath, oldName, newName });
    setRenaming(null);
  }, { keepOpen: true });
  const remove = async (name: string, force: boolean) => {
    setBusy(true);
    try {
      await invoke("git_delete_branch", { path: repoPath, name, force });
      setConfirmForce(null);
      onChanged();
      await loadBranches();
    } catch (reason) {
      if (!force && String(reason).includes("not fully merged")) setConfirmForce(name);
      else onErrorRef.current(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => branches.filter((branch) => !needle || branch.name.toLocaleLowerCase().includes(needle)), [branches, needle]);
  const local = visible.filter((branch) => !branch.isRemote);
  const remote = visible.filter((branch) => branch.isRemote);

  const renderRow = (branch: BranchInfo) => {
    if (renaming?.name === branch.name) {
      return <li key={branch.name} className="bp-row">
        <input className="bp-input" aria-label={`New name for ${branch.name}`} autoFocus value={renaming.value} disabled={busy}
          onChange={(event) => setRenaming({ name: branch.name, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && renaming.value.trim()) { event.preventDefault(); void rename(branch.name, renaming.value.trim()); }
            if (event.key === "Escape") { event.stopPropagation(); setRenaming(null); }
          }} />
      </li>;
    }
    return <li key={branch.name} className={"bp-row" + (branch.isHead ? " current" : "")}>
      <button type="button" className="bp-item" aria-label={`Checkout ${branch.name}`} disabled={busy || branch.isHead} onClick={() => void checkout(branch.name)}>
        <span className="bp-check" aria-hidden="true">{branch.isHead ? "✓" : ""}</span>
        <span className="bp-name">{branch.name}</span>
        {!branch.isRemote && (branch.ahead || branch.behind) ? <span className="bp-meta">{branch.ahead ? `↑${branch.ahead}` : ""}{branch.behind ? ` ↓${branch.behind}` : ""}</span> : null}
      </button>
      {(!branch.isHead || !branch.isRemote) && <span className="bp-actions">
        {!branch.isHead && currentBranch && <button type="button" className="bp-icon" aria-label={`Merge ${branch.name} into ${currentBranch}`} title={`Merge into ${currentBranch}`} disabled={busy} onClick={() => void merge(branch.name)}>⤵</button>}
        {!branch.isRemote && <button type="button" className="bp-icon" aria-label={`Rename ${branch.name}`} title="Rename branch" disabled={busy} onClick={() => setRenaming({ name: branch.name, value: branch.name })}>✎</button>}
        {!branch.isRemote && !branch.isHead && <button type="button" className="bp-icon" aria-label={`Delete ${branch.name}`} title="Delete branch" disabled={busy} onClick={() => void remove(branch.name, false)}>✕</button>}
      </span>}
      {confirmForce === branch.name && <div className="bp-confirm" role="alert">
        <span>Not fully merged. Delete anyway?</span>
        <button type="button" className="bp-danger" onClick={() => void remove(branch.name, true)}>Force delete</button>
        <button type="button" onClick={() => setConfirmForce(null)}>Cancel</button>
      </div>}
    </li>;
  };

  return <div className="branch-picker" ref={rootRef}>
    <button type="button" className="bp-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={`Switch branch, current ${label}`} title="Switch branch" onClick={() => (open ? close() : setOpen(true))}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 3.5-3 6-8 6" /></svg>
      <span className="bp-label">{label}</span>
      <svg className="bp-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {open && <div className="bp-popover" role="dialog" aria-label="Branches">
      <input className="bp-input" aria-label="Search branches" placeholder="Search branches" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      {creating === null
        ? <button type="button" className="bp-new" onClick={() => setCreating("")}>+ New branch from {label}…</button>
        : <input className="bp-input" aria-label="New branch name" placeholder="New branch name, Enter to create" autoFocus value={creating} disabled={busy}
          onChange={(event) => setCreating(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && creating.trim()) { event.preventDefault(); void create(creating.trim()); }
            if (event.key === "Escape") { event.stopPropagation(); setCreating(null); }
          }} />}
      <div className="bp-list">
        {local.length > 0 && <><div className="bp-section">Local</div><ul>{local.map(renderRow)}</ul></>}
        {remote.length > 0 && <><div className="bp-section">Remote</div><ul>{remote.map(renderRow)}</ul></>}
        {local.length + remote.length === 0 && <div className="bp-empty">No matching branches</div>}
      </div>
    </div>}
  </div>;
}
