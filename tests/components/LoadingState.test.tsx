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
});
