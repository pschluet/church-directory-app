import { useState } from "react";
import {
  daysInMonth,
  MOVEABLE_FEASTS,
  MOVEABLE_FEAST_LABELS,
  resolveSpecialDateRule,
  specialDateWriteSchema,
  WEEKDAY_NAMES,
  type MoveableFeast,
  type RuleDirection,
  type RuleUnit,
  type SpecialDateDto,
  type SpecialDateRule,
  type SpecialDateType,
} from "@shared";
import { api } from "../lib/api";
import {
  formatMonthDay,
  formatSpecialDateRule,
  MONTH_NAMES,
  showYearCountLabel,
} from "../lib/format";
import { PersonPicker, type PickedPerson } from "./PersonPicker";
import { Button, Field, SegmentedControl, Select, inputClass } from "./ui";

/**
 * Adding or editing a special date.
 *
 * The form enforces the same rules as the schema and the database, but the
 * point is to make them visible rather than to catch mistakes: the "show age"
 * checkbox is disabled until a year is entered, and choosing "wedding
 * anniversary" makes both the year and the second person required.
 *
 * A name day additionally gets a choice between a fixed day and one set
 * relative to a church feast ("the 2nd Sunday after Pascha") -- the rule is
 * stored instead of a month and day, and resolved to an actual date by the
 * server and by the preview below.
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
  {
    value: "FEAST_DAY",
    label: "Name day",
    help: "The feast of your patron saint — a fixed day, or one that moves with Pascha.",
  },
];

const MODE_OPTIONS: { value: "ABSOLUTE" | "RELATIVE"; label: string }[] = [
  { value: "ABSOLUTE", label: "On a date" },
  { value: "RELATIVE", label: "Relative to a feast" },
];

const COUNT_UNIT_OPTIONS: { value: RuleUnit; label: string }[] = [
  { value: "DAYS", label: "Days" },
  { value: "WEEKDAY", label: "Days of the week" },
];

const DIRECTION_OPTIONS: { value: RuleDirection; label: string }[] = [
  { value: "AFTER", label: "After" },
  { value: "BEFORE", label: "Before" },
];

const WEEKDAY_OPTIONS = WEEKDAY_NAMES.map((name, index) => ({
  value: String(index),
  label: name,
}));

/** The next three years' dates a rule resolves to, so it is obvious the date moves. */
function rulePreviewDates(rule: SpecialDateRule): string {
  const startYear = new Date().getFullYear();
  return [startYear, startYear + 1, startYear + 2]
    .map((year) => resolveSpecialDateRule(rule, year))
    .map((resolved) => formatMonthDay(resolved.month, resolved.day, resolved.year))
    .join(" · ");
}

