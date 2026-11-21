import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor/editor";
import type { EditorLanguageId } from "./editorLanguages";
import { loadMonaco, type MonacoRuntime } from "./monacoRuntime";
import type { ThemeId } from "../settings/SettingsDialog";
import { applyYerminalTheme } from "./monacoTheme";
import "./monaco-editor.css";

export type MonacoCodeEditorProps = {
  id: string; path: string; name: string; value: string; readOnly: boolean;
  enabledLanguages: readonly EditorLanguageId[]; fontFamily: string; fontSize: number; theme: ThemeId; minimap?: boolean;
  onChange: (value: string) => void; onSave: () => void;
};
type MountedEditor = { runtime: MonacoRuntime; model: editor.ITextModel; editor: editor.IStandaloneCodeEditor };
let nextModelId = 0;

export function MonacoCodeEditor(props: MonacoCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const applying = useRef(false);
  const [mounted, setMounted] = useState<MountedEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [languageError, setLanguageError] = useState(false);

  useEffect(() => {
    let closed = false;
    let dispose: (() => void) | undefined;
    setError(null);
    void loadMonaco().then((runtime) => {
      if (closed || !host.current) return;
      const current = latest.current;
      const { monaco } = runtime;
      const model = monaco.editor.createModel(current.value, "plaintext", monaco.Uri.parse(`inmemory://yerminal/${++nextModelId}/${encodeURIComponent(current.name)}`));
      model.updateOptions({ tabSize: 4, insertSpaces: true });
      let instance: editor.IStandaloneCodeEditor;
      try {
        instance = monaco.editor.create(host.current, { model, automaticLayout: true, readOnly: current.readOnly, ariaLabel: (current.readOnly ? "Contents of " : "Edit ") + current.name, fontFamily: current.fontFamily, fontSize: current.fontSize, minimap: { enabled: current.minimap !== false }, scrollBeyondLastLine: false, wordBasedSuggestions: "currentDocument", padding: { top: 12 }, theme: "vs-dark" });
      } catch (reason) { model.dispose(); throw reason; }
      const changes = instance.onDidChangeModelContent(() => {
        if (!applying.current && !latest.current.readOnly) latest.current.onChange(model.getValue());
      });
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { if (!latest.current.readOnly) latest.current.onSave(); });
      dispose = () => { changes.dispose(); instance.dispose(); model.dispose(); };
      setMounted({ runtime, model, editor: instance });
    }).catch(() => { if (!closed) setError("Could not load the editor. Your file content is preserved."); });
    return () => { closed = true; dispose?.(); };
  }, [props.id, attempt]);

  useEffect(() => {
    if (!mounted) return;
    if (mounted.model.getValue() !== props.value) {
      applying.current = true;
      try { mounted.model.setValue(props.value); } finally { applying.current = false; }
    }
  }, [mounted, props.value]);

  useEffect(() => {
    if (!mounted) return;
    mounted.editor.updateOptions({ fontFamily: props.fontFamily, fontSize: props.fontSize, readOnly: props.readOnly, minimap: { enabled: props.minimap !== false }, ariaLabel: (props.readOnly ? "Contents of " : "Edit ") + props.name });
    applyYerminalTheme(mounted.runtime.monaco, host.current, props.theme);
  }, [mounted, props.fontFamily, props.fontSize, props.readOnly, props.name, props.theme, props.minimap]);

  useEffect(() => {
    if (!mounted) return;
    let current = true;
    const { languages, monaco } = mounted.runtime;
    languages.setEnabled(props.enabledLanguages);
    monaco.editor.setModelLanguage(mounted.model, "plaintext");
    setLanguageError(false);
    void languages.ensure(props.path).then((language) => { if (current) monaco.editor.setModelLanguage(mounted.model, language); }).catch(() => { if (current) setLanguageError(true); });
    return () => { current = false; };
  }, [mounted, props.path, props.enabledLanguages]);

  return <div className="monaco-code-editor-shell">
    {error ? <div className="code-editor-message" role="alert">{error}<button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry editor</button></div> : !mounted && <div className="monaco-loading" role="status">Loading editor…</div>}
    {languageError && <div className="monaco-language-error" role="status">Syntax support could not load. Editing as plain text.</div>}
    <div className="monaco-code-editor" ref={host} />
  </div>;
}
