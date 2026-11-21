import { parseCollapsedRepos, serializeCollapsedRepos } from "./repoExpansion";

/** Remembers which Git Changes repositories have their History section open, keyed like repoExpansionKey. */
export const HISTORY_OPEN_STORAGE_KEY = "yerminal.git-history-open";

export function setHistoryOpen(open: ReadonlySet<string>, key: string, isOpen: boolean): Set<string> {
  const next = new Set(open);
  if (isOpen) next.add(key); else next.delete(key);
  return next;
}

function defaultStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function readOpenHistory(storage: Storage | null = defaultStorage()): Set<string> {
  try {
    return parseCollapsedRepos(storage?.getItem(HISTORY_OPEN_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function writeOpenHistory(keys: ReadonlySet<string>, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(HISTORY_OPEN_STORAGE_KEY, serializeCollapsedRepos(keys));
  } catch {
    /* preference only: losing it is harmless */
  }
}
