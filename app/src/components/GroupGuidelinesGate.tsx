import { useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { GROUP_GUIDELINES_VERSION } from "@shared";
import { useMe } from "../context/MeContext";
import { api, ApiError } from "../lib/api";
import { Button, Modal } from "./ui";
import { GroupGuidelinesList } from "./GroupGuidelinesInfo";

/**
 * The groups pages, behind the parish's group guidelines.
 *
 * Nothing behind it renders until the member has agreed to the current
 * version, so no group is fetched first. "Not now" is the only way out other
 * than agreeing: it goes home rather than leaving a blank page behind a
 * dialog nobody can close.
 */
export function GroupGuidelinesGate({ children }: { children: ReactNode }) {
  const { me, reload } = useMe();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (me?.groupGuidelinesAgreedVersion === GROUP_GUIDELINES_VERSION) return <>{children}</>;

  async function agree() {
    setBusy(true);
    setError(null);
    try {
      await api("/me/group-guidelines", {
        method: "POST",
        body: { version: GROUP_GUIDELINES_VERSION },
        withOrg: false,
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your agreement. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Group Guidelines" onClose={() => {}} dismissable={false}>
      <div className="space-y-4">
        <p className="text-ink-muted">
          Please read and agree to these guidelines before using the groups page.
        </p>
        <GroupGuidelinesList />
        <label className="flex items-center gap-2 font-bold text-ink">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          I have read and agree to these guidelines
        </label>
        {error && (
          <p role="alert" className="text-sm font-bold text-primary">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={agree} disabled={!checked || busy}>
            {busy ? "Saving…" : "Agree"}
          </Button>
          <Button variant="ghost" onClick={() => navigate("/")} disabled={busy}>
            Not now
          </Button>
        </div>
      </div>
    </Modal>
  );
}
