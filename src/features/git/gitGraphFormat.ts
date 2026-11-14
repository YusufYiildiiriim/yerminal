const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative commit time for a unix timestamp in seconds. */
export function formatRelativeTime(timestampSeconds: number, nowMs: number = Date.now()): string {
  const elapsed = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(timestampSeconds * 1000).toLocaleDateString();
}

export function formatFullDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleString();
}

export function changeKindLetter(kind: string): string {
  if (kind === "deleted") return "D";
  if (kind === "added") return "A";
  if (kind === "renamed") return "R";
  return "M";
}
