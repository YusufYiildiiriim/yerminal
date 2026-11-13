import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const complexDiff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1234567..abcdef0 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -2,8 +2,9 @@ first hunk context",
  " same line",
  "-const oldA = 1;",
  "-const oldB = 2;",
  "+const newA = 10;",
  "+const newB = 20;",
  "+const newC = 30;",
  " tail line",
  "@@ -30,3 +31,2 @@ second hunk context",
  " before second change",
  "-removed only",
  " after second change",
  "@@ -50,2 +51,2 @@ third hunk context",
  "-old final",
  "\\ No newline at end of file",
  "+new final",
  "\\ No newline at end of file",
  "@@ -60 +61 @@ header-shaped code",
  "--- old final header",
  "+++ new final header",
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
    expect(document.querySelectorAll(".diff-view-cell.added")).toHaveLength(2);
    expect(document.querySelector(".diff-view-cell.removed")).toBeInTheDocument();
  });

  it("aligns paired changes across multiple hunks and leaves unmatched sides empty", () => {
    render(<DiffView diff={complexDiff} path="src/app.ts" root="C:/work/repo" staged />);

    const rows = screen.getAllByRole("row");
    const paired = rows.find((row) => within(row).queryByText("const oldA = 1;"));
    expect(paired).toBeDefined();
    expect(within(paired!).getByText("const newA = 10;")).toBeInTheDocument();
    expect(within(paired!).getByText("const oldA = 1;")).toBeInTheDocument();
    expect(rows.filter((row) => row.classList.contains("hunk"))).toHaveLength(4);

    const oldBRow = rows.find((row) => within(row).queryByText("const oldB = 2;"));
    expect(oldBRow).toHaveClass("has-removed");
    expect(within(oldBRow!).getByText("const newB = 20;")).toBeInTheDocument();
    const extraAddedRow = rows.find((row) => within(row).queryByText("const newC = 30;"));
    expect(extraAddedRow).toHaveClass("added-only");
    expect(within(extraAddedRow!).getByLabelText("No previous line")).toBeInTheDocument();
    const removedOnlyRow = rows.find((row) => within(row).queryByText("removed only"));
    expect(removedOnlyRow).toHaveClass("removed-only");
    expect(within(removedOnlyRow!).getByLabelText("No current line")).toBeInTheDocument();
    const noNewlineRow = rows.find((row) => within(row).queryByText("old final"));
    expect(noNewlineRow).toBeDefined();
    expect(within(noNewlineRow!).getByText("new final")).toBeInTheDocument();
    const noNewlineNotes = within(noNewlineRow!).getAllByText("\\ No newline at end of file");
    expect(noNewlineNotes).toHaveLength(2);
    expect(noNewlineNotes[0].closest(".diff-view-cell")).toHaveClass("removed");
    expect(noNewlineNotes[1].closest(".diff-view-cell")).toHaveClass("added");
    const headerShapedChange = rows.find((row) => within(row).queryByText("-- old final header"));
    expect(headerShapedChange).toBeDefined();
    expect(within(headerShapedChange!).getByText("++ new final header")).toBeInTheDocument();
  });

  it("shows the loading state without rendering stale diff rows", () => {
    render(<DiffView diff={diff} path="src/app.ts" root="C:/work/repo" staged loading />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading file changes");
    expect(screen.queryByText("new value")).not.toBeInTheDocument();
  });

  it("keeps an added file as right-only content and preserves binary metadata", () => {
    render(<DiffView diff={["diff --git a/data.bin b/data.bin", "new file mode 100644", "Binary files /dev/null and b/data.bin differ"].join("\n")} path="data.bin" root="repo" staged />);

    expect(screen.getByText("Binary files /dev/null and b/data.bin differ")).toBeInTheDocument();
    expect(screen.getByText("new file mode 100644")).toBeInTheDocument();
    expect(screen.queryByText("No diff available.")).not.toBeInTheDocument();
  });

  it("shows added and deleted file content on their existing side", () => {
    const added = ["diff --git a/new.ts b/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1,2 @@", "+first", "+second"].join("\n");
    const deleted = ["diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-first", "-second"].join("\n");

    const { rerender } = render(<DiffView diff={added} path="new.ts" root="repo" staged />);
    expect(screen.getByText("first").closest("[role=row]")).toHaveClass("added-only");
    expect(screen.getByText("second").closest("[role=row]")).toHaveClass("added-only");
    rerender(<DiffView diff={deleted} path="gone.ts" root="repo" staged={false} />);
    expect(screen.getByText("first").closest("[role=row]")).toHaveClass("removed-only");
    expect(screen.getByText("second").closest("[role=row]")).toHaveClass("removed-only");
  });

  it("shows the empty state for a diff with no changes", () => {
    render(<DiffView diff="" path="empty.ts" root="repo" staged={false} />);
    expect(screen.getByText("No diff available.")).toBeInTheDocument();
  });
});
