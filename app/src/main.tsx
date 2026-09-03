import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Amplify } from "aws-amplify";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AuthProvider } from "./context/AuthContext";
import { DEV_AUTH } from "./lib/api";
import { createQueryClient } from "./lib/queryClient";
import "./theme.css";

/*
 * Amplify only handles authentication here -- the API is called with plain
 * fetch against the same origin. With DEV_AUTH there is no Cognito to
 * configure, which is what lets the app run with no AWS account at all.
 */
if (!DEV_AUTH) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_USER_POOL_ID ?? "",
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID ?? "",
      },
    },
  });
}

/*
 * Above AuthProvider, because MeProvider is itself a query now and signing out
 * has to be able to empty the cache.
 */
const queryClient = createQueryClient();

/*
 * Lazily, and only in development: a static import would put the panel in the
 * production bundle whether or not it is ever rendered.
 */
const Devtools = lazy(async () => {
  const { ReactQueryDevtools } = await import("@tanstack/react-query-devtools");
  return { default: ReactQueryDevtools };
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
        {import.meta.env.DEV && (
          <Suspense fallback={null}>
            <Devtools initialIsOpen={false} />
          </Suspense>
        )}
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
);

/*
 * Production only. The virtual module is created by vite-plugin-pwa, which is
 * not in vitest.config.ts (a standalone config, not a merge of vite.config.ts),
 * and in dev a worker in front of the /api and /photos proxies only obscures
 * what the server actually returned. Dynamic, so under test and in dev neither
 * the import nor its resolution ever happens.
 *
 * `immediate` takes the update on the next launch instead of prompting: in
 * standalone display there is no address bar and no reload button, so someone
 * left on a stale shell has no way out short of deleting the app.
 */
if (import.meta.env.PROD) {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
