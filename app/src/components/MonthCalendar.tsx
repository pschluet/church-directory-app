import { useMemo } from "react";
import type { SpecialDateOccurrenceDto } from "@shared";
import { MONTH_NAMES, parseIsoDate, todayIso } from "../lib/format";

/**
 * The optional month grid from the requirements: marks the days that have
 * something on them, and tapping one shows that day's dates beneath.
 *
 * On a phone each cell is a dot-marked number, which is all that fits legibly;
 * from `lg` up the cells grow and show a preview of the entries.
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export interface CalendarDay {
  date: string;
  dates: SpecialDateOccurrenceDto[];
}

export function MonthCalendar({
  year,
  month,
  days,
  selectedDate,
  onSelectDate,
  onChangeMonth,
}: {
  year: number;
  month: number;
  days: CalendarDay[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  onChangeMonth: (year: number, month: number) => void;
}) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const today = todayIso();

  // Blank cells so the 1st lands under the right weekday.
  const leadingBlanks = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const step = (delta: number) => {
    const next = new Date(year, month - 1 + delta, 1);
    onChangeMonth(next.getFullYear(), next.getMonth() + 1);
  };

  return (
    <div className="rounded-lg border border-line bg-surface p-3 md:p-4">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous month"
          className="tap-target rounded-md px-2 text-xl text-ink-muted transition hover:text-primary"
        >
          ‹
        </button>
        <h3 className="font-bold text-ink">
          {MONTH_NAMES[month - 1]} {year}
        </h3>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="Next month"
          className="tap-target rounded-md px-2 text-xl text-ink-muted transition hover:text-primary"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-ink-muted">
        {WEEKDAYS.map((day) => (
          <div key={day} className="py-1">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <div key={`blank-${i}`} aria-hidden="true" />
        ))}

        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const entries = byDate.get(iso)?.dates ?? [];
          const isSelected = selectedDate === iso;
          const isToday = iso === today;

          return (
            <button
              key={iso}
              type="button"
              onClick={() => onSelectDate(iso)}
              aria-pressed={isSelected}
              aria-label={`${MONTH_NAMES[month - 1]} ${day}${
                entries.length
                  ? `, ${entries.length} special date${entries.length > 1 ? "s" : ""}`
                  : ""
              }`}
              className={`tap-target flex flex-col items-center justify-start rounded-md p-1 transition lg:min-h-20 lg:items-start lg:p-2 ${
                isSelected
                  ? "bg-primary text-white"
                  : entries.length > 0
                    ? "bg-primary/5 text-ink hover:bg-primary/10"
                    : "text-ink-muted hover:bg-surface-muted"
              }`}
            >
              <span
                className={`text-sm ${isToday ? "font-bold underline decoration-accent decoration-2 underline-offset-2" : ""}`}
              >
                {day}
              </span>

              {entries.length > 0 && (
                <>
                  {/* Phones and tablets: a dot per entry, capped at three. */}
                  <span className="mt-0.5 flex gap-0.5 lg:hidden" aria-hidden="true">
                    {entries.slice(0, 3).map((entry) => (
                      <span
                        key={entry.id}
                        className={`h-1.5 w-1.5 rounded-full ${
                          isSelected ? "bg-white" : "bg-primary"
                        }`}
                      />
                    ))}
                  </span>

                  {/* Wide screens: show who it is. */}
                  <span
                    className="mt-1 hidden w-full flex-col items-start gap-0.5 text-left text-[0.65rem] leading-tight lg:flex"
                    aria-hidden="true"
                  >
                    {entries.slice(0, 2).map((entry) => (
                      <span key={entry.id} className="w-full truncate">
                        {entry.personName}
                      </span>
                    ))}
                    {entries.length > 2 && <span>+{entries.length - 2} more</span>}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {selectedDate && (
        <p className="mt-3 border-t border-line pt-3 text-sm text-ink-muted">
          Showing{" "}
          {parseIsoDate(selectedDate).toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
      )}
    </div>
  );
}
