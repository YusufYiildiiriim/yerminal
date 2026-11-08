type DiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";

function getDiffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

export function DiffViewer({ diff, emptyMessage }: { diff: string; emptyMessage: string }) {
  if (!diff) return <div className="diff-empty">{emptyMessage}</div>;

  return (
    <div className="diff-code" role="region" aria-label="File changes" tabIndex={0}>
      {diff.split(/\r?\n/).map((line, index) => {
        const kind = getDiffLineKind(line);
        const marker = kind === "added" ? "+" : kind === "removed" ? "−" : kind === "context" ? " " : "";
        const content = kind === "added" || kind === "removed" || kind === "context"
          ? line.slice(1)
          : line;
        return (
          <div className={`diff-line ${kind}`} key={`${index}-${line}`}>
            <span
              className="diff-line-marker"
              role={kind === "added" || kind === "removed" ? "img" : undefined}
              aria-label={kind === "added" ? "Added" : kind === "removed" ? "Removed" : undefined}
              aria-hidden={kind === "context" || kind === "hunk" || kind === "meta"}
            >
              {marker}
            </span>
            <code>{content || " "}</code>
          </div>
        );
      })}
    </div>
  );
}
