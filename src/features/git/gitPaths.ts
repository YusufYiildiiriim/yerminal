/** Joins a repository root and a repository-relative path, whatever separators the root uses. */
export function joinRepoPath(root: string, relativePath: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relativePath}`;
}
