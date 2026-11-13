import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommitSnapshotBanner } from "../../src/features/editor/CommitSnapshotBanner";

afterEach(cleanup);

describe("CommitSnapshotBanner", () => {
  it("falls back to the modified label for an unknown change kind and to a default title for a blank message", () => {
    render(<CommitSnapshotBanner snapshot={{ shortId: "abc1234", message: "   ", changeKind: "unmerged" }} filePath="src/app.ts" />);

    expect(screen.getByRole("complementary", { name: "Historical source from commit abc1234" })).toBeInTheDocument();
    expect(screen.getByText("Modified in commit")).toHaveClass("commit-snapshot-kind", "modified");
    expect(screen.getByText("Commit source snapshot")).toHaveAttribute("title", "Commit source snapshot");
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });

  it("does not treat inherited object keys as change kinds", () => {
    render(<CommitSnapshotBanner snapshot={{ shortId: "abc1234", message: "Fix", changeKind: "toString" }} filePath="a.ts" />);
    expect(screen.getByText("Modified in commit")).toBeInTheDocument();
  });

  it("renders a known change kind, the author, and the commit time as an ISO dateTime", () => {
    const timestamp = 1_700_000_000;
    render(<CommitSnapshotBanner snapshot={{ shortId: "def5678", message: "  Rename helper  ", changeKind: "renamed", author: "Ada", timestamp }} filePath="src/helper.ts" />);

    expect(screen.getByText("Renamed in commit")).toHaveClass("renamed");
    expect(screen.getByText("Rename helper")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    const time = document.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2023-11-14T22:13:20.000Z");
    expect(time).toHaveTextContent(new Date(timestamp * 1000).toLocaleString());
  });

  it("omits the time for a non-finite timestamp", () => {
    render(<CommitSnapshotBanner snapshot={{ shortId: "a", message: "m", changeKind: "added", timestamp: Number.NaN }} filePath="a.ts" />);
    expect(screen.getByText("Added in commit")).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
  });
});
