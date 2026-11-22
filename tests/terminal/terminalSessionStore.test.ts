import { describe, expect, it } from "vitest";

import {
  nextTerminalName,
  planRestore,
  readTerminalSessions,
  RESTORE_STAGGER_MS,
  SNAPSHOT_DEBOUNCE_MS,
  snapshotWorkspaceSessions,
  TERMINAL_SESSIONS_KEY,
  writeTerminalSessions,
  type LiveTerminal,
} from "../../src/features/terminal/terminalSessionStore";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: data,
  };
}

const live = (id: string, name: string, extra: Partial<LiveTerminal> = {}): LiveTerminal => ({
  id, name, shell: "powershell", workingDirectory: "C:\\repo", exited: false, ...extra,
});

describe("terminal session store: read and write", () => {
  it("uses its own key and round-trips the saved sessions", () => {
    const storage = memoryStorage();
    const value = { workspaces: { "workspace-1": [{ name: "api", groupId: "g1", shell: "powershell", workingDirectory: "C:\\repo\\api", active: true }] } };
    expect(writeTerminalSessions(value, storage)).toBe(true);
    expect(storage.raw.has(TERMINAL_SESSIONS_KEY)).toBe(true);
    expect(readTerminalSessions(storage)).toEqual(value);
  });

  it("returns an empty record for missing or malformed data", () => {
    expect(readTerminalSessions(memoryStorage())).toEqual({ workspaces: {} });
    expect(readTerminalSessions(memoryStorage({ [TERMINAL_SESSIONS_KEY]: "{broken" }))).toEqual({ workspaces: {} });
  });

  it("drops entries that are not sessions and keeps the valid ones", () => {
    const storage = memoryStorage({
      [TERMINAL_SESSIONS_KEY]: JSON.stringify({ workspaces: { w: [{ name: "ok", groupId: "g", shell: "bash", workingDirectory: null, active: false }, { name: 3 }, null] } }),
    });
    expect(readTerminalSessions(storage).workspaces.w).toEqual([{ name: "ok", groupId: "g", shell: "bash", workingDirectory: null, active: false }]);
  });

  it("reports a failed write instead of throwing", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(writeTerminalSessions({ workspaces: {} }, storage)).toBe(false);
  });
});

describe("terminal session store: snapshot", () => {
  it("saves the open terminals of each group in group and terminal order, with names and the active one", () => {
    const groups = [
      { id: "g1", terminalIds: ["a", "b"], activeTerminalId: "b" },
      { id: "g2", terminalIds: ["c"], activeTerminalId: "c" },
    ];
    const terminals = [live("a", "api"), live("b", "logs"), live("c", "Terminal 3", { workingDirectory: "C:\\repo\\web" })];
    expect(snapshotWorkspaceSessions(groups, terminals)).toEqual([
      { name: "api", groupId: "g1", shell: "powershell", workingDirectory: "C:\\repo", active: false },
      { name: "logs", groupId: "g1", shell: "powershell", workingDirectory: "C:\\repo", active: true },
      { name: "Terminal 3", groupId: "g2", shell: "powershell", workingDirectory: "C:\\repo\\web", active: true },
    ]);
  });

  it("leaves out exited terminals and ids that no longer exist", () => {
    const groups = [{ id: "g1", terminalIds: ["a", "gone", "dead"], activeTerminalId: null }];
    const terminals = [live("a", "api"), live("dead", "old", { exited: true })];
    expect(snapshotWorkspaceSessions(groups, terminals).map((session) => session.name)).toEqual(["api"]);
  });
});

describe("terminal session store: restore plan", () => {
  it("keeps the saved order and group, and sends a session with an unknown group to the active group", () => {
    const plan = planRestore([
      { name: "api", groupId: "g1", shell: "powershell", workingDirectory: "C:\\repo\\api", active: false },
      { name: "lost", groupId: "deleted", shell: "bash", workingDirectory: null, active: true },
    ], ["g1", "g2"], "g2");
    expect(plan.map((item) => [item.name, item.groupId, item.active])).toEqual([["api", "g1", false], ["lost", "g2", true]]);
  });

  it("uses small, fixed stagger so twelve terminals start without freezing the UI", () => {
    expect(RESTORE_STAGGER_MS).toBeGreaterThan(0);
    expect(RESTORE_STAGGER_MS).toBeLessThanOrEqual(100);
    expect(SNAPSHOT_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});

describe("terminal session store: names", () => {
  it("numbers new terminals from the first free slot, so restored names do not shift it", () => {
    expect(nextTerminalName([])).toBe("Terminal 1");
    expect(nextTerminalName(["Terminal 1", "api", "Terminal 3"])).toBe("Terminal 2");
    expect(nextTerminalName(["terminal 1", "Terminal 2"])).toBe("Terminal 3");
  });
});

describe("terminal session store: numbering keeps the group-size start", () => {
  it("starts from the given ordinal and skips names that are taken", () => {
    expect(nextTerminalName(["powershell"], 2)).toBe("Terminal 2");
    expect(nextTerminalName(["Terminal 2", "api"], 2)).toBe("Terminal 3");
  });
});
