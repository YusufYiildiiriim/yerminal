import { useMemo, useState } from "react";
import { DEFAULT_LANGUAGES, type EditorLanguageId } from "../editor/editorLanguages";
import type { ThemeId } from "../settings/SettingsDialog";
import { MonacoDiffView } from "./MonacoDiffView";
import { planDiffEditor, type DiffVersions } from "./diffEditorModel";

type DiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";
type DiffRow = { kind: DiffLineKind; oldNumber: number | null; newNumber: number | null; content: string; notes?: string[] };
type CodeSide = { kind: "added" | "removed" | "context"; number: number | null; content: string; notes?: string[] } | null;
type DisplayRow = { kind: "meta"; content: string } | { kind: "hunk"; content: string; hidden: number } | { kind: "code"; old: CodeSide; current: CodeSide };

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isMetaLine(line: string): boolean {
  return line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")
    || /^(old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|new file mode|deleted file mode|Binary files|GIT binary patch) /.test(line);
}

function parseDiffRows(diff: string): DiffRow[] {
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const rows: DiffRow[] = [];
  let oldNumber: number | null = null;
  let newNumber: number | null = null;
  let inHunk = false;
  for (const line of lines) {
    const hunkHeader = HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeader) {
      inHunk = true;
      oldNumber = Number(hunkHeader[1]);
      newNumber = Number(hunkHeader[2]);
      rows.push({ kind: "hunk", oldNumber, newNumber, content: line });
      continue;
    }
    if (line.startsWith("diff --git ")) inHunk = false;
    if (inHunk && line.startsWith("\\")) {
      const previous = rows.at(-1);
      if (previous && previous.kind !== "hunk" && previous.kind !== "meta") {
        previous.notes = [...(previous.notes ?? []), line];
        continue;
      }
    }
    if (isMetaLine(line) && !(inHunk && (line.startsWith("--- ") || line.startsWith("+++ ")))) {
      rows.push({ kind: "meta", oldNumber: null, newNumber: null, content: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", oldNumber: null, newNumber, content: line.slice(1) });
      if (newNumber !== null) newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "removed", oldNumber, newNumber: null, content: line.slice(1) });
      if (oldNumber !== null) oldNumber += 1;
      continue;
    }
    rows.push({ kind: "context", oldNumber, newNumber, content: line.startsWith(" ") ? line.slice(1) : line });
    if (oldNumber !== null) oldNumber += 1;
    if (newNumber !== null) newNumber += 1;
  }
  return rows;
}

function pairDiffRows(rows: DiffRow[]): DisplayRow[] {
  const display: DisplayRow[] = [];
  // Next old-side line not yet shown; the gap before a hunk is the unchanged lines git left out.
  let nextOldLine = 1;
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (row.kind === "meta") {
      if (row.content.startsWith("diff --git ")) nextOldLine = 1;
      display.push({ kind: "meta", content: row.content });
      index += 1;
      continue;
    }
    if (row.kind === "hunk") {
      const start = row.oldNumber ?? nextOldLine;
      const hidden = Math.max(0, start - nextOldLine);
      if (hidden > 0) display.push({ kind: "hunk", content: row.content, hidden });
      nextOldLine = Math.max(nextOldLine, start);
      index += 1;
      continue;
    }
    if (row.kind === "context") {
      const side: CodeSide = { kind: "context", number: row.oldNumber, content: row.content, notes: row.notes };
      display.push({ kind: "code", old: side, current: { ...side, number: row.newNumber } });
      if (row.oldNumber !== null) nextOldLine = row.oldNumber + 1;
      index += 1;
      continue;
    }

    const changes: DiffRow[] = [];
    while (index < rows.length && (rows[index].kind === "added" || rows[index].kind === "removed")) {
      changes.push(rows[index]);
      if (rows[index].kind === "removed" && rows[index].oldNumber !== null) nextOldLine = (rows[index].oldNumber as number) + 1;
      index += 1;
    }
    const removed = changes.filter((change) => change.kind === "removed");
    const added = changes.filter((change) => change.kind === "added");
    for (let pairIndex = 0; pairIndex < Math.max(removed.length, added.length); pairIndex += 1) {
      const old = removed[pairIndex];
      const current = added[pairIndex];
      display.push({
        kind: "code",
        old: old ? { kind: "removed", number: old.oldNumber, content: old.content, notes: old.notes } : null,
        current: current ? { kind: "added", number: current.newNumber, content: current.content, notes: current.notes } : null,
      });
    }
  }
  return display;
}

