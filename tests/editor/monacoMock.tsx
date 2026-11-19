import type { MonacoCodeEditorProps } from "../../src/features/editor/MonacoCodeEditor";
// App integration tests exercise persistence and shortcuts through this editor boundary.
// The real adapter lifecycle and browser rendering are verified separately.
export function MonacoCodeEditor(props: MonacoCodeEditorProps) {
  return <div className="monaco-code-editor"><textarea aria-label={(props.readOnly ? "Contents of " : "Edit ") + props.name} readOnly={props.readOnly} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); if (!props.readOnly) props.onSave(); }
  }} /></div>;
}
