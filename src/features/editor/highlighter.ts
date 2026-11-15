import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import githubDark from "@shikijs/themes/github-dark";

const languageLoaders: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  makefile: () => import("@shikijs/langs/makefile"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
let readyHighlighter: HighlighterCore | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const attempt: Promise<HighlighterCore> = createHighlighterCore({
      themes: [githubDark],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).catch((reason: unknown) => {
      // Forget the failed attempt so a later call can retry initialization.
      if (highlighterPromise === attempt) highlighterPromise = null;
      throw reason;
    });
    highlighterPromise = attempt;
  }
  return highlighterPromise;
}

export async function highlightCode(code: string, language: string): Promise<string> {
  const loadLanguage = languageLoaders[language];
  if (!loadLanguage) throw new Error(`Unsupported syntax language: ${language}`);
  const highlighter = await getHighlighter();
  readyHighlighter = highlighter;
  if (!highlighter.getLoadedLanguages().includes(language)) await highlighter.loadLanguage(loadLanguage);
  return highlighter.codeToHtml(code, { lang: language, theme: "github-dark" });
}



/**
 * Highlights synchronously once the engine and the language are already loaded; returns null otherwise.
 * Lets the editable overlay recolor every keystroke instead of flashing to plain text until the async pass lands.
 */
export function highlightCodeSync(code: string, language: string): string | null {
  if (!readyHighlighter || !readyHighlighter.getLoadedLanguages().includes(language)) return null;
  try {
    return readyHighlighter.codeToHtml(code, { lang: language, theme: "github-dark" });
  } catch {
    return null;
  }
}
