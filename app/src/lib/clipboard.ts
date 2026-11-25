import { showToast } from "../components/ui";

/**
 * Copies, and says so with a toast: the menu the action was in has already
 * closed (or there never was one -- a long press), so without the toast nothing
 * on screen would show that anything happened.
 */
export function copyWithToast(text: string, done: string): void {
  if (!navigator.clipboard) {
    showToast("Copying is not available here");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => showToast(done),
    () => showToast("Could not copy")
  );
}
