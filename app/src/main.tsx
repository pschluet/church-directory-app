import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Amplify } from "aws-amplify";
import { App } from "./App";
import { AuthProvider } from "./context/AuthContext";
import { DEV_AUTH } from "./lib/api";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
