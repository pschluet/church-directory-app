import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { FamilyDto, FamilySummaryDto, PersonDto, PersonSummaryDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
import { PersonForm } from "../components/PersonForm";
import { PhoneLink } from "../components/PhoneLink";
import { PhotoUpload } from "../components/PhotoUpload";
import { SpecialDateForm } from "../components/SpecialDateForm";
import { Badge, Button, ErrorNotice, Modal, Spinner } from "../components/ui";
import {
  formatMonthDay,
  formatMultilineAddress,
  fullName,
  specialDateDetail,
  specialDateLabel,
  specialDatePartnerName,
} from "../lib/format";

/**
 * One person's full record, and the place their details and dates are edited.
 *
 * Stacked on a phone; photo beside details from `md` up.
 */
export function PersonDetail() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useMe();
  const [person, setPerson] = useState<PersonDto | null>(null);
  const [family, setFamily] = useState<FamilyDto | null>(null);
  const [families, setFamilies] = useState<FamilySummaryDto[]>([]);
  const [directory, setDirectory] = useState<PersonSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
  const [editingDateId, setEditingDateId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await api<PersonDto>(`/persons/${id}`);
      setPerson(loaded);
      // The family is needed for the inheritance pickers; the directory for
      // choosing the other half of an anniversary.
      const [familyResult, directoryResult, familyListResult] = await Promise.all([
        loaded.familyId
          ? api<FamilyDto>(`/families/${loaded.familyId}`).catch(() => null)
          : Promise.resolve(null),
        loaded.canEdit
          ? api<{ people: PersonSummaryDto[] }>("/directory", { query: { limit: 200 } }).catch(
              () => ({ people: [] })
            )
          : Promise.resolve({ people: [] }),
        // Only an admin may move someone between families, so only they need
        // a list to choose from.
        isAdmin
          ? api<{ families: FamilySummaryDto[] }>("/families").catch(() => ({ families: [] }))
          : Promise.resolve({ families: [] }),
      ]);
      setFamily(familyResult);
      setDirectory(directoryResult.people);
      setFamilies(familyListResult.families);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that person");
    } finally {
      setLoading(false);
    }
  }, [id, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="Loading" />;
  if (error) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (!person) return null;

  const name = fullName(person);
  const address = formatMultilineAddress(person);
  const editingDate = person.specialDates.find((date) => date.id === editingDateId);

  return (
    <>
      <div className="mb-6 flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
        {/* Fixed-width sidebar from md up, so the photo controls never crowd
            the details beside them. */}
        <div className="flex shrink-0 flex-col items-center gap-3 md:w-44">
          {person.canEdit ? (
            <PhotoUpload
              stacked
              owner={{ personId: person.id }}
              thumbUrl={person.thumbUrl}
              fullUrl={person.fullUrl}
              person={person}
              onUploaded={async ({ photoKey }) => {
                setPerson(
                  await api<PersonDto>(`/persons/${person.id}/photo`, {
                    method: "PUT",
                    body: { photoKey },
                  })
                );
              }}
              onRemove={async () => {
                setPerson(
                  await api<PersonDto>(`/persons/${person.id}/photo`, {
                    method: "PUT",
                    body: { photoKey: null },
                  })
                );
              }}
            />
          ) : (
            <Avatar thumbUrl={person.thumbUrl} fullUrl={person.fullUrl} person={person} size="lg" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-ink md:text-3xl">{name}</h1>
            {person.appUserId === null && <Badge>No account</Badge>}
          </div>

          {person.familyId && (
            <p className="mt-1 text-ink-muted">
              <Link to={`/families/${person.familyId}`} className="text-primary hover:text-accent">
                {person.familyName} family
              </Link>
            </p>
          )}

          <dl className="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-2">
            <DetailRow label="Phone" inheritedFrom={person.inheritedFrom.phone?.name}>
              {person.phone ? <PhoneLink phone={person.phone} label={name} /> : <NotSet />}
            </DetailRow>

            <DetailRow label="Alternate phone" inheritedFrom={person.inheritedFrom.altPhone?.name}>
              {person.altPhone ? <PhoneLink phone={person.altPhone} label={name} /> : <NotSet />}
            </DetailRow>

            <DetailRow label="Email" inheritedFrom={person.inheritedFrom.email?.name}>
              {person.email ? (
                <a
                  href={`mailto:${person.email}`}
                  className="break-all text-primary hover:text-accent"
                >
                  {person.email}
                </a>
              ) : (
                <NotSet />
              )}
            </DetailRow>

            <DetailRow label="Patron saint">
              {person.patronSaint ? <span>{person.patronSaint}</span> : <NotSet />}
            </DetailRow>

            <DetailRow
              label="Address"
              inheritedFrom={person.inheritedFrom.address?.name}
              className="md:col-span-2"
            >
              {address.length > 0 ? (
                <span className="block whitespace-pre-line">{address.join("\n")}</span>
              ) : (
                <NotSet />
              )}
            </DetailRow>
          </dl>

          {person.canEdit && (
            <div className="mt-5">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            </div>
          )}
        </div>
      </div>

      <section className="rounded-lg border border-line bg-surface p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-ink">Special dates</h2>
          {person.canEdit && (
            <Button variant="secondary" onClick={() => setAddingDate(true)}>
              Add a date
            </Button>
          )}
        </div>

        {person.specialDates.length === 0 ? (
          <p className="text-ink-muted">No dates recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {person.specialDates.map((date) => {
              const detail = specialDateDetail(date);
              const isTheirs = date.personId === person.id;
              const partnerName = specialDatePartnerName(date, person.id);
              return (
                <li key={date.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                  <span className="font-bold text-ink">{specialDateLabel(date.type)}</span>
                  <span>{formatMonthDay(date.month, date.day, date.year)}</span>
                  {detail && <span className="text-sm font-bold text-accent">{detail}</span>}
                  {partnerName && (
                    <span className="text-sm text-ink-muted">with {partnerName}</span>
                  )}
                  {person.canEdit && isTheirs && (
                    <span className="ml-auto flex gap-3 text-sm">
                      <button
                        type="button"
                        className="font-bold text-primary hover:text-accent"
                        onClick={() => setEditingDateId(date.id)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="font-bold text-primary hover:text-accent"
                        onClick={async () => {
                          await api(`/special-dates/${date.id}`, { method: "DELETE" });
                          await load();
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {editing && (
        <Modal title={`Edit ${name}`} onClose={() => setEditing(false)}>
          <PersonForm
            person={person}
            familyMembers={family?.members ?? []}
            families={isAdmin ? families : undefined}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              setPerson(updated);
              setEditing(false);
              // A move changes which relatives the inheritance pickers offer.
              if (updated.familyId !== person.familyId) void load();
            }}
          />
        </Modal>
      )}

      {(addingDate || editingDate) && (
        <Modal
          title={editingDate ? "Edit date" : `Add a date for ${person.firstName}`}
          onClose={() => {
            setAddingDate(false);
            setEditingDateId(null);
          }}
        >
          <SpecialDateForm
            personId={person.id}
            existing={editingDate}
            candidates={directory}
            onCancel={() => {
              setAddingDate(false);
              setEditingDateId(null);
            }}
            onSaved={async () => {
              setAddingDate(false);
              setEditingDateId(null);
              await load();
            }}
          />
        </Modal>
      )}
    </>
  );
}

function DetailRow({
  label,
  inheritedFrom,
  className = "",
  children,
}: {
  label: string;
  inheritedFrom?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <dt className="text-sm font-bold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5">
        {children}
        {inheritedFrom && (
          <span className="mt-0.5 block text-xs text-ink-muted">Shared with {inheritedFrom}</span>
        )}
      </dd>
    </div>
  );
}

function NotSet() {
  return <span className="text-ink-muted">—</span>;
}
