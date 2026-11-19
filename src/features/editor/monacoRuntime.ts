import { createMonacoLanguages } from "./monacoLanguages";
import { createTypeScriptService } from "./typeScriptService";

const TYPESCRIPT_WORKER_LABELS = new Set(["typescript", "javascript"]);

async function initialize() {
  self.MonacoEnvironment = {
    // The TypeScript worker is only requested after its contribution is loaded, which happens on first TS/JS file.
    getWorker: async (_workerId: string, label: string) => {
      if (TYPESCRIPT_WORKER_LABELS.has(label)) {
        const { default: TypeScriptWorker } = await import("monaco-editor/language/typescript/ts.worker?worker");
        return new TypeScriptWorker();
      }
      const { default: EditorWorker } = await import("monaco-editor/editor/editor.worker?worker");
      return new EditorWorker();
    },
  };
  const [monaco] = await Promise.all([import("monaco-editor/editor"), import("monaco-editor/features/register.all")]);
  const { ModesRegistry } = await import("monaco-editor/editor/common/languages/modesRegistry");
  // Pinned Monaco adapter: the public register API drops the registry disposable.
  const languages = createMonacoLanguages(monaco, (language) => ModesRegistry.registerLanguage(language));
  const typeScript = createTypeScriptService(() => import("monaco-editor/language/typescript/monaco.contribution").then(() => undefined));
  return {
    monaco,
    languages: {
      setEnabled: languages.setEnabled,
      dispose: languages.dispose,
      /** Language detection is unchanged; TS/JS additionally starts the semantic service once it is enabled. */
      ensure: async (path: string) => {
        const language = await languages.ensure(path);
        if (language !== "plaintext") await typeScript.ensureFor(language)?.catch(() => undefined);
        return language;
      },
    },
  };
}
export type MonacoRuntime = Awaited<ReturnType<typeof initialize>>;
let pending: Promise<MonacoRuntime> | undefined;
/** No Monaco code, grammar or worker is loaded until an editor actually mounts. */
export function loadMonaco(): Promise<MonacoRuntime> {
  return pending ??= initialize().catch((error: unknown) => { pending = undefined; throw error; });
}
