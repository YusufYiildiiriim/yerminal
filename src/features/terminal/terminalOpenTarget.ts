import { createTerminalGroup, renameTerminalGroup, selectTerminalGroup, type TerminalGroups } from "./terminalWorkspaceActions";

/** Where a new terminal goes: a folder (null = the workspace root, as before) and a group (null = the active group). */
export type TerminalGroupChoice = { kind: "existing"; id: string } | { kind: "new"; name: string };
export type TerminalOpenChoice = { folder: string | null; group: TerminalGroupChoice | null };
/** Which questions the prompt asks. Entry points that already know the folder skip the folder question. */
export type TerminalOpenAsk = { folder: boolean; group: boolean };
export type TerminalOpenDefaults = { terminalDefaultPath?: string; terminalDefaultGroup?: string };

export const RECENT_TERMINAL_FOLDERS_KEY = "yerminal.terminal-recent-folders.v1";
export const RECENT_TERMINAL_FOLDER_LIMIT = 6;

/**
 * Defaults used when "Use defaults when opening a terminal" is on. An empty path keeps the workspace root;
 * an empty group name keeps the active group. A group name that matches nothing creates that group.
 */
export function resolveTerminalOpenDefaults(settings: TerminalOpenDefaults, groups: readonly { id: string; name: string }[]): TerminalOpenChoice {
  const folder = (settings.terminalDefaultPath ?? "").trim() || null;
  const name = (settings.terminalDefaultGroup ?? "").trim();
  if (!name) return { folder, group: null };
  const existing = findGroupByName(groups, name);
  return { folder, group: existing ? { kind: "existing", id: existing.id } : { kind: "new", name } };
}

/** Folder choices in the prompt: workspace root first, then workspace folders and recent folders, without duplicates. */
export function folderChoices(rootPath: string, workspaceFolders: readonly string[], recent: readonly string[]): string[] {
  const seen = new Set<string>();
  return [rootPath, ...workspaceFolders, ...recent].filter((path) => {
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

export function readRecentTerminalFolders(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_TERMINAL_FOLDERS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, RECENT_TERMINAL_FOLDER_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Puts the folder first in the recent list and returns the updated list. Storage failures keep the list in memory only. */
export function rememberTerminalFolder(path: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
  const next = [path, ...readRecentTerminalFolders(storage).filter((item) => item !== path)].slice(0, RECENT_TERMINAL_FOLDER_LIMIT);
  try {
    storage.setItem(RECENT_TERMINAL_FOLDERS_KEY, JSON.stringify(next));
  } catch {
    /* The list is recent-only; losing it is harmless. */
  }
  return next;
}

/** Applies a group choice to a workspace's groups. A new name that is already taken selects that group instead. */
export function applyTerminalGroupChoice(state: TerminalGroups, choice: TerminalGroupChoice): TerminalGroups {
  if (choice.kind === "existing") return selectTerminalGroup(state, choice.id);
  const existing = findGroupByName(state.groups, choice.name);
  if (existing) return selectTerminalGroup(state, existing.id);
  const created = createTerminalGroup(state);
  return renameTerminalGroup(created, created.activeGroupId, choice.name);
}

function findGroupByName<T extends { name: string }>(groups: readonly T[], name: string): T | undefined {
  const key = name.trim().toLocaleLowerCase();
  return groups.find((group) => group.name.trim().toLocaleLowerCase() === key);
}
