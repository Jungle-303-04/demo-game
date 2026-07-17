import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(
      new URL("../../../dist/services/ops-console/web", import.meta.url),
    ),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8085",
    },
  },
});
