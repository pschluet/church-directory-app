import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  publicEventRsvpSchema,
  publicJoinRequestSchema,
  type EventTokenTargetDto,
  type PublicEventDto,
} from "@shared";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatDayLabel, formatEventTimes, formatRelativeDay, todayIso } from "../lib/format";
import { Badge, Button, ErrorNotice, Field, Spinner, inputClass } from "../components/ui";
import { SignInForm } from "./Login";

/**
 * /e/:token -- the one URL an event's link, QR code and flyer all carry.
 *
 * It routes first and renders second, on one question: is there a session?
 *
 *   signed in  -> GET /events/by-token/:token (a lookup, no access check)
 *                   200 -> straight to /groups/:id/events/:postId, where the
 *                          group's own rules decide what this reader sees
 *                   404 -> "That event link is not valid."
 *   signed out -> GET /public/events/:token
 *                   200 -> the public page: the event, sign-in, and a way to
 *                          RSVP or ask to join without an account
 *                   404 -> a sign-in prompt that names nothing
 *
 * The anonymous 404 means the organizer did not tick "Allow Public RSVP", or
 * the token is made up. The API makes those indistinguishable on purpose, and
 * so does this page.
 *
 * Outside RootGate in the route table, since this is the one page that must
 * render without a session -- so no AppShell, no NavStack, no MeProvider. It
 * is a landing page, and the auth and query providers above the router are all
 * it needs.
 *
 * A scanned QR code opens in the phone's browser, not the installed app: that
 * would take iOS Universal Links or Android App Links, which this app does not
 * configure. Someone already in the app who taps the link stays in it.
 */
export function PublicEvent() {
  const { token = "" } = useParams<{ token: string }>();
  const { status } = useAuth();

  if (status === "loading") return <Spinner label="Opening the event" />;
  if (status === "signedIn") return <SignedInRedirect token={token} />;
  return <AnonymousEvent token={token} />;
}

function SignedInRedirect({ token }: { token: string }) {
  const target = useQuery({
    queryKey: qk.eventByToken(token),
    queryFn: ({ signal }) =>
      api<EventTokenTargetDto>(`/events/by-token/${encodeURIComponent(token)}`, {
        signal,
        withOrg: false,
      }),
    retry: false,
  });

  if (target.isPending) return <Spinner label="Opening the event" />;
  if (target.data) {
    // `replace`, so Back leaves the app rather than bouncing between this
    // URL and the event's page. Whether this reader may see the event is that
    // page's question, not this one's.
    return <Navigate to={`/groups/${target.data.groupId}/events/${target.data.postId}`} replace />;
  }
  return (
    <LandingFrame>
      <div className="mx-auto max-w-md">
        {target.error instanceof ApiError && target.error.status === 404 ? (
          <ErrorNotice message="That event link is not valid." />
        ) : (
          <ErrorNotice
            message={target.error?.message ?? "Could not open that event"}
            onRetry={() => void target.refetch()}
          />
        )}
      </div>
    </LandingFrame>
  );
}

