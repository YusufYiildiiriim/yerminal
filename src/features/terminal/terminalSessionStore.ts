/**
 * Saved list of open terminals, so they can be started again after an app restart.
 * Only the metadata is kept: name, group, order, start folder, shell and the active one.
 * Scrollback and running processes are not saved.
 */

export const TERMINAL_SESSIONS_KEY = "yerminal.terminal-sessions.v1";
/** Pause between two restored terminals, so twelve of them start without freezing the UI. */
export const RESTORE_STAGGER_MS = 40;
/** Saves are batched: a burst of changes becomes one write. */
export const SNAPSHOT_DEBOUNCE_MS = 300;

export type PersistedTerminalSession = {
  name: string;
  groupId: string;
  shell: string;
  /** Folder the terminal was started in. Null means the workspace root at that time. */
  workingDirectory: string | null;
  active: boolean;
};
export type PersistedTerminalSessions = { workspaces: Record<string, PersistedTerminalSession[]> };

/** The parts of a live terminal that a snapshot needs. */
export type LiveTerminal = { id: string; name: string; shell: string; workingDirectory: string | null; exited: boolean };
/** The parts of a terminal group that a snapshot needs. */
export type SnapshotGroup = { id: string; terminalIds: readonly string[]; activeTerminalId: string | null };

export type PlannedRestore = PersistedTerminalSession;

type Storage = Pick<globalThis.Storage, "getItem"> & Partial<Pick<globalThis.Storage, "setItem">>;

export function readTerminalSessions(storage: Storage = localStorage): PersistedTerminalSessions {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TERMINAL_SESSIONS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { workspaces: {} };
    const rows = (parsed as { workspaces?: unknown }).workspaces;
    if (!rows || typeof rows !== "object") return { workspaces: {} };
    const workspaces: Record<string, PersistedTerminalSession[]> = {};
    for (const [workspaceId, list] of Object.entries(rows as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      workspaces[workspaceId] = list.filter(isSession);
    }
    return { workspaces };
  } catch {
    return { workspaces: {} };
  }
}

export function writeTerminalSessions(value: PersistedTerminalSessions, storage: Storage = localStorage): boolean {
  try {
    storage.setItem?.(TERMINAL_SESSIONS_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Saved terminals of one workspace, in group and terminal order. Exited and unknown terminals are skipped. */
export function snapshotWorkspaceSessions(groups: readonly SnapshotGroup[], terminals: readonly LiveTerminal[]): PersistedTerminalSession[] {
  const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  const sessions: PersistedTerminalSession[] = [];
  for (const group of groups) {
    for (const id of group.terminalIds) {
      const terminal = byId.get(id);
      if (!terminal || terminal.exited) continue;
      sessions.push({
        name: terminal.name,
        groupId: group.id,
        shell: terminal.shell,
        workingDirectory: terminal.workingDirectory,
        active: group.activeTerminalId === id,
      });
    }
  }
  return sessions;
}

/** Sessions to start, in saved order. A session whose group no longer exists goes to the active group. */
export function planRestore(saved: readonly PersistedTerminalSession[], groupIds: readonly string[], activeGroupId: string): PlannedRestore[] {
  return saved.map((session) => ({ ...session, groupId: groupIds.includes(session.groupId) ? session.groupId : activeGroupId }));
}

/** The lowest "Terminal N" that no name in use takes, compared without case. */
export function nextTerminalName(taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  let ordinal = 1;
  while (used.has(`terminal ${ordinal}`)) ordinal += 1;
  return `Terminal ${ordinal}`;
}

function isSession(value: unknown): value is PersistedTerminalSession {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.groupId === "string" && typeof record.shell === "string"
    && (typeof record.workingDirectory === "string" || record.workingDirectory === null) && typeof record.active === "boolean";
}
