import { cleanup, render, screen, within } from "@testing-library/react";
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

beforeEach(() => {
  tauri.invoke.mockReset();
  mockBackend();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("sidebar agent usage", () => {
  it("keeps the resources strip independent and reads usage only when expanded", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ agentUsageEnabled: true }));
    const user = userEvent.setup(); render(<App />);
    await user.click(within(screen.getByRole("region", { name: "Terminal groups" })).getByRole("button", { name: "Resource usage" }));
    expect(document.getElementById("terminal-resource-panel")).toBeInTheDocument();
    expect(usageCalls()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Agent usage" }));
    expect(await screen.findByRole("region", { name: "Codex CLI usage" })).toBeInTheDocument();
    expect(document.getElementById("terminal-resource-panel")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Agent usage" }));
    expect(screen.queryByRole("region", { name: "Codex CLI usage" })).not.toBeInTheDocument();
  });
  it("shows the disabled message when the setting is off", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Agent usage" }));
    expect(await screen.findByText("Agent usage is off. Turn it on in Settings > Terminal.")).toBeInTheDocument();
    expect(usageCalls().at(-1)?.[1]).toEqual({ enabled: false });
  });
  it("resizes agent usage with the keyboard without resizing resources", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "Agent usage" }));
    const handle = screen.getByRole("separator", { name: "Resize agent usage" });
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus(); await user.keyboard("{ArrowUp}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    expect(document.getElementById("terminal-resource-panel")).not.toBeInTheDocument();
  });
});
