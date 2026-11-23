import "./loading-state.css";

type Props = {
  /** Announced to assistive tech and shown beside the spinner. */
  label: string;
  /** Tighter spacing for dense lists such as a repository card. */
  compact?: boolean;
  /** Full-width block with the ring and label centered; for a list or commit-changes wait, not an inline one. */
  centered?: boolean;
};

/**
 * A quiet loading indicator: a small ring and a label, announced as a polite status.
 * Inline by default; `centered` makes it a full-width block with the ring and label in the middle.
 * Reusable anywhere a section waits for data; the ring is decorative, the label carries the meaning.
 */
export function LoadingState({ label, compact = false, centered = false }: Props) {
  const classes = `loading-state${compact ? " is-compact" : ""}${centered ? " is-centered" : ""}`;
  return <div className={classes} role="status" aria-live="polite" aria-label={label}>
    <span className="loading-state-spinner" aria-hidden="true" />
    <span className="loading-state-label">{label}</span>
  </div>;
}
