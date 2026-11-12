export type TerminalLayoutNode =
  | { type: "terminal"; sessionId: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; ratio: number; children: [TerminalLayoutNode, TerminalLayoutNode] };

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
