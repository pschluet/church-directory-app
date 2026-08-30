import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { FamilySummaryDto } from "@shared";
import { familyWriteSchema } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Spinner,
  inputClass,
} from "../components/ui";

/**
 * Every family in the parish, so one can be created or joined without first
 * finding a member and going through their record.
 *
 * Joining is a request an existing member approves -- except for admins, whose
 * request the API approves on the spot, which is why their button says "Join"
 * rather than "Ask to join".
 */
export function Families() {
  const { me, isAdmin, organizationId, reload: reloadMe } = useMe();
  const navigate = useNavigate();
  const [families, setFamilies] = useState<FamilySummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmMove, setConfirmMove] = useState<FamilySummaryDto | null>(null);

  const myPersonId = me?.appUser.personId ?? null;
  const myFamilyId = me?.person?.familyId ?? null;
  const myFamilyName = families.find((f) => f.id === myFamilyId)?.name ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { families: loaded } = await api<{ families: FamilySummaryDto[] }>("/families");
      setFamilies(loaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load families");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // A super admin switching parish is looking at a different set of families.
  }, [load, organizationId]);

  async function requestToJoin(family: FamilySummaryDto): Promise<void> {
    setBusyId(family.id);
    setError(null);
    try {
      await api(`/families/${family.id}/join-requests`, { method: "POST" });
      setConfirmMove(null);
      await load();
      // An admin's request is approved immediately, so their own family changed.
      await reloadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that request");
    } finally {
      setBusyId(null);
    }
  }

  function rowAction(family: FamilySummaryDto) {
    if (!myPersonId) return null;
    if (family.id === myFamilyId) return <Badge tone="accent">Your family</Badge>;
    if (family.pendingJoinRequestId) return <Badge tone="primary">Requested</Badge>;

    // Leaving a family behind is worth a warning; joining from nowhere is not.
    const needsWarning = myFamilyId !== null;
    return (
      <Button
        variant="secondary"
        disabled={busyId === family.id}
        onClick={() => (needsWarning ? setConfirmMove(family) : void requestToJoin(family))}
      >
        {isAdmin ? "Join" : "Ask to join"}
      </Button>
    );
  }

  return (
    <>
      <PageHeading
        title="Families"
        subtitle={`${families.length} ${families.length === 1 ? "family" : "families"}`}
        actions={
          // Creating means joining unless you are an admin, and joining needs a
          // directory record.
          (isAdmin || myPersonId) && (
            <Button onClick={() => setCreating(true)}>Create a family</Button>
          )
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      {!myPersonId && (
        <ErrorNotice message="Your directory record is missing, so you cannot join a family. Ask a parish administrator to look into it." />
      )}

      {loading ? (
        <Spinner label="Loading families" />
      ) : families.length === 0 ? (
        <EmptyState title="No families yet">
          Create the first one and everyone else can ask to join it.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {families.map((family) => (
            <li
              key={family.id}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <Link
                  to={`/families/${family.id}`}
                  className="font-bold text-primary hover:text-accent"
                >
                  {family.name}
                </Link>
                <p className="truncate text-sm text-ink-muted">
                  {family.memberCount} {family.memberCount === 1 ? "member" : "members"}
                  {/* Nothing stops two households sharing a surname, so name a
                      few people to tell them apart. */}
                  {family.memberNames.length > 0 && ` — ${family.memberNames.join(", ")}`}
                  {family.memberCount > family.memberNames.length &&
                    ` +${family.memberCount - family.memberNames.length}`}
                </p>
              </div>
              {rowAction(family)}
            </li>
          ))}
        </ul>
      )}

      {confirmMove && (
        <ConfirmDialog
          title="Ask to join this family?"
          confirmLabel={isAdmin ? "Join" : "Send request"}
          busy={busyId === confirmMove.id}
          onConfirm={() => void requestToJoin(confirmMove)}
          onClose={() => setConfirmMove(null)}
        >
          You are in the {myFamilyName ?? "current"} family. If this is approved you will move to{" "}
          {confirmMove.name}, and any details you share with your current family will be cleared.
        </ConfirmDialog>
      )}

      {creating && (
        <CreateFamilyModal
          isAdmin={isAdmin}
          myPersonId={myPersonId}
          myFamilyName={myFamilyName}
          existingNames={families.map((f) => f.name)}
          onClose={() => setCreating(false)}
          onCreated={async (created, joined) => {
            setCreating(false);
            if (joined) {
              await reloadMe();
              navigate(`/families/${created.id}`);
            } else {
              // Stay put so several can be set up in a row.
              await load();
            }
          }}
        />
      )}
    </>
  );
}

function CreateFamilyModal({
  isAdmin,
  myPersonId,
  myFamilyName,
  existingNames,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  myPersonId: string | null;
  myFamilyName: string | null;
  existingNames: string[];
  onClose: () => void;
  onCreated: (created: { id: string; name: string }, joined: boolean) => Promise<void>;
}) {
  // An admin setting a family up for someone else is the common case, and
  // defaulting this on would quietly move them out of their own family.
  const canChoose = isAdmin && myPersonId !== null;
  const [name, setName] = useState("");
  const [join, setJoin] = useState(!isAdmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only an admin may opt out of joining, and an admin with no directory record
  // of their own has nothing to join with.
  const joining = canChoose ? join : !isAdmin;
  const duplicate = existingNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());

  async function submit(): Promise<void> {
    const parsed = familyWriteSchema.safeParse({ name });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That name is not valid");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string; name: string }>("/families", {
        method: "POST",
        body: { name: parsed.data.name, join: joining },
      });
      await onCreated(created, joining);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that family");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create a family" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Family name"
          hint={duplicate ? `There is already a family called ${name.trim()}.` : undefined}
        >
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={150}
            autoFocus
          />
        </Field>

        {canChoose && (
          <label className="flex items-start gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={join}
              onChange={(event) => setJoin(event.target.checked)}
              className="mt-1"
            />
            <span>
              Put me in this family
              {myFamilyName && ` — this moves you out of the ${myFamilyName} family`}
            </span>
          </label>
        )}

        {joining && myFamilyName && (
          <p className="text-sm font-bold text-primary">
            You are in the {myFamilyName} family. Creating this one moves you out of it, and any
            details you share with them will be cleared.
          </p>
        )}

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Create"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
