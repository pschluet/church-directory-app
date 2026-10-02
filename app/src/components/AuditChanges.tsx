import { createContext, useContext, useState } from "react";
import {
  roleLabel,
  userStatusLabel,
  ROLES,
  USER_STATUSES,
  SPECIAL_DATE_TYPES,
  type AuditReferenceDto,
  type SpecialDateType,
} from "@shared";
import { displayPhone, formatMonthDay, parseIsoDate, specialDateLabel } from "../lib/format";
import { Button } from "./ui";

/**
 * The details behind one audit entry.
 *
 * `audit_log.changes` is untyped jsonb and every call site passes its own
 * shape, so this dispatches on what it finds rather than on the action. Four
 * cases, in order of how much can be said about them, ending in the raw JSON --
 * which is not a failure mode but the honest answer for a payload nobody has
 * taught this file about yet.
 *
 * The heading matters as much as the rendering. Nearly every entry carries the
 * *payload that was submitted*, not a before-and-after: the update handlers
 * pass `changes: payload`, which is the new state with no record of the old.
 * Laying that out as a diff would show a reader something the data does not
 * contain, so the two are headed differently and only the shapes that genuinely
 * hold both sides are called changes.
 *
 * The previous values are not recorded anywhere, for any action -- so this
 * used to say as much under every "Submitted values" heading, which meant
 * repeating one fact about the schema on every row of the page. The heading
 * carries it: what was submitted is what there is.
 */
export function AuditChanges({
  changes,
  references = NO_REFERENCES,
}: {
  changes: unknown;
  references?: Record<string, AuditReferenceDto>;
}) {
  if (changes === null || changes === undefined) {
    return <p className="text-sm text-ink-muted">No details were recorded for this entry.</p>;
  }

  return (
    <ReferencesContext.Provider value={references}>
      <AuditChangesBody changes={changes} />
    </ReferencesContext.Provider>
  );
}

const NO_REFERENCES: Record<string, AuditReferenceDto> = {};

/**
 * The uuids inside `changes`, resolved to names by the API. A module-private
 * context rather than a prop threaded through `Transition`, `Section` and two
 * `<dl>` loops -- only `Value`, at the bottom of the tree, needs it.
 */
const ReferencesContext = createContext<Record<string, AuditReferenceDto>>(NO_REFERENCES);

