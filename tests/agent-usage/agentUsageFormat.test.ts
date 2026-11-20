import { describe, expect, it } from "vitest";
import { formatPercentLeft, formatTokens, limitResetLabel, windowLabel } from "../../src/features/agent-usage/agentUsageFormat";

describe("agent usage formatting", () => {
  it("shortens token counts for the compact rows", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5K");
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

  it("shows the reset time while the window is open and flags it once it has passed", () => {
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    expect(limitResetLabel(now + 3 * 3600_000, now)).toMatch(/^Resets .*Nov/);
    expect(limitResetLabel(now - 60_000, now)).toBe("Window ended, reading may be stale");
  });
});
