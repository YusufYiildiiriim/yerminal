import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GroupHeaderAddButton, GroupRowAddButton } from "../../src/features/terminal/TerminalGroupAddButtons";

afterEach(() => {
  cleanup();
});

describe("terminal group add buttons", () => {
  it("the header button is the general add button and calls onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<GroupHeaderAddButton onClick={onClick} />);

    await user.click(screen.getByRole("button", { name: "Add terminal to group" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a group row button names its own group and calls onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<GroupRowAddButton groupName="Logs" onClick={onClick} />);

    await user.click(screen.getByRole("button", { name: "New terminal in Logs" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
