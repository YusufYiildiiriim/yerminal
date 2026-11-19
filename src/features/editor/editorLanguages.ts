/** Language choices are data only: importing this module never loads an editor or grammar. */
export const EDITOR_LANGUAGES = [
  { id: "csharp", label: "C#", extensions: ["cs"], defaultEnabled: true },
  { id: "razor", label: "Razor / CSHTML", extensions: ["razor", "cshtml"], defaultEnabled: true },
  { id: "typescript", label: "TypeScript / TSX", extensions: ["ts", "tsx", "mts", "cts"], defaultEnabled: true },
  { id: "javascript", label: "JavaScript / JSX", extensions: ["js", "jsx", "mjs", "cjs"], defaultEnabled: true },
  { id: "html", label: "HTML", extensions: ["html", "htm"], defaultEnabled: true },
  { id: "css", label: "CSS", extensions: ["css"], defaultEnabled: true },
  { id: "json", label: "JSON / JSONC", extensions: ["json", "jsonc"], defaultEnabled: true },
  { id: "markdown", label: "Markdown", extensions: ["md", "markdown"], defaultEnabled: true },
  { id: "yaml", label: "YAML", extensions: ["yaml", "yml"], defaultEnabled: true },
  { id: "sql", label: "SQL", extensions: ["sql"], defaultEnabled: true },
  { id: "shell", label: "Shell / Bash", extensions: ["sh", "bash", "zsh"], defaultEnabled: true },
  { id: "powershell", label: "PowerShell", extensions: ["ps1", "psm1", "psd1"], defaultEnabled: true },
  { id: "python", label: "Python", extensions: ["py", "pyw"], defaultEnabled: false },
  { id: "cpp", label: "C / C++", extensions: ["c", "cc", "cpp", "cxx", "h", "hpp"], defaultEnabled: false },
  { id: "go", label: "Go", extensions: ["go"], defaultEnabled: false },
  { id: "java", label: "Java", extensions: ["java"], defaultEnabled: false },
  { id: "kotlin", label: "Kotlin", extensions: ["kt", "kts"], defaultEnabled: false },
  { id: "lua", label: "Lua", extensions: ["lua"], defaultEnabled: false },
  { id: "php", label: "PHP", extensions: ["php"], defaultEnabled: false },
  { id: "ruby", label: "Ruby", extensions: ["rb"], defaultEnabled: false },
  { id: "rust", label: "Rust", extensions: ["rs"], defaultEnabled: false },
  { id: "scss", label: "SCSS", extensions: ["scss"], defaultEnabled: false },
  { id: "swift", label: "Swift", extensions: ["swift"], defaultEnabled: false },
  { id: "xml", label: "XML", extensions: ["xml", "svg"], defaultEnabled: false },
  { id: "dockerfile", label: "Dockerfile", extensions: [], defaultEnabled: false },
] as const;

export type EditorLanguageId = typeof EDITOR_LANGUAGES[number]["id"];
export type EditorLanguage = { id: EditorLanguageId | "plaintext"; label: string };
export const DEFAULT_LANGUAGES: readonly EditorLanguageId[] = EDITOR_LANGUAGES.filter((language) => language.defaultEnabled).map((language) => language.id);
const knownIds = new Set<string>(EDITOR_LANGUAGES.map((language) => language.id));

/** Missing or malformed preferences use defaults; an empty list deliberately disables all languages. */
export function normalizeEnabledLanguages(value: unknown): EditorLanguageId[] {
  if (!Array.isArray(value)) return [...DEFAULT_LANGUAGES];
  return [...new Set(value.filter((id): id is EditorLanguageId => typeof id === "string" && knownIds.has(id)))];
}

export function detectEditorLanguage(path: string): EditorLanguage {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  const language = name === "dockerfile" || name.startsWith("dockerfile.")
    ? EDITOR_LANGUAGES.find((candidate) => candidate.id === "dockerfile")
    : EDITOR_LANGUAGES.find((candidate) => (candidate.extensions as readonly string[]).includes(extension));
  return language ? { id: language.id, label: language.label } : { id: "plaintext", label: "Plain Text" };
}

type Registration = { dispose: () => void };
type PendingLanguage = { promise: Promise<EditorLanguageId | "plaintext">; registration?: Registration };

/** The loader owns grammar/provider registration and must return a disposable for all of them. */
export function createLanguageRegistry(load: (id: EditorLanguageId) => Promise<Registration>) {
  let enabled = new Set<EditorLanguageId>();
  const pending = new Map<EditorLanguageId, PendingLanguage>();

  function setEnabled(ids: readonly EditorLanguageId[]) {
    enabled = new Set(ids);
    for (const [id, entry] of pending) {
      if (enabled.has(id)) continue;
      pending.delete(id);
      entry.registration?.dispose();
    }
  }

  async function ensure(path: string): Promise<EditorLanguageId | "plaintext"> {
    const id = detectEditorLanguage(path).id;
    if (id === "plaintext" || !enabled.has(id)) return "plaintext";
    const existing = pending.get(id);
    if (existing) return existing.promise;
    const entry: PendingLanguage = { promise: Promise.resolve("plaintext") };
    // Keep the entry identity so disabling and re-enabling during an import cannot retain stale providers.
    entry.promise = load(id).then((registration) => {
      if (pending.get(id) !== entry || !enabled.has(id)) {
        registration.dispose();
        return "plaintext";
      }
      entry.registration = registration;
      return id;
    }).catch((error: unknown) => {
      if (pending.get(id) === entry) pending.delete(id);
      throw error;
    });
    pending.set(id, entry);
    return entry.promise;
  }

  return { setEnabled, ensure, dispose: () => setEnabled([]) };
}
