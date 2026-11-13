export type TerminalLayoutNode =
  | { type: "terminal"; sessionId: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; children: [TerminalLayoutNode, TerminalLayoutNode] };

export type TerminalGroup = {
  id: string;
  name: string;
  terminalIds: string[];
  activeTerminalId: string | null;
  layout: TerminalLayoutNode | null;
};

export type TerminalGroups = { groups: TerminalGroup[]; activeGroupId: string };

export function createInitialTerminalGroups(): TerminalGroups {
  const group: TerminalGroup = { id: "terminal-group-default", name: "Terminal 1", terminalIds: [], activeTerminalId: null, layout: null };
  return { groups: [group], activeGroupId: group.id };
}

export function createTerminalGroup(state: TerminalGroups): TerminalGroups {
  let ordinal = state.groups.length + 1;
  while (state.groups.some((group) => group.name === `Terminal ${ordinal}`)) ordinal += 1;
  const group: TerminalGroup = { id: `terminal-group-${crypto.randomUUID()}`, name: `Terminal ${ordinal}`, terminalIds: [], activeTerminalId: null, layout: null };
  return { groups: [...state.groups, group], activeGroupId: group.id };
}

export function selectTerminalGroup(state: TerminalGroups, groupId: string): TerminalGroups {
  return state.groups.some((group) => group.id === groupId) ? { ...state, activeGroupId: groupId } : state;
}

export function closeTerminalGroup(state: TerminalGroups, groupId: string): TerminalGroups {
  if (state.groups.length <= 1) return state;
  const closingIndex = state.groups.findIndex((group) => group.id === groupId);
  if (closingIndex < 0) return state;
  const destinationIndex = closingIndex > 0 ? closingIndex - 1 : 1;
  const closing = state.groups[closingIndex];
  const destination = state.groups[destinationIndex];
  const incomingIds = closing.terminalIds.filter((id) => !destination.terminalIds.includes(id));
  const terminalIds = [...destination.terminalIds, ...incomingIds];
  const layout = mergeLayouts(layoutForGroup(destination), incomingLayout(closing, incomingIds));
  const groups = state.groups.filter((group) => group.id !== groupId).map((group) => group.id === destination.id
    ? { ...group, terminalIds, activeTerminalId: closing.activeTerminalId ?? group.activeTerminalId ?? terminalIds[0] ?? null, layout }
    : group);
  return { groups, activeGroupId: state.activeGroupId === groupId ? destination.id : state.activeGroupId };
}

export function moveTerminalBetweenGroups(state: TerminalGroups, sessionId: string, targetGroupId: string): TerminalGroups {
  const source = state.groups.find((group) => group.terminalIds.includes(sessionId));
  const target = state.groups.find((group) => group.id === targetGroupId);
  if (!source || !target || source.id === target.id) return state;
  const nextGroups = state.groups.map((group) => {
    if (group.id === source.id) {
      const terminalIds = group.terminalIds.filter((id) => id !== sessionId);
      return { ...group, terminalIds, activeTerminalId: group.activeTerminalId === sessionId ? terminalIds[0] ?? null : group.activeTerminalId, layout: removeTerminal(group.layout, sessionId) };
    }
    if (group.id === target.id) {
      const terminalIds = [...group.terminalIds, sessionId];
      return { ...group, terminalIds, activeTerminalId: sessionId, layout: appendTerminalToLayout(layoutForGroup(group), sessionId) };
    }
    return group;
  });
  return { groups: nextGroups, activeGroupId: targetGroupId };
}

export function removeTerminalFromGroups(state: TerminalGroups, sessionId: string): TerminalGroups {
  const groups = state.groups.map((group) => {
    if (!group.terminalIds.includes(sessionId)) return group;
    const terminalIds = group.terminalIds.filter((id) => id !== sessionId);
    return { ...group, terminalIds, activeTerminalId: group.activeTerminalId === sessionId ? terminalIds[0] ?? null : group.activeTerminalId, layout: removeTerminal(group.layout, sessionId) };
  });
  return { ...state, groups };
}

