/** Remembers which Git Changes repository blocks the user collapsed, keyed by repository root. */
export const COLLAPSED_REPOS_STORAGE_KEY = "yerminal.git-collapsed-repos";

export function repoExpansionKey(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function parseCollapsedRepos(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

export function serializeCollapsedRepos(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].sort());
}

export function setRepoExpanded(collapsed: ReadonlySet<string>, key: string, expanded: boolean): Set<string> {
  const next = new Set(collapsed);
  if (expanded) next.delete(key); else next.add(key);
  return next;
}

function defaultStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function readCollapsedRepos(storage: Storage | null = defaultStorage()): Set<string> {
  try {
    return parseCollapsedRepos(storage?.getItem(COLLAPSED_REPOS_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function writeCollapsedRepos(keys: ReadonlySet<string>, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(COLLAPSED_REPOS_STORAGE_KEY, serializeCollapsedRepos(keys));
  } catch {
    /* preference only: losing it is harmless */
  }
}
