import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { AgentUsagePanel } from "../../src/features/agent-usage/AgentUsagePanel";

const css = readFileSync(join(process.cwd(), "src/features/agent-usage/agent-usage.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of every rule whose selector list contains `selector`, joined. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim()).includes(selector))
    .map((match) => match[2]);
  if (bodies.length === 0) throw new Error(`rule ${selector} not found`);
  return bodies.join(";");
}

const now = Date.UTC(2026, 10, 20, 12, 0, 0);
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const snapshot = {
  status: "ok",
  generatedAtMs: now,
  agents: [
    {
      id: "codex",
      name: "Codex CLI",
      supported: true,
      available: true,
      limitsSupported: true,
      limits: {
        primary: { remainingPercent: 80, windowMinutes: 300, resetsAtMs: now + 3 * 3600_000, ended: false },
        secondary: { remainingPercent: 50, windowMinutes: 10080, resetsAtMs: now + 2 * 86400_000, ended: false },
        observedAtMs: now,
      },
      planType: "plus",
      today: { ...zero, input: 300, output: 200, total: 500 },
      week: { ...zero, input: 1000, output: 500, total: 1500 },
      models: [],
      error: null,
    },
    {
      id: "claude",
      name: "Claude Code",
      supported: true,
      available: true,
      limitsSupported: false,
      limits: null,
      planType: null,
      today: { ...zero, total: 15 },
      week: { ...zero, total: 17 },
      models: [{ model: "opus", total: 15 }, { model: "sonnet", total: 2 }],
      error: null,
    },
  ],
};

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockResolvedValue(snapshot);
});

afterEach(cleanup);

describe("agent usage layout (style guard)", () => {
  it("lays out token totals as a label and value grid per stat", () => {
    expect(ruleBody(".agent-usage-stats")).toMatch(/display:\s*grid/);
    expect(ruleBody(".agent-usage-stat")).toMatch(/display:\s*grid/);
    expect(ruleBody(".agent-usage-stat")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
    expect(ruleBody(".agent-usage-stat dd")).toMatch(/text-align:\s*right/);
  });

  it("lays out model rows as a name column and a right-aligned value column", () => {
    expect(ruleBody(".agent-usage-model")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
    expect(ruleBody(".agent-usage-model dd")).toMatch(/text-align:\s*right/);
    expect(ruleBody(".agent-usage-model dt")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("separates each group with a spacing rule and a short muted title", () => {
    expect(ruleBody(".agent-usage-group")).toMatch(/margin-top:\s*\d+px/);
    expect(ruleBody(".agent-usage-group-title")).toMatch(/color:\s*var\(--text-muted\)/);
    expect(ruleBody(".agent-usage-unit")).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it("uses only shared type scale tokens and no literal font sizes", () => {
    expect(css.match(/font-size:\s*\d/g) ?? []).toEqual([]);
  });

  it("does not introduce a fixed width that would overflow the 184 px panel", () => {
    expect(css).not.toMatch(/(?<![\w-])width:\s*(1[89]\d|2\d\d|[3-9]\d\d)px/);
  });
});

describe("agent usage layout (structure)", () => {
  it("renders group titles, stat rows and value units as separate elements", async () => {
    render(<AgentUsagePanel enabled />);
    await act(async () => {});

    const codex = screen.getByRole("region", { name: "Codex CLI usage" });
    expect(within(codex).getByText("Limits")).toHaveClass("agent-usage-group-title");
    expect(within(codex).getByText("Tokens")).toHaveClass("agent-usage-group-title");
    const stats = codex.querySelectorAll(".agent-usage-stat");
    expect(stats).toHaveLength(2);
    expect(stats[0].querySelector("dt")).toHaveTextContent("Today");
    expect(stats[0].querySelector("dd .agent-usage-num")).toHaveTextContent("500");
    expect(stats[1].querySelector("dd .agent-usage-num")).toHaveTextContent("1.5");
    expect(stats[1].querySelector("dd .agent-usage-unit")).toHaveTextContent("K");
  });

  it("renders model names and values as definition pairs", async () => {
    render(<AgentUsagePanel enabled />);
    await act(async () => {});

    const claude = screen.getByRole("region", { name: "Claude Code usage" });
    expect(claude.querySelectorAll(".agent-usage-model")).toHaveLength(2);
    expect(within(claude).getByText("Models")).toHaveClass("agent-usage-group-title");
    expect(claude.querySelector(".agent-usage-model dt")).toHaveTextContent("opus");
    expect(claude.querySelector(".agent-usage-model dd")).toHaveTextContent("15");
  });
});
