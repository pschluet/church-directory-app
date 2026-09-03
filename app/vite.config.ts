import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());

  /*
   * In production CloudFront routes /api/* to the Lambda and /photos/* to the
   * private photos bucket on the same origin, so the SPA always calls relative
   * paths. Locally both map to the Hono node server, which serves photos off
   * disk under PHOTO_STORAGE=local and so hands out identical URLs either way.
   * Set VITE_DEV_API_PROXY_TARGET to point at a deployed HttpApi instead.
   *
   * Shared with `preview`, which has its own proxy option and does not inherit
   * the dev server's: `vite preview` is the only way to exercise the service
   * worker locally, since it is the only local server that runs the build.
   */
  const target = env.VITE_DEV_API_PROXY_TARGET ?? "http://localhost:3000";
  const proxy = {
    "/api": { target, changeOrigin: true },
    "/photos": { target, changeOrigin: true },
  };

  return {
    plugins: [
      react(),
      tailwindcss(),
      /*
       * Installable, so the directory can live on a home screen: this is the
       * app someone opens standing in the parking lot after a service, and one
       * tap beats recalling a URL. Standalone display also gives back the
       * ~90px of browser chrome, which the card lists and the full-screen
       * photo view all want.
       *
       * It caches the app shell and nothing else. See workbox.runtimeCaching
       * below -- that restraint is the whole point, not an omission.
       */
      VitePWA({
        registerType: "autoUpdate",
        // Both favicons and the iOS icon live in public/ and are referenced
        // only from index.html, so Workbox would not otherwise precache them.
        includeAssets: ["favicon.ico", "favicon.svg", "apple-touch-icon-180x180.png"],
        manifest: {
          id: "/",
          // Parish-neutral: one deployment serves every parish, and AppShell
          // shows the signed-in organization's own name.
          name: "Parish Directory",
          short_name: "Directory",
          description: "Parish directory",
          // Not a deep link. Sign-in is an email one-time code, so the user
          // leaves for their mail app and comes back, and App.tsx sends anyone
          // without a session to Login regardless of where they entered.
          start_url: "/",
          scope: "/",
          display: "standalone",
          /*
           * Not "portrait". Android honours a manifest orientation lock for an
           * installed app, so that setting made a tablet refuse to rotate --
           * while iOS ignores the field entirely, which is why the same build
           * rotated on an iPhone and hid the problem. Nothing here wants to be
           * locked: the card lists reflow, and the full-screen photo view is
           * better in landscape for a photo that was taken that way.
           */
          orientation: "any",
          // The liturgical red and white from theme.css, so the splash screen
          // and title bar match the app rather than flashing a default.
          theme_color: "#b42d23",
          background_color: "#ffffff",
          icons: [
            { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
            { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
            {
              src: "maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Deliberately no `woff`: @fontsource emits both, every browser that
          // can run this app takes the woff2, and precaching the pair would
          // download 96KB nobody ever requests.
          globPatterns: ["**/*.{js,css,html,woff2,svg,ico,png,webmanifest}"],

          // A deep link like /dates has no extension and so no precache entry;
          // serve the shell and let the router take it. This mirrors the
          // CloudFront SpaFallback function, which rewrites any URI without a
          // dot to /index.html.
          navigateFallback: "/index.html",
          // Both are same-origin (see server.proxy below), so a document
          // request under either prefix has to reach the network rather than
          // being answered with the shell. Matched by prefix and not by
          // extension on purpose: photo renditions are extensionless, e.g.
          // /photos/<org>/person/<id>/<ulid>/thumb.
          navigateFallbackDenylist: [/^\/api\//, /^\/photos\//],

          /*
           * Empty, and it has to stay empty. generateSW only intercepts what
           * it has a route for, so with no runtime routes every /api/* fetch,
           * every /photos/* <img> and every presigned S3 upload falls straight
           * through to the network and nothing personal is written to disk.
           *
           * This is the same decision lib/queryClient.ts makes about a
           * localStorage persister, for the same reason: the alternative is
           * the parish's phone numbers and addresses sitting on whatever phone
           * last signed in. A runtimeCaching entry for either prefix would
           * undo it silently, which is what test/serviceWorker.test.ts
           * watches for. Photos are already cached by the browser and the
           * CloudFront edge -- their paths are permanent ULIDs -- so there is
           * nothing to gain here either.
           */
          runtimeCaching: [],
        },
        // The dev server proxies /api and /photos to the Hono server; a worker
        // sitting in front of that only makes local debugging harder.
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        // The API's Zod schemas and shared helpers, so form validation and the
        // server agree by construction. See api/src/types.ts.
        "@shared": new URL("../api/src/types.ts", import.meta.url).pathname,
      },
    },
    server: { proxy },
    preview: { proxy },
  };
});
