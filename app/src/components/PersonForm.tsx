import { useMemo, useState } from "react";
import {
  formatPhone,
  fullName,
  INHERITABLE_ATTRIBUTES,
  normalizePhone,
  personWriteSchema,
  type InheritableAttribute,
  type PersonDto,
  type PersonSummaryDto,
} from "@shared";
import { api, ApiError } from "../lib/api";
import { InheritToggle, inheritanceCandidates } from "./InheritToggle";
import { Button, Field, inputClass } from "./ui";

/**
 * Editing a person.
 *
 * Single column on a phone; a two-column field grid from `md` up. Phone numbers
 * are normalised to E.164 on blur so `tel:` links dial correctly, and the same
 * Zod schema the API uses validates the payload before it is sent.
 */

const INHERIT_LABEL: Record<InheritableAttribute, string> = {
  email: "email",
  phone: "phone number",
  altPhone: "alternate number",
  lastName: "last name",
  address: "address",
};

interface FormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  altPhone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  patronSaint: string;
  /** "" means no family. Only ever edited when `families` is supplied. */
  familyId: string;
  inherit: Record<InheritableAttribute, string | null>;
}

function initialState(person: PersonDto): FormState {
  return {
    firstName: person.firstName,
    // A field that is currently inherited shows the source's value; clearing
    // the toggle reveals whatever the person had of their own, which the API
    // never overwrote.
    lastName: person.inheritedFrom.lastName ? "" : (person.lastName ?? ""),
    email: person.inheritedFrom.email ? "" : (person.email ?? ""),
    phone: person.inheritedFrom.phone ? "" : (person.phone ?? ""),
    altPhone: person.inheritedFrom.altPhone ? "" : (person.altPhone ?? ""),
    addressLine1: person.inheritedFrom.address ? "" : (person.addressLine1 ?? ""),
    addressLine2: person.inheritedFrom.address ? "" : (person.addressLine2 ?? ""),
    city: person.inheritedFrom.address ? "" : (person.city ?? ""),
    state: person.inheritedFrom.address ? "" : (person.state ?? ""),
    postalCode: person.inheritedFrom.address ? "" : (person.postalCode ?? ""),
    country: person.inheritedFrom.address ? "" : (person.country ?? ""),
    patronSaint: person.patronSaint ?? "",
    familyId: person.familyId ?? "",
    inherit: {
      email: person.inheritedFrom.email?.personId ?? null,
      phone: person.inheritedFrom.phone?.personId ?? null,
      altPhone: person.inheritedFrom.altPhone?.personId ?? null,
      lastName: person.inheritedFrom.lastName?.personId ?? null,
      address: person.inheritedFrom.address?.personId ?? null,
    },
  };
}

/** An inherited phone shown read-only reads better formatted. */
function formatInherited(phone: string | null | undefined): string {
  return phone ? formatPhone(phone) : "";
}

