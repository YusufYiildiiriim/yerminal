import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { AgentUsagePanel } from "../../src/features/agent-usage/AgentUsagePanel";

const now = Date.UTC(2026, 10, 20, 12, 0, 0);
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const okSnapshot = {
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
      models: [
        { model: "opus", total: 15 },
        { model: "sonnet", total: 2 },
      ],
      error: null,
    },
    { id: "agy", name: "Antigravity (agy)", supported: false, available: false, limitsSupported: false, limits: null, planType: null, today: zero, week: zero, models: [], error: null },
    { id: "custom", name: "Custom agents (agents.toml)", supported: false, available: false, limitsSupported: false, limits: null, planType: null, today: zero, week: zero, models: [], error: null },
  ],
};

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReset();
  tauri.isTauri.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AgentUsagePanel", () => {
  it("shows Codex limits as remaining percent with reset time and token totals", async () => {
    tauri.invoke.mockResolvedValue(okSnapshot);
    render(<AgentUsagePanel enabled />);
    await flush();

    const codex = screen.getByRole("region", { name: "Codex CLI usage" });
    expect(within(codex).getByText("80% left")).toBeInTheDocument();
    expect(within(codex).getByText("50% left")).toBeInTheDocument();
    expect(within(codex).getByText("5h")).toBeInTheDocument();
    expect(within(codex).getByText("7d")).toBeInTheDocument();
    expect(within(codex).getByText(/Today 500/)).toBeInTheDocument();
    expect(within(codex).getByText(/Week 1\.5K/)).toBeInTheDocument();
    expect(within(codex).getByText("in 1K · out 500 · cache 0")).toBeInTheDocument();
    expect(within(codex).getByText("Totals include cache tokens.")).toBeInTheDocument();
    expect(tauri.invoke).toHaveBeenCalledWith("agent_usage_snapshot", { enabled: true });
  });

  it("shows a neutral note instead of a percentage for a window that has ended", async () => {
    const codexAgent = okSnapshot.agents[0];
    const snapshot = {
      ...okSnapshot,
      agents: [
        {
          ...codexAgent,
          limits: {
            observedAtMs: now,
            primary: { remainingPercent: null, windowMinutes: 300, resetsAtMs: now - 60_000, ended: true },
            secondary: codexAgent.limits.secondary,
          },
        },
        ...okSnapshot.agents.slice(1),
      ],
    };
    tauri.invoke.mockResolvedValue(snapshot);
    render(<AgentUsagePanel enabled />);
    await flush();

    const codex = screen.getByRole("region", { name: "Codex CLI usage" });
    expect(within(codex).getByText("Window ended")).toBeInTheDocument();
    expect(within(codex).getByText("Waiting for next Codex run")).toBeInTheDocument();
    // Only the open secondary window still reports a percentage.
    expect(within(codex).getAllByText(/% left/)).toHaveLength(1);
  });

  it("states that Claude limit percentages are not readable locally and lists the model split", async () => {
    tauri.invoke.mockResolvedValue(okSnapshot);
    render(<AgentUsagePanel enabled />);
    await flush();

    const claude = screen.getByRole("region", { name: "Claude Code usage" });
    expect(within(claude).getByText("Limit percentage can't be read locally for this tool.")).toBeInTheDocument();
    expect(within(claude).getByText(/Today 15/)).toBeInTheDocument();
    expect(within(claude).getByText("opus")).toBeInTheDocument();
    expect(within(claude).getByText("sonnet")).toBeInTheDocument();
  });

  it("marks agents without usage data with a neutral empty row", async () => {
    tauri.invoke.mockResolvedValue(okSnapshot);
    render(<AgentUsagePanel enabled />);
    await flush();

    expect(screen.getByRole("region", { name: "Antigravity (agy) usage" })).toHaveTextContent("No usage data");
    expect(screen.getByRole("region", { name: "Custom agents (agents.toml) usage" })).toHaveTextContent("No usage data");
  });

  it("shows the loading state until the first snapshot arrives", async () => {
    let resolve!: (value: unknown) => void;
    tauri.invoke.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AgentUsagePanel enabled />);
    expect(screen.getByText("Loading usage…")).toBeInTheDocument();

    resolve(okSnapshot);
    await flush();
    expect(screen.queryByText("Loading usage…")).not.toBeInTheDocument();
  });

  it("shows the disabled state the backend reports, without any usage rows", async () => {
    tauri.invoke.mockResolvedValue({ status: "disabled", generatedAtMs: now, agents: [] });
    render(<AgentUsagePanel enabled={false} />);
    await flush();

    expect(tauri.invoke).toHaveBeenCalledWith("agent_usage_snapshot", { enabled: false });
    expect(screen.getByText("Agent usage is off. Turn it on in Settings > Terminal.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Codex CLI usage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Claude Code usage" })).not.toBeInTheDocument();
  });

  it("shows a readable error when the command fails", async () => {
    tauri.invoke.mockRejectedValue("Could not read usage logs");
    render(<AgentUsagePanel enabled />);
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("Usage unavailable: Could not read usage logs");
  });

  it("explains that usage is only available in the desktop app outside Tauri", async () => {
    tauri.isTauri.mockReturnValue(false);
    render(<AgentUsagePanel enabled />);
    await flush();

    expect(screen.getByText("Usage is available in the desktop app.")).toBeInTheDocument();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("refreshes every 15 seconds while mounted and stops after unmount", async () => {
    vi.useFakeTimers();
    tauri.invoke.mockResolvedValue(okSnapshot);
    const { unmount } = render(<AgentUsagePanel enabled />);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(tauri.invoke).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
  });
});
