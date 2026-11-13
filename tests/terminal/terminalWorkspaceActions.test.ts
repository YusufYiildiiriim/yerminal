import { describe, expect, it, vi } from "vitest";
import { appendTerminalToLayout, closeTerminalGroup, createInitialTerminalGroups, createTerminalGroup, moveTerminalBetweenGroups, openFolderInNewTerminal, removeTerminalFromGroups, selectTerminalGroup, type TerminalLayoutNode } from "../../src/features/terminal/terminalWorkspaceActions";

describe("terminal groups", () => {
  it("creates and selects groups without crossing workspace state", () => {
    const workspaceA = createTerminalGroup(createInitialTerminalGroups());
    const workspaceB = createInitialTerminalGroups();
    expect(workspaceA.groups).toHaveLength(2);
    expect(workspaceA.activeGroupId).toBe(workspaceA.groups[1].id);
    expect(selectTerminalGroup(workspaceA, workspaceA.groups[0].id).activeGroupId).toBe(workspaceA.groups[0].id);
    expect(workspaceB.groups).toHaveLength(1);
    expect(workspaceB.activeGroupId).toBe(workspaceB.groups[0].id);
  });

  it("moves a live session between groups while preserving its session id and the other layouts", () => {
    const initial = createInitialTerminalGroups();
    const destination = createTerminalGroup(initial);
    const sourceId = initial.activeGroupId;
    const firstGroup = { ...destination.groups[0], terminalIds: ["one", "two"], activeTerminalId: "one", layout: appendTerminalToLayout(appendTerminalToLayout(null, "one"), "two") };
    const otherGroup = destination.groups[1];
    const state = { ...destination, groups: [firstGroup, otherGroup], activeGroupId: sourceId };

    const moved = moveTerminalBetweenGroups(state, "one", otherGroup.id);

    expect(moved.activeGroupId).toBe(otherGroup.id);
    expect(moved.groups[0].terminalIds).toEqual(["two"]);
    expect(moved.groups[0].activeTerminalId).toBe("two");
    expect(moved.groups[1].terminalIds).toEqual(["one"]);
    expect(moved.groups[1].activeTerminalId).toBe("one");
    expect(moved.groups[1].layout).toEqual({ type: "terminal", sessionId: "one" });
    expect(moveTerminalBetweenGroups(moved, "one", otherGroup.id)).toBe(moved);
  });

  it("closes a session from its group without closing or moving neighboring sessions", () => {
    const initial = createInitialTerminalGroups();
    const state = { ...initial, groups: [{ ...initial.groups[0], terminalIds: ["one", "two"], activeTerminalId: "one", layout: appendTerminalToLayout(appendTerminalToLayout(null, "one"), "two") }] };
    const closed = removeTerminalFromGroups(state, "one");
    expect(closed.groups[0].terminalIds).toEqual(["two"]);
    expect(closed.groups[0].activeTerminalId).toBe("two");
    expect(closed.groups[0].layout).toEqual({ type: "terminal", sessionId: "two" });
  });

  it("closes a group by moving its sessions into a neighbor without discarding their IDs", () => {
    const initial = createInitialTerminalGroups();
    const withSecond = createTerminalGroup(initial);
    const groups = [
      { ...withSecond.groups[0], terminalIds: ["one"], activeTerminalId: "one", layout: { type: "terminal" as const, sessionId: "one" } },
      { ...withSecond.groups[1], terminalIds: ["two"], activeTerminalId: "two", layout: { type: "terminal" as const, sessionId: "two" } },
    ];
    const closed = closeTerminalGroup({ groups, activeGroupId: groups[0].id }, groups[0].id);
    expect(closed.groups).toHaveLength(1);
    expect(closed.activeGroupId).toBe(groups[1].id);
    expect(closed.groups[0].terminalIds).toEqual(["two", "one"]);
    expect(closed.groups[0].layout).toEqual(expect.objectContaining({ type: "split" }));
    expect(closeTerminalGroup(closed, groups[1].id)).toBe(closed);
  });
});

describe("openFolderInNewTerminal", () => {
  it("creates a distinct terminal at the selected folder and activates it", async () => {
    const createTerminalAt = vi.fn(async (workingDirectory: string) => ({ id: "new-terminal", workingDirectory }));
    const activateTerminal = vi.fn();
    const onDesktopRequired = vi.fn();

    const result = await openFolderInNewTerminal({
      isDesktop: true,
      folderPath: "C:\\work\\repo\\src",
      createTerminalAt,
      activateTerminal,
      onDesktopRequired,
    });

    expect(createTerminalAt).toHaveBeenCalledOnce();
    expect(createTerminalAt).toHaveBeenCalledWith("C:\\work\\repo\\src");
    expect(result).toEqual({ id: "new-terminal", workingDirectory: "C:\\work\\repo\\src" });
    expect(activateTerminal).toHaveBeenCalledWith("new-terminal");
    expect(onDesktopRequired).not.toHaveBeenCalled();
  });

  it("does not create or activate a terminal outside Tauri", async () => {
    const createTerminalAt = vi.fn();
    const activateTerminal = vi.fn();
    const onDesktopRequired = vi.fn();

    await expect(openFolderInNewTerminal({
      isDesktop: false,
      folderPath: "/work/repo/src",
      createTerminalAt,
      activateTerminal,
      onDesktopRequired,
    })).resolves.toBeNull();

    expect(createTerminalAt).not.toHaveBeenCalled();
    expect(activateTerminal).not.toHaveBeenCalled();
    expect(onDesktopRequired).toHaveBeenCalledOnce();
  });

  it("keeps the current layout intact and adds the new terminal beside it", () => {
    const current: TerminalLayoutNode = {
      type: "split",
      id: "custom-root",
      direction: "vertical",
      ratio: 0.63,
      children: [
        { type: "terminal", sessionId: "first" },
        { type: "split", id: "custom-inner", direction: "horizontal", ratio: 0.4, children: [
          { type: "terminal", sessionId: "second" },
          { type: "terminal", sessionId: "third" },
        ] },
      ],
    };

    const result = appendTerminalToLayout(current, "fourth");

    expect(result).toEqual({
      type: "split",
      id: expect.any(String),
      direction: "horizontal",
      ratio: 0.5,
      children: [current, { type: "terminal", sessionId: "fourth" }],
    });
    expect(result.type === "split" && result.children[0]).toBe(current);
  });

  it("starts a layout when the workspace has no visible terminal yet", () => {
    expect(appendTerminalToLayout(null, "first")).toEqual({ type: "terminal", sessionId: "first" });
  });
});

