/** A ready-made app for the right dock. Adding an app = adding one line here. */
export interface AppDef {
  id: string;
  name: string;
  url: string;
  /** How the app's window title ends (or equals); lets an already open window of the site be reused. */
  titleHint: string;
}

export const APP_CATALOG: readonly AppDef[] = [
  { id: "youtube-music", name: "YouTube Music", url: "https://music.youtube.com", titleHint: "YouTube Music" },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com", titleHint: "YouTube" },
  { id: "x", name: "X", url: "https://x.com", titleHint: "X" },
];

export function findApp(id: string): AppDef | undefined {
  return APP_CATALOG.find((app) => app.id === id);
}
