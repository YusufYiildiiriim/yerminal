// Client-side check for the Publish dialog. The Rust side (git_remote.rs) validates the same rules again and is authoritative.

const REMOTE_NAME_MAX = 64;
const REMOTE_URL_MAX = 2048;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOST = "[A-Za-z0-9][A-Za-z0-9.-]*";
const USER = "[A-Za-z0-9][A-Za-z0-9._-]*";
const PORT = "(?::\\d{1,5})?";
const HTTPS_URL = new RegExp(`^https://${HOST}${PORT}/.+$`);
const SSH_URL = new RegExp(`^ssh://(?:${USER}@)?${HOST}${PORT}/.+$`);
const SCP_URL = new RegExp(`^${USER}@${HOST}:.+$`);

/** Returns an error message, or null when the name is a plain remote name. */
export function validateRemoteName(name: string): string | null {
  if (name.length === 0 || name.length > REMOTE_NAME_MAX || !NAME_PATTERN.test(name) || name.includes("..")) {
    return "Remote name: use letters, digits, '.', '_' or '-', starting with a letter or digit";
  }
  return null;
}

const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Returns an error message, or null when the name is a plain GitHub repository name (mirrors Rust validate_repo_name). */
export function validateRepoName(name: string): string | null {
  const plain = name.length > 0 && name.length <= 100 && !name.startsWith("-") && name !== "." && name !== ".." && REPO_NAME_PATTERN.test(name);
  return plain ? null : "Repository name: use letters, digits, '.', '_' or '-' (no spaces or '/')";
}

/** A GitHub-safe default name taken from the folder name. */
export function suggestRepoName(folderName: string): string {
  const cleaned = folderName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/-+$/, "").slice(0, 100);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "repository";
}

/** Returns an error message, or null when the URL is https://, ssh:// or git@host:path. */
export function validateRemoteUrl(url: string): string | null {
  const plain = url.length > 0
    && url.length <= REMOTE_URL_MAX
    && !url.startsWith("-")
    && !/[\s\p{Cc}]/u.test(url)
    && (HTTPS_URL.test(url) || SSH_URL.test(url) || SCP_URL.test(url));
  return plain ? null : "Remote URL: use https://host/path, ssh://[user@]host[:port]/path or git@host:path";
}
