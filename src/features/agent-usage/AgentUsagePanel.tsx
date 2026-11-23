import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  formatBreakdown,
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
    {snapshot.agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)}
  </section>;
}

function AgentRow({ agent }: { agent: AgentUsage }) {
  const hasData = agent.supported && agent.available;
  return <div className="agent-usage-row" role="region" aria-label={`${agent.name} usage`}>
    <div className="agent-usage-head">
      <span className="agent-usage-name">{agent.name}</span>
      {agent.planType && <span className="agent-usage-plan">{agent.planType}</span>}
    </div>
    {!hasData ? <div className="agent-usage-empty">No usage data</div> : <>
      {agent.limitsSupported
        ? agent.limits ? <LimitBars limits={agent.limits} /> : <div className="agent-usage-empty">No limit data yet</div>
        : <div className="agent-usage-note">Limit percentage can&apos;t be read locally for this tool.</div>}
      <div className="agent-usage-group">
        <div className="agent-usage-group-title">Tokens</div>
        <dl className="agent-usage-stats">
          <div className="agent-usage-stat"><dt>Today</dt><dd><TokenValue value={agent.today.total} /></dd></div>
          <div className="agent-usage-stat"><dt>Week</dt><dd><TokenValue value={agent.week.total} /></dd></div>
        </dl>
        <div className="agent-usage-breakdown" title="Week, by token kind">{formatBreakdown(agent.week)}</div>
        <div className="agent-usage-note">Totals include cache tokens.</div>
      </div>
      {agent.models.length > 0 && <div className="agent-usage-group">
        <div className="agent-usage-group-title">Models</div>
        <dl className="agent-usage-models">
          {agent.models.slice(0, 4).map((model) => <div className="agent-usage-model" key={model.model}>
            <dt>{model.model}</dt>
            <dd><TokenValue value={model.total} /></dd>
          </div>)}
        </dl>
      </div>}
      {agent.error && <div className="agent-usage-error">{agent.error}</div>}
    </>}
  </div>;
}

/** Token count as number and unit, so the K / M suffix can be styled apart from the digits. */
function TokenValue({ value }: { value: number }) {
  const text = formatTokens(value);
  const unit = text.match(/[KM]$/)?.[0] ?? "";
  return <>
    <span className="agent-usage-num">{unit ? text.slice(0, -1) : text}</span>
    {unit && <span className="agent-usage-unit">{unit}</span>}
  </>;
}

function LimitBars({ limits }: { limits: LimitSnapshot }) {
  const windows = [limits.primary, limits.secondary].filter((window): window is LimitWindow => window !== null);
  return <div className="agent-usage-group">
    <div className="agent-usage-group-title">Limits</div>
    <div className="agent-usage-limits">
      {windows.map((window) => window.ended || window.remainingPercent === null
        ? <div className="agent-usage-limit is-ended" key={window.windowMinutes}>
          <span className="agent-usage-window">{windowLabel(window.windowMinutes)}</span>
          <span className="agent-usage-value">Window ended</span>
          <span className="agent-usage-reset">Waiting for next Codex run</span>
        </div>
        : <div className="agent-usage-limit" key={window.windowMinutes}>
          <span className="agent-usage-window">{windowLabel(window.windowMinutes)}</span>
          <span className="agent-usage-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, window.remainingPercent))}%` }} /></span>
          <span className="agent-usage-value">{formatPercentLeft(window.remainingPercent)}</span>
          <span className="agent-usage-reset">{limitResetLabel(window.resetsAtMs)}</span>
        </div>)}
    </div>
  </div>;
}