type DiffViewProps = { diff: string; path: string; root: string; staged: boolean; loading?: boolean; emptyMessage?: string; sideLabel?: string; versions?: DiffVersions | null; enabledLanguages?: readonly EditorLanguageId[]; theme?: ThemeId; fontFamily?: string; fontSize?: number };

export function DiffView({ diff, path, root, staged, loading = false, emptyMessage = "No diff available.", sideLabel, versions, enabledLanguages = DEFAULT_LANGUAGES, theme = "obsidian", fontFamily, fontSize }: DiffViewProps) {
  const rows = useMemo(() => parseDiffRows(diff), [diff]);
  // The Monaco view falls back to the patch rows for these versions if the editor cannot load.
  const [failedVersions, setFailedVersions] = useState<DiffVersions | null | undefined>(undefined);
  const monacoPlan = planDiffEditor(versions);
  const monacoDiff = monacoPlan.mode === "monaco" && failedVersions !== versions ? monacoPlan : null;
  const headerRows = rows.filter((row) => row.kind === "meta" && /^(diff --git |index |--- |\+\+\+ )/.test(row.content));
  const displayRows = pairDiffRows(rows.filter((row) => !headerRows.includes(row)));
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

  if (loading) return <div className="diff-view" role="region" aria-label="File diff"><div className="code-editor-message" role="status"><span className="editor-loading-indicator" /><span>Loading file changes…</span></div></div>;

  return <div className="diff-view" role="region" aria-label="File diff" tabIndex={0}>
    <div className="diff-view-strip">
      <span className="diff-view-file" title={path}>{fileName}</span>
      <span className={"diff-view-side" + (staged ? " staged" : "") + (sideLabel ? " commit" : "")}>{sideLabel ?? (staged ? "Index" : "Working Tree")}</span>
      <span className="diff-view-repo" title={root}>{repoName}</span>
    </div>
    {headerRows.length > 0 && <details className="diff-view-details"><summary>Diff details</summary><pre>{headerRows.map((row) => row.content).join("\n")}</pre></details>}
    {monacoDiff ? <MonacoDiffView original={monacoDiff.original} modified={monacoDiff.modified} path={path} enabledLanguages={enabledLanguages} theme={theme} fontFamily={fontFamily} fontSize={fontSize} onUnavailable={() => setFailedVersions(versions)} />
    : displayRows.length === 0 ? <div className="diff-view-empty">{emptyMessage}</div> : <>
      <div className="diff-view-columns" aria-hidden="true"><span>Previous</span><span>Current</span></div>
      <div className="diff-view-lines" role="table" aria-label="Side-by-side file changes">
        {displayRows.map((row, index) => row.kind === "code"
          ? <div className={`diff-view-line ${row.old?.kind === "removed" ? "has-removed" : ""} ${row.current?.kind === "added" ? "has-added" : ""} ${row.old && !row.current ? "removed-only" : ""} ${row.current && !row.old ? "added-only" : ""}`} role="row" key={index}>
            <DiffCell side="old" value={row.old} />
            <DiffCell side="current" value={row.current} />
          </div>
          : row.kind === "hunk"
          ? <div className="diff-view-line hunk" role="row" key={index}><span className="diff-view-hidden" role="cell" title={row.content}>{row.hidden === 1 ? "1 hidden line" : `${row.hidden} hidden lines`}</span></div>
          : <div className={`diff-view-line ${row.kind}`} role="row" key={index}><code className="diff-view-content" role="cell">{row.content}</code></div>)}
      </div>
    </>}
  </div>;
}

function DiffCell({ side, value }: { side: "old" | "current"; value: CodeSide }) {
  const label = side === "old" ? "previous" : "current";
  if (!value) return <span className={`diff-view-cell ${side} empty`} role="cell"><span className="diff-view-number" /><span className="diff-view-marker" /><span className="diff-view-content" aria-label={side === "old" ? "No previous line" : "No current line"} /></span>;
  return <span className={`diff-view-cell ${side} ${value.kind}`} role="cell">
    <span className="diff-view-number" aria-hidden="true">{value.number ?? ""}</span>
    <span className="diff-view-marker" aria-hidden="true">{value.kind === "added" ? "+" : value.kind === "removed" ? "−" : ""}</span>
    <code className="diff-view-content" aria-label={`${label} ${value.kind} line`}>
      {value.content}
      {value.notes?.map((note) => <span className="diff-view-note" key={note}>{note}</span>)}
    </code>
  </span>;
}
