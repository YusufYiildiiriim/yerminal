import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrandMark } from "../../src/brand/BrandMark";

const markSource = readFileSync("assets/brand/yerminal-mark.svg", "utf8");
const iconSource = readFileSync("assets/brand/yerminal-icon.svg", "utf8");

function sourcePaths(svg: string) {
  return [...svg.matchAll(/<path d="([^"]+)" fill="(#[0-9a-f]{6})"\s*\/>/gi)].map((match) => ({ d: match[1], fill: match[2].toLowerCase() }));
}

function renderedPaths(container: HTMLElement) {
  return [...container.querySelectorAll("path")].map((path) => ({ d: path.getAttribute("d"), fill: path.getAttribute("fill") }));
}

describe("BrandMark", () => {
  it("renders the three approved polygons in the approved colors", () => {
    const { container } = render(<BrandMark />);
    expect(renderedPaths(container)).toEqual([
      { d: "M4 26 L16 26 L38 46 L16 66 L4 66 L26 46 Z", fill: "#1c7a48" },
      { d: "M46 28 L58 28 L82 66 L70 66 Z", fill: "#a3650f" },
      { d: "M96 28 L108 28 L68 92 L56 92 Z", fill: "#a3650f" },
    ]);
  });

  it("matches the SVG source files in the repo", () => {
    const { container } = render(<BrandMark />);
    expect(sourcePaths(markSource)).toHaveLength(3);
    expect(renderedPaths(container)).toEqual(sourcePaths(markSource));
    expect(renderedPaths(container)).toEqual(sourcePaths(iconSource));
  });

  it("paints the dark rounded tile with the approved fill and hairline stroke", () => {
    const { container } = render(<BrandMark />);
    const tile = container.querySelector("rect");
    expect(tile).toHaveAttribute("fill", "#17161f");
    expect(tile).toHaveAttribute("stroke", "#2a2c36");
    expect(iconSource).toContain('fill="#17161f"');
    expect(iconSource).toContain('stroke="#2a2c36"');
  });

  it("is decorative and draws no letter glyph", () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg?.textContent).toBe("");
    expect(container.querySelector("text")).toBeNull();
  });
});
