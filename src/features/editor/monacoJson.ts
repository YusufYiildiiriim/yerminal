import type { languages } from "monaco-editor/editor";
// A local JSON/JSONC tokenizer avoids the upstream JSON entry point's permanent auto-registration.
export const conf: languages.LanguageConfiguration = { brackets: [["{", "}"], ["[", "]"]], autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: '"', close: '"', notIn: ["string"] }], comments: { lineComment: "//", blockComment: ["/*", "*/"] } };
export const language: languages.IMonarchLanguage = {
  tokenPostfix: ".json", tokenizer: {
    root: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, "key"], [/"/, "string", "@string"], [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"], [/\b(?:true|false|null)\b/, "keyword"], [/[{}\[\]]/, "@brackets"], [/[,:]/, "delimiter"], [/\/\/.*$/, "comment"], [/\/\*/, "comment", "@comment"]],
    string: [[/[^\\"]+/, "string"], [/\\./, "string.escape"], [/"/, "string", "@pop"]],
    comment: [[/[^*]+/, "comment"], [/\*\//, "comment", "@pop"], [/\*/, "comment"]],
  },
};
