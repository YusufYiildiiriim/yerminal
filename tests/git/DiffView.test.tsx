import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView } from "../../src/features/git/DiffView";

afterEach(cleanup);

const diff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1234567..abcdef0 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -4,2 +4,3 @@ function run()",
  " keep",
  "-old value",
  "+new value",
  "+second added value",
].join("\n");

describe("DiffView", () => {
  it("preserves diff metadata and renders numbered additions and removals", () => {
    render(<DiffView diff={diff} path="src/app.ts" root="C:/work/repo" staged={false} />);

    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByText("Working Tree")).toBeInTheDocument();
    const details = screen.getByText("Diff details").closest("details");
    expect(details).not.toHaveAttribute("open");
    const rawHeaders = details?.querySelector("pre");
    expect(rawHeaders).toHaveTextContent("diff --git a/src/app.ts b/src/app.ts");
    expect(rawHeaders).not.toBeVisible();
    fireEvent.click(screen.getByText("Diff details"));
    expect(rawHeaders).toHaveTextContent("index 1234567..abcdef0 100644");
    expect(rawHeaders).toBeVisible();
    expect(screen.getByText("@@ -4,2 +4,3 @@ function run()")).toBeInTheDocument();
    expect(screen.getByText("old value")).toBeInTheDocument();
    expect(screen.getByText("new value")).toBeInTheDocument();
    expect(screen.getByText("second added value")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Added line" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Removed line" })).toBeInTheDocument();
    expect(screen.getAllByText("5")).toHaveLength(2);
    expect(screen.getByText("6")).toBeInTheDocument();
  });

  it("shows the loading state without rendering stale diff rows", () => {
    render(<DiffView diff={diff} path="src/app.ts" root="C:/work/repo" staged loading />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading file changes");
    expect(screen.queryByText("new value")).not.toBeInTheDocument();
  });
});
