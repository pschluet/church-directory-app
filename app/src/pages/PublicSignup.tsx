import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  signupDetailPath,
  publicSignupEntryCreateSchema,
  type PublicSignupDto,
  type PublicSignupEntryCreatedDto,
  type SignupTokenTargetDto,
} from "@shared";
import { useAuth } from "../context/AuthContext";
import { api, ApiError } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatDayLabel } from "../lib/format";
import {
  entryEditUrl,
  loadEditTokens,
  parseEntryParam,
  saveEditTokens,
  templateSpec,
} from "../lib/signups";
import { Badge, Button, ErrorNotice, Field, Spinner, inputClass } from "../components/ui";
import { LandingFrame } from "../components/LandingFrame";
import { LinkifiedText } from "../components/LinkifiedText";
import {
  ImportantInfo,
  SignupIcon,
  SignupSlots,
  type EntryInput,
  type SignupView,
} from "../components/GroupSignup";
import { SignInForm } from "./Login";

/**
 * /s/:token -- the one URL a sign-up's link, QR code and flyer all carry. It
 * routes exactly as /e/:token does (see PublicEvent.tsx): a signed-in reader is
 * sent to the sign-up in its group; anybody else gets the public page, if the
 * organizer opened it, and a sign-in prompt that names nothing if not.
 *
 * The public page leads with sign-in, like the event page: the sign-up's
 * details, then "Members: sign in to sign up", then a folded "Not a member?"
 * card that holds the slots and the name and email fields. It starts unfolded
 * for a returning stranger -- one whose browser holds edit tokens for this
 * sign-up, or who followed their "save this link" URL -- so their own entries
 * are where they left them.
 *
 * The public page never names anyone. A stranger's own entries are known by
 * the edit tokens this browser holds -- from signing up here, or from the
 * "save this link" URL (`?entry=<id>.<token>`), which works on any device.
 */
export function PublicSignup() {
  const { token = "" } = useParams<{ token: string }>();
  const { status } = useAuth();

  if (status === "loading") return <Spinner label="Opening the sign-up" />;
  if (status === "signedIn") return <SignedInRedirect token={token} />;
  return <AnonymousSignup token={token} />;
}

function SignedInRedirect({ token }: { token: string }) {
  const target = useQuery({
    queryKey: qk.signupByToken(token),
    queryFn: ({ signal }) =>
      api<SignupTokenTargetDto>(`/events/signups/by-token/${encodeURIComponent(token)}`, {
        signal,
        withOrg: false,
      }),
    retry: false,
  });

  if (target.isPending) return <Spinner label="Opening the sign-up" />;
  if (target.data) {
    return <Navigate to={signupDetailPath(target.data.groupId, target.data.postId)} replace />;
  }
  return (
    <LandingFrame>
      <div className="mx-auto max-w-md">
        {target.error instanceof ApiError && target.error.status === 404 ? (
          <ErrorNotice message="That sign-up link is not valid." />
        ) : (
          <ErrorNotice
            message={target.error?.message ?? "Could not open that sign-up"}
            onRetry={() => void target.refetch()}
          />
        )}
      </div>
    </LandingFrame>
  );
}

function AnonymousSignup({ token }: { token: string }) {
  const query = useQuery({
    queryKey: qk.publicSignup(token),
    queryFn: ({ signal }) =>
      api<PublicSignupDto>(`/public/signups/${encodeURIComponent(token)}`, {
        signal,
        withOrg: false,
      }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  if (query.isPending) return <Spinner label="Opening the sign-up" />;
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <LandingFrame>
        <div className="flex justify-center">
          <SignInForm title="Sign in to see this sign-up." offerRequest={false} />
        </div>
      </LandingFrame>
    );
  }
  if (query.error || !query.data) {
    return (
      <LandingFrame>
        <div className="mx-auto max-w-md">
          <ErrorNotice
            message={query.error?.message ?? "Could not open that sign-up"}
            onRetry={() => void query.refetch()}
          />
        </div>
      </LandingFrame>
    );
  }
  return <PublicSignupPage token={token} signup={query.data} refetch={() => query.refetch()} />;
}

interface Signer {
  firstName: string;
  lastName: string;
  email: string;
}

const SIGNER_KEY = "signup-signer";

/** Whoever last signed up from this browser, so a second slot needs no retyping. */
function loadSigner(): Signer {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIGNER_KEY) ?? "null") as Signer | null;
    if (parsed && typeof parsed.firstName === "string") return parsed;
  } catch {
    // Fall through to blank.
  }
  return { firstName: "", lastName: "", email: "" };
}

