import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn().mockResolvedValue(() => {}),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    destroy: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../src/features/terminal/TerminalPane", () => ({
  default: () => <div data-testid="mock-terminal">Terminal Pane</div>,
}));

import App from "../../src/App";

const SETTINGS_KEY = "yerminal.app-settings.v1";
const now = Date.now();
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usageSnapshot = {
  status: "ok",
  generatedAtMs: now,
  agents: [
    {
      id: "codex",
      name: "Codex CLI",
      supported: true,
      available: true,
      limitsSupported: true,
      limits: { primary: { remainingPercent: 80, windowMinutes: 300, resetsAtMs: now + 3 * 3600_000, ended: false }, secondary: null, observedAtMs: now },
      planType: "plus",
      today: { ...zero, total: 500 },
      week: { ...zero, total: 1500 },
      models: [],
      error: null,
    },
    { id: "claude", name: "Claude Code", supported: true, available: false, limitsSupported: false, limits: null, planType: null, today: zero, week: zero, models: [], error: null },
    { id: "agy", name: "Antigravity (agy)", supported: false, available: false, limitsSupported: false, limits: null, planType: null, today: zero, week: zero, models: [], error: null },
    { id: "custom", name: "Custom agents (agents.toml)", supported: false, available: false, limitsSupported: false, limits: null, planType: null, today: zero, week: zero, models: [], error: null },
  ],
};

function usageCalls() {
  return tauri.invoke.mock.calls.filter(([command]) => command === "agent_usage_snapshot");
}

function mockBackend() {
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_usage_snapshot") {
      const enabled = (usageCalls().at(-1)?.[1] as { enabled?: boolean } | undefined)?.enabled;
      return enabled ? usageSnapshot : { status: "disabled", generatedAtMs: now, agents: [] };
    }
    if (command === "terminal_resource_usage") return [];
    return undefined;
  });
}

async function openMonitorTab(tab: "Resources" | "Usage") {
  const user = userEvent.setup();
  render(<App />);
  const terminalGroups = screen.getByRole("region", { name: "Terminal groups" });
  await user.click(within(terminalGroups).getByRole("button", { name: "Resource usage" }));
  const panel = document.getElementById("terminal-resource-panel") as HTMLElement;
  expect(panel).toBeInTheDocument();
  await user.click(within(panel).getByRole("tab", { name: tab }));
  return { user, panel };
}

beforeEach(() => {
  tauri.invoke.mockReset();
  mockBackend();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("terminal monitor Usage tab", () => {
  it("allows resizing the monitor with the keyboard and retains its size across tabs", async () => {
    const { user, panel } = await openMonitorTab("Resources");
    const handle = screen.getByRole("separator", { name: "Resize terminal monitor" });
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    await user.keyboard("{ArrowUp}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    await user.click(within(panel).getByRole("tab", { name: "Usage" }));
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  });

  it("does not request usage while the Resources tab is selected", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ agentUsageEnabled: true }));
    await openMonitorTab("Resources");
    expect(usageCalls()).toHaveLength(0);
  });

  it("with the setting off, the Usage tab asks the backend with enabled false and shows the off state", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ agentUsageEnabled: false }));
    const { panel } = await openMonitorTab("Usage");

    expect(await within(panel).findByText("Agent usage is off. Turn it on in Settings > Terminal.")).toBeInTheDocument();
    expect(usageCalls().length).toBeGreaterThan(0);
    expect(usageCalls().every(([, args]) => (args as { enabled: boolean }).enabled === false)).toBe(true);
    expect(within(panel).queryByRole("region", { name: "Codex CLI usage" })).not.toBeInTheDocument();
  });

  it("with the setting on, the Usage tab shows the agent panel and the Resources graph is hidden", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ agentUsageEnabled: true }));
    const { panel } = await openMonitorTab("Usage");

    await waitFor(() => expect(within(panel).getByRole("region", { name: "Codex CLI usage" })).toBeInTheDocument());
    expect(usageCalls().at(-1)?.[1]).toEqual({ enabled: true });
    expect(within(panel).getByRole("tab", { name: "Usage" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel).queryByLabelText("Terminal resource usage")).not.toBeInTheDocument();
  });
});
