import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./terminal-resource-graph.css";

type TerminalSummary = { id: string; name: string; shellLabel: string };
type TerminalResourceMetric = { sessionId: string; available: boolean; processCount: number; memoryBytes: number; cpuPercent: number | null };
type TerminalResourceGraphProps = { workspaceName: string; terminals: TerminalSummary[]; activeTerminalId: string | null };

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

export function TerminalResourceGraph({ workspaceName, terminals, activeTerminalId }: TerminalResourceGraphProps) {
  const sessionKey = terminals.map((terminal) => terminal.id).join("|");
  const sessionIds = sessionKey ? sessionKey.split("|") : [];
  const [metrics, setMetrics] = useState<TerminalResourceMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let requestId = 0;
    setMetrics([]);
    setLoading(true);
    setError(null);
    if (sessionIds.length === 0) {
      setMetrics([]);
      setLoading(false);
      setError(null);
      return () => { mounted = false; };
    }
    const refresh = async () => {
      if (!isTauri() || inFlight) {
        if (mounted && !isTauri()) {
          setError("Terminal resource monitoring is available in the desktop app.");
          setLoading(false);
        }
        return;
      }
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
  }, [sessionKey]);

  const metricBySession = new Map(metrics.map((metric) => [metric.sessionId, metric]));
  const maxMemory = Math.max(1, ...metrics.filter((metric) => metric.available).map((metric) => metric.memoryBytes));
  const maxCpu = Math.max(1, ...metrics.filter((metric) => metric.available && metric.cpuPercent !== null).map((metric) => metric.cpuPercent ?? 0));

  return <section className="terminal-resource-view" aria-labelledby="terminal-resource-title">
    <header className="terminal-resource-header">
      <div>
        <span className="terminal-resource-eyebrow">ACTIVE WORKSPACE</span>
        <h2 id="terminal-resource-title">Terminal resource graph</h2>
        <p>{workspaceName} · {terminals.length} terminal {terminals.length === 1 ? "session" : "sessions"} · Process-tree metrics</p>
      </div>
      <div className="terminal-resource-live"><span className="terminal-resource-live-dot" />Live · 1.5s refresh</div>
    </header>
    {error && <div className="terminal-resource-error" role="alert">{error}</div>}
    {terminals.length === 0 ? <div className="terminal-resource-empty">
      <span className="terminal-resource-empty-icon" aria-hidden="true">▤</span>
      <strong>No terminals in this workspace</strong>
      <p>Resource graphs appear here for terminals opened in the active workspace.</p>
    </div> : <div className="terminal-resource-grid" aria-live="polite">
      {terminals.map((terminal) => {
        const metric = metricBySession.get(terminal.id);
        const available = metric?.available ?? false;
        const cpu = metric?.cpuPercent ?? null;
        const memoryWidth = available ? Math.max(metric?.memoryBytes ? 2 : 0, (metric?.memoryBytes ?? 0) / maxMemory * 100) : 0;
        const cpuWidth = available && cpu !== null ? Math.max(cpu > 0 ? 2 : 0, cpu / maxCpu * 100) : 0;
        return <article className={"terminal-resource-card" + (terminal.id === activeTerminalId ? " active" : "")} key={terminal.id}>
          <div className="terminal-resource-card-heading">
            <span className="terminal-resource-terminal-icon" aria-hidden="true">▣</span>
            <div className="terminal-resource-terminal-name">
              <strong>{terminal.name}</strong>
              <span>{terminal.shellLabel}{terminal.id === activeTerminalId ? " · ACTIVE" : ""}</span>
            </div>
            <span className={"terminal-resource-state" + (available ? " available" : "")}>{available ? "TRACKED" : metric ? "UNAVAILABLE" : loading ? "SAMPLING" : "UNAVAILABLE"}</span>
          </div>
          {available ? <div className="terminal-resource-metrics">
            <div className="terminal-resource-metric-row">
              <div className="terminal-resource-metric-label"><span>RAM</span><strong>{formatMemory(metric?.memoryBytes ?? 0)}</strong></div>
              <div className="terminal-resource-bar"><span className="memory" style={{ width: memoryWidth + "%" }} /></div>
            </div>
            <div className="terminal-resource-metric-row">
              <div className="terminal-resource-metric-label"><span title="Share of logical CPU capacity available to yerminal">CPU · MACHINE CAPACITY</span><strong>{cpu === null ? "Measuring…" : cpu.toFixed(1) + "%"}</strong></div>
              <div className="terminal-resource-bar"><span className="cpu" style={{ width: cpuWidth + "%" }} /></div>
            </div>
            <footer className="terminal-resource-card-footer"><span>{metric?.processCount ?? 0} processes in this terminal tree</span><span>Bars compare this workspace</span></footer>
          </div> : <p className="terminal-resource-unavailable">{metric ? "The terminal process is no longer available." : loading ? "Collecting process data…" : "No process data is available for this session."}</p>}
        </article>;
      })}
    </div>}
  </section>;
}
