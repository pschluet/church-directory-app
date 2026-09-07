import { createBrowserRouter, Navigate, ScrollRestoration } from "react-router";
import { useAuth } from "./context/AuthContext";
import { MeProvider, useMe } from "./context/MeContext";
import { AppShell } from "./components/AppShell";
import { NavStackProvider } from "./components/NavStack";
import { ErrorNotice, Spinner } from "./components/ui";
import { Login } from "./pages/Login";
import { Directory } from "./pages/Directory";
import { UpcomingDates } from "./pages/UpcomingDates";
import { PersonDetail } from "./pages/PersonDetail";
import { MyDetails } from "./pages/MyDetails";
import { Families } from "./pages/Families";
import { PrayerRequests } from "./pages/PrayerRequests";
import { Settings } from "./pages/Settings";
import { FamilyDetail } from "./pages/FamilyDetail";
import { AdminUsers } from "./pages/AdminUsers";
import { AdminOrganizations } from "./pages/AdminOrganizations";
import { AuditLog } from "./pages/AuditLog";

/*
 * A data router rather than `<BrowserRouter>` + `<Routes>`, and not for the sake
 * of loaders -- there are none, and every request still goes through TanStack
 * Query. It is because `viewTransition` and `<ScrollRestoration>` only exist in
 * this mode: declarative mode accepts the `viewTransition` prop and silently
 * ignores it, and `useScrollRestoration` throws outright without a data router
 * behind it. The sliding back navigation needs both.
 *
 * Built once at module scope, as a data router must be -- rebuilding it in
 * render would throw the history away on every pass.
 */
export const router = createBrowserRouter([
  {
    element: <RootGate />,
    children: [
      { index: true, element: <Directory /> },
      { path: "dates", element: <UpcomingDates /> },
      { path: "people/:id", element: <PersonDetail /> },
      { path: "me", element: <MyDetails /> },
      { path: "settings", element: <Settings /> },
      { path: "prayer-requests", element: <PrayerRequests /> },
      { path: "families", element: <Families /> },
      { path: "families/:id", element: <FamilyDetail /> },
      {
        path: "admin/users",
        element: (
          <RequireRole requires="admin">
            <AdminUsers />
          </RequireRole>
        ),
      },
      /*
        Admins and above, matching `requireRole("ADMIN")` on /api/audit. A
        prayer request admin is a member with one extra privilege, and this
        holds every edit anyone in the parish has made.
      */
      {
        path: "audit-log",
        element: (
          <RequireRole requires="admin">
            <AuditLog />
          </RequireRole>
        ),
      },
      {
        path: "admin/organizations",
        element: (
          <RequireRole requires="superAdmin">
            <AdminOrganizations />
          </RequireRole>
        ),
      },
      // Unknown paths go home rather than showing a dead end.
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

/**
 * The layout route: the sign-in gate, and the frame every page sits in.
 *
 * The gate is here rather than above the router because a data router is built
 * before anything has rendered and cannot be conditional. Nothing below renders
 * until there is a session, so there is still no `/login` route -- signing out
 * simply takes this back to the form.
 */
function RootGate() {
  const { status } = useAuth();

  if (status === "loading") return <Spinner label="Signing you in" />;
  if (status !== "signedIn") return <Login />;

  return (
    <MeProvider>
      <SignedIn />
    </MeProvider>
  );
}

function SignedIn() {
  const { me, loading, error, reload } = useMe();

  // The token is valid but the directory has no account for it -- deleted, or
  // created directly in Cognito rather than through the invite flow.
  if (error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <ErrorNotice message={error} onRetry={() => void reload()} />
      </div>
    );
  }
  if (loading && !me) return <Spinner label="Loading your directory" />;

  return (
    <NavStackProvider>
      {/*
        Puts a page back where it was rather than at the top, which is half of
        what makes the back chevron worth having -- returning to the directory
        from somebody's page should return you to the row you tapped.

        It keeps `{ key: scrollY }` in `sessionStorage`, and the router keeps the
        pairs of paths it has animated between beside it. Worth being explicit
        about, because the rule everywhere else here is that nothing goes to
        disk. What these hold is offsets under opaque random history keys, and a
        list of `/people/<id>` and `/families/<id>` paths -- record ids, with no
        name, address or phone number attached to them, per tab, useless without
        a session, and gone when the tab closes. That is a different class of
        thing from the directory itself, which is what the rule is for. Signing
        out clears both anyway; see AuthContext.
      */}
      <ScrollRestoration />
      <AppShell />
    </NavStackProvider>
  );
}

/**
 * Hides pages the caller has no business seeing. This is convenience, not
 * security -- every route on the API checks permissions independently.
 */
function RequireRole({
  requires,
  children,
}: {
  requires: "admin" | "superAdmin";
  children: React.ReactNode;
}) {
  const { isAdmin, isSuperAdmin } = useMe();
  const allowed = requires === "admin" ? isAdmin : isSuperAdmin;
  if (!allowed) return <Navigate to="/" replace />;
  return children;
}