function saveSigner(signer: Signer): void {
  try {
    window.localStorage.setItem(SIGNER_KEY, JSON.stringify(signer));
  } catch {
    // Not fatal.
  }
}

function PublicSignupPage({
  token,
  signup,
  refetch,
}: {
  token: string;
  signup: PublicSignupDto;
  refetch: () => Promise<unknown>;
}) {
  const [params] = useSearchParams();
  const [tokens, setTokens] = useState<Record<string, string>>(() => loadEditTokens(token));
  const [signer, setSigner] = useState<Signer>(loadSigner);
  const [saved, setSaved] = useState<{ entryId: string; editToken: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(
    () => Object.keys(tokens).length > 0 || params.get("entry") !== null
  );

  // An edit link opened on this device: remember its token like one made here.
  useEffect(() => {
    const fromLink = parseEntryParam(params.get("entry"));
    if (!fromLink) return;
    setTokens((current) => {
      if (current[fromLink.entryId] === fromLink.token) return current;
      const next = { ...current, [fromLink.entryId]: fromLink.token };
      saveEditTokens(token, next);
      return next;
    });
  }, [params, token]);

  const write = useMutation({
    mutationFn: (request: { path: string; method: string; body: unknown }) =>
      api<PublicSignupEntryCreatedDto | null>(request.path, {
        method: request.method,
        body: request.body,
        withOrg: false,
      }),
    onSettled: async () => {
      await refetch();
    },
  });

  const view: SignupView = useMemo(
    () => ({
      noteMode: signup.noteMode,
      notePrompt: signup.notePrompt,
      writeInsEnabled: signup.writeInsEnabled,
      writeInMax: signup.writeInMax,
      writeInCount: signup.writeInCount,
      closed: signup.closed,
      slots: signup.slots.map((slot) => ({
        ...slot,
        entries: slot.entries.map((e) => ({
          id: e.id,
          quantity: e.quantity,
          note: e.note,
          name: null,
          personId: null,
          isMine: e.id in tokens,
          canRemove: e.id in tokens,
        })),
      })),
    }),
    [signup, tokens]
  );

  const base = `/public/signups/${encodeURIComponent(token)}/entries`;

  async function create(input: EntryInput): Promise<unknown> {
    const parsed = publicSignupEntryCreateSchema.safeParse({ ...input, ...signer });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Check your name and email";
      throw Object.assign(new Error(message), { local: true });
    }
    saveSigner(signer);
    const created = await write.mutateAsync({ path: base, method: "POST", body: parsed.data });
    if (created) {
      const next = { ...tokens, [created.entryId]: created.editToken };
      setTokens(next);
      saveEditTokens(token, next);
      setSaved(created);
    }
    return created;
  }

  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? (write.error instanceof Error ? write.error.message : null);
  const spec = templateSpec(signup.template);
  const editUrl = saved ? entryEditUrl(token, saved.entryId, saved.editToken) : null;

  const nameFields = (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="First name">
          <input
            className={inputClass}
            autoComplete="given-name"
            value={signer.firstName}
            onChange={(e) => setSigner({ ...signer, firstName: e.target.value })}
          />
        </Field>
        <Field label="Last name">
          <input
            className={inputClass}
            autoComplete="family-name"
            value={signer.lastName}
            onChange={(e) => setSigner({ ...signer, lastName: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Email address" hint="For the organizer only. Never shown on this page.">
        <input
          className={inputClass}
          type="email"
          autoComplete="email"
          value={signer.email}
          onChange={(e) => setSigner({ ...signer, email: e.target.value })}
        />
      </Field>
    </div>
  );

  return (
    <LandingFrame band={signup.organizationName}>
      <div className="mx-auto max-w-xl space-y-6">
        <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <div className="h-1.5 bg-gradient-to-r from-primary via-primary-light to-accent" />
          <div className="space-y-4 p-6 md:p-8">
            {signup.cancelled && (
              <p
                role="status"
                className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 font-bold text-primary"
              >
                This sign-up has been removed.
              </p>
            )}
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent">
                <SignupIcon />
                Sign-up{signup.template !== "CUSTOM" && ` · ${spec.name}`}
              </p>
              <h1 className="break-words text-3xl font-bold leading-tight text-ink">
                {signup.title}
              </h1>
              {signup.groupName && (
                <p className="text-sm text-ink-muted">
                  From <span className="font-bold text-ink">{signup.groupName}</span>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {signup.closed && !signup.cancelled && <Badge tone="neutral">Closed</Badge>}
                {signup.closesOn && !signup.closed && (
                  <Badge tone="accent">Sign up by {formatDayLabel(signup.closesOn)}</Badge>
                )}
              </div>
            </div>
            {signup.description && (
              <p className="whitespace-pre-line break-words leading-relaxed text-ink [overflow-wrap:anywhere]">
                <LinkifiedText text={signup.description} />
              </p>
            )}
            {signup.importantInfo && <ImportantInfo text={signup.importantInfo} />}
          </div>
        </article>

        <div className="flex justify-center">
          <SignInForm
            // Nothing to sign up for once it is removed or closed; members can still sign in.
            title={
              signup.cancelled || signup.closed ? "Members: sign in" : "Members: sign in to sign up"
            }
            headingLevel="h2"
            autoFocus={false}
            offerRequest={false}
            fullWidth
          />
        </div>

        {!signup.cancelled && (
          <div className="rounded-lg border border-line bg-surface p-6 shadow-sm md:p-8">
            <button
              type="button"
              aria-expanded={reveal}
              onClick={() => setReveal((value) => !value)}
              className="w-full text-left font-bold text-primary underline-offset-2 hover:text-accent hover:underline"
            >
              Not a member? Sign up without an account.
            </button>
            {reveal && (
              <div className="mt-4 space-y-4">
                {editUrl && (
                  <div
                    role="status"
                    className="space-y-2 rounded-xl border border-accent/40 bg-accent/5 p-4 text-ink"
                  >
                    <p className="font-bold">You're signed up. Thank you!</p>
                    <p className="text-sm">
                      Save this link to change or cancel your sign-up later. Nothing is emailed to
                      you.
                    </p>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        aria-label="Your edit link"
                        className={`${inputClass} text-sm`}
                        value={editUrl}
                        onFocus={(e) => e.target.select()}
                      />
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void navigator.clipboard?.writeText(editUrl).then(() => setCopied(true));
                        }}
                      >
                        {copied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                )}

                <SignupSlots
                  view={view}
                  canSignUp={!signup.closed}
                  linkPeople={false}
                  busy={write.isPending}
                  error={error}
                  formExtra={nameFields}
                  onCreate={async (input) => {
                    setLocalError(null);
                    setSaved(null);
                    try {
                      return await create(input);
                    } catch (err) {
                      if ((err as { local?: boolean }).local) setLocalError((err as Error).message);
                      throw err;
                    }
                  }}
                  onUpdate={(entryId, input) => {
                    setLocalError(null);
                    return write.mutateAsync({
                      path: `${base}/${entryId}`,
                      method: "PATCH",
                      body: { ...input, editToken: tokens[entryId] },
                    });
                  }}
                  onRemove={(entry) => {
                    setLocalError(null);
                    write.mutate({
                      path: `${base}/${entry.id}`,
                      method: "DELETE",
                      body: { editToken: tokens[entry.id] },
                    });
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </LandingFrame>
  );
}
