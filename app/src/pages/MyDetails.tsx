import { Navigate } from "react-router";
import { useMe } from "../context/MeContext";
import { ErrorNotice, Spinner } from "../components/ui";

/**
 * "My Details" is just the signed-in person's own record, so rather than
 * duplicating PersonDetail this redirects to it. A super admin with no
 * organization has no directory record of their own yet, which is explained
 * instead.
 */
export function MyDetails() {
  const { me, loading, error, reload } = useMe();

  if (loading) return <Spinner label="Loading your details" />;
  if (error) return <ErrorNotice message={error} onRetry={() => void reload()} />;

  if (me?.appUser.personId) {
    return <Navigate to={`/people/${me.appUser.personId}`} replace />;
  }

  return (
    <ErrorNotice
      message={
        me?.appUser.role === "SUPER_ADMIN"
          ? "You are a super administrator without a parish of your own, so there is no directory record to edit. Pick a church from the menu to manage its directory."
          : "Your directory record is missing. Ask a parish administrator to look into it."
      }
    />
  );
}
