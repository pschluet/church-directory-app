import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@shared": new URL("../api/src/types.ts", import.meta.url).pathname },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
