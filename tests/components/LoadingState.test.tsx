import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LoadingState } from "../../src/components/LoadingState";

afterEach(() => cleanup());

describe("LoadingState", () => {
  it("announces its label politely as a status region", () => {
    render(<LoadingState label="Loading changes…" />);

    const status = screen.getByRole("status", { name: "Loading changes…" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading changes…");
  });

  it("keeps the spinner decorative so assistive tech reads only the label", () => {
    const { container } = render(<LoadingState label="Loading repository…" />);

    const spinner = container.querySelector(".loading-state-spinner");
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute("aria-hidden", "true");
  });

  it("can be rendered compact inside a dense list without changing its role", () => {
    const { container } = render(<LoadingState label="Loading" compact />);

    expect(container.querySelector(".loading-state")).toHaveClass("is-compact");
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("can be centered as a block so a list or commit-changes wait sits mid-row, not against the left edge", () => {
    const { container } = render(<LoadingState label="Loading changed files…" centered />);

    const root = container.querySelector(".loading-state");
    expect(root).toHaveClass("is-centered");
    expect(root).not.toHaveClass("is-compact");
    expect(screen.getByRole("status", { name: "Loading changed files…" })).toHaveTextContent("Loading changed files…");
  });

  it("ships a centered rule that centers spinner and label across the full container width", () => {
    const css = readFileSync("src/components/loading-state.css", "utf8");
    const match = css.match(/\.loading-state\.is-centered\s*\{([^}]*)\}/);

    expect(match).not.toBeNull();
    const rule = match?.[1] ?? "";
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/justify-content:\s*center/);
    expect(rule).toMatch(/align-items:\s*center/);
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/padding:\s*\d+px\s+\d+px/);
  });
});
