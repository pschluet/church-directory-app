import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "./context/AuthContext";
import { MeProvider, useMe } from "./context/MeContext";
import { AppShell } from "./components/AppShell";
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

export function App() {
  const { status } = useAuth();

  if (status === "loading") return <Spinner label="Signing you in" />;
  if (status !== "signedIn") return <Login />;

  return (
    <MeProvider>
      <SignedInRoutes />
    </MeProvider>
  );
}

function SignedInRoutes() {
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
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Directory />} />
        <Route path="dates" element={<UpcomingDates />} />
        <Route path="people/:id" element={<PersonDetail />} />
        <Route path="me" element={<MyDetails />} />
        <Route path="settings" element={<Settings />} />
        <Route path="prayer-requests" element={<PrayerRequests />} />
        <Route path="families" element={<Families />} />
        <Route path="families/:id" element={<FamilyDetail />} />
        <Route
          path="admin/users"
          element={
            <RequireRole requires="admin">
              <AdminUsers />
            </RequireRole>
          }
        />
        <Route
          path="admin/organizations"
          element={
            <RequireRole requires="superAdmin">
              <AdminOrganizations />
            </RequireRole>
          }
        />
        {/* Unknown paths go home rather than showing a dead end. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
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
