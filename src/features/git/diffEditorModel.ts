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
