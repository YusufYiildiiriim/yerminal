import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
    // Git worktrees under .temp/ carry their own copy of tests/; never collect them.
    exclude: [...configDefaults.exclude, ".temp/**"],
  },
});
