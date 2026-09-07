import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";

/**
 * How deep into the app you are, and how to get back out.
 *
 * The app is installable and runs in standalone display mode, where there is no
 * address bar and no browser back button -- so on the phone this is written for,
 * a page reached from the directory had no way back at all short of an
 * edge-swipe, which is invisible until you already know it is there.
 *
 * Two things are tracked, and they are not the same thing:
 *
 *   - **depth**, which decides whether the chevron is shown at all. Seeded from
 *     React Router's own `history.state.idx`, which it sets to 0 on the first
 *     load and increments on each push. Seeding from it rather than starting at
 *     zero is what keeps the chevron after a reload halfway down the stack, and
 *     what correctly *withholds* it from someone who arrived on a deep link from
 *     outside the app, where going back would leave it.
 *   - **the entries themselves**, by index, so a pop's *distance* is knowable.
 *     `useNavigationType` says only that something was a pop; it cannot say
 *     whether it went back one entry or four.
 */

interface NavStack {
  canGoBack: boolean;
  goBack: () => void;
  /** Home, discarding the stack -- the header title. */
  resetToHome: () => void;
}

interface Entry {
  key: string;
  pathname: string;
}

const NavStackContext = createContext<NavStack | null>(null);

/**
 * React Router's index for the current history entry.
 *
 * Read defensively: it is absent under a memory router (which never touches
 * `window.history`) and on the very first render before the router's own
 * `replaceState` has run, and either way zero -- "this is where we started" --
 * is the right answer.
 */
function seedDepth(): number {
  const idx: unknown = window.history.state?.idx;
  return typeof idx === "number" && idx > 0 ? idx : 0;
}

/**
 * The entry the chevron would land on: the nearest one below us whose path is
 * not the one we are already on.
 *
 * "One entry back" and "the previous page" are different questions here.
 * Directory's "account holders only" and each of the audit log's five filters
 * push deliberately, so that the browser's own back button undoes them -- which
 * is worth keeping, and which means the history is not a list of pages. This
 * answers the second question.
 *
 * An index we have no record of -- anything from before a reload -- counts as a
 * target: it is a page we cannot name but can still return to.
 */
function backTarget(seen: (Entry | undefined)[], depth: number, here: string): number {
  let target = depth - 1;
  while (target > 0 && seen[target]?.pathname === here) target -= 1;
  return target;
}

