import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

import { TerminalResourceGraph } from "../../src/features/terminal/TerminalResourceGraph";

type Metric = { sessionId: string; available: boolean; processCount: number; memoryBytes: number; cpuPercent: number | null };

const terminals = [
  { id: "one", name: "Shell one", shellLabel: "PowerShell" },
  { id: "two", name: "Shell two", shellLabel: "PowerShell" },
];

function renderGraph(props: Partial<Parameters<typeof TerminalResourceGraph>[0]> = {}) {
  return render(<TerminalResourceGraph enabled workspaceName="Workspace 1" terminals={terminals} activeTerminalId="one" onFocusTerminal={vi.fn()} {...props} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {});
}

function cardFor(name: string) {
  return screen.getByRole("button", { name: `Focus ${name} terminal` });
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri.invoke.mockReset();
  tauri.isTauri.mockReset();
  tauri.isTauri.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TerminalResourceGraph polling", () => {
  it("polls every 1.5s, skips ticks while a request is in flight and stops on unmount", async () => {
    const first = deferred<Metric[]>();
    tauri.invoke.mockReturnValueOnce(first.promise).mockResolvedValue([]);
    const { unmount } = renderGraph();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("terminal_resource_usage", { sessionIds: ["one", "two"] });

    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(tauri.invoke).toHaveBeenCalledTimes(1);

    first.resolve([]);
    await flush();
    await act(async () => { vi.advanceTimersByTime(1499); });
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(tauri.invoke).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("TerminalResourceGraph metrics", () => {
  it("formats memory, shows measuring CPU and marks ended processes", async () => {
    tauri.invoke.mockResolvedValue([
      { sessionId: "one", available: true, processCount: 1, memoryBytes: 1536, cpuPercent: null },
      { sessionId: "two", available: false, processCount: 0, memoryBytes: 0, cpuPercent: null },
    ]);
    renderGraph();
    await flush();
    expect(cardFor("Shell one")).toHaveTextContent("RAM1.50 KB");
    expect(cardFor("Shell one")).toHaveTextContent("CPUMeasuring…");
    expect(cardFor("Shell two")).toHaveTextContent("Process ended");
  });

  it("formats larger memory sizes and CPU percentages", async () => {
    tauri.invoke.mockResolvedValue([
      { sessionId: "one", available: true, processCount: 2, memoryBytes: 15 * 1024 * 1024, cpuPercent: 12.345 },
      { sessionId: "two", available: true, processCount: 1, memoryBytes: 512, cpuPercent: 0 },
    ]);
    renderGraph();
    await flush();
    expect(cardFor("Shell one")).toHaveTextContent("RAM15.0 MB");
    expect(cardFor("Shell one")).toHaveTextContent("CPU12.3%");
    expect(cardFor("Shell two")).toHaveTextContent("RAM512 B");
    expect(cardFor("Shell two")).toHaveTextContent("CPU0.0%");
  });

  it("shows the collecting state until the first result arrives", () => {
    tauri.invoke.mockReturnValue(new Promise(() => {}));
    renderGraph();
    expect(cardFor("Shell one")).toHaveTextContent("Collecting metrics…");
  });

  it("reports an unavailable metric outside the desktop app without polling", async () => {
    tauri.isTauri.mockReturnValue(false);
    renderGraph();
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Terminal resource monitoring is available in the desktop app.");
    expect(cardFor("Shell one")).toHaveTextContent("Unavailable");
    expect(screen.queryByText("Live · 1.5s")).not.toBeInTheDocument();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("shows the request error", async () => {
    tauri.invoke.mockRejectedValue("usage failed");
    renderGraph();
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("usage failed");
  });
});
