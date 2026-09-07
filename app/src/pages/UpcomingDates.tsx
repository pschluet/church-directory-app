import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
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
 *
 * Everything about what you are looking at -- the view, the range, the month,
 * the day -- lives in the query string rather than in component state, for the
 * same reasons Directory's search and filter do. It travels in a link, survives
 * a reload, and above all it comes back when you do: tapping a name here
 * unmounts this page, and held in `useState` the calendar would reset to the
 * current month and today the moment you pressed the back chevron. Which of the
 * writes below pushes a history entry and which replaces one is the whole
 * subtlety, and is commented at each.
 */

const RANGE_PRESETS = [7, 14, 30] as const;
const MAX_DAYS = 366;
const DEFAULT_DAYS = 7;

type View = "list" | "calendar";

interface CalendarResponse {
  year: number;
  month: number;
  days: { date: string; dates: SpecialDateOccurrenceDto[] }[];
}

/** `YYYY-MM`, the form the `month` param takes. */
function monthParam(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/*
 * Everything below parses defensively and falls back to the default rather than
 * trusting what it finds. These are four values that used to be `useState` with
 * a type each; in the URL they are strings someone can edit in the address bar,
 * and `days=-4` or `month=banana` has to mean "the default" and not a request
 * for four hundred days or an invalid Date.
 */

function readView(params: URLSearchParams): View {
  return params.get("view") === "calendar" ? "calendar" : "list";
}

function readDays(params: URLSearchParams): number {
  const raw = params.get("days");
  if (!raw) return DEFAULT_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(Math.max(parsed, 1), MAX_DAYS);
}

function readMonth(params: URLSearchParams): { year: number; month: number } {
  const now = new Date();
  const thisMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };

  const match = /^(\d{4})-(\d{2})$/.exec(params.get("month") ?? "");
  if (!match) return thisMonth;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return thisMonth;
  return { year, month };
}

/**
 * With no `day` param, today -- but only when today is a day the grid on screen
 * actually shows. Without that second half, paging to next month and reloading
 * selects a date that is not in the month you are looking at, and the list
 * underneath describes a day you cannot see.
 */
function readSelectedDate(params: URLSearchParams, year: number, month: number): string | null {
  const explicit = params.get("day");
  if (explicit) return explicit;

  const today = todayIso();
  return today.startsWith(monthParam(year, month)) ? today : null;
}

export function UpcomingDates() {
  const { organizationId } = useMe();
  const [params, setParams] = useSearchParams();

  const view = readView(params);
  const days = readDays(params);
  const { year: calendarYear, month: calendarMonth } = readMonth(params);
  const selectedDate = readSelectedDate(params, calendarYear, calendarMonth);

  // The browser's today, so the window is the user's day rather than the
  // server's timezone.
  const start = todayIso();

  /*
   * A push, not a replace: one deliberate press of a two-position switch is
   * exactly the kind of thing the browser's back button should undo.
   */
  function chooseView(next: View): void {
    setParams((prev) => {
      const updated = new URLSearchParams(prev);
      if (next === "calendar") updated.set("view", "calendar");
      else updated.delete("view");
      return updated;
    });
  }

  /*
   * Merged into whatever is already there, and the default dropped rather than
   * spelled out, so the common case leaves no query string at all.
   *
   * `replace` for the number box and a push for the presets, which is the same
   * split Directory draws between typing and clicking: three buttons are three
   * decisions worth being able to undo, where the box would otherwise leave a
   * history entry per digit.
   */
  function writeDays(next: number, options?: { replace?: boolean }): void {
    const clamped = Math.min(Math.max(next, 1), MAX_DAYS);
    setParams((prev) => {
      const updated = new URLSearchParams(prev);
      if (clamped === DEFAULT_DAYS) updated.delete("days");
      else updated.set("days", String(clamped));
      return updated;
    }, options);
  }

  /*
   * Year and month are one param rather than two, so there is no window in
   * which they disagree -- two writes, or one of the two missing from a
   * hand-edited URL, used to be expressible as "March 2026" and "September" at
   * the same time.
   *
   * A replace, unlike the view and range switches: paging through months is a
   * thing people do several times in a row, and pushing each one would bury the
   * page you arrived from under a stack of months for the chevron to walk back
   * through. The month is still in the URL, so coming back still finds it.
   */
  function changeMonth(year: number, month: number): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        updated.set("month", monthParam(year, month));
        // The selected day belongs to the month being left behind.
        updated.delete("day");
        return updated;
      },
      { replace: true }
    );
  }

  // Also a replace, and for the same reason: tapping around a grid to see what
  // is on each day is browsing, not navigating.
  function selectDate(date: string): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        updated.set("day", date);
        return updated;
      },
      { replace: true }
    );
  }

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
                onClick={() => chooseView(option)}
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
                  onClick={() => writeDays(preset)}
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
                  if (Number.isFinite(next)) writeDays(next, { replace: true });
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
            onSelectDate={selectDate}
            onChangeMonth={changeMonth}
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
