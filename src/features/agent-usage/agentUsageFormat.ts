// Shapes returned by the `agent_usage_snapshot` command (camelCase, numbers only).
export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type LimitWindow = { remainingPercent: number | null; windowMinutes: number; resetsAtMs: number; ended: boolean };
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
  if (value < 1_000_000) return scaled(value / 1000) + "K";
  return scaled(value / 1_000_000) + "M";
}

/** One decimal below 10, whole numbers above; a trailing ".0" is dropped (1.0K -> 1K). */
function scaled(amount: number): string {
  return amount < 10 ? amount.toFixed(1).replace(/\.0$/, "") : String(Math.round(amount));
}

/**
 * Input / output / cache split for a total. Claude's total already includes cache
 * reads and writes, and Codex's total includes cached input, so cache is shown apart.
 */
export function formatBreakdown(totals: TokenTotals): string {
  const cache = totals.cacheRead + totals.cacheWrite;
  return `in ${formatTokens(totals.input)} · out ${formatTokens(totals.output)} · cache ${formatTokens(cache)}`;
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

/** Reset time of a window that is still open. Ended windows are shown by the panel instead. */
export function limitResetLabel(resetsAtMs: number): string {
  const reset = new Date(resetsAtMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Resets ${reset}`;
}
