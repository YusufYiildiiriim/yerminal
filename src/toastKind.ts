export type ToastKind = "error" | "success" | "warning";

/**
 * Notifications arrive as plain strings (from backend errors as well as from our own success
 * messages), so the look of a toast is derived from the text: known success messages are green,
 * merge conflicts and "do this first" guidance are amber, and everything else is treated as an error.
 */
export function classifyToast(message: string): ToastKind {
  const text = message.trim();
  if (/conflicts?\b/i.test(text) || /^(Choose|Launch|Install) /.test(text)) return "warning";
  if (
    /^(Fetch|Pull|Push|Publish):/.test(text)
    || /^Created (merge )?commit /.test(text)
    || /^(Merged|Fast-forwarded to|Already up to date|Merge aborted)/.test(text)
  ) return "success";
  return "error";
}