export function SpecialDateForm({
  personId,
  existing,
  onSaved,
  onCancel,
}: {
  personId: string;
  existing?: SpecialDateDto;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<SpecialDateType>(existing?.type ?? "BIRTHDAY");
  const [mode, setMode] = useState<"ABSOLUTE" | "RELATIVE">(
    existing?.rule ? "RELATIVE" : "ABSOLUTE"
  );
  const [month, setMonth] = useState(existing?.month ?? 1);
  const [day, setDay] = useState(existing?.day ?? 1);
  const [year, setYear] = useState<string>(existing?.year ? String(existing.year) : "");
  const [showYearCount, setShowYearCount] = useState(existing?.showYearCount ?? false);
  // Seeded from the date being edited, so reopening an anniversary shows the
  // partner without a lookup -- the DTO already carries their name.
  const [relatedPerson, setRelatedPerson] = useState<PickedPerson | null>(
    existing?.relatedPersonId && existing.relatedPersonName
      ? { id: existing.relatedPersonId, name: existing.relatedPersonName }
      : null
  );

  const [reference, setReference] = useState<MoveableFeast>(existing?.rule?.reference ?? "PASCHA");
  const [direction, setDirection] = useState<RuleDirection>(existing?.rule?.direction ?? "AFTER");
  const [unit, setUnit] = useState<RuleUnit>(existing?.rule?.unit ?? "DAYS");
  const [count, setCount] = useState(String(existing?.rule?.count ?? 0));
  const [weekday, setWeekday] = useState(String(existing?.rule?.weekday ?? 0));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedYear = year.trim() === "" ? null : Number(year);
  const yearRequired = type === "ANNIVERSARY";
  // "if opting-in to showing age, must select full month/day/year"
  const canShowYearCount = parsedYear !== null;
  const maxDay = daysInMonth(month, parsedYear);
  const relative = type === "FEAST_DAY" && mode === "RELATIVE";

  const selectedType = TYPE_OPTIONS.find((option) => option.value === type)!;

  const rule: SpecialDateRule = {
    reference,
    direction,
    unit,
    count: Number(count || 0),
    weekday: unit === "WEEKDAY" ? Number(weekday) : null,
  };

  async function save(): Promise<void> {
    setError(null);

    const payload = relative
      ? {
          type,
          month: null,
          day: null,
          year: null,
          showYearCount: false,
          relatedPersonId: null,
          rule,
        }
      : {
          type,
          month,
          day: Math.min(day, maxDay),
          year: type === "FEAST_DAY" ? null : parsedYear,
          showYearCount: canShowYearCount && showYearCount,
          relatedPersonId: type === "ANNIVERSARY" ? (relatedPerson?.id ?? null) : null,
          rule: null,
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
        <Select
          value={type}
          onChange={(next) => {
            setType(next);
            // A name day is a day only, so a year would be rejected.
            if (next === "FEAST_DAY") {
              setYear("");
              setShowYearCount(false);
            } else {
              // Only a name day can be relative -- switching away drops it.
              setMode("ABSOLUTE");
            }
          }}
          options={TYPE_OPTIONS}
        />
      </Field>

      {type === "FEAST_DAY" && (
        <SegmentedControl
          label="How the date is set"
          value={mode}
          onChange={setMode}
          options={MODE_OPTIONS}
        />
      )}

      {!relative && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Month">
            <Select
              value={String(month)}
              onChange={(value) => setMonth(Number(value))}
              options={MONTH_NAMES.map((name, index) => ({
                value: String(index + 1),
                label: name,
              }))}
            />
          </Field>

          <Field label="Day">
            <Select
              value={String(Math.min(day, maxDay))}
              onChange={(value) => setDay(Number(value))}
              options={Array.from({ length: maxDay }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              }))}
            />
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
      )}

      {relative && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Feast">
              <Select
                value={reference}
                onChange={setReference}
                options={MOVEABLE_FEASTS.map((feast) => ({
                  value: feast,
                  label: MOVEABLE_FEAST_LABELS[feast],
                }))}
              />
            </Field>

            <Field label="Count by">
              <Select
                value={unit}
                onChange={(next) => {
                  setUnit(next);
                  if (next === "WEEKDAY" && Number(count) < 1) setCount("1");
                }}
                options={COUNT_UNIT_OPTIONS}
              />
            </Field>

            <Field
              label="How many"
              hint={
                unit === "DAYS"
                  ? "Zero is the feast itself."
                  : "Counted strictly after — 1 Sunday after Pascha is the Sunday following it, not Pascha itself."
              }
            >
              <input
                className={inputClass}
                inputMode="numeric"
                value={count}
                onChange={(event) => setCount(event.target.value.replace(/\D/g, "").slice(0, 3))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {unit === "WEEKDAY" && (
              <Field label="Day of the week">
                <Select value={weekday} onChange={setWeekday} options={WEEKDAY_OPTIONS} />
              </Field>
            )}
            <Field label="Before or after">
              <Select value={direction} onChange={setDirection} options={DIRECTION_OPTIONS} />
            </Field>
          </div>

          <p role="status" aria-live="polite" className="text-sm text-ink-muted">
            <span className="font-bold text-ink">{formatSpecialDateRule(rule)}</span>
            {" — "}
            {rulePreviewDates(rule)}
          </p>
        </>
      )}

      {type === "ANNIVERSARY" && (
        <PersonPicker
          label="Married to"
          hint="A wedding anniversary links two people and is stored once."
          value={relatedPerson}
          onChange={setRelatedPerson}
          excludePersonId={personId}
        />
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
            <span className="font-bold text-ink">{showYearCountLabel(type)}</span>
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
