import "./loading-state.css";

type Props = {
  /** Announced to assistive tech and shown beside the spinner. */
  label: string;
  /** Tighter spacing for dense lists such as a repository card. */
  compact?: boolean;
};

/**
 * A quiet inline loading indicator: a small ring and a label, announced as a polite status.
 * Reusable anywhere a section waits for data; the ring is decorative, the label carries the meaning.
 */
export function LoadingState({ label, compact = false }: Props) {
  return <div className={`loading-state${compact ? " is-compact" : ""}`} role="status" aria-live="polite" aria-label={label}>
    <span className="loading-state-spinner" aria-hidden="true" />
    <span className="loading-state-label">{label}</span>
  </div>;
}
