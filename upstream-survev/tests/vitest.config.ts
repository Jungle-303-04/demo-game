import { defineConfig } from "vitest/config";

// Keep the upstream game suite hermetic. Vitest otherwise walks parent
// directories for Vite/Wrangler configuration, which makes linked worktrees
// inherit unrelated host-project plugins.
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
    },
});
