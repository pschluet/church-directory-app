import { useState } from "react";
import {
  daysInMonth,
  specialDateWriteSchema,
  type PersonSummaryDto,
  type SpecialDateDto,
  type SpecialDateType,
} from "@shared";
import { api } from "../lib/api";
import { MONTH_NAMES } from "../lib/format";
import { Button, Field, inputClass } from "./ui";

/**
 * Adding or editing a special date.
 *
 * The form enforces the same rules as the schema and the database, but the
 * point is to make them visible rather than to catch mistakes: the "show age"
 * checkbox is disabled until a year is entered, and choosing "wedding
 * anniversary" makes both the year and the second person required.
 */

const TYPE_OPTIONS: { value: SpecialDateType; label: string; help: string }[] = [
  {
    value: "BIRTHDAY",
    label: "Birthday",
    help: "A year is optional — leave it out to record only the day.",
  },
  {
    value: "ANNIVERSARY",
    label: "Wedding anniversary",
    help: "Needs a full date and links the two of you.",
  },
  { value: "FEAST_DAY", label: "Name day", help: "The feast of your patron saint: day only." },
];

export function SpecialDateForm({
  personId,
  existing,
  candidates,
  onSaved,
  onCancel,
}: {
  personId: string;
  existing?: SpecialDateDto;
  /** People in the organization who could be the other half of an anniversary. */
  candidates: PersonSummaryDto[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<SpecialDateType>(existing?.type ?? "BIRTHDAY");
  const [month, setMonth] = useState(existing?.month ?? 1);
  const [day, setDay] = useState(existing?.day ?? 1);
  const [year, setYear] = useState<string>(existing?.year ? String(existing.year) : "");
  const [showYearCount, setShowYearCount] = useState(existing?.showYearCount ?? false);
  const [relatedPersonId, setRelatedPersonId] = useState(existing?.relatedPersonId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedYear = year.trim() === "" ? null : Number(year);
  const yearRequired = type === "ANNIVERSARY";
  // "if opting-in to showing age, must select full month/day/year"
  const canShowYearCount = parsedYear !== null;
  const maxDay = daysInMonth(month, parsedYear);

  const selectedType = TYPE_OPTIONS.find((option) => option.value === type)!;

  async function save(): Promise<void> {
    setError(null);

    const payload = {
      type,
      month,
      day: Math.min(day, maxDay),
      year: type === "FEAST_DAY" ? null : parsedYear,
      showYearCount: canShowYearCount && showYearCount,
      relatedPersonId: type === "ANNIVERSARY" ? relatedPersonId || null : null,
    };

    const parsed = specialDateWriteSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That date does not look right");
      return;
    }

    setSaving(true);
    try {
      if (existing) {
        await api(`/special-dates/${existing.id}`, { method: "PATCH", body: parsed.data });
      } else {
        await api("/special-dates", { method: "POST", body: { personId, ...parsed.data } });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that date");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Occasion" hint={selectedType.help}>
        <select
          className={inputClass}
          value={type}
          onChange={(event) => {
            const next = event.target.value as SpecialDateType;
            setType(next);
            // A name day is a day only, so a year would be rejected.
            if (next === "FEAST_DAY") {
              setYear("");
              setShowYearCount(false);
            }
          }}
        >
          {TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Month">
          <select
            className={inputClass}
            value={month}
            onChange={(event) => setMonth(Number(event.target.value))}
          >
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Day">
          <select
            className={inputClass}
            value={Math.min(day, maxDay)}
            onChange={(event) => setDay(Number(event.target.value))}
          >
            {Array.from({ length: maxDay }, (_, i) => i + 1).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        {type !== "FEAST_DAY" && (
          <Field
            label={yearRequired ? "Year" : "Year (optional)"}
            hint={yearRequired ? undefined : "Leave blank to record only the day"}
          >
            <input
              className={inputClass}
              inputMode="numeric"
              placeholder="1985"
              value={year}
              required={yearRequired}
              onChange={(event) => {
                setYear(event.target.value.replace(/\D/g, "").slice(0, 4));
                if (event.target.value.trim() === "") setShowYearCount(false);
              }}
            />
          </Field>
        )}
      </div>

      {type === "ANNIVERSARY" && (
        <Field label="Married to" hint="A wedding anniversary links two people and is stored once.">
          <select
            className={inputClass}
            value={relatedPersonId}
            required
            onChange={(event) => setRelatedPersonId(event.target.value)}
          >
            <option value="">Choose a person…</option>
            {candidates
              .filter((candidate) => candidate.id !== personId)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.firstName} {candidate.lastName ?? ""}
                </option>
              ))}
          </select>
        </Field>
      )}

      {type !== "FEAST_DAY" && (
        <label className="tap-target flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-primary"
            checked={canShowYearCount && showYearCount}
            disabled={!canShowYearCount}
            onChange={(event) => setShowYearCount(event.target.checked)}
          />
          <span>
            <span className="font-bold text-ink">
              {type === "BIRTHDAY" ? "Show my age to others" : "Show how many years"}
            </span>
            <span className="block text-sm text-ink-muted">
              {canShowYearCount
                ? "Off by default. Only the day is shown otherwise."
                : "Enter a year first — an age cannot be worked out without one."}
            </span>
          </span>
        </label>
      )}

      {error && (
        <p role="alert" className="font-bold text-primary">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save date" : "Add date"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
