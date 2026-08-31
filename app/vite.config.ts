import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        // The API's Zod schemas and shared helpers, so form validation and the
        // server agree by construction. See api/src/types.ts.
        "@shared": new URL("../api/src/types.ts", import.meta.url).pathname,
      },
    },
    server: {
      proxy: {
        // In production CloudFront routes /api/* to the Lambda on the same
        // origin, so the SPA always calls relative paths. Locally that maps to
        // the Hono node server; set VITE_DEV_API_PROXY_TARGET to point at a
        // deployed HttpApi instead.
        "/api": {
          target: env.VITE_DEV_API_PROXY_TARGET ?? "http://localhost:3000",
          changeOrigin: true,
        },
        // Deployed, /photos/* is a CloudFront behaviour onto the private photos
        // bucket. Locally the Hono server serves the same paths off disk, so
        // the API hands out identical URLs either way.
        "/photos": {
          target: env.VITE_DEV_API_PROXY_TARGET ?? "http://localhost:3000",
          changeOrigin: true,
        },
      },
    },
  };
});
