/** Full text of both sides of one file change, as returned by the git_diff_versions commands. */
export type DiffVersions = { original: string; modified: string; binary: boolean; tooLarge: boolean };

export type DiffEditorPlan =
  | { mode: "monaco"; original: string; modified: string }
  | { mode: "patch"; reason: "unavailable" | "binary" | "too-large" | "unchanged" };

/** Monaco needs both full texts; anything else keeps the patch view. Absent sides are already empty strings. */
export function planDiffEditor(versions: DiffVersions | null | undefined): DiffEditorPlan {
  if (!versions) return { mode: "patch", reason: "unavailable" };
  if (versions.binary) return { mode: "patch", reason: "binary" };
  if (versions.tooLarge) return { mode: "patch", reason: "too-large" };
  // Identical sides would open an empty-looking editor; the patch view shows the empty message instead.
  if (versions.original === versions.modified) return { mode: "patch", reason: "unchanged" };
  return { mode: "monaco", original: versions.original, modified: versions.modified };
}

/** One change as Monaco's getLineChanges reports it (1-based modified lines; 0 end marks a deletion). */
export type DiffLineChange = { modifiedStartLineNumber: number; modifiedEndLineNumber: number };

/** The line Monaco's own goToDiff jumps to. A deletion stores the line before the gap, so it lands one line later. */
export function changeJumpLine(change: DiffLineChange): number {
  return change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : Math.max(1, change.modifiedStartLineNumber);
}

/** 1-based index of the change the cursor is on or last passed (0 before the first one), out of all changes. */
export function diffPosition(changes: readonly DiffLineChange[], cursorLine: number): { index: number; total: number } {
  let index = 0;
  changes.forEach((change, position) => { if (changeJumpLine(change) <= cursorLine) index = position + 1; });
  return { index, total: changes.length };
}
