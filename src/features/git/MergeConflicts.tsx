import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./merge-conflicts.css";

type Props = {
  repoPath: string;
  merging: boolean;
  conflicts: string[];
  onChanged: () => void;
  onError: (message: string) => void;
  onOpenFile: (relativePath: string) => void;
};

/**
 * Merge-in-progress banner (commit or abort) and the list of conflicted files, each with
 * "ours", "theirs" and "mark resolved" actions. Nothing renders outside a merge.
 */
export function MergeConflicts({ repoPath, merging, conflicts, onChanged, onError, onOpenFile }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  if (!merging && conflicts.length === 0) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (reason) {
      onError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resolve = (file: string, side: "ours" | "theirs" | "merged") =>
    run(async () => { await invoke("git_resolve_conflict", { path: repoPath, filePath: file, side }); });

  const commitMerge = () => run(async () => {
    const message = (await invoke<string>("git_merge_message", { path: repoPath })) || "Merge";
    const id = await invoke<string>("git_commit_staged", { path: repoPath, message });
    onError(`Created merge commit ${id.slice(0, 7)}`);
  });

  const abortMerge = () => run(async () => {
    await invoke("git_merge_abort", { path: repoPath });
    setConfirmAbort(false);
    onError("Merge aborted");
  });

  return <section className="merge-panel" aria-label="Merge in progress">
    <header className="merge-heading">
      <strong>Merge in progress</strong>
      <span>{conflicts.length > 0 ? `${conflicts.length} ${conflicts.length === 1 ? "conflict" : "conflicts"} to resolve` : "All conflicts resolved"}</span>
    </header>
    {merging && <div className="merge-actions">
      <button type="button" className="merge-primary" disabled={busy || conflicts.length > 0} onClick={() => void commitMerge()}>Commit merge</button>
      {confirmAbort
        ? <span className="merge-confirm" role="alert">
          Abort and discard the merge?
          <button type="button" className="merge-danger" disabled={busy} onClick={() => void abortMerge()}>Abort merge</button>
          <button type="button" onClick={() => setConfirmAbort(false)}>Keep</button>
        </span>
        : <button type="button" disabled={busy} onClick={() => setConfirmAbort(true)}>Abort merge…</button>}
    </div>}
    {conflicts.length > 0 && <ul className="merge-files" aria-label="Conflicted files">
      {conflicts.map((file) => <li key={file} className="merge-file">
        <button type="button" className="merge-path" title={`Open ${file} to edit the conflict`} aria-label={`Open ${file}`} onClick={() => onOpenFile(file)}>
          <span className="change-kind conflicted" aria-hidden="true">!</span>
          <span>{file}</span>
        </button>
        <span className="merge-file-actions">
          <button type="button" aria-label={`Take ours for ${file}`} title="Keep the version from the current branch" disabled={busy} onClick={() => void resolve(file, "ours")}>Ours</button>
          <button type="button" aria-label={`Take theirs for ${file}`} title="Use the version from the merged branch" disabled={busy} onClick={() => void resolve(file, "theirs")}>Theirs</button>
          <button type="button" aria-label={`Mark ${file} as resolved`} title="Accept the file as edited" disabled={busy} onClick={() => void resolve(file, "merged")}>Resolved</button>
        </span>
      </li>)}
    </ul>}
  </section>;
}
