import "./commit-snapshot-banner.css";

export type CommitSnapshotChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechanged";

export type CommitSnapshotContext = {
  shortId: string;
  message: string;
  changeKind: string;
  author?: string;
  timestamp?: number;
};

const changeKindLabel: Record<CommitSnapshotChangeKind, string> = {
  added: "Added in commit",
  modified: "Modified in commit",
  deleted: "Deleted in commit",
  renamed: "Renamed in commit",
  copied: "Copied in commit",
  typechanged: "Type changed in commit",
};

export function CommitSnapshotBanner({ snapshot, filePath }: { snapshot: CommitSnapshotContext; filePath: string }) {
  const message = snapshot.message.trim() || "Commit source snapshot";
  const changeKind = Object.hasOwn(changeKindLabel, snapshot.changeKind)
    ? snapshot.changeKind as CommitSnapshotChangeKind
    : "modified";
  const timestamp = snapshot.timestamp !== undefined && Number.isFinite(snapshot.timestamp)
    ? new Date(snapshot.timestamp * 1000)
    : null;

  return <aside className="commit-snapshot-banner" aria-label={`Historical source from commit ${snapshot.shortId}`}>
    <div className="commit-snapshot-copy">
      <div className="commit-snapshot-heading">
        <div className="commit-snapshot-kicker"><span>HISTORICAL SOURCE</span><code title={snapshot.shortId}>{snapshot.shortId}</code></div>
        <strong className="commit-snapshot-message" title={message}>{message}</strong>
      </div>
      <code className="commit-snapshot-path" title={filePath}>{filePath}</code>
      <div className="commit-snapshot-meta">
        {snapshot.author && <span>{snapshot.author}</span>}
        {timestamp && <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString()}</time>}
      </div>
    </div>
    <div className="commit-snapshot-badges">
      <span className={`commit-snapshot-kind ${changeKind}`}>{changeKindLabel[changeKind]}</span>
      <span className="commit-snapshot-readonly">Read only</span>
    </div>
  </aside>;
}