function AuditChangesBody({ changes }: { changes: unknown }) {
  const transitions = asTransitions(changes);
  if (transitions) {
    const visible = transitions.filter(({ field }) => field === null || !HIDDEN_FIELDS.has(field));
    /*
     * A bare `{from, to}` names no field, so there is no label to put over it
     * and a made-up one ("Value") would only repeat the action badge, which has
     * already said "Sign-in address changed". With nothing to label, a <dl>
     * would be a <dd> with no <dt>, so it is not one.
     */
    const [only] = visible;
    return (
      <div className="space-y-4">
        {visible.length === 1 && only && only.field === null ? (
          <Section title="Changes">
            <Transition from={only.from} to={only.to} field="" />
          </Section>
        ) : (
          <Section title="Changes">
            <dl className="space-y-3">
              {visible.map(({ field, from, to }) => (
                <div key={field}>
                  <dt className="text-sm font-bold text-ink">{humanizeField(field ?? "")}</dt>
                  <dd className="mt-0.5">
                    <Transition from={from} to={to} field={field ?? ""} />
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        )}
        <RawJson value={changes} fallback={false} />
      </div>
    );
  }

  const fields = asRenderableFields(changes);
  if (fields) {
    const visible = fields.filter(([field]) => !HIDDEN_FIELDS.has(field));
    return (
      <div className="space-y-4">
        <Section title="Submitted values">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
            {visible.map(([field, value]) => (
              <div key={field} className="sm:col-span-2 sm:grid sm:grid-cols-subgrid">
                <dt className="text-sm font-bold text-ink">{humanizeField(field)}</dt>
                <dd className="text-sm text-ink-muted">
                  <Value value={value} field={field} />
                </dd>
              </div>
            ))}
          </dl>
        </Section>
        <RawJson value={changes} fallback={false} />
      </div>
    );
  }

  return <RawJson value={changes} fallback />;
}

/** One before -> after pair. Stacks on a phone; the arrow only appears once
 *  the two values sit side by side, where it has a direction to point in. */
function Transition({ from, to, field }: { from: unknown; to: unknown; field: string }) {
  return (
    <span className="flex flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:gap-2">
      <span className="text-ink-muted line-through decoration-ink-muted/50">
        <Value value={from} field={field} />
      </span>
      <span aria-hidden="true" className="hidden text-ink-muted sm:inline">
        →
      </span>
      <span className="sr-only">changed to</span>
      <span className="font-bold text-ink">
        <Value value={to} field={field} />
      </span>
    </span>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">{title}</p>
      {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * The full payload, verbatim and collapsed -- an escape hatch, not only a
 * fallback.
 *
 * Rendering a uuid as a name, suppressing `placeId`, and collapsing a photo
 * key to a verb (`Value`, `HIDDEN_FIELDS`) are all lossy. On a page whose only
 * job is to be a complete record, each is defensible only because the bytes
 * that were actually recorded stay one click away -- so this appears under
 * every entry that has a payload at all, not only the ones this file has no
 * layout for.
 *
 * `overflow-x-auto` on the <pre> and `min-w-0` on its parent are load-bearing
 * on a phone -- a single unbroken uuid is wider than the screen, and without
 * them it stretches the card and takes the whole page's horizontal scroll
 * with it.
 */
function RawJson({ value, fallback }: { value: unknown; fallback: boolean }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(value, null, 2);

  return (
    <Section
      title="Details"
      note={
        fallback
          ? "Recorded in a shape this page has no layout for, so here it is verbatim."
          : "What was actually recorded, in full."
      }
    >
      <div className="min-w-0">
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
          {open ? "Hide raw details" : "Show raw details"}
        </Button>
        {open && (
          <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-surface-muted p-3 text-xs text-ink">
            {json}
          </pre>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** A scalar, or an array of nothing but scalars -- the shape `Value` can lay out. */
function isRenderable(value: unknown): boolean {
  return isScalar(value) || (Array.isArray(value) && value.every(isScalar));
}

interface FieldTransition {
  /** Null for a bare `{from, to}`, which names nothing. */
  field: string | null;
  from: unknown;
  to: unknown;
}

/**
 * A genuine before-and-after.
 *
 * Two forms qualify: a bare `{from, to}` -- which is what the sign-in address
 * change records -- and an object whose every value is one. Anything else,
 * including a `{from, to}` mixed in with ordinary fields, is not a diff and is
 * not shown as one.
 */
function asTransitions(changes: unknown): FieldTransition[] | null {
  if (!isPlainObject(changes)) return null;

  if (isTransitionValue(changes)) {
    return [{ field: null, from: changes.from, to: changes.to }];
  }

  const entries = Object.entries(changes);
  if (entries.length === 0) return null;
  if (!entries.every(([, value]) => isTransitionValue(value))) return null;

  return entries.map(([field, value]) => ({
    field,
    from: (value as Record<string, unknown>).from,
    to: (value as Record<string, unknown>).to,
  }));
}

function isTransitionValue(value: unknown): value is { from: unknown; to: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("from") && keys.includes("to");
}

/**
 * A flat object of plain values and lists of them -- the common case, since
 * the create and update handlers pass the request payload straight through.
 *
 * Nested objects disqualify the whole thing rather than being skipped: showing
 * four of a payload's six fields and silently dropping the other two would be
 * worse than showing the JSON, on a page whose only job is to be a complete
 * record. An array qualifies -- `family.reorderMembers`' entire meaning is the
 * order of a list of ids -- but only one of scalars; an array containing an
 * object is a shape this file has no layout for, same as a bare nested object.
 */
function asRenderableFields(changes: unknown): [string, unknown][] | null {
  if (!isPlainObject(changes)) return null;
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;
  return entries.every(([, value]) => isRenderable(value)) ? entries : null;
}

// ---------------------------------------------------------------------------
// Labels and values
// ---------------------------------------------------------------------------

/**
 * Recorded, shown under "raw details" (see `RawJson`), and useless in the
 * layout above it. `placeId` is a Google identifier no reader has ever seen --
 * the same reason `V14__map_view.sql` keeps it out of `search_text` -- and the
 * address lines sitting beside it in the same payload already say what
 * actually changed.
 *
 * Hiding a field is a *partial* view of the payload, which this file otherwise
 * refuses to do -- it is only allowable because the raw details above keep the
 * full value one click away. If that escape hatch is ever removed, this list
 * should be emptied along with it.
 */
const HIDDEN_FIELDS = new Set(["placeId"]);

/**
 * The field names that come out of `humanizeField` wrong, and nothing else.
 * Everything the generic path already handles is deliberately absent, so this
 * map stays a list of exceptions rather than a second copy of the payloads.
 *
 * Several entries below exist only because the *value* now renders as a name
 * rather than a uuid (see `Value`): "Inherit last name from person id" was a
 * defensible label while the value was an id; once it reads "Maria Schlueter",
 * a label ending in "id" is simply wrong.
 */
const FIELD_LABELS: Record<string, string> = {
  e164: "Phone number",
  phoneE164: "Phone number",
  altPhoneE164: "Alternate phone",
  patronSaint: "Patron saint",
  yearCount: "Years",
  showYearCount: "Show the year count",
  organizationId: "Church",
  duplicatePersonId: "Duplicate record",
  relatedPersonId: "Linked person",
  value: "Value",
  inheritLastNameFromPersonId: "Surname taken from",
  inheritEmailFromPersonId: "Email taken from",
  inheritPhoneFromPersonId: "Phone taken from",
  inheritAltPhoneFromPersonId: "Alternate phone taken from",
  inheritAddressFromPersonId: "Address taken from",
  personId: "Person",
  personIds: "Order",
  familyId: "Family",
  fromFamilyId: "Previous family",
  mergedPersonId: "Merged record",
  hadAccount: "Had an account",
  viaApproval: "Through a request",
  photo: "Photo",
  removedAnniversaries: "Anniversaries removed",
};

/** `addressLine1` -> "Address line 1". */
export function humanizeField(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;

  const spaced = field
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHOTO_CHANGE_LABELS: Record<string, string> = {
  ADDED: "Added",
  REPLACED: "Replaced",
  REMOVED: "Removed",
};

/**
 * Known enum values, labelled only when the *field* and the *value* both
 * match -- never the value alone. A `note` that happens to read "ADMIN" is
 * somebody's free text, not a role, and must not be mangled into
 * "Administrator"; the field name is what tells the two apart.
 *
 * `type` is the loosest key here -- today only a special date records it --
 * which is why every entry below still checks its value against its enum
 * before labelling it, rather than labelling on the field name alone.
 */
const VALUE_LABELS: Record<string, (value: string) => string | null> = {
  role: (value) => ((ROLES as readonly string[]).includes(value) ? roleLabel(value) : null),
  status: (value) =>
    (USER_STATUSES as readonly string[]).includes(value) ? userStatusLabel(value) : null,
  type: (value) =>
    (SPECIAL_DATE_TYPES as readonly string[]).includes(value)
      ? specialDateLabel(value as SpecialDateType)
      : null,
  photo: (value) => PHOTO_CHANGE_LABELS[value] ?? null,
};

/**
 * One value, formatted the way the rest of the app formats it.
 *
 * "Not set" is a real answer here and a common one -- clearing a phone number
 * is a change worth seeing -- so an empty value gets an em dash with the words
 * behind it for anyone who cannot see that it is an em dash.
 */
function Value({ value, field }: { value: unknown; field: string }) {
  const references = useContext(ReferencesContext);

  if (value === null || value === undefined || value === "") {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">not set</span>
      </>
    );
  }
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "number") return <>{value}</>;

  /*
   * An ordered list, not a bullet list: the one array the app records today is
   * `family.reorderMembers`' running order, and a bulleted list would discard
   * the only thing that payload means. An empty array gets its own word --
   * distinct from "not set" above, because an empty list was still set.
   */
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">none</span>
        </>
      );
    }
    return (
      <ol className="list-decimal space-y-0.5 pl-5">
        {value.map((item, index) => (
          // Keyed on position deliberately: the list has no better key, and
          // position is exactly what it is showing.
          <li key={index}>
            <Value value={item} field={field} />
          </li>
        ))}
      </ol>
    );
  }

  if (typeof value === "string") {
    const known = VALUE_LABELS[field]?.(value);
    if (known) return <>{known}</>;

    if (/^\+\d{7,}$/.test(value) && /phone|e164/i.test(field)) {
      return <>{displayPhone(value) ?? value}</>;
    }
    if (ISO_DATE.test(value)) {
      const date = parseIsoDate(value);
      return <>{formatMonthDay(date.getMonth() + 1, date.getDate(), date.getFullYear())}</>;
    }
    if (UUID_PATTERN.test(value)) {
      const reference = references[value.toLowerCase()];
      if (reference) return <span title={value}>{reference.label}</span>;
    }
    // Wrapped rather than truncated: a note or an address is worth reading, and
    // `break-words` is what keeps a long uuid inside the card.
    return <span className="break-words">{value}</span>;
  }

  return <>{JSON.stringify(value)}</>;
}
