/** An app of the right dock as the backend reports it. The page never sees a path or a url. */
export interface AppInfo {
  id: string;
  name: string;
  kind: "builtin" | "custom";
}

/** Shown until (or when) the backend list is not there; the real catalog and its urls live in the backend. */
export const READY_MADE_APPS: readonly AppInfo[] = [
  { id: "youtube-music", name: "YouTube Music", kind: "builtin" },
  { id: "youtube", name: "YouTube", kind: "builtin" },
  { id: "x", name: "X", kind: "builtin" },
];

export function splitApps(list: readonly AppInfo[]): { ready: AppInfo[]; own: AppInfo[] } {
  return { ready: list.filter((app) => app.kind === "builtin"), own: list.filter((app) => app.kind === "custom") };
}

/** Display name of an id: current list first, then a name seen earlier (an app removed from the list while open), then the id. */
export function nameOf(id: string, list: readonly AppInfo[], seen: ReadonlyMap<string, string>): string {
  return list.find((app) => app.id === id)?.name ?? seen.get(id) ?? id;
}
