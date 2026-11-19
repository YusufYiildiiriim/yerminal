import type * as Monaco from "monaco-editor/editor";
import { createLanguageRegistry, EDITOR_LANGUAGES, type EditorLanguageId } from "./editorLanguages";

// Import definitions, never their register entry points: registration must remain reversible.
const grammars = {
  csharp: () => import("monaco-editor/languages/definitions/csharp/csharp"),
  razor: () => import("monaco-editor/languages/definitions/razor/razor"),
  typescript: () => import("monaco-editor/languages/definitions/typescript/typescript"),
  javascript: () => import("monaco-editor/languages/definitions/javascript/javascript"),
  html: () => import("monaco-editor/languages/definitions/html/html"),
  css: () => import("monaco-editor/languages/definitions/css/css"),
  markdown: () => import("monaco-editor/languages/definitions/markdown/markdown"),
  yaml: () => import("monaco-editor/languages/definitions/yaml/yaml"),
  sql: () => import("monaco-editor/languages/definitions/sql/sql"),
  shell: () => import("monaco-editor/languages/definitions/shell/shell"),
  powershell: () => import("monaco-editor/languages/definitions/powershell/powershell"),
  python: () => import("monaco-editor/languages/definitions/python/python"),
  cpp: () => import("monaco-editor/languages/definitions/cpp/cpp"),
  go: () => import("monaco-editor/languages/definitions/go/go"),
  java: () => import("monaco-editor/languages/definitions/java/java"),
  kotlin: () => import("monaco-editor/languages/definitions/kotlin/kotlin"),
  lua: () => import("monaco-editor/languages/definitions/lua/lua"),
  php: () => import("monaco-editor/languages/definitions/php/php"),
  ruby: () => import("monaco-editor/languages/definitions/ruby/ruby"),
  rust: () => import("monaco-editor/languages/definitions/rust/rust"),
  scss: () => import("monaco-editor/languages/definitions/scss/scss"),
  swift: () => import("monaco-editor/languages/definitions/swift/swift"),
  xml: () => import("monaco-editor/languages/definitions/xml/xml"),
  dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/dockerfile"),
  json: () => import("./monacoJson"),
} satisfies Record<EditorLanguageId, () => Promise<{ conf: Monaco.languages.LanguageConfiguration; language: Monaco.languages.IMonarchLanguage }>>;

export function createMonacoLanguages(monaco: typeof Monaco, register: (language: Monaco.languages.ILanguageExtensionPoint) => Monaco.IDisposable) {
  return createLanguageRegistry(async (id) => {
    const { conf, language } = await grammars[id]();
    const definition = EDITOR_LANGUAGES.find((item) => item.id === id)!;
    const registrations: Monaco.IDisposable[] = [];
    try {
      registrations.push(register({ id, aliases: [definition.label], extensions: definition.extensions.map((extension) => "." + extension) }));
      registrations.push(monaco.languages.setLanguageConfiguration(id, conf));
      registrations.push(monaco.languages.setMonarchTokensProvider(id, language));
      return { dispose: () => registrations.reverse().forEach((registration) => registration.dispose()) };
    } catch (error) {
      registrations.reverse().forEach((registration) => registration.dispose());
      throw error;
    }
  });
}
