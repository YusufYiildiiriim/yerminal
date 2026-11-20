import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  formatPercentLeft,
  formatTokens,
  limitResetLabel,
  windowLabel,
  type AgentUsage,
  type AgentUsageSnapshot,
  type LimitSnapshot,
  type LimitWindow,
} from "./agentUsageFormat";
import "./agent-usage.css";
import "./terminal-monitor-tabs.css";

const REFRESH_MS = 15_000;

/**
 * Per-agent usage list for the terminal monitor. The backend reads the local logs
 * only while `enabled` is true; this panel only forwards the setting and renders numbers.
 */
export function AgentUsagePanel({ enabled }: { enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await invoke<AgentUsageSnapshot>("agent_usage_snapshot", { enabled });
        if (mounted) {
          setSnapshot(result);
          setError(null);
        }
      } catch (reason) {
        if (mounted) setError(String(reason));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [enabled]);

  if (!isTauri()) return <section className="agent-usage" aria-label="Agent usage"><p className="agent-usage-note">Usage is available in the desktop app.</p></section>;
  if (error) return <section className="agent-usage" aria-label="Agent usage"><p className="agent-usage-error" role="alert">Usage unavailable: {error}</p></section>;
  if (!snapshot) return <section className="agent-usage" aria-label="Agent usage"><p className="agent-usage-note">Loading usage…</p></section>;
  if (snapshot.status === "disabled") return <section className="agent-usage" aria-label="Agent usage"><p className="agent-usage-note">{"Agent usage is off. Turn it on in Settings > Terminal."}</p></section>;

  return <section className="agent-usage" aria-label="Agent usage" aria-live="polite">
    {snapshot.agents.map((agent) => <AgentRow key={agent.id} agent={agent} nowMs={snapshot.generatedAtMs} />)}
  </section>;
}

function AgentRow({ agent, nowMs }: { agent: AgentUsage; nowMs: number }) {
  const hasData = agent.supported && agent.available;
  return <div className="agent-usage-row" role="region" aria-label={`${agent.name} usage`}>
    <div className="agent-usage-head">
      <span className="agent-usage-name">{agent.name}</span>
      {agent.planType && <span className="agent-usage-plan">{agent.planType}</span>}
    </div>
    {!hasData ? <div className="agent-usage-empty">No usage data</div> : <>
      {agent.limitsSupported
        ? agent.limits ? <LimitBars limits={agent.limits} nowMs={nowMs} /> : <div className="agent-usage-empty">No limit data yet</div>
        : <div className="agent-usage-note">Limit percentage can&apos;t be read locally for this tool.</div>}
      <div className="agent-usage-totals">
        <span>Today {formatTokens(agent.today.total)}</span>
        <span>Week {formatTokens(agent.week.total)}</span>
      </div>
      {agent.models.length > 0 && <div className="agent-usage-models">
        {agent.models.slice(0, 4).map((model) => <span className="agent-usage-model" key={model.model}>
          <span>{model.model}</span>
          <span>{formatTokens(model.total)}</span>
        </span>)}
      </div>}
      {agent.error && <div className="agent-usage-error">{agent.error}</div>}
    </>}
  </div>;
}

function LimitBars({ limits, nowMs }: { limits: LimitSnapshot; nowMs: number }) {
  const windows = [limits.primary, limits.secondary].filter((window): window is LimitWindow => window !== null);
  return <div className="agent-usage-limits">
    {windows.map((window) => <div className="agent-usage-limit" key={window.windowMinutes}>
      <span className="agent-usage-window">{windowLabel(window.windowMinutes)}</span>
      <span className="agent-usage-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, window.remainingPercent))}%` }} /></span>
      <span className="agent-usage-value">{formatPercentLeft(window.remainingPercent)}</span>
      <span className="agent-usage-reset">{limitResetLabel(window.resetsAtMs, nowMs)}</span>
    </div>)}
  </div>;
}