function layoutSessionIds(node: TerminalLayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === "terminal") return [node.sessionId];
  return [...layoutSessionIds(node.children[0]), ...layoutSessionIds(node.children[1])];
}

describe("null layouts", () => {
  it("keeps existing terminals when moving a session into a group whose layout is not built yet", () => {
    const withSecond = createTerminalGroup(createInitialTerminalGroups());
    const groups = [
      { ...withSecond.groups[0], terminalIds: ["a", "b"], activeTerminalId: "a", layout: null },
      { ...withSecond.groups[1], terminalIds: ["c"], activeTerminalId: "c", layout: { type: "terminal" as const, sessionId: "c" } },
    ];
    const moved = moveTerminalBetweenGroups({ groups, activeGroupId: groups[1].id }, "c", groups[0].id);
    expect(moved.groups[0].terminalIds).toEqual(["a", "b", "c"]);
    expect(layoutSessionIds(moved.groups[0].layout)).toEqual(["a", "b", "c"]);
  });

  it("keeps every terminal when closing a group into a neighbour whose layout is not built yet", () => {
    const withSecond = createTerminalGroup(createInitialTerminalGroups());
    const groups = [
      { ...withSecond.groups[0], terminalIds: ["a", "b"], activeTerminalId: "a", layout: null },
      { ...withSecond.groups[1], terminalIds: ["c"], activeTerminalId: "c", layout: { type: "terminal" as const, sessionId: "c" } },
    ];
    const closed = closeTerminalGroup({ groups, activeGroupId: groups[1].id }, groups[1].id);
    expect(closed.groups[0].terminalIds).toEqual(["a", "b", "c"]);
    expect(layoutSessionIds(closed.groups[0].layout)).toEqual(["a", "b", "c"]);
  });
});

function areaShares(node: TerminalLayoutNode | null, share = 1, shares: Record<string, number> = {}): Record<string, number> {
  if (!node) return shares;
  if (node.type === "terminal") {
    shares[node.sessionId] = share;
    return shares;
  }
  areaShares(node.children[0], share * node.ratio, shares);
  areaShares(node.children[1], share * (1 - node.ratio), shares);
  return shares;
}

describe("merging groups", () => {
  it("gives every terminal an even share when a group is closed into its neighbour", () => {
    const withSecond = createTerminalGroup(createInitialTerminalGroups());
    const groups = [
      { ...withSecond.groups[0], terminalIds: ["a"], activeTerminalId: "a", layout: { type: "terminal" as const, sessionId: "a" } },
      { ...withSecond.groups[1], terminalIds: ["b", "c", "d"], activeTerminalId: "b", layout: null },
    ];
    const closed = closeTerminalGroup({ groups, activeGroupId: groups[0].id }, groups[1].id);
    const shares = areaShares(closed.groups[0].layout);
    expect(Object.keys(shares).sort()).toEqual(["a", "b", "c", "d"]);
    for (const share of Object.values(shares)) expect(share).toBeGreaterThanOrEqual(1 / 4 - 1e-9);
  });
});

describe("closing the first group", () => {
  it("merges into the next group and keeps a different active group", () => {
    let state = createTerminalGroup(createTerminalGroup(createInitialTerminalGroups()));
    state = {
      ...state,
      groups: [
        { ...state.groups[0], terminalIds: ["a"], activeTerminalId: "a", layout: { type: "terminal", sessionId: "a" } },
        { ...state.groups[1], terminalIds: ["b"], activeTerminalId: "b", layout: { type: "terminal", sessionId: "b" } },
        { ...state.groups[2], terminalIds: ["c"], activeTerminalId: "c", layout: { type: "terminal", sessionId: "c" } },
      ],
      activeGroupId: state.groups[2].id,
    };
    const [first, second, third] = state.groups;
    const closed = closeTerminalGroup(state, first.id);
    expect(closed.groups.map((group) => group.id)).toEqual([second.id, third.id]);
    expect(closed.groups[0].terminalIds).toEqual(["b", "a"]);
    expect(closed.groups[1]).toBe(third);
    expect(closed.activeGroupId).toBe(third.id);
  });
});
