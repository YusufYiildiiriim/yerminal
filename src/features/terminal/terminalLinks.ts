import type { IDisposable, ILink, Terminal } from "@xterm/xterm";

export type TerminalUrlMatch = { start: number; end: number; url: string };

const URL_PATTERN = /https?:\/\/[^\s]+/g;
const TRAILING_PUNCTUATION = /[.,;)\]]/;

export function findUrls(line: string): TerminalUrlMatch[] {
  const matches: TerminalUrlMatch[] = [];
  for (const raw of line.matchAll(URL_PATTERN)) {
    const rawStart = raw.index ?? 0;
    const rawEnd = rawStart + raw[0].length;
    const schemeEnd = raw[0].indexOf("//") + 2;
    let url = raw[0];
    let end = rawEnd;
    while (url.length > schemeEnd && TRAILING_PUNCTUATION.test(url[url.length - 1] ?? "")) {
      url = url.slice(0, -1);
      end -= 1;
    }
    if (url.length > schemeEnd) matches.push({ start: rawStart, end, url });
  }
  return matches;
}

export function registerUrlLinks(
  terminal: Terminal,
  handlers: { open: (url: string) => void; hint: (message: string) => void },
): IDisposable {
  const activate = (event: MouseEvent, url: string) => {
    if (event.ctrlKey || event.metaKey) handlers.open(url);
    else handlers.hint("Hold Ctrl (⌘ on macOS) and click to open the link.");
  };
  return terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      callback(findUrls(line.translateToString(true)).map((match) => toLink(match, bufferLineNumber, activate)));
    },
  });
}

function toLink(match: TerminalUrlMatch, bufferLineNumber: number, activate: (event: MouseEvent, url: string) => void): ILink {
  return {
    range: {
      start: { x: match.start + 1, y: bufferLineNumber },
      end: { x: match.end, y: bufferLineNumber },
    },
    text: match.url,
    activate,
    decorations: { underline: true, pointerCursor: true },
  };
}
