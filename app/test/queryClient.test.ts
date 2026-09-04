import { describe, expect, it } from "vitest";
import { createQueryClient } from "../src/lib/queryClient";

/**
 * The two app-wide defaults that other decisions rest on.
 *
 * Both are the kind of setting that looks harmless to change and quietly
 * changes behaviour everywhere, with nothing else failing.
 */
describe("createQueryClient defaults", () => {
  const defaults = () => createQueryClient().getDefaultOptions().queries;

  it("keeps refetch-on-focus opt-in", () => {
    /*
     * Exactly three queries turn this on -- the notification bell's inbox and
     * the two on the prayer requests page -- because those are the only ones
     * where something can change without the member doing anything. Flipping
     * the default to true would silently enable it for all two dozen queries in
     * the app, which is a traffic change no other test would notice.
     */
    expect(defaults()?.refetchOnWindowFocus).toBe(false);
  });

  it("persists nothing", () => {
    /*
     * There is no persister, and that is the point: the alternative is the
     * parish's phone numbers and addresses sitting in localStorage on whatever
     * phone last signed in. The service worker refuses to cache /api/* for the
     * same reason (see test/serviceWorker.test.ts).
     */
    expect(defaults()?.gcTime).toBeUndefined();
    expect(defaults()?.staleTime).toBe(30_000);
  });
});
