import { openUrl } from "@tauri-apps/plugin-opener";
import { version as APP_VERSION } from "../../../package.json";
import releasesJson from "./releases.json";

export type ReleaseIssue = { number: number; title: string };
export type ReleaseNote = { version: string; date: string; issues: ReleaseIssue[] };
export type ReleaseNotesData = { repository: string; releases: ReleaseNote[] };

/** Bundled at build time from releases.json; no network access is needed to show the page. */
export const RELEASES: ReleaseNotesData = releasesJson;

/** The app version from package.json (tauri.conf.json and Cargo.toml must match; see tests/config/release-check.test.ts). */
export const CURRENT_VERSION: string = APP_VERSION;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/;

/** Returns a list of problems; an empty list means the data is valid. */
export function validateReleaseData(data: ReleaseNotesData): string[] {
  const problems: string[] = [];
  if (!REPOSITORY_PATTERN.test(data.repository)) problems.push(`repository must be a GitHub https URL: ${data.repository}`);
  const seen = new Set<string>();
  for (const release of data.releases) {
    if (!VERSION_PATTERN.test(release.version)) problems.push(`version must be x.y.z: ${release.version}`);
    if (seen.has(release.version)) problems.push(`version listed twice: ${release.version}`);
    seen.add(release.version);
    if (!DATE_PATTERN.test(release.date)) problems.push(`date must be YYYY-MM-DD in ${release.version}: ${release.date}`);
    for (const issue of release.issues) {
      if (!Number.isInteger(issue.number) || issue.number < 1) problems.push(`issue number must be a positive integer in ${release.version}: ${issue.number}`);
      if (typeof issue.title !== "string" || issue.title.trim() === "" || issue.title.length > 300) problems.push(`issue #${issue.number} in ${release.version} needs a title of 1-300 characters`);
    }
  }
  return problems;
}

/** GitHub issue page of this repository, or null for a number that cannot be an issue. */
export function issueUrl(number: number): string | null {
  if (!Number.isInteger(number) || number < 1) return null;
  return `${RELEASES.repository}/issues/${number}`;
}

const ALLOWED_ISSUE_URL = new RegExp("^" + RELEASES.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/issues/[1-9]\\d*$");

/** Only issue pages of this repository may be opened from the version notes. */
export function isAllowedIssueUrl(url: string): boolean {
  return ALLOWED_ISSUE_URL.test(url);
}

/** Opens a GitHub issue in the default browser. Returns false, and opens nothing, for any other URL. */
export async function openIssueUrl(url: string): Promise<boolean> {
  if (!isAllowedIssueUrl(url)) return false;
  await openUrl(url);
  return true;
}
