import { cleanup, render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowTitleBar } from "../../src/shell/WindowTitleBar";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({}),
}));

afterEach(() => {
  cleanup();
});

const srcDir = join(process.cwd(), "src");

function listCss(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listCss(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

const css = listCss(srcDir)
  .map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");

/** Splits a selector list on top-level commas only, so :not(a, b) stays whole. */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part) => part.replace(/\s+/g, " "));
}

/** Declarations of every rule whose selector list contains `selector` (whitespace-normalised), joined. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => !match[1].trim().startsWith("@") && splitSelectorList(match[1]).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

/** Every selector in the shell stylesheets that targets an svg inside the title bar. */
function titlebarSvgSelectors(): string[] {
  return [...css.matchAll(/([^{}]+)\{/g)]
    .filter((match) => !match[1].trim().startsWith("@"))
    .flatMap((match) => splitSelectorList(match[1]))
    .filter((selector) => /\.titlebar(?![-\w])/.test(selector) && /\bsvg\b/.test(selector));
}

const TITLEBAR = ".app-shell[data-theme] .titlebar";
const BRAND_LOGO = ".app-shell[data-theme] .brand-logo";

describe("title bar brand mark style", () => {
  it("no title bar svg rule matches the brand mark, so its own fills and geometry are kept", () => {
    const { container } = render(
      <div className="app-shell" data-theme="obsidian">
        <WindowTitleBar breadcrumb="Terminal · main" />
      </div>,
    );
    const brand = container.querySelector(".brand-logo") as Element;
    expect(brand).not.toBeNull();
    const matching = titlebarSvgSelectors().filter((selector) => {
      try {
        return brand.matches(selector);
      } catch {
        return false;
      }
    });
    expect(matching).toEqual([]);
  });

  it("keeps the window control icons styled by the generic title bar svg rule", () => {
    const { container } = render(
      <div className="app-shell" data-theme="obsidian">
        <WindowTitleBar breadcrumb="Terminal · main" />
      </div>,
    );
    const icon = container.querySelector(".window-control svg") as Element;
    expect(icon.getAttribute("stroke")).toBe("currentColor");
  });
});

describe("title bar height", () => {
  it("defines the bar height once as a token and uses it on the bar", () => {
    const definitions = [...css.matchAll(/--titlebar-height\s*:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(definitions).toEqual(["40px"]);
    expect(ruleBody(TITLEBAR)).toContain("height: var(--titlebar-height)");
    expect(ruleBody(TITLEBAR)).toContain("flex: 0 0 var(--titlebar-height)");
  });

  it("sizes the brand logo to about 22 px so it fits the shorter bar", () => {
    expect(ruleBody(BRAND_LOGO)).toMatch(/width:\s*22px/);
    expect(ruleBody(BRAND_LOGO)).toMatch(/height:\s*22px/);
  });
});
