import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./terminal-resource-graph.css";

type TerminalSummary = { id: string; name: string; shellLabel: string };
type TerminalResourceMetric = { sessionId: string; available: boolean; processCount: number; memoryBytes: number; cpuPercent: number | null };
type TerminalResourceGraphProps = { enabled: boolean; workspaceName: string; terminals: TerminalSummary[]; activeTerminalId: string | null; onFocusTerminal: (terminalId: string) => void };

function formatMemory(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return size.toFixed(size >= 10 ? 1 : 2) + " " + units[unitIndex];
}

// Flat usage strip below the terminal panes: one cell per terminal with a
// neutral CPU meter and "memory · cpu" text. Clicking a cell focuses the terminal.
export function TerminalResourceGraph({ enabled, terminals, activeTerminalId, onFocusTerminal }: TerminalResourceGraphProps) {
  const sessionKey = terminals.map((terminal) => terminal.id).join("|");
  const sessionIds = sessionKey ? sessionKey.split("|") : [];
  const [metrics, setMetrics] = useState<TerminalResourceMetric[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let requestId = 0;
    setMetrics([]);
    setLoading(enabled && sessionIds.length > 0);
    setError(null);

    if (!enabled || sessionIds.length === 0) {
      setLoading(false);
      return () => { mounted = false; };
    }
    if (!isTauri()) {
      setError("Terminal resource monitoring is available in the desktop app.");
      setLoading(false);
      return () => { mounted = false; };
    }

    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const currentRequest = ++requestId;
      try {
        const result = await invoke<TerminalResourceMetric[]>("terminal_resource_usage", { sessionIds });
        if (mounted && currentRequest === requestId) {
          setMetrics(result);
          setError(null);
          setLoading(false);
        }
      } catch (reason) {
        if (mounted && currentRequest === requestId) {
          setError(String(reason));
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 1500);
    return () => {
      mounted = false;
      requestId += 1;
      window.clearInterval(interval);
    };
  }, [enabled, sessionKey]);

  const metricBySession = new Map(metrics.map((metric) => [metric.sessionId, metric]));

  return <section className="terminal-resource-strip" aria-label="Terminal resource usage">
    {error && <div className="terminal-resource-error" role="alert">{error}</div>}
    {terminals.length === 0 ? <div className="terminal-resource-empty">No terminal sessions in this workspace</div> : <div className="terminal-resource-list" aria-live="polite">
      {terminals.map((terminal) => {
        const metric = metricBySession.get(terminal.id);
        const available = metric?.available ?? false;
        const cpu = metric?.cpuPercent ?? null;
        const value = available && metric
          ? formatMemory(metric.memoryBytes) + " · " + (cpu === null ? "Measuring…" : cpu.toFixed(1) + "%")
          : metric ? "Process ended" : loading ? "Collecting metrics…" : "Unavailable";
        return <button className={"terminal-resource-card" + (terminal.id === activeTerminalId ? " active" : "")} key={terminal.id} type="button" title={`Focus ${terminal.name}`} aria-pressed={terminal.id === activeTerminalId} aria-label={`Focus ${terminal.name} terminal`} onClick={() => onFocusTerminal(terminal.id)}>
          <span className="terminal-resource-terminal-name">{terminal.name}</span>
          <span className="terminal-resource-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, cpu ?? 0))}%` }} /></span>
          <span className="terminal-resource-value">{value}</span>
        </button>;
      })}
    </div>}
  </section>;
}
