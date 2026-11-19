import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor/editor";
import type { EditorLanguageId } from "../editor/editorLanguages";
import { loadMonaco, type MonacoRuntime } from "../editor/monacoRuntime";
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
type MountedDiff = { runtime: MonacoRuntime; editor: editor.IStandaloneDiffEditor; original: editor.ITextModel; modified: editor.ITextModel };
let nextDiffId = 0;

/** Read-only side-by-side Monaco diff of two full texts. Monaco loads only when this view mounts. */
export function MonacoDiffView(props: MonacoDiffViewProps) {
  const { original, modified, path, enabledLanguages, fontFamily, fontSize, theme } = props;
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [mounted, setMounted] = useState<MountedDiff | null>(null);

  // The diff is recreated only when the texts or path change; theme, fonts and languages update in place below.
  useEffect(() => {
    let closed = false;
    let created: MountedDiff | undefined;
    void loadMonaco().then((runtime) => {
      if (closed || !host.current) return;
      const { monaco } = runtime;
      const id = ++nextDiffId;
      const name = encodeURIComponent(path.split(/[\/]/).pop() ?? path);
      const originalModel = monaco.editor.createModel(original, "plaintext", monaco.Uri.parse(`inmemory://yerminal-diff/${id}/base/${name}`));
      const modifiedModel = monaco.editor.createModel(modified, "plaintext", monaco.Uri.parse(`inmemory://yerminal-diff/${id}/current/${name}`));
      const current = latest.current;
      const instance = monaco.editor.createDiffEditor(host.current, { readOnly: true, originalEditable: false, renderSideBySide: true, automaticLayout: true, scrollBeyondLastLine: false, fontFamily: current.fontFamily, fontSize: current.fontSize, ariaLabel: "Diff of " + path });
      instance.setModel({ original: originalModel, modified: modifiedModel });
      created = { runtime, editor: instance, original: originalModel, modified: modifiedModel };
      setMounted(created);
    }).catch(() => { if (!closed) latest.current.onUnavailable(); });
    return () => {
      closed = true;
      if (created) {
        created.editor.dispose();
        created.original.dispose();
        created.modified.dispose();
      }
      setMounted(null);
    };
  }, [original, modified, path]);

  useEffect(() => {
    if (!mounted) return;
    applyYerminalTheme(mounted.runtime.monaco, host.current, theme);
  }, [mounted, theme]);

  useEffect(() => {
    if (!mounted) return;
    mounted.editor.updateOptions({ fontFamily, fontSize });
  }, [mounted, fontFamily, fontSize]);

  useEffect(() => {
    if (!mounted) return;
    let current = true;
    const { languages, monaco } = mounted.runtime;
    languages.setEnabled(enabledLanguages);
    void languages.ensure(path).then((language) => {
      if (!current) return;
      monaco.editor.setModelLanguage(mounted.original, language);
      monaco.editor.setModelLanguage(mounted.modified, language);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [mounted, path, enabledLanguages]);

  return <div className="monaco-code-editor-shell diff-monaco-shell"><div className="monaco-code-editor diff-monaco" ref={host} /></div>;
}
