import { useMemo } from "react";

type DiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";
type DiffRow = { kind: DiffLineKind; oldNumber: number | null; newNumber: number | null; content: string };

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isMetaLine(line: string): boolean {
  return line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")
    || /^(old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|new file mode|deleted file mode|Binary files|GIT binary patch) /.test(line);
}

// Keeps hunk headers and meta lines verbatim so no diff metadata is ever lost.
function parseDiffRows(diff: string): DiffRow[] {
  const lines = diff.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows: DiffRow[] = [];
  let oldNumber: number | null = null;
  let newNumber: number | null = null;
  for (const line of lines) {
    const hunkHeader = HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeader) {
      oldNumber = Number(hunkHeader[1]);
      newNumber = Number(hunkHeader[2]);
      rows.push({ kind: "hunk", oldNumber: null, newNumber: null, content: line });
      continue;
    }
    if (isMetaLine(line)) {
      rows.push({ kind: "meta", oldNumber: null, newNumber: null, content: line });
      continue;
    }
    if (line.startsWith("+")) {
      const currentNew = newNumber;
      rows.push({ kind: "added", oldNumber: null, newNumber: currentNew, content: line.slice(1) });
      if (currentNew !== null) newNumber = currentNew + 1;
      continue;
    }
    if (line.startsWith("-")) {
      const currentOld = oldNumber;
      rows.push({ kind: "removed", oldNumber: currentOld, newNumber: null, content: line.slice(1) });
      if (currentOld !== null) oldNumber = currentOld + 1;
      continue;
    }
    const currentOld = oldNumber;
    const currentNew = newNumber;
    rows.push({ kind: "context", oldNumber: currentOld, newNumber: currentNew, content: line.startsWith(" ") ? line.slice(1) : line });
    if (currentOld !== null) oldNumber = currentOld + 1;
    if (currentNew !== null) newNumber = currentNew + 1;
  }
  return rows;
}

type DiffViewProps = { diff: string; path: string; root: string; staged: boolean; loading?: boolean; emptyMessage?: string };

export function DiffView({ diff, path, root, staged, loading = false, emptyMessage = "No diff available." }: DiffViewProps) {
  const rows = useMemo(() => parseDiffRows(diff), [diff]);
  const headerRows = rows.filter((row) => row.kind === "meta" && /^(diff --git |index |--- |\+\+\+ )/.test(row.content));
  const displayRows = rows.filter((row) => !headerRows.includes(row));
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

  if (loading) return <div className="diff-view" role="region" aria-label="File diff"><div className="code-editor-message" role="status"><span className="editor-loading-indicator" /><span>Loading file changes…</span></div></div>;

  return <div className="diff-view" role="region" aria-label="File diff" tabIndex={0}>
    <div className="diff-view-strip">
      <span className="diff-view-file" title={path}>{fileName}</span>
      <span className={"diff-view-side" + (staged ? " staged" : "")}>{staged ? "Index" : "Working Tree"}</span>
      <span className="diff-view-repo" title={root}>{repoName}</span>
    </div>
    {headerRows.length > 0 && <details className="diff-view-details"><summary>Diff details</summary><pre>{headerRows.map((row) => row.content).join("\n")}</pre></details>}
    {displayRows.length === 0 ? <div className="diff-view-empty">{emptyMessage}</div> : <div className="diff-view-lines">
      {displayRows.map((row, index) => row.kind === "hunk" || row.kind === "meta"
        ? <div className={`diff-view-line ${row.kind}`} key={index}><code className="diff-view-content">{row.content}</code></div>
        : <div className={`diff-view-line ${row.kind}`} key={index}>
          <span className="diff-view-number" aria-hidden="true">{row.oldNumber ?? ""}</span>
          <span className="diff-view-number" aria-hidden="true">{row.newNumber ?? ""}</span>
          <span
            className="diff-view-marker"
            role={row.kind === "added" || row.kind === "removed" ? "img" : undefined}
            aria-label={row.kind === "added" ? "Added line" : row.kind === "removed" ? "Removed line" : undefined}
            aria-hidden={row.kind === "added" || row.kind === "removed" ? undefined : true}
          >{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}</span>
          <code className="diff-view-content">{row.content}</code>
        </div>)}
    </div>}
  </div>;
}
