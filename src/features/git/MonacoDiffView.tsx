import { useEffect, useRef } from "react";
import type { EditorLanguageId } from "../editor/editorLanguages";
import { loadMonaco } from "../editor/monacoRuntime";
import { applyYerminalTheme } from "../editor/monacoTheme";
import type { ThemeId } from "../settings/SettingsDialog";
import "../editor/monaco-editor.css";

export type MonacoDiffViewProps = {
  original: string;
  modified: string;
  path: string;
  enabledLanguages: readonly EditorLanguageId[];
  fontFamily?: string;
  fontSize?: number;
  theme: ThemeId;
  onUnavailable: () => void;
};
let nextDiffId = 0;

/** Read-only side-by-side Monaco diff of two full texts. Monaco loads only when this view mounts. */
export function MonacoDiffView({ original, modified, path, enabledLanguages, fontFamily, fontSize, theme, onUnavailable }: MonacoDiffViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const latestUnavailable = useRef(onUnavailable);
  latestUnavailable.current = onUnavailable;

  useEffect(() => {
    let closed = false;
    let dispose: (() => void) | undefined;
    void loadMonaco().then(async (runtime) => {
      if (closed || !host.current) return;
      const { monaco } = runtime;
      const id = ++nextDiffId;
      const name = encodeURIComponent(path.split(/[\/]/).pop() ?? path);
      const originalModel = monaco.editor.createModel(original, "plaintext", monaco.Uri.parse(`inmemory://yerminal-diff/${id}/base/${name}`));
      const modifiedModel = monaco.editor.createModel(modified, "plaintext", monaco.Uri.parse(`inmemory://yerminal-diff/${id}/current/${name}`));
      const editor = monaco.editor.createDiffEditor(host.current, { readOnly: true, originalEditable: false, renderSideBySide: true, automaticLayout: true, scrollBeyondLastLine: false, fontFamily, fontSize, ariaLabel: "Diff of " + path });
      editor.setModel({ original: originalModel, modified: modifiedModel });
      applyYerminalTheme(monaco, host.current, theme);
      dispose = () => { editor.dispose(); originalModel.dispose(); modifiedModel.dispose(); };
      runtime.languages.setEnabled(enabledLanguages);
      const language = await runtime.languages.ensure(path);
      if (closed) return;
      monaco.editor.setModelLanguage(originalModel, language);
      monaco.editor.setModelLanguage(modifiedModel, language);
    }).catch(() => { if (!closed) latestUnavailable.current(); });
    return () => { closed = true; dispose?.(); };
    // Versions and path identify the diff; option changes do not need a new model.
  }, [original, modified, path]);

  return <div className="monaco-code-editor-shell diff-monaco-shell"><div className="monaco-code-editor diff-monaco" ref={host} /></div>;
}
