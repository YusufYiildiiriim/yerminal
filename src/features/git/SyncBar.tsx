import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PointerMenu, type PointerMenuItem, type PointerMenuTarget } from "../workspace/PointerMenu";
import "./git-sync.css";

type RemoteState = { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean };
type Operation = "fetch" | "pull" | "push";

type Props = {
  repoPath: string;
  /** Changes whenever the parent refreshed the repository, so ahead/behind stays current. */
  refreshKey: number;
  onChanged: () => void;
  onError: (message: string) => void;
  /** Reports the ahead count so the repository header can show it. */
  onAheadChange?: (ahead: number) => void;
  /** Items that do not need a remote: they stay in the menu even without one. */
  onNewBranch?: () => void;
  onRefresh?: () => void;
  view?: "list" | "tree";
  onViewChange?: (view: "list" | "tree") => void;
};

function summarize(label: string, message: string): string {
  const lines = String(message).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const text = lines.length > 2 ? lines.slice(-2).join(" · ") : lines.join(" · ");
  return `${label}: ${text.length > 220 ? `${text.slice(0, 217)}…` : text || "done"}`;
}

/**
 * Remote toolbar of a repository: Push (or Publish) stays visible with its count; Fetch and Pull,
 * New branch, Refresh and the list/tree switch live in the ⋯ menu. Nothing is removed, only moved.
 */
export function SyncBar({ repoPath, refreshKey, onChanged, onError, onAheadChange, onNewBranch, onRefresh, view = "list", onViewChange }: Props) {
  const [state, setState] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [menu, setMenu] = useState<PointerMenuTarget | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await invoke<RemoteState | undefined>("git_remote_state", { path: repoPath });
      setState(next && typeof next === "object" ? next : null);
    } catch {
      setState(null);
    }
  }, [repoPath]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { onAheadChange?.(state?.ahead ?? 0); }, [state?.ahead, onAheadChange]);

  const run = async (operation: Operation) => {
    if (busy) return;
    setBusy(operation);
    const label = operation === "fetch" ? "Fetch" : operation === "pull" ? "Pull" : state?.upstream ? "Push" : "Publish";
    try {
      const message = await invoke<string>(`git_${operation}`, { path: repoPath });
      onError(summarize(label, message));
    } catch (reason) {
      onError(summarize(`${label} failed`, String(reason)));
    } finally {
      setBusy(null);
      await load();
      onChanged();
    }
  };

  const closeMenu = useCallback(() => {
    setMenu(null);
    moreRef.current?.focus();
  }, []);

  const openMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    const hasRemote = Boolean(state?.hasRemote);
    const detached = state?.branch === null;
    const published = state?.upstream != null;
    const items: PointerMenuItem[] = [];
    if (hasRemote) {
      items.push({ label: busy === "fetch" ? "Fetching…" : "Fetch", onSelect: () => void run("fetch"), disabled: busy !== null });
      items.push({ label: busy === "pull" ? "Pulling…" : `Pull ↓${state?.behind ?? 0}`, onSelect: () => void run("pull"), disabled: busy !== null || detached || !published });
    }
    items.push({ label: "New branch…", onSelect: () => onNewBranch?.(), separatorBefore: hasRemote });
    items.push({ label: "Refresh", onSelect: () => onRefresh?.() });
    items.push({ label: view === "list" ? "✓ List view" : "List view", onSelect: () => onViewChange?.("list"), separatorBefore: true });
    items.push({ label: view === "tree" ? "✓ Tree view" : "Tree view", onSelect: () => onViewChange?.("tree") });
    setMenu({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4, label: "Git actions", items });
  };

  const hasRemote = Boolean(state?.hasRemote);
  const detached = state?.branch === null;
  const published = state?.upstream != null;

  return <div className="sync-bar" role="group" aria-label="Remote sync">
    {hasRemote && <button type="button" className={`sync-button${published && state?.ahead === 0 ? "" : " primary"}`} aria-label={published ? "Push to remote" : "Publish branch"} title={published ? `Push to ${state?.upstream}` : "Publish this branch to the remote"} disabled={busy !== null || detached || (published && state?.ahead === 0)} onClick={() => void run("push")}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V7M6 12l6-6 6 6" /></svg>
      <span>{busy === "push" ? (published ? "Pushing…" : "Publishing…") : published ? "Push" : "Publish"}</span>
      {(state?.ahead ?? 0) > 0 && <small className="sync-count" aria-label={`${state?.ahead} commits to push`}>{state?.ahead}</small>}
    </button>}
    <button ref={moreRef} type="button" className="sync-button sync-more" aria-label="More git actions" title="More git actions" aria-haspopup="menu" aria-expanded={menu !== null} onClick={openMenu}>
      <span aria-hidden="true">⋯</span>
    </button>
    <PointerMenu target={menu} onClose={closeMenu} />
  </div>;
}
