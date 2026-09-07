import { Link as RouterLink, NavLink as RouterNavLink } from "react-router";
import type { LinkProps, NavLinkProps } from "react-router";

/**
 * `Link` and `NavLink` with view transitions already turned on.
 *
 * Not a style preference. React Router only animates a *back* navigation if the
 * forward navigation between those same two paths opted in: it records the pair
 * when `viewTransition` is set going in, and on the way out it looks the pair up
 * again (`appliedViewTransitions`, in the router's own source). A pop that finds
 * nothing recorded is not animated at all -- so the back animation is only ever
 * as complete as this is, and that includes the edge-swipe and the hardware back
 * button, which have no click handler for us to hook.
 *
 * Hence one place rather than a `viewTransition` prop on each of the sixteen
 * links in the app: the seventeenth would be a page you could slide into and not
 * slide back out of, and nothing would fail loudly enough to notice. Written
 * once so it cannot disagree with itself, the same reason `hasRole` is.
 *
 * `viewTransition` comes before the spread so a caller can still opt out.
 */

export function Link(props: LinkProps) {
  return <RouterLink viewTransition {...props} />;
}

export function NavLink(props: NavLinkProps) {
  return <RouterNavLink viewTransition {...props} />;
}
