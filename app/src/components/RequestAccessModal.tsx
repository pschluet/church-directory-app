import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DirectoryRequestChurchDto } from "@shared";
import { api } from "../lib/api";
import { Button, Field, Modal, Select, Spinner, inputClass } from "./ui";

/**
 * "Request to be added", from the sign-in page.
 *
 * A Modal, which is already the two shapes this wants: a sheet up from the
 * bottom on a phone and a centred dialog from `md` up.
 *
 * Both calls are made signed out, which `api` copes with -- there is no token
 * to attach -- but `withOrg: false` matters: a super admin who signed out on
 * this browser leaves their chosen parish in localStorage, and these routes are
 * not scoped by it.
 *
 * The server answers the same whether the request was stored, was a duplicate
 * or was for somebody who already has an account (see
 * api/src/routes/directory-requests.ts), so the confirmation is worded to be
 * true in every one of those cases.
 */
export function RequestAccessModal({
  initialEmail = "",
  onClose,
}: {
  initialEmail?: string;
  onClose: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [organizationId, setOrganizationId] = useState("");
  // The honeypot. Never shown to a person, so anything in it came from a
  // script filling every field it found.
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Not in qk: it is the one query that runs signed out, and nothing else ever
  // needs to invalidate it.
  const churchesQuery = useQuery({
    queryKey: ["directory-requests", "churches"],
    queryFn: ({ signal }) =>
      api<{ churches: DirectoryRequestChurchDto[] }>("/directory-requests/churches", {
        withOrg: false,
        signal,
      }),
  });
  const churches = churchesQuery.data?.churches ?? [];

  if (sent) {
    return (
      <Modal title="Request sent" onClose={onClose}>
        <p className="text-ink-muted">
          Thank you. An administrator will review your request, and you will get an email at{" "}
          <span className="font-bold text-ink">{email.trim()}</span> once you have been added.
        </p>
        <div className="mt-6">
          <Button onClick={onClose} className="w-full sm:w-auto">
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  const complete =
    firstName.trim() !== "" && lastName.trim() !== "" && email.trim() !== "" && organizationId;

  return (
    <Modal title="Request to be added" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/directory-requests", {
              method: "POST",
              withOrg: false,
              body: { firstName, lastName, email, organizationId, website: website || undefined },
            });
            setSent(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not send your request");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-ink-muted">
          Tell us who you are and which church you belong to. An administrator will add you to the
          directory and email you when you can sign in.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="First name">
            <input
              className={inputClass}
              autoComplete="given-name"
              required
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </Field>
          <Field label="Last name">
            <input
              className={inputClass}
              autoComplete="family-name"
              required
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </Field>
        </div>

        <Field label="Email address">
          <input
            className={inputClass}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Church">
          {churchesQuery.isPending ? (
            <Spinner label="Loading churches" />
          ) : (
            <Select
              required
              value={organizationId}
              onChange={setOrganizationId}
              placeholder="Choose a church…"
              options={churches.map((church) => ({ value: church.id, label: church.name }))}
            />
          )}
        </Field>

        {/*
         * Off screen rather than `hidden` or `display: none`, which the simpler
         * scripts know to skip. Out of the tab order and the accessibility
         * tree, so a person never lands on it.
         */}
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label>
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </label>
        </div>

        {(error ?? churchesQuery.error?.message) && (
          <p role="alert" className="font-bold text-primary">
            {error ?? churchesQuery.error?.message}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || !complete}>
            {busy ? "Sending…" : "Send request"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
