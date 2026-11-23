import { useId, useState, type ReactNode } from "react";
import "./git-cards.css";

type Props = {
  /** Accessible name of the card region. */
  label: string;
  /** Visible title in the header band. */
  title: string;
  count: number;
  className?: string;
  /** Open at first; the choice lasts for the session only. */
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * A Git Changes section as a card: a header band (title, count, chevron) above a recessed body.
 * The whole band toggles the card; the body scrolls on its own so the panel does not grow.
 */
export function GitCard({ label, title, count, className, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return <section className={`git-card${open ? "" : " is-collapsed"}${className ? ` ${className}` : ""}`} aria-label={label}>
    <button type="button" className="git-card-band" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
      <span className="git-card-title">{title}</span>
      <span className="git-card-count">{count}</span>
      <span className="git-card-chev" aria-hidden="true">▾</span>
    </button>
    <div id={bodyId} className="git-card-body git-card-scroll" hidden={!open}>{children}</div>
  </section>;
}
