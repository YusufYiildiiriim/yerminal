import type { PointerMenuItem } from "../workspace/PointerMenu";

export type EditorTabMenuActionId = "close" | "close-others" | "close-all";

// Where the menu was opened: the right-clicked tab (null on the empty strip) and the group's tabs in order.
export type EditorTabMenuContext = { tabId: string | null; groupTabIds: readonly string[] };

// closeTabs goes through the same path as the tab's × button, so unsaved-change prompts apply to each tab.
export type EditorTabMenuServices = { closeTabs: (tabIds: readonly string[]) => Promise<void> };

export type EditorTabMenuAction = {
  id: EditorTabMenuActionId;
  label: string;
  isEnabled: (context: EditorTabMenuContext) => boolean;
  run: (context: EditorTabMenuContext, services: EditorTabMenuServices) => Promise<void>;
};

// Add an entry here to add a menu item (for example "Close to the Right" or "Copy Path"); the menu renders from this list.
export const EDITOR_TAB_MENU_ACTIONS: readonly EditorTabMenuAction[] = [
  {
    id: "close",
    label: "Close",
    isEnabled: ({ tabId }) => tabId !== null,
    run: ({ tabId }, { closeTabs }) => closeTabs(tabId === null ? [] : [tabId]),
  },
  {
    id: "close-others",
    label: "Close Others",
    isEnabled: ({ tabId, groupTabIds }) => tabId !== null && groupTabIds.length > 1,
    run: ({ tabId, groupTabIds }, { closeTabs }) => closeTabs(groupTabIds.filter((id) => id !== tabId)),
  },
  {
    id: "close-all",
    label: "Close All",
    isEnabled: ({ groupTabIds }) => groupTabIds.length > 0,
    run: ({ groupTabIds }, { closeTabs }) => closeTabs([...groupTabIds]),
  },
];

export function editorTabMenuItems(context: EditorTabMenuContext, services: EditorTabMenuServices): PointerMenuItem[] {
  return EDITOR_TAB_MENU_ACTIONS.map((action) => {
    const enabled = action.isEnabled(context);
    return {
      label: action.label,
      disabled: !enabled,
      onSelect: () => {
        if (enabled) void action.run(context, services);
      },
    };
  });
}
