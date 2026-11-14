import type { UserEvent } from "@testing-library/user-event";
import { screen } from "@testing-library/react";

type Scope = { getByRole: typeof screen.getByRole };

// Opens the workspace "..." menu and picks one of its items.
export async function chooseWorkspaceAction(user: UserEvent, scope: Scope, item: string) {
  await user.click(scope.getByRole("button", { name: "Workspace actions" }));
  await user.click(scope.getByRole("menuitem", { name: item }));
}

// Opens a terminal group's "..." menu and picks one of its items.
export async function chooseGroupAction(user: UserEvent, scope: Scope, groupName: string, item: string) {
  await user.click(scope.getByRole("button", { name: `Group actions for ${groupName}` }));
  await user.click(scope.getByRole("menuitem", { name: item }));
}
