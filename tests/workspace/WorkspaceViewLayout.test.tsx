import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceViewLayout } from "../../src/features/workspace/WorkspaceViewLayout";

describe("WorkspaceViewLayout", () => {
  afterEach(cleanup);
  it("hides the inactive surface while retaining both views in the layout", () => {
    const { rerender } = render(
      <WorkspaceViewLayout activeView="code" code={<button>Save file</button>} terminal={<button>Run command</button>} />,
    );

    expect(screen.getByText("Save file").parentElement).not.toHaveAttribute("hidden");
    expect(screen.getByText("Run command").parentElement).toHaveAttribute("hidden");

    rerender(<WorkspaceViewLayout activeView="terminals" code={<button>Save file</button>} terminal={<button>Run command</button>} />);

    expect(screen.getByText("Save file").parentElement).toHaveAttribute("hidden");
    expect(screen.getByText("Run command").parentElement).not.toHaveAttribute("hidden");
  });
});
