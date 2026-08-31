import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SpecialDateOccurrenceDto, UpcomingDatesDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { MonthCalendar } from "../components/MonthCalendar";
import { SpecialDateList } from "../components/SpecialDateList";
import { ErrorNotice, PageHeading, Spinner, inputClass } from "../components/ui";
import { formatDayLabel, todayIso } from "../lib/format";

/**
 * "Upcoming special dates."
 *
 * Defaults to today and the next six days, with the range adjustable. The month
 * grid is the optional second view; the list is the default on a phone, where a
 * calendar is cramped.
 */

const RANGE_PRESETS = [7, 14, 30] as const;
const MAX_DAYS = 366;

type View = "list" | "calendar";

interface CalendarResponse {
  year: number;
  month: number;
  days: { date: string; dates: SpecialDateOccurrenceDto[] }[];
}

export function UpcomingDates() {
  const { organizationId } = useMe();
  const [view, setView] = useState<View>("list");
  const [days, setDays] = useState(7);

  const now = new Date();
  const [calendarYear, setCalendarYear] = useState(now.getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(now.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(todayIso());

  // The browser's today, so the window is the user's day rather than the
  // server's timezone.
  const start = todayIso();

  /*
   * Each view fetches only while it is the one on screen, but what it fetched
   * stays in the cache -- so the list/calendar toggle no longer costs a request
   * every time it is pressed.
   */
  const upcomingQuery = useQuery({
    queryKey: qk.upcomingDates(organizationId, start, days),
    queryFn: ({ signal }) =>
      api<UpcomingDatesDto>("/special-dates/upcoming", { signal, query: { start, days } }),
    enabled: view === "list",
  });

  const calendarQuery = useQuery({
    queryKey: qk.calendar(organizationId, calendarYear, calendarMonth),
    queryFn: ({ signal }) =>
      api<CalendarResponse>("/special-dates/calendar", {
        signal,
        query: { year: calendarYear, month: calendarMonth },
      }),
    enabled: view === "calendar",
  });

  const upcoming = upcomingQuery.data ?? null;
  const calendar = calendarQuery.data ?? null;
  const loading = view === "list" && upcomingQuery.isPending;
  const error =
    (view === "list" ? upcomingQuery.error?.message : calendarQuery.error?.message) ?? null;

  const selectedDay = calendar?.days.find((day) => day.date === selectedDate);

  return (
    <>
      <PageHeading
        title="Special Dates"
        subtitle={
          view === "list" && upcoming
            ? `${formatDayLabel(upcoming.start)} to ${formatDayLabel(upcoming.end)}`
            : undefined
        }
        actions={
          <div
            role="group"
            aria-label="View"
            className="inline-flex overflow-hidden rounded-md border border-primary"
          >
            {(["list", "calendar"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={`tap-target px-4 py-2 font-bold capitalize transition ${
                  view === option ? "bg-primary text-white" : "text-primary hover:bg-primary/10"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />

      {error && <ErrorNotice message={error} />}

      {view === "list" ? (
        <>
          <div className="mb-6 flex flex-wrap items-end gap-3">
            <div
              role="group"
              aria-label="Range"
              className="inline-flex overflow-hidden rounded-md border border-line"
            >
              {RANGE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={days === preset}
                  onClick={() => setDays(preset)}
                  className={`tap-target px-3 py-2 font-bold transition ${
                    days === preset
                      ? "bg-primary/10 text-primary"
                      : "text-ink-muted hover:text-primary"
                  }`}
                >
                  {preset} days
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <span className="font-bold">or</span>
              <input
                className={`${inputClass} w-24`}
                type="number"
                min={1}
                max={MAX_DAYS}
                aria-label="Number of days"
                value={days}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setDays(Math.min(Math.max(next, 1), MAX_DAYS));
                }}
              />
              <span>days</span>
            </label>
          </div>

          {loading ? (
            <Spinner label="Loading dates" />
          ) : (
            <SpecialDateList days={upcoming?.days ?? []} />
          )}
        </>
      ) : (
        <div className="space-y-6">
          <MonthCalendar
            year={calendarYear}
            month={calendarMonth}
            days={calendar?.days ?? []}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            onChangeMonth={(year, month) => {
              setCalendarYear(year);
              setCalendarMonth(month);
              setSelectedDate(null);
            }}
          />

          {selectedDate && (
            <SpecialDateList
              days={selectedDay ? [selectedDay] : [{ date: selectedDate, dates: [] }]}
              emptyTitle="Nothing on this day"
            />
          )}
        </div>
      )}
    </>
  );
}
