import "./commit-snapshot-banner.css";

export type CommitSnapshotChangeKind = "added" | "modified" | "deleted" | "renamed";

export type CommitSnapshotContext = {
  shortId: string;
  message: string;
  changeKind: CommitSnapshotChangeKind;
  author?: string;
  timestamp?: number;
};

const changeKindLabel: Record<CommitSnapshotChangeKind, string> = {
  added: "Added in commit",
  modified: "Modified in commit",
  deleted: "Deleted in commit",
  renamed: "Renamed in commit",
};

export function CommitSnapshotBanner({ snapshot }: { snapshot: CommitSnapshotContext }) {
  const message = snapshot.message.trim() || "Commit source snapshot";

  return <aside className="commit-snapshot-banner" aria-label={`Historical source from commit ${snapshot.shortId}`}>
    <div className="commit-snapshot-mark" aria-hidden="true">↶</div>
    <div className="commit-snapshot-copy">
      <div className="commit-snapshot-kicker"><span>COMMIT SNAPSHOT</span><code title={snapshot.shortId}>{snapshot.shortId}</code></div>
      <strong className="commit-snapshot-message" title={message}>{message}</strong>
      <div className="commit-snapshot-meta">
        {snapshot.author && <span>{snapshot.author}</span>}
        {snapshot.timestamp !== undefined && <time dateTime={new Date(snapshot.timestamp * 1000).toISOString()}>{new Date(snapshot.timestamp * 1000).toLocaleString()}</time>}
      </div>
    </div>
    <div className="commit-snapshot-badges">
      <span className={`commit-snapshot-kind ${snapshot.changeKind}`}>{changeKindLabel[snapshot.changeKind]}</span>
      <span className="commit-snapshot-readonly">Read only</span>
    </div>
  </aside>;
}
