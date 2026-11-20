import { describe, expect, it } from "vitest";
import { formatBreakdown, formatPercentLeft, formatTokens, limitResetLabel, windowLabel } from "../../src/features/agent-usage/agentUsageFormat";

describe("agent usage formatting", () => {
  it("shortens token counts for the compact rows", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(45_300)).toBe("45K");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  it("states the remaining percent, rounded to a whole number", () => {
    expect(formatPercentLeft(80)).toBe("80% left");
    expect(formatPercentLeft(59.6)).toBe("60% left");
    expect(formatPercentLeft(0)).toBe("0% left");
  });

  it("labels rate-limit windows by length", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("7d");
    expect(windowLabel(60)).toBe("1h");
    expect(windowLabel(90)).toBe("90m");
  });

  it("shows the reset time of an open window", () => {
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(limitResetLabel(now + 3 * 3600_000)).toMatch(/^Resets .*Nov/);
  });

  it("splits a Codex total so the three parts add up to it (cached input is not counted twice)", () => {
    // Codex: total 1200 = uncached input 600 + output 200 + cached 400.
    const codex = { input: 600, output: 200, cacheRead: 400, cacheWrite: 0, total: 1200 };
    expect(formatBreakdown(codex)).toBe("in 600 · out 200 · cache 400");
    expect(codex.input + codex.output + codex.cacheRead + codex.cacheWrite).toBe(codex.total);
  });

  it("states what a total covers: input, output and cache, with cache counted separately", () => {
    expect(formatBreakdown({ input: 1500, output: 0, cacheRead: 400, cacheWrite: 20, total: 1900 })).toBe("in 1.5K · out 0 · cache 420");
  });
});
