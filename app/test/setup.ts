import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/*
 * Setup files run for every suite, including the ones that opt into
 * `@vitest-environment node` to read the build output, where there is no
 * `window` to hang a stub on.
 */
if (typeof window !== "undefined") {
  // jsdom has neither, and components use both.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });

  // `configurable` matters as well as `writable`: userEvent.setup() installs its
  // own clipboard stub, and cannot replace a property that is pinned down.
  Object.defineProperty(navigator, "clipboard", {
    writable: true,
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
}