export function PersonForm({
  person,
  familyMembers,
  families,
  onSaved,
  onCancel,
}: {
  person: PersonDto;
  familyMembers: PersonSummaryDto[];
  /**
   * Supplying this shows the family picker. Only admins may move someone
   * between families, and that gate lives at the call site so this component
   * stays driven purely by props.
   */
  families?: { id: string; name: string }[];
  onSaved: (updated: PersonDto) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(person));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /*
   * Inheritance is validated against the *destination* family, so a move and a
   * set of pointers cannot travel in one request: the API would reject every
   * source as "not in the same family", or refuse the lot with "join a family
   * before inheriting". The move drops them anyway, so the form does the same
   * and says so.
   */
  const movingFamily = families !== undefined && form.familyId !== (person.familyId ?? "");

  /*
   * Which family members already inherit which attribute. Offering them as a
   * source would create a chain the API rejects, so they are filtered out here
   * rather than surfacing an error after the fact.
   */
  const inheritingMembers = useMemo(() => {
    const map = new Map<string, Set<InheritableAttribute>>();
    for (const member of familyMembers) {
      // A summary does not carry the pointers, so this is only known for the
      // person being edited; everyone else is assumed eligible and the API is
      // the backstop.
      if (member.id === person.id) {
        map.set(member.id, new Set(INHERITABLE_ATTRIBUTES.filter((a) => person.inheritedFrom[a])));
      }
    }
    return map;
  }, [familyMembers, person]);

  function normalisePhoneField(key: "phone" | "altPhone"): void {
    const raw = form[key];
    if (!raw.trim()) return;
    const normalised = normalizePhone(raw);
    if (normalised) {
      set(key, normalised);
      setFieldErrors((prev) => {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
    } else {
      setFieldErrors((prev) => ({ ...prev, [key]: "That does not look like a phone number" }));
    }
  }

  async function save(): Promise<void> {
    setError(null);
    setFieldErrors({});

    const payload = {
      firstName: form.firstName,
      lastName: form.inherit.lastName ? undefined : form.lastName,
      email: form.inherit.email ? undefined : form.email || null,
      phone: form.inherit.phone ? undefined : normalizePhone(form.phone),
      altPhone: form.inherit.altPhone ? undefined : normalizePhone(form.altPhone),
      ...(form.inherit.address
        ? {}
        : {
            addressLine1: form.addressLine1,
            addressLine2: form.addressLine2,
            city: form.city,
            state: form.state,
            postalCode: form.postalCode,
            country: form.country,
          }),
      patronSaint: form.patronSaint,
      inheritEmailFromPersonId: movingFamily ? null : form.inherit.email,
      inheritPhoneFromPersonId: movingFamily ? null : form.inherit.phone,
      inheritAltPhoneFromPersonId: movingFamily ? null : form.inherit.altPhone,
      inheritLastNameFromPersonId: movingFamily ? null : form.inherit.lastName,
      inheritAddressFromPersonId: movingFamily ? null : form.inherit.address,
      // Absent unless the picker is shown, because the API treats the key being
      // present as an instruction to move.
      ...(families ? { familyId: form.familyId || null } : {}),
    };

    // Validate with the API's own schema before the round trip.
    const parsed = personWriteSchema.partial().safeParse(payload);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setSaving(true);
    try {
      onSaved(
        await api<PersonDto>(`/persons/${person.id}`, { method: "PATCH", body: parsed.data })
      );
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setFieldErrors(
          Object.fromEntries(err.issues.map((issue) => [issue.path.split(".")[0]!, issue.message]))
        );
      }
      setError(err instanceof Error ? err.message : "Could not save those changes");
    } finally {
      setSaving(false);
    }
  }

  const candidatesFor = (attribute: InheritableAttribute) =>
    inheritanceCandidates(attribute, person.id, familyMembers, inheritingMembers);

  const inheritedNote = (attribute: InheritableAttribute) =>
    form.inherit[attribute]
      ? familyMembers.find((m) => m.id === form.inherit[attribute])
      : undefined;

  /** "Paul Schlueter's", for the hint under an inherited field. */
  const sourceName = (attribute: InheritableAttribute) => {
    const source = inheritedNote(attribute);
    return source ? fullName(source) : "another family member";
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {/*
        Paired so both columns of a row either have an inheritance toggle or
        neither do: mixing them makes the grid row as tall as the taller cell
        and leaves an obvious gap under the shorter one.
      */}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First name" error={fieldErrors.firstName}>
          <input
            className={inputClass}
            value={form.firstName}
            onChange={(e) => set("firstName", e.target.value)}
            required
          />
        </Field>

        <Field label="Patron saint" hint="Shown alongside their name day">
          <input
            className={inputClass}
            value={form.patronSaint}
            onChange={(e) => set("patronSaint", e.target.value)}
          />
        </Field>
      </div>

      {families && (
        <Field
          label="Family"
          hint={
            movingFamily
              ? "Save the move first, then choose who they share details with."
              : "Moving someone clears the details they share with their current family, and the details their relatives share from them."
          }
        >
          <select
            className={inputClass}
            value={form.familyId}
            onChange={(e) => set("familyId", e.target.value)}
          >
            <option value="">No family</option>
            {families.map((family) => (
              <option key={family.id} value={family.id}>
                {family.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <InheritToggle
            attribute="lastName"
            label={INHERIT_LABEL.lastName}
            candidates={candidatesFor("lastName")}
            sourceId={form.inherit.lastName}
            onChange={(id) => set("inherit", { ...form.inherit, lastName: id })}
            disabled={movingFamily}
          />
          <Field
            label="Last name"
            error={fieldErrors.lastName}
            hint={form.inherit.lastName ? `Using ${sourceName("lastName")}'s last name` : undefined}
          >
            <input
              className={inputClass}
              value={
                form.inherit.lastName ? (inheritedNote("lastName")?.lastName ?? "") : form.lastName
              }
              disabled={Boolean(form.inherit.lastName)}
              onChange={(e) => set("lastName", e.target.value)}
            />
          </Field>
        </div>

        <div>
          <InheritToggle
            attribute="email"
            label={INHERIT_LABEL.email}
            candidates={candidatesFor("email")}
            sourceId={form.inherit.email}
            onChange={(id) => set("inherit", { ...form.inherit, email: id })}
            disabled={movingFamily}
          />
          <Field
            label="Email"
            error={fieldErrors.email}
            hint={form.inherit.email ? `Using ${sourceName("email")}'s email` : undefined}
          >
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              className={inputClass}
              value={form.inherit.email ? (inheritedNote("email")?.email ?? "") : form.email}
              disabled={Boolean(form.inherit.email)}
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <InheritToggle
            attribute="phone"
            label={INHERIT_LABEL.phone}
            candidates={candidatesFor("phone")}
            sourceId={form.inherit.phone}
            onChange={(id) => set("inherit", { ...form.inherit, phone: id })}
            disabled={movingFamily}
          />
          <Field
            label="Phone"
            error={fieldErrors.phone}
            hint={
              form.inherit.phone
                ? `Using ${sourceName("phone")}'s number`
                : "Any format — we tidy it up so it can be tapped to call"
            }
          >
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className={inputClass}
              value={
                form.inherit.phone
                  ? // Formatted, because this field cannot be edited anyway.
                    formatInherited(inheritedNote("phone")?.phone)
                  : form.phone
              }
              disabled={Boolean(form.inherit.phone)}
              onChange={(e) => set("phone", e.target.value)}
              onBlur={() => normalisePhoneField("phone")}
            />
          </Field>
        </div>

        <div>
          <InheritToggle
            attribute="altPhone"
            label={INHERIT_LABEL.altPhone}
            candidates={candidatesFor("altPhone")}
            sourceId={form.inherit.altPhone}
            onChange={(id) => set("inherit", { ...form.inherit, altPhone: id })}
            disabled={movingFamily}
          />
          <Field
            label="Alternate phone"
            error={fieldErrors.altPhone}
            hint={form.inherit.altPhone ? `Using ${sourceName("altPhone")}'s number` : undefined}
          >
            <input
              type="tel"
              inputMode="tel"
              className={inputClass}
              value={
                form.inherit.altPhone
                  ? formatInherited(inheritedNote("altPhone")?.altPhone)
                  : form.altPhone
              }
              disabled={Boolean(form.inherit.altPhone)}
              onChange={(e) => set("altPhone", e.target.value)}
              onBlur={() => normalisePhoneField("altPhone")}
            />
          </Field>
        </div>
      </div>

      <fieldset className="rounded-lg border border-line p-4">
        <legend className="px-1 font-bold text-ink">Address</legend>

        <InheritToggle
          attribute="address"
          label={INHERIT_LABEL.address}
          candidates={candidatesFor("address")}
          sourceId={form.inherit.address}
          onChange={(id) => set("inherit", { ...form.inherit, address: id })}
          disabled={movingFamily}
        />

        {form.inherit.address ? (
          <p className="mt-2 text-sm text-ink-muted">
            Using {sourceName("address")}'s address:{" "}
            {[
              inheritedNote("address")?.addressLine1,
              inheritedNote("address")?.city,
              inheritedNote("address")?.state,
              inheritedNote("address")?.postalCode,
            ]
              .filter(Boolean)
              .join(", ") || "not set yet"}
          </p>
        ) : (
          <div className="mt-2 grid gap-4 md:grid-cols-2">
            <Field label="Street" className="md:col-span-2">
              <input
                className={inputClass}
                autoComplete="address-line1"
                value={form.addressLine1}
                onChange={(e) => set("addressLine1", e.target.value)}
              />
            </Field>
            <Field label="Apartment, suite, etc." className="md:col-span-2">
              <input
                className={inputClass}
                autoComplete="address-line2"
                value={form.addressLine2}
                onChange={(e) => set("addressLine2", e.target.value)}
              />
            </Field>
            <Field label="City">
              <input
                className={inputClass}
                autoComplete="address-level2"
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
              />
            </Field>
            <Field label="State">
              <input
                className={inputClass}
                autoComplete="address-level1"
                value={form.state}
                onChange={(e) => set("state", e.target.value)}
              />
            </Field>
            <Field label="ZIP code">
              <input
                className={inputClass}
                inputMode="numeric"
                autoComplete="postal-code"
                value={form.postalCode}
                onChange={(e) => set("postalCode", e.target.value)}
              />
            </Field>
            <Field label="Country">
              <input
                className={inputClass}
                autoComplete="country-name"
                value={form.country}
                onChange={(e) => set("country", e.target.value)}
              />
            </Field>
          </div>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="font-bold text-primary">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