export function NavStackProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();

  const [depth, setDepth] = useState(seedDepth);
  // The depth the effect below has already accounted for. Kept beside the state
  // so `goBack` does not have to be rebuilt every time the depth changes.
  const depthRef = useRef(depth);
  const entries = useRef<Entry[] | null>(null);
  // Set by resetToHome and read by the effect below, which cannot otherwise
  // tell that navigation apart from any other replace.
  const resetting = useRef(false);

  /*
   * Recording the entry we loaded on during render, not in an effect, so the
   * effect below never has a first run with nothing behind it -- it sees the
   * current entry already at its own index and concludes, correctly, that
   * nothing has moved. Idempotent, so StrictMode's double render is harmless.
   */
  if (entries.current === null) {
    entries.current = [];
    entries.current[depth] = { key: location.key, pathname: location.pathname };
  }

  useLayoutEffect(() => {
    const seen = entries.current;
    if (!seen) return;

    /*
     * The reset, handled before anything below because it is the one navigation
     * whose meaning does not follow from its history action. It arrives as a
     * REPLACE, which the rules further down would read as "same rung of the
     * ladder, different contents" and animate as nothing at all.
     */
    if (resetting.current) {
      resetting.current = false;
      seen.length = 0;
      seen[0] = { key: location.key, pathname: location.pathname };
      /*
       * Rewritten so that a reload agrees with us. Depth is seeded from React
       * Router's `idx`, and without this a refresh would bring the chevron back
       * describing a stack that has been thrown away.
       *
       * The entries the browser still holds behind this one cannot be removed --
       * no API deletes history -- so its own back button still works. If it is
       * used, the chevron reappears describing where it has actually landed,
       * which is the honest answer rather than a chevron pointing at nothing.
       */
      window.history.replaceState({ ...window.history.state, idx: 0 }, "");
      document.documentElement.dataset.nav = "back";
      depthRef.current = 0;
      setDepth(0);
      return;
    }

    const previous = depthRef.current;
    let next = previous;
    if (navigationType === "PUSH") {
      next = previous + 1;
    } else if (navigationType === "POP") {
      // Where this entry was when we last saw it. A pop to something we have no
      // record of -- anything before a reload -- is treated as one step, which
      // is the only safe guess.
      const known = seen.findIndex((entry) => entry?.key === location.key);
      next = known >= 0 ? known : Math.max(0, previous - 1);
    }
    // A REPLACE stays where it is: it is the same rung of the ladder with
    // different contents, which is exactly what the detail pages do after a
    // merge or a delete, and what Directory's debounced search does per letter.

    // Read before the write below, which overwrites this slot on a replace.
    const samePage = seen[previous]?.pathname === location.pathname;

    // Whatever was ahead of a push is unreachable now.
    if (navigationType === "PUSH") seen.length = next;
    seen[next] = { key: location.key, pathname: location.pathname };

    /*
     * The direction the CSS animates, written here rather than from a `popstate`
     * listener on purpose. React Router registers its own `popstate` handler
     * when the router is built, at module scope, before any of this has mounted
     * -- so a listener of ours would be racing it. This runs during the React
     * commit that happens *inside* the view transition's callback, which is
     * before the transition's animations are started, and unlike a click handler
     * it is equally right for the edge-swipe, the hardware back button and the
     * browser's forward button.
     *
     * `none` when the path did not change, and that case is not obscure: it is
     * every filter on Directory and the audit log, all of which push. The
     * chevron steps over those, but the browser's own back button cannot be made
     * to -- so without this, undoing a checkbox slides the entire directory off
     * to the right. theme.css leaves `none` to the browser's plain cross-fade.
     *
     * Written unconditionally. Leaving the last value in place for a navigation
     * that did not move -- a replace, which is what both detail pages do after a
     * merge or a delete -- means the transition after it animates in whichever
     * direction something else went earlier.
     */
    document.documentElement.dataset.nav =
      samePage || next === previous ? "none" : next < previous ? "back" : "forward";

    depthRef.current = next;
    setDepth(next);
  }, [location.key, location.pathname, navigationType]);

  // Withdrawn rather than left behind describing a navigation that is over --
  // the same reason AppShell removes `--app-header-height` when it unmounts.
  useLayoutEffect(() => {
    return () => {
      delete document.documentElement.dataset.nav;
    };
  }, []);

  /*
   * Back to the previous *page*, which is not always the previous history entry.
   * Directory's "account holders only" and each of the audit log's five filters
   * deliberately push, so that the browser's own back button undoes them -- and
   * that is worth keeping. But it means a chevron that popped one entry would
   * animate a full page slide sideways to untick a checkbox, and on the audit
   * log it could take five taps to leave the page. So consecutive entries
   * sharing the current path are stepped over in one go.
   */
  const goBack = useCallback(() => {
    const seen = entries.current ?? [];
    // The ref rather than the state, so a stale closure cannot pop the wrong
    // distance in the one render where the two disagree.
    const delta = backTarget(seen, depthRef.current, location.pathname) - depthRef.current;
    if (delta >= 0) return;

    // Also set here, so the button does not depend on the effect above winning a
    // race it has no reason to lose but would fail silently if it did.
    document.documentElement.dataset.nav = "back";
    void navigate(delta);
  }, [location.pathname, navigate]);

  /*
   * The header title: go home, and start counting again from there.
   *
   * A replace to `/` rather than popping back to the first entry, because those
   * are two different destinations. The title means the directory; the entry a
   * session began on is only *usually* the directory, since a push notification
   * or a shared link can open the app anywhere. Replacing also animates
   * unconditionally, where a pop animates only if the router happens to have
   * recorded that pair of paths on the way in.
   *
   * Slides away to the right, like the chevron: this goes back out of wherever
   * you are, it does not go deeper.
   */
  const resetToHome = useCallback(() => {
    // Already at the start, with nothing to discard and nowhere to go.
    if (location.pathname === "/" && location.search === "" && depthRef.current === 0) return;

    resetting.current = true;
    document.documentElement.dataset.nav = "back";
    void navigate("/", { replace: true, viewTransition: true });
  }, [location.pathname, location.search, navigate]);

  /*
   * Not simply `depth > 0`. A pushed filter is a history entry, but it is not
   * somewhere you went -- and a chevron that appears on the directory the moment
   * you tick a checkbox is claiming the page has a parent when it has not. So
   * the question is whether the entry we would land on is a different page.
   *
   * Recomputed each render rather than memoised on `depth`, because it depends
   * on the path as well as the depth.
   */
  const seen = entries.current ?? [];
  const landing = seen[backTarget(seen, depth, location.pathname)]?.pathname ?? null;
  const canGoBack = depth > 0 && landing !== location.pathname;

  const value = { canGoBack, goBack, resetToHome };
  return <NavStackContext.Provider value={value}>{children}</NavStackContext.Provider>;
}

export function useNavStack(): NavStack {
  const value = useContext(NavStackContext);
  if (!value) throw new Error("useNavStack must be used inside a NavStackProvider");
  return value;
}
