/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_USER_POOL_ID?: string;
  readonly VITE_USER_POOL_CLIENT_ID?: string;
  /**
   * "true" when the local API server is running with DEV_AUTH_EMAIL set. The
   * SPA then skips the sign-in screen and sends no Authorization header,
   * because the server is injecting the claims itself.
   */
  readonly VITE_DEV_AUTH?: string;
  readonly VITE_DEV_API_PROXY_TARGET?: string;
  /** Where the emoji picker's data is served from; injected by the emojibase plugin in vite.config.ts. */
  readonly VITE_EMOJIBASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