function AnonymousEvent({ token }: { token: string }) {
  const eventQuery = useQuery({
    queryKey: qk.publicEvent(token),
    queryFn: ({ signal }) =>
      api<PublicEventDto>(`/public/events/${encodeURIComponent(token)}`, {
        signal,
        withOrg: false,
      }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  if (eventQuery.isPending) return <Spinner label="Opening the event" />;
  if (eventQuery.error instanceof ApiError && eventQuery.error.status === 404) {
    return <SignInGate />;
  }
  if (eventQuery.error || !eventQuery.data) {
    return (
      <LandingFrame>
        <div className="mx-auto max-w-md">
          <ErrorNotice
            message={eventQuery.error?.message ?? "Could not open that event"}
            onRetry={() => void eventQuery.refetch()}
          />
        </div>
      </LandingFrame>
    );
  }
  return <PublicEventPage token={token} event={eventQuery.data} />;
}

/** The band and the background, with nothing about any one event in them. */
function LandingFrame({
  band = "Parish Directory",
  children,
}: {
  band?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-muted">
      <div className="bg-primary px-4 py-2 text-center text-sm text-white">{band}</div>
      <main className="flex-1 px-4 py-8 md:py-12">{children}</main>
    </div>
  );
}

/**
 * What a link to an event that is not public shows -- and a made-up link too.
 * It must say nothing specific to either: no title, no group, no parish, and
 * no "request to join" or "RSVP without joining", which would be offering to
 * accept a reply about an event the reader cannot even confirm exists.
 * Signing in carries them on, through SignedInRedirect.
 */
function SignInGate() {
  return (
    <LandingFrame>
      <div className="flex justify-center">
        <SignInForm title="Sign in to see this event." offerRequest={false} />
      </div>
    </LandingFrame>
  );
}

function PublicEventPage({ token, event }: { token: string; event: PublicEventDto }) {
  const [reveal, setReveal] = useState(false);
  const past = event.eventDate < todayIso();
  const open = !event.cancelled && !past;

  return (
    <LandingFrame band={event.organizationName}>
      <div className="mx-auto max-w-xl space-y-6">
        <EventDetails event={event} past={past} />

        <div className="flex justify-center">
          <SignInForm
            // Nothing to RSVP to once it is cancelled; members can still sign in.
            title={event.cancelled ? "Members: sign in" : "Members: sign in to RSVP"}
            headingLevel="h2"
            autoFocus={false}
            offerRequest={false}
            fullWidth
          />
        </div>

        {open && (
          <div className="rounded-lg border border-line bg-surface p-6 shadow-sm md:p-8">
            <button
              type="button"
              aria-expanded={reveal}
              onClick={() => setReveal((value) => !value)}
              className="w-full text-left font-bold text-primary underline-offset-2 hover:text-accent hover:underline"
            >
              Not a member? Request to join or RSVP without joining.
            </button>
            {reveal && <NonMemberChoices token={token} title={event.title} />}
          </div>
        )}
      </div>
    </LandingFrame>
  );
}

function EventDetails({ event, past }: { event: PublicEventDto; past: boolean }) {
  const times = formatEventTimes(event.startTime, event.endTime);
  const soon = past || event.cancelled ? null : formatRelativeDay(event.eventDate);
  const struck = event.cancelled ? "line-through text-ink-muted" : "";

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className="h-1.5 bg-gradient-to-r from-primary via-primary-light to-accent" />
      <div className="space-y-4 p-6 md:p-8">
        {event.cancelled && (
          <p
            role="status"
            className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 font-bold text-primary"
          >
            This event has been cancelled.
          </p>
        )}
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {soon && <Badge tone="accent">{soon}</Badge>}
            {past && !event.cancelled && <Badge tone="neutral">Past</Badge>}
          </div>
          <h1 className={`break-words text-3xl font-bold leading-tight text-ink ${struck}`}>
            {event.title}
          </h1>
          {event.groupName && (
            <p className="text-sm text-ink-muted">
              Hosted by <span className="font-bold text-ink">{event.groupName}</span>
            </p>
          )}
        </div>
        <dl className={`space-y-2 text-ink ${struck}`}>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 font-bold text-ink-muted">When</dt>
            <dd>
              {formatDayLabel(event.eventDate)}
              {times && <span> · {times}</span>}
            </dd>
          </div>
          {event.location && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 font-bold text-ink-muted">Where</dt>
              <dd className="min-w-0 break-words">
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {event.location}
                </a>
              </dd>
            </div>
          )}
        </dl>
        {event.description && (
          // Muted rather than struck through when cancelled: a paragraph of
          // struck-out text is hard to read, and the banner already says it.
          <p
            className={`whitespace-pre-line break-words leading-relaxed ${
              event.cancelled ? "text-ink-muted" : "text-ink"
            }`}
          >
            {event.description}
          </p>
        )}
        {!event.cancelled && event.rsvpCounts.attending > 0 && (
          <p className="text-sm font-bold text-accent">
            {event.rsvpCounts.attending}{" "}
            {event.rsvpCounts.attending === 1 ? "person is" : "people are"} going
          </p>
        )}
      </div>
    </article>
  );
}

type Choice = "rsvp" | "join";

/** The two things somebody without an account can do, disclosed under the event. */
function NonMemberChoices({ token, title }: { token: string; title: string }) {
  const [choice, setChoice] = useState<Choice | null>(null);

  const option = (value: Choice, label: string) => (
    <button
      type="button"
      aria-pressed={choice === value}
      onClick={() => setChoice(value)}
      className={`flex-1 rounded-lg border px-4 py-3 font-bold transition ${
        choice === value
          ? "border-primary bg-primary text-white"
          : "border-line bg-surface text-ink hover:border-accent"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        {option("rsvp", "RSVP without joining")}
        {option("join", "Request to join")}
      </div>
      {choice === "rsvp" && <PublicRsvpForm token={token} title={title} />}
      {choice === "join" && <JoinRequestForm token={token} />}
    </div>
  );
}

interface NameFields {
  firstName: string;
  lastName: string;
  email: string;
}

function NameInputs({
  values,
  onChange,
  errors,
}: {
  values: NameFields;
  onChange: (values: NameFields) => void;
  errors: Record<string, string>;
}) {
  const input = (key: keyof NameFields, label: string, type = "text", autoComplete?: string) => (
    <Field label={label} error={errors[key]}>
      <input
        className={inputClass}
        type={type}
        autoComplete={autoComplete}
        required
        aria-invalid={Boolean(errors[key])}
        value={values[key]}
        onChange={(event) => onChange({ ...values, [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {input("firstName", "First name", "text", "given-name")}
        {input("lastName", "Last name", "text", "family-name")}
      </div>
      {input("email", "Email address", "email", "email")}
    </>
  );
}

/** Field errors keyed by path, from the same schema the API runs. */
function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }) {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    errors[key] ??= issue.message;
  }
  return errors;
}

/**
 * RSVP without an account: implicitly "going". Every field is required, and 0
 * guests is a real answer where an empty box is not. The same email twice is a
 * correction, so the one confirmation is right either way. Nothing is emailed
 * to the address -- see routes/public.ts -- so this screen is the confirmation.
 */
function PublicRsvpForm({ token, title }: { token: string; title: string }) {
  const [values, setValues] = useState<NameFields>({ firstName: "", lastName: "", email: "" });
  const [guests, setGuests] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: (body: unknown) =>
      api(`/public/events/${encodeURIComponent(token)}/rsvp`, {
        method: "POST",
        body,
        withOrg: false,
      }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = publicEventRsvpSchema.safeParse({
      ...values,
      guestCount: guests.trim() === "" ? undefined : Number(guests),
    });
    if (!parsed.success) {
      setErrors(issuesOf(parsed.error));
      return;
    }
    setErrors({});
    submit.mutate(parsed.data);
  }

  if (submit.isSuccess && submit.variables) {
    const count = (submit.variables as { guestCount: number }).guestCount;
    return (
      <p role="status" className="rounded-md border border-accent/40 bg-accent/5 p-4 text-ink">
        You are on the list for <strong>{title}</strong>
        {count > 0 && (
          <>
            , with{" "}
            <strong>
              {count} {count === 1 ? "guest" : "guests"}
            </strong>
          </>
        )}
        . To change your answer, send the form again with the same email address.
      </p>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-3">
      <NameInputs values={values} onChange={setValues} errors={errors} />
      <Field
        label="Number of guests"
        hint="Not counting yourself. 0 if it is just you."
        error={errors.guestCount}
      >
        <input
          className={`${inputClass} max-w-32`}
          type="number"
          inputMode="numeric"
          min={0}
          max={50}
          required
          aria-invalid={Boolean(errors.guestCount)}
          value={guests}
          onChange={(event) => setGuests(event.target.value)}
        />
      </Field>
      {submit.error && (
        <p role="alert" className="font-bold text-primary">
          {submit.error.message}
        </p>
      )}
      <Button type="submit" disabled={submit.isPending} className="w-full">
        {submit.isPending ? "Sending…" : "RSVP"}
      </Button>
    </form>
  );
}

/**
 * Asking to be added to the parish's directory. Lands in the same queue as the
 * sign-in page's "Request to be added", in the event's own parish.
 */
function JoinRequestForm({ token }: { token: string }) {
  const [values, setValues] = useState<NameFields>({ firstName: "", lastName: "", email: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: (body: unknown) =>
      api(`/public/events/${encodeURIComponent(token)}/join-request`, {
        method: "POST",
        body,
        withOrg: false,
      }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = publicJoinRequestSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(issuesOf(parsed.error));
      return;
    }
    setErrors({});
    submit.mutate(parsed.data);
  }

  if (submit.isSuccess) {
    return (
      <p role="status" className="rounded-md border border-accent/40 bg-accent/5 p-4 text-ink">
        We have passed that on to the parish office. Someone will be in touch.
      </p>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-3">
      <NameInputs values={values} onChange={setValues} errors={errors} />
      {submit.error && (
        <p role="alert" className="font-bold text-primary">
          {submit.error.message}
        </p>
      )}
      <Button type="submit" disabled={submit.isPending} className="w-full">
        {submit.isPending ? "Sending…" : "Request to join"}
      </Button>
    </form>
  );
}
