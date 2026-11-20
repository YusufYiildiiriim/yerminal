// Shapes returned by the `agent_usage_snapshot` command (camelCase, numbers only).
export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type LimitWindow = { remainingPercent: number; windowMinutes: number; resetsAtMs: number };
export type LimitSnapshot = { primary: LimitWindow | null; secondary: LimitWindow | null; observedAtMs: number };
export type ModelUsage = { model: string; total: number };
export type AgentUsage = {
  id: string;
  name: string;
  supported: boolean;
  available: boolean;
  limitsSupported: boolean;
  limits: LimitSnapshot | null;
  planType: string | null;
  today: TokenTotals;
  week: TokenTotals;
  models: ModelUsage[];
  error: string | null;
};
export type AgentUsageSnapshot = { status: "ok" | "disabled"; generatedAtMs: number; agents: AgentUsage[] };

/** Compact token count: 500, 1.5K, 45K, 1.2M, 12M. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return (thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))) + "K";
  }
  const millions = value / 1_000_000;
  return (millions < 10 ? millions.toFixed(1) : String(Math.round(millions))) + "M";
}

/** Remaining share of a rate-limit window, as a whole percent. */
export function formatPercentLeft(remaining: number): string {
  return `${Math.round(remaining)}% left`;
}

/** Window length as a short label: 300 min is "5h", 10080 min is "7d". */
export function windowLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Reset time of an open window; a passed reset means the last reading may be stale. */
export function limitResetLabel(resetsAtMs: number, nowMs: number): string {
  if (resetsAtMs <= nowMs) return "Window ended, reading may be stale";
  const reset = new Date(resetsAtMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Resets ${reset}`;
}
