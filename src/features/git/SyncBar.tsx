import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PointerMenu, type PointerMenuItem, type PointerMenuTarget } from "../workspace/PointerMenu";
import { PublishRemoteDialog, type GithubAccount, type PublishChoice } from "./PublishRemoteDialog";
import { suggestRepoName } from "./remoteUrl";
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
 * Without any remote, Publish also appears and asks for a remote URL before it adds the remote and pushes.
 */
export function SyncBar({ repoPath, refreshKey, onChanged, onError, onAheadChange, onNewBranch, onRefresh, view = "list", onViewChange }: Props) {
  const [state, setState] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [menu, setMenu] = useState<PointerMenuTarget | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [account, setAccount] = useState<GithubAccount | null>(null);
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

  /** Opens the Publish dialog and reads the GitHub CLI state for it. A missing or unreadable state means "not available". */
  const openPublish = () => {
    setAccount(null);
    setPublishing(true);
    invoke<GithubAccount | undefined>("git_github_status")
      .then((next) => setAccount(next && typeof next === "object" ? next : { installed: false, loggedIn: false, login: null }))
      .catch(() => setAccount({ installed: false, loggedIn: false, login: null }));
  };

  /** Creates the GitHub repository or adds the typed remote, then publishes the branch in one backend call. The dialog closes either way; a failure keeps what the backend says was done. */
  const publishNew = async (choice: PublishChoice) => {
    setPublishing(false);
    if (busy) return;
    setBusy("push");
    try {
      const message = choice.kind === "github"
        ? await invoke<string>("git_create_github_repo", { path: repoPath, name: choice.name, public: choice.public })
        : await invoke<string>("git_add_remote_publish", { path: repoPath, name: choice.name, url: choice.url });
      onError(summarize("Publish", message));
    } catch (reason) {
      onError(summarize("Publish failed", String(reason)));
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
    if (state && !hasRemote) {
      items.push({ label: "Publish branch…", onSelect: openPublish, disabled: busy !== null || detached });
    }
    if (hasRemote) {
      items.push({ label: busy === "fetch" ? "Fetching…" : "Fetch", onSelect: () => void run("fetch"), disabled: busy !== null });
      items.push({ label: busy === "pull" ? "Pulling…" : `Pull ↓${state?.behind ?? 0}`, onSelect: () => void run("pull"), disabled: busy !== null || detached || !published });
    }
    items.push({ label: "New branch…", onSelect: () => onNewBranch?.(), separatorBefore: items.length > 0 });
    items.push({ label: "Refresh", onSelect: () => onRefresh?.() });
    items.push({ label: view === "list" ? "✓ List view" : "List view", onSelect: () => onViewChange?.("list"), separatorBefore: true });
    items.push({ label: view === "tree" ? "✓ Tree view" : "Tree view", onSelect: () => onViewChange?.("tree") });
    setMenu({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4, label: "Git actions", items });
  };

  const hasRemote = Boolean(state?.hasRemote);
  const detached = state?.branch === null;
  const published = state?.upstream != null;

  // Push appears only when something is waiting to be pushed; Publish stays while there is no upstream, and also with no remote at all (it asks for the URL first).
  const showPublish = state !== null && (hasRemote ? !published || (state.ahead ?? 0) > 0 : true);

  return <div className="sync-bar" role="group" aria-label="Remote sync">
    {showPublish && <button type="button" className="sync-button primary" aria-label={published ? "Push to remote" : "Publish branch"} title={published ? `Push to ${state?.upstream}` : hasRemote ? "Publish this branch to the remote" : "Add a remote and publish this branch"} disabled={busy !== null || detached} onClick={() => (hasRemote ? void run("push") : openPublish())}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V7M6 12l6-6 6 6" /></svg>
      <span>{busy === "push" ? (published ? "Pushing…" : "Publishing…") : published ? "Push" : "Publish"}</span>
      {(state?.ahead ?? 0) > 0 && <small className="sync-count" aria-label={`${state?.ahead} commits to push`}>{state?.ahead}</small>}
    </button>}
    <button ref={moreRef} type="button" className="sync-button sync-more" aria-label="More git actions" title="More git actions" aria-haspopup="menu" aria-expanded={menu !== null} onClick={openMenu}>
      <span aria-hidden="true">⋯</span>
    </button>
    <PointerMenu target={menu} onClose={closeMenu} />
    {publishing && state?.branch && <PublishRemoteDialog branch={state.branch} defaultRepoName={suggestRepoName(repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "")} account={account} onSubmit={(choice) => void publishNew(choice)} onCancel={() => setPublishing(false)} />}
  </div>;
}
