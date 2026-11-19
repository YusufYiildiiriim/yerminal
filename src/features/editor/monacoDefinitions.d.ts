declare module "monaco-editor/languages/definitions/*" {
  import type { languages } from "monaco-editor/editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
declare module "monaco-editor/editor/common/languages/modesRegistry" {
  import type { languages, IDisposable } from "monaco-editor/editor";
  export const ModesRegistry: { registerLanguage(language: languages.ILanguageExtensionPoint): IDisposable };
}
