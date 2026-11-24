import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { validateRemoteName, validateRemoteUrl, validateRepoName } from "./remoteUrl";
import "./publish-remote-dialog.css";

/** What `git_github_status` reports. null while it is still being checked. */
export type GithubAccount = { installed: boolean; loggedIn: boolean; login: string | null };

export type PublishChoice =
  | { kind: "github"; name: string; public: boolean }
  | { kind: "url"; name: string; url: string };

type Mode = "github" | "url";

type Props = {
  /** The branch that will be published. */
  branch: string;
  /** GitHub-safe repository name suggested from the folder name. */
  defaultRepoName: string;
  account: GithubAccount | null;
  onSubmit: (choice: PublishChoice) => void;
  onCancel: () => void;
};

const DEFAULT_REMOTE_NAME = "origin";

/**
 * Publish a branch that has no remote. Default: create a GitHub repository with the GitHub CLI (private unless
 * Public is chosen). The second mode adds an existing remote by URL. Validation runs here; the backend validates again.
 */
export function PublishRemoteDialog({ branch, defaultRepoName, account, onSubmit, onCancel }: Props) {
  const titleId = useId();
  const repoRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const unavailable = account !== null && !account.loggedIn;
  const [mode, setMode] = useState<Mode>(() => (unavailable ? "url" : "github"));
  const [repoName, setRepoName] = useState(defaultRepoName);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [remoteName, setRemoteName] = useState(DEFAULT_REMOTE_NAME);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  // When gh turns out to be missing or signed out, the URL mode is the only usable one; say why.
  useEffect(() => {
    if (unavailable) setMode("url");
  }, [unavailable]);

  useEffect(() => {
    (mode === "github" ? repoRef : urlRef).current?.focus();
  }, [mode]);

  const notice = unavailable
    ? account?.installed
      ? "Not signed in to GitHub CLI. Run `gh auth login` in a terminal, or use a remote URL."
      : "GitHub CLI not found. Install gh, or use a remote URL."
    : null;
  const shown = error ?? notice;
  const isPublic = visibility === "public";
  const githubChecking = mode === "github" && account === null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === "github") {
      const name = repoName.trim();
      const problem = validateRepoName(name);
      if (problem) {
        setError(problem);
        return;
      }
      onSubmit({ kind: "github", name, public: isPublic });
      return;
    }
    const name = remoteName.trim();
    const url = remoteUrl.trim();
    const problem = validateRemoteName(name) ?? validateRemoteUrl(url);
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit({ kind: "url", name, url });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  const submitLabel = mode === "url" ? "Add remote and publish" : isPublic ? "Publish publicly" : "Publish";

  return createPortal(
    <div className="publish-remote-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <form className="publish-remote-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} onSubmit={submit} noValidate>
        <h2 id={titleId}>{`Publish ${branch}`}</h2>
        <fieldset className="publish-remote-modes">
          <legend className="publish-remote-hint">Where should this branch go?</legend>
          <label className="publish-remote-option">
            <input type="radio" name="publish-mode" checked={mode === "github"} disabled={unavailable} onChange={() => { setMode("github"); setError(null); }} />
            <span>Create GitHub repository</span>
          </label>
          <label className="publish-remote-option">
            <input type="radio" name="publish-mode" checked={mode === "url"} onChange={() => { setMode("url"); setError(null); }} />
            <span>Use existing remote URL</span>
          </label>
        </fieldset>

        {mode === "github" ? <>
          <p className="publish-remote-hint">Creates the repository with GitHub CLI and pushes this branch to it.</p>
          {account?.loggedIn && account.login && <p className="publish-remote-hint">{`Account: ${account.login}`}</p>}
          <label className="publish-remote-field">
            <span>Repository name</span>
            <input ref={repoRef} type="text" autoComplete="off" spellCheck={false} maxLength={100} value={repoName} onChange={(event) => { setRepoName(event.currentTarget.value); setError(null); }} />
          </label>
          <fieldset className="publish-remote-modes">
            <legend className="publish-remote-hint">Visibility</legend>
            <label className="publish-remote-option">
              <input type="radio" name="publish-visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} />
              <span>Private</span>
            </label>
            <label className="publish-remote-option">
              <input type="radio" name="publish-visibility" checked={visibility === "public"} onChange={() => setVisibility("public")} />
              <span>Public</span>
            </label>
          </fieldset>
          {isPublic && <p className="publish-remote-warning" role="note">Anyone on the internet can see this repository.</p>}
        </> : <>
          <p className="publish-remote-hint">Adds a remote and pushes this branch to it.</p>
          <label className="publish-remote-field">
            <span>Remote name</span>
            <input type="text" autoComplete="off" spellCheck={false} maxLength={64} value={remoteName} onChange={(event) => { setRemoteName(event.currentTarget.value); setError(null); }} />
          </label>
          <label className="publish-remote-field">
            <span>Remote URL</span>
            <input ref={urlRef} type="text" autoComplete="off" spellCheck={false} placeholder="https://host/owner/repo.git" value={remoteUrl} onChange={(event) => { setRemoteUrl(event.currentTarget.value); setError(null); }} />
          </label>
        </>}

        {shown && <p className="publish-remote-error" role="alert">{shown}</p>}
        <footer className="publish-remote-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="is-primary" type="submit" disabled={githubChecking}>{submitLabel}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
