import { createMonacoLanguages } from "./monacoLanguages";

async function initialize() {
  self.MonacoEnvironment = {
    getWorker: async () => {
      const { default: EditorWorker } = await import("monaco-editor/editor/editor.worker?worker");
      return new EditorWorker();
    },
  };
  const [monaco] = await Promise.all([import("monaco-editor/editor"), import("monaco-editor/features/register.all")]);
  const { ModesRegistry } = await import("monaco-editor/editor/common/languages/modesRegistry");
  // Pinned Monaco adapter: the public register API drops the registry disposable.
  return { monaco, languages: createMonacoLanguages(monaco, (language) => ModesRegistry.registerLanguage(language)) };
}
export type MonacoRuntime = Awaited<ReturnType<typeof initialize>>;
let pending: Promise<MonacoRuntime> | undefined;
/** No Monaco code, grammar or worker is loaded until an editor actually mounts. */
export function loadMonaco(): Promise<MonacoRuntime> {
  return pending ??= initialize().catch((error: unknown) => { pending = undefined; throw error; });
}