/** A null layout means "derive it from terminalIds", so build that layout before changing it. */
function layoutForGroup(group: TerminalGroup): TerminalLayoutNode | null {
  return group.layout ?? buildEvenTerminalLayout(group.terminalIds);
}

/** Builds a horizontal chain in which every session gets an equal share of the width. */
export function buildEvenTerminalLayout(sessionIds: string[]): TerminalLayoutNode | null {
  const [first, ...rest] = sessionIds;
  if (first === undefined) return null;
  const terminal: TerminalLayoutNode = { type: "terminal", sessionId: first };
  const remainder = buildEvenTerminalLayout(rest);
  if (!remainder) return terminal;
  return { type: "split", id: crypto.randomUUID(), direction: "horizontal", ratio: 1 / sessionIds.length, children: [terminal, remainder] };
}

function layoutLeafCount(node: TerminalLayoutNode): number {
  return node.type === "terminal" ? 1 : layoutLeafCount(node.children[0]) + layoutLeafCount(node.children[1]);
}

function layoutLeafIds(node: TerminalLayoutNode | null): string[] {
  if (!node) return [];
  return node.type === "terminal" ? [node.sessionId] : [...layoutLeafIds(node.children[0]), ...layoutLeafIds(node.children[1])];
}

/** Reuses the closing group's own layout when it holds exactly the incoming sessions. */
function incomingLayout(group: TerminalGroup, incomingIds: string[]): TerminalLayoutNode | null {
  const existing = layoutLeafIds(group.layout);
  const sameSessions = existing.length === incomingIds.length && incomingIds.every((id) => existing.includes(id));
  return sameSessions ? group.layout : buildEvenTerminalLayout(incomingIds);
}

/** Places two layouts side by side, sizing each side by how many terminals it holds. */
function mergeLayouts(first: TerminalLayoutNode | null, second: TerminalLayoutNode | null): TerminalLayoutNode | null {
  if (!first) return second;
  if (!second) return first;
  const firstCount = layoutLeafCount(first);
  const ratio = firstCount / (firstCount + layoutLeafCount(second));
  return { type: "split", id: crypto.randomUUID(), direction: "horizontal", ratio, children: [first, second] };
}

function removeTerminal(layout: TerminalLayoutNode | null, sessionId: string): TerminalLayoutNode | null {
  if (!layout) return null;
  if (layout.type === "terminal") return layout.sessionId === sessionId ? null : layout;
  const first = removeTerminal(layout.children[0], sessionId);
  const second = removeTerminal(layout.children[1], sessionId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, children: [first, second] };
}

type OpenFolderInNewTerminalOptions<T extends { id: string }> = {
  isDesktop: boolean;
  folderPath: string;
  createTerminalAt: (workingDirectory: string) => Promise<T | null>;
  activateTerminal: (terminalId: string) => void;
  onDesktopRequired: () => void;
};

export async function openFolderInNewTerminal<T extends { id: string }>({
  isDesktop,
  folderPath,
  createTerminalAt,
  activateTerminal,
  onDesktopRequired,
}: OpenFolderInNewTerminalOptions<T>): Promise<T | null> {
  if (!isDesktop) {
    onDesktopRequired();
    return null;
  }

  const terminal = await createTerminalAt(folderPath);
  if (terminal) activateTerminal(terminal.id);
  return terminal;
}

export function appendTerminalToLayout(layout: TerminalLayoutNode | null, sessionId: string): TerminalLayoutNode {
  const terminal: TerminalLayoutNode = { type: "terminal", sessionId };
  if (!layout) return terminal;
  return {
    type: "split",
    id: crypto.randomUUID(),
    direction: "horizontal",
    ratio: 0.5,
    children: [layout, terminal],
  };
}
