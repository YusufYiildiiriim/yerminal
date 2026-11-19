const TYPESCRIPT_LANGUAGES = new Set(["typescript", "javascript"]);

/**
 * Starts Monaco's TypeScript worker only when a TypeScript or JavaScript model is actually opened.
 * `start` runs at most once; a failed start clears the memo so the next file may retry.
 */
export function createTypeScriptService(start: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  return {
    ensureFor(languageId: string): Promise<void> | null {
      if (!TYPESCRIPT_LANGUAGES.has(languageId)) return null;
      return pending ??= start().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    },
  };
}
