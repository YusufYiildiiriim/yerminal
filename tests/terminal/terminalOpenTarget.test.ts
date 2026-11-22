import { describe, expect, it } from "vitest";

import {
  applyTerminalGroupChoice,
  folderChoices,
  readRecentTerminalFolders,
  rememberTerminalFolder,
  RECENT_TERMINAL_FOLDER_LIMIT,
  RECENT_TERMINAL_FOLDERS_KEY,
  resolveTerminalOpenDefaults,
  normalizeTerminalName,
  TERMINAL_NAME_MAX_LENGTH,
} from "../../src/features/terminal/terminalOpenTarget";
import { createInitialTerminalGroups, createTerminalGroup } from "../../src/features/terminal/terminalWorkspaceActions";

const groups = [
  { id: "g-default", name: "Terminal 1" },
  { id: "g-api", name: "API" },
];

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: data,
  };
}

describe("resolveTerminalOpenDefaults", () => {
  it("keeps the current behaviour when both defaults are empty: no folder override, no group change", () => {
    expect(resolveTerminalOpenDefaults({ terminalDefaultPath: "", terminalDefaultGroup: "" }, groups)).toEqual({ folder: null, group: null });
    expect(resolveTerminalOpenDefaults({}, groups)).toEqual({ folder: null, group: null });
  });

  it("uses the default path when one is set", () => {
    expect(resolveTerminalOpenDefaults({ terminalDefaultPath: "  C:\\work\\api  ", terminalDefaultGroup: "" }, groups).folder).toBe("C:\\work\\api");
  });

  it("selects an existing group by name, ignoring case and surrounding spaces", () => {
    expect(resolveTerminalOpenDefaults({ terminalDefaultGroup: " api " }, groups).group).toEqual({ kind: "existing", id: "g-api" });
  });

  it("asks for a new group with that name when no group matches the default", () => {
    expect(resolveTerminalOpenDefaults({ terminalDefaultGroup: "Logs" }, groups).group).toEqual({ kind: "new", name: "Logs" });
  });
});

describe("folderChoices", () => {
  it("lists the workspace root first, then workspace folders and recent folders without duplicates", () => {
    expect(folderChoices("C:\\repo", ["C:\\repo", "C:\\other"], ["C:\\other", "", "C:\\recent"]))
      .toEqual(["C:\\repo", "C:\\other", "C:\\recent"]);
  });
});

describe("recent terminal folders", () => {
  it("moves a reopened folder to the front and keeps at most the limit", () => {
    const storage = memoryStorage();
    for (let index = 0; index < RECENT_TERMINAL_FOLDER_LIMIT + 2; index += 1) rememberTerminalFolder(`C:\\f${index}`, storage);
    rememberTerminalFolder("C:\\f3", storage);
    const list = readRecentTerminalFolders(storage);
    expect(list[0]).toBe("C:\\f3");
    expect(list).toHaveLength(RECENT_TERMINAL_FOLDER_LIMIT);
    expect(new Set(list).size).toBe(list.length);
  });

  it("persists under its own key and ignores malformed stored values", () => {
    const storage = memoryStorage({ [RECENT_TERMINAL_FOLDERS_KEY]: "{not json" });
    expect(readRecentTerminalFolders(storage)).toEqual([]);
    rememberTerminalFolder("C:\\repo", storage);
    expect(JSON.parse(storage.raw.get(RECENT_TERMINAL_FOLDERS_KEY) ?? "[]")).toEqual(["C:\\repo"]);
  });
});

describe("applyTerminalGroupChoice", () => {
  it("selects an existing group", () => {
    const state = createInitialTerminalGroups();
    const withTwo = createTerminalGroup(state);
    const next = applyTerminalGroupChoice(withTwo, { kind: "existing", id: state.groups[0].id });
    expect(next.activeGroupId).toBe(state.groups[0].id);
  });

  it("creates a new group with the chosen name and makes it active", () => {
    const next = applyTerminalGroupChoice(createInitialTerminalGroups(), { kind: "new", name: "Logs" });
    const created = next.groups.find((group) => group.name === "Logs");
    expect(created).toBeDefined();
    expect(next.activeGroupId).toBe(created?.id);
    expect(next.groups).toHaveLength(2);
  });

  it("selects the existing group when the new name is already taken", () => {
    const state = createInitialTerminalGroups();
    const next = applyTerminalGroupChoice(state, { kind: "new", name: "terminal 1" });
    expect(next.groups).toHaveLength(1);
    expect(next.activeGroupId).toBe(state.groups[0].id);
  });
});

describe("normalizeTerminalName (#45)", () => {
  it("trims the name and leaves a blank or whitespace-only name to the automatic one", () => {
    expect(normalizeTerminalName("  API  ")).toBe("API");
    expect(normalizeTerminalName("")).toBeUndefined();
    expect(normalizeTerminalName("   \t ")).toBeUndefined();
    expect(normalizeTerminalName(undefined)).toBeUndefined();
  });

  it("caps the name at the shared length limit", () => {
    expect(TERMINAL_NAME_MAX_LENGTH).toBe(40);
    expect(normalizeTerminalName("x".repeat(60))).toBe("x".repeat(40));
    expect(normalizeTerminalName(`  ${"y".repeat(39)}z  `)?.length).toBe(40);
  });
});
