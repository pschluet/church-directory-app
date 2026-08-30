import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MeDto } from "@shared";
import { api, getActiveOrganizationId, setActiveOrganizationId } from "../lib/api";

/**
 * Who the signed-in person is, as far as the directory is concerned.
 *
 * Role and organization come from the API rather than from the token, because
 * they live in Postgres -- a Cognito group cannot express "which organization
 * is this admin scoped to". Everything in the UI that depends on permissions
 * reads from here.
 */

interface MeContextValue {
  me: MeDto | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** The organization the UI is currently showing. */
  organizationId: string | null;
  /** Super admins only; a no-op for everyone else. */
  switchOrganization: (organizationId: string) => Promise<void>;
}

const MeContext = createContext<MeContextValue | null>(null);

export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMe(await api<MeDto>("/me"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your account");
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * A super admin has no organization of their own, so on first sign-in there
   * is nothing to show until they pick one. Selecting the first available
   * organization is friendlier than an empty directory with no explanation.
   */
  useEffect(() => {
    if (!me?.appUser) return;
    const stored = getActiveOrganizationId();
    if (me.organization) {
      if (stored !== me.organization.id) setActiveOrganizationId(me.organization.id);
      return;
    }
    const first = me.availableOrganizations[0];
    if (!stored && first) {
      setActiveOrganizationId(first.id);
      void reload();
    }
  }, [me, reload]);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      setActiveOrganizationId(organizationId);
      await reload();
    },
    [reload]
  );

  const value = useMemo<MeContextValue>(
    () => ({
      me,
      loading,
      error,
      reload,
      isAdmin: me?.appUser.role === "ADMIN" || me?.appUser.role === "SUPER_ADMIN",
      isSuperAdmin: me?.appUser.role === "SUPER_ADMIN",
      organizationId: me?.organization?.id ?? null,
      switchOrganization,
    }),
    [me, loading, error, reload, switchOrganization]
  );

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used within a MeProvider");
  return ctx;
}
