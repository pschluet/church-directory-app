import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FamilyDto, FamilySummaryDto, PersonDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
import { PersonForm } from "../components/PersonForm";
import { PhoneLink } from "../components/PhoneLink";
import { PhotoUpload } from "../components/PhotoUpload";
import { SpecialDateForm } from "../components/SpecialDateForm";
import { Badge, Button, ErrorNotice, InfoPopover, Modal, Spinner } from "../components/ui";
import {
  formatMonthDay,
  formatMultilineAddress,
  fullName,
  showYearCountLabel,
  specialDateDetail,
  specialDateLabel,
  specialDatePartner,
} from "../lib/format";

/**
 * One person's full record, and the place their details and dates are edited.
 *
 * Stacked on a phone; photo beside details from `md` up.
 */
export function PersonDetail() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin, organizationId } = useMe();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
  const [editingDateId, setEditingDateId] = useState<string | null>(null);

  const personQuery = useQuery({
    queryKey: qk.person(organizationId, id ?? ""),
    queryFn: ({ signal }) => api<PersonDto>(`/persons/${id}`, { signal }),
    enabled: Boolean(id),
  });
  const person = personQuery.data ?? null;

  /*
   * Both of these used to hang off the person fetch inside a Promise.all, each
   * with a `.catch(() => fallback)` so that a refusal did not take the page
   * down with it. As their own queries they keep that: `enabled` decides
   * whether to ask at all, and their errors are simply not read.
   *
   * The family is needed for the inheritance pickers. The anniversary partner
   * is not fetched here any more -- SpecialDateForm's picker searches the
   * directory as you type.
   */
  const familyQuery = useQuery({
    queryKey: qk.family(organizationId, person?.familyId ?? ""),
    queryFn: ({ signal }) => api<FamilyDto>(`/families/${person?.familyId}`, { signal }),
    enabled: Boolean(person?.familyId),
  });
  const family = familyQuery.data ?? null;

  // Only an admin may move someone between families, so only they need a list
  // to choose from.
  const familiesQuery = useQuery({
    queryKey: qk.families(organizationId),
    queryFn: ({ signal }) => api<{ families: FamilySummaryDto[] }>("/families", { signal }),
    enabled: isAdmin,
  });
  const families = familiesQuery.data?.families ?? [];

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.person(organizationId, id ?? "") });
  };

  // A date belongs to the person, but it is also what Special Dates counts.
  const reloadDates = async () => {
    await Promise.all([
      reload(),
      queryClient.invalidateQueries({ queryKey: qk.specialDates(organizationId) }),
    ]);
  };

  /*
   * `PATCH /persons/:id` and `PUT /persons/:id/photo` both hand back the whole
   * record, so it goes straight into the cache -- refetching what the server
   * has already said would be a round trip for nothing. The directory still
   * has to be told, because a rename or a new photo shows on the cards there.
   */
  const applyPerson = (updated: PersonDto): void => {
    queryClient.setQueryData(qk.person(organizationId, updated.id), updated);
    void queryClient.invalidateQueries({ queryKey: qk.directoryRoot(organizationId) });
  };

  if (personQuery.isPending) return <Spinner label="Loading" />;
  if (personQuery.error) {
    return (
      <ErrorNotice message={personQuery.error.message} onRetry={() => void personQuery.refetch()} />
    );
  }
  if (!person) return null;

  const savePhoto = async (photoKey: string | null): Promise<void> => {
    applyPerson(
      await api<PersonDto>(`/persons/${person.id}/photo`, { method: "PUT", body: { photoKey } })
    );
  };

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
                await savePhoto(photoKey);
              }}
              onRemove={async () => {
                await savePhoto(null);
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
              const partner = specialDatePartner(date, person.id);
              return (
                <li key={date.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                  <span className="font-bold text-ink">{specialDateLabel(date.type)}</span>
                  <span className="inline-flex items-center gap-1.5">
                    {formatMonthDay(date.month, date.day, date.year)}
                    {/* A year we can see while `showYearCount` is off means the
                        API judged us allowed to -- the person themselves, an
                        admin, or the other half of an anniversary. Everyone else
                        received `year: null`, so no "is this my page" check is
                        needed here. */}
                    {date.year != null && !date.showYearCount && (
                      <InfoPopover
                        label={`Why can I see the year of this ${specialDateLabel(date.type).toLowerCase()}?`}
                        title="Not shown to others"
                      >
                        “{showYearCountLabel(date.type)}” is off for this date, so other members see
                        only the day and month.
                      </InfoPopover>
                    )}
                  </span>
                  {detail && <span className="text-sm font-bold text-accent">{detail}</span>}
                  {partner && (
                    <span className="text-sm text-ink-muted">
                      with{" "}
                      <Link
                        to={`/people/${partner.id}`}
                        className="text-primary transition hover:text-accent"
                      >
                        {partner.name}
                      </Link>
                    </span>
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
                          await reloadDates();
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
              applyPerson(updated);
              setEditing(false);
              // A move changes which relatives the inheritance pickers offer,
              // and which family lists them.
              if (updated.familyId !== person.familyId) {
                void reload();
                void queryClient.invalidateQueries({ queryKey: qk.families(organizationId) });
              }
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
            onCancel={() => {
              setAddingDate(false);
              setEditingDateId(null);
            }}
            onSaved={async () => {
              setAddingDate(false);
              setEditingDateId(null);
              await reloadDates();
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
