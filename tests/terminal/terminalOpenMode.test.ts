import { describe, expect, it } from "vitest";

import { terminalOpenAsk } from "../../src/features/terminal/terminalOpenTarget";

describe("terminalOpenAsk", () => {
  it("pickGroupAndFolder asks the group and the folder (general Terminal groups add button)", () => {
    expect(terminalOpenAsk("pickGroupAndFolder")).toEqual({ folder: true, group: true });
  });

  it("folderOnly asks only the folder (a group row's add button, the group is already known)", () => {
    expect(terminalOpenAsk("folderOnly")).toEqual({ folder: true, group: false });
  });
});
