import { useEffect, useRef, useState } from "react";
import "./releaseNotes.css";
import { openIssueUrl, issueUrl, RELEASES, type ReleaseNote } from "./releaseNotes";

type Props = { releases?: ReleaseNote[]; onClose: () => void };

/** Version notes dialog. Opened above the workspace from the rail entry, like Help & Settings. */
export function ReleaseNotesDialog({ releases = RELEASES.releases, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [openError, setOpenError] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const openIssue = (number: number) => {
    const url = issueUrl(number);
    if (!url) return;
    setOpenError(false);
    openIssueUrl(url).then((opened) => setOpenError(!opened)).catch(() => setOpenError(true));
  };

  return <div className="release-notes-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="release-notes-heading">
      <header className="release-notes-head">
        <h2 id="release-notes-heading">Version notes</h2>
        <button ref={closeRef} type="button" className="release-notes-close" aria-label="Close version notes" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div className="release-notes-body">
        {releases.length === 0 && <p className="release-notes-empty">No release notes yet.</p>}
        {releases.map((release) => <section key={release.version} className="release-notes-release" aria-labelledby={"release-" + release.version}>
          <h3 id={"release-" + release.version}>{release.version + " · " + (release.date ?? "Upcoming")}</h3>
          {release.issues.length === 0 ? <p className="release-notes-empty">No closed issues listed.</p> : <ul className="release-notes-issues" aria-label={"Issues closed in " + release.version}>
            {release.issues.map((issue) => <li key={issue.number}>
              <button type="button" className="release-notes-issue" aria-label={"Open issue #" + issue.number} title={"Open issue #" + issue.number + " on GitHub"} onClick={() => openIssue(issue.number)}>
                <span className="release-notes-issue-number">#{issue.number}</span>
                <span className="release-notes-issue-title">{issue.title}</span>
              </button>
            </li>)}
          </ul>}
        </section>)}
        {openError && <p className="release-notes-error" role="status">Could not open the issue in the browser.</p>}
      </div>
    </section>
  </div>;
}
