import { useCallback, useEffect, useRef } from "react";

/**
 * Loads the next page when a sentinel element nears the viewport.
 *
 * Returns a ref callback to put on an empty element after the list. Nothing
 * else in the app scrolls to paginate -- the directory has a "Show more" button
 * -- so this is the first IntersectionObserver here, and it is an addition to
 * that button rather than a replacement for it. The button has to stay: a
 * sentinel is unreachable by keyboard and a screen reader never scrolls one
 * into view, so it would be the only way to page for anyone not using a mouse
 * or a thumb.
 *
 * `rootMargin` fires the load before the sentinel is actually visible, so the
 * next page is usually already in hand by the time the list runs out.
 *
 * `enabled` should be "there is a next page and we are not already fetching
 * it". The observer fires repeatedly while the sentinel stays in view -- which
 * it does, since a short page leaves it on screen -- and disconnecting while a
 * fetch is in flight is what stops that becoming a request per frame.
 */
export function useInfiniteScroll(
  onLoadMore: () => void,
  { enabled, rootMargin = "400px" }: { enabled: boolean; rootMargin?: string }
): (node: Element | null) => void {
  const nodeRef = useRef<Element | null>(null);

  // Kept in a ref so a new callback identity on every render -- which
  // `fetchNextPage` closures have -- does not tear down and rebuild the
  // observer each time.
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  const observerRef = useRef<IntersectionObserver | null>(null);

  const observe = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    const node = nodeRef.current;
    // jsdom has no IntersectionObserver, and neither do a few older browsers.
    // Doing nothing is the whole fallback, because "Show more" is still there.
    if (!node || !enabled || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current();
      },
      { rootMargin }
    );
    observer.observe(node);
    observerRef.current = observer;
  }, [enabled, rootMargin]);

  useEffect(() => {
    observe();
    return () => observerRef.current?.disconnect();
  }, [observe]);

  return useCallback(
    (node: Element | null) => {
      nodeRef.current = node;
      observe();
    },
    [observe]
  );
}
