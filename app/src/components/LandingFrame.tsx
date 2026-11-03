import type { ReactNode } from "react";

/**
 * The band and the background for the pages that render with no session -- an
 * event's share link, the help walkthrough. Nothing about any one parish in it
 * unless the caller names one in `band`.
 */
export function LandingFrame({
  band = "Parish Directory",
  children,
}: {
  band?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-muted">
      <div className="bg-primary px-4 py-2 text-center text-sm text-white">{band}</div>
      <main className="flex-1 px-4 py-8 md:py-12">{children}</main>
    </div>
  );
}
