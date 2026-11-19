import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./git-sync.css";

type RemoteState = { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean };
type Operation = "fetch" | "pull" | "push";

type Props = {
  repoPath: string;
  /** Changes whenever the parent refreshed the repository, so ahead/behind stays current. */
  refreshKey: number;
  onChanged: () => void;
  onError: (message: string) => void;
};

function summarize(label: string, message: string): string {
  const lines = String(message).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const text = lines.length > 2 ? lines.slice(-2).join(" · ") : lines.join(" · ");
  return `${label}: ${text.length > 220 ? `${text.slice(0, 217)}…` : text || "done"}`;
}

export function SyncBar({ repoPath, refreshKey, onChanged, onError }: Props) {
  const [state, setState] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await invoke<RemoteState | undefined>("git_remote_state", { path: repoPath });
      setState(next && typeof next === "object" ? next : null);
    } catch {
      setState(null);
    }
  }, [repoPath]);

  useEffect(() => { void load(); }, [load, refreshKey]);

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

  if (!state || !state.hasRemote) return null;
  const detached = state.branch === null;
  const published = state.upstream !== null;

  return <div className="sync-bar" role="group" aria-label="Remote sync">
    <button type="button" className="sync-button" aria-label="Fetch from remote" title="Fetch: download remote changes without merging them" disabled={busy !== null} onClick={() => void run("fetch")}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" /></svg>
      <span>{busy === "fetch" ? "Fetching…" : "Fetch"}</span>
    </button>
    <button type="button" className="sync-button" aria-label="Pull from remote" title={published ? `Pull from ${state.upstream}` : "Publish this branch first"} disabled={busy !== null || detached || !published} onClick={() => void run("pull")}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v13M6 12l6 6 6-6" /></svg>
      <span>{busy === "pull" ? "Pulling…" : "Pull"}</span>
      {state.behind > 0 && <small className="sync-count" aria-label={`${state.behind} commits to pull`}>{state.behind}</small>}
    </button>
    <button type="button" className={`sync-button${published && state.ahead === 0 ? "" : " primary"}`} aria-label={published ? "Push to remote" : "Publish branch"} title={published ? `Push to ${state.upstream}` : "Publish this branch to the remote"} disabled={busy !== null || detached || (published && state.ahead === 0)} onClick={() => void run("push")}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V7M6 12l6-6 6 6" /></svg>
      <span>{busy === "push" ? (published ? "Pushing…" : "Publishing…") : published ? "Push" : "Publish"}</span>
      {state.ahead > 0 && <small className="sync-count" aria-label={`${state.ahead} commits to push`}>{state.ahead}</small>}
    </button>
  </div>;
}
