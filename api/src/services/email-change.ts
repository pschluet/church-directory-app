import { createHash, timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { Caller } from "../auth";
import { one, type Queryable } from "../db";
import { audit } from "../audit";
import { generateCode, MAX_ATTEMPTS } from "../auth-challenge";
import { updateUserEmail } from "../cognito";
import { sendEmailChangeCodeEmail, sendEmailChangedNoticeEmail } from "../email";
import { emailSchema, type PendingEmailChangeDto } from "../types";

/**
 * Changing the address an account signs in with.
 *
 * There are two ways in, and both end up at `applyEmailChange`:
 *
 *   Self-service  `requestEmailChange` emails a code to the *new* address;
 *                 nothing changes until `confirmEmailChange` is given it back.
 *                 The same proof-of-mailbox the sign-in flow itself relies on
 *                 (see auth-challenge.ts), which is the point: the pool's
 *                 accountRecovery is NONE, so a mistyped address with no
 *                 verification would be unrecoverable.
 *   Admin override  routes/admin.ts and routes/persons.ts call
 *                 `applyEmailChange` directly, with no code -- the rescue path
 *                 for someone who has lost access to their old mailbox and so
 *                 could never receive a code there in the first place.
 *
 * `app_users.email` is the sign-in address; `persons.email` is the directory
 * contact address shown to other members. For anyone with an account the two
 * are kept identical -- applyEmailChange writes both in the same transaction
 * and drops any email inheritance pointing at the person, which would
 * otherwise contradict the mirror the next time it was read.
 */

const EXPIRY_MINUTES = 10;

interface AccountRow {
  id: string;
  cognito_sub: string | null;
  email: string;
  organization_id: string | null;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

async function loadAccount(q: Queryable, appUserId: string): Promise<AccountRow> {
  const row = await one<AccountRow>(
    q,
    "select id, cognito_sub, email::text as email, organization_id from app_users where id = $1",
    [appUserId]
  );
  if (!row) throw new HTTPException(404, { message: "Account not found" });
  return row;
}

/** 409s if `email` already belongs to some other account. */
export async function assertEmailAvailable(q: Queryable, email: string): Promise<void> {
  const existing = await one<{ id: string }>(q, "select id from app_users where email = $1", [
    email,
  ]);
  if (existing) {
    throw new HTTPException(409, {
      message: "Someone with that email address already has an account",
    });
  }
}

/**
 * Starts a self-service change for `appUserId`: emails a code to `rawEmail`
 * and records it as pending. Replaces whatever request was already pending
 * for this account, so asking twice just resends rather than stacking codes.
 */
export async function requestEmailChange(
  q: Queryable,
  appUserId: string,
  rawEmail: string
): Promise<PendingEmailChangeDto> {
  const email = emailSchema.parse(rawEmail);
  const account = await loadAccount(q, appUserId);
  if (email === account.email) {
    throw new HTTPException(400, { message: "That is already your sign-in address" });
  }
  await assertEmailAvailable(q, email);

  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60_000);

  await q.query(
    `insert into email_change_requests (app_user_id, new_email, code_hash, attempts, expires_at)
     values ($1, $2, $3, 0, $4)
     on conflict (app_user_id) do update
       set new_email = excluded.new_email,
           code_hash = excluded.code_hash,
           attempts = 0,
           created_at = now(),
           expires_at = excluded.expires_at`,
    [appUserId, email, hashCode(code), expiresAt]
  );

  await sendEmailChangeCodeEmail({ to: email, code });

  return { email, expiresAt: expiresAt.toISOString() };
}

/** Drops a pending self-service request without applying it. */
export async function cancelEmailChange(q: Queryable, appUserId: string): Promise<void> {
  await q.query("delete from email_change_requests where app_user_id = $1", [appUserId]);
}

/** The pending request for `appUserId`, or null if there is none or it has expired. */
export async function pendingEmailChangeFor(
  q: Queryable,
  appUserId: string
): Promise<PendingEmailChangeDto | null> {
  const row = await one<{ new_email: string; expires_at: Date }>(
    q,
    `select new_email::text as new_email, expires_at
       from email_change_requests
      where app_user_id = $1 and expires_at > now()`,
    [appUserId]
  );
  return row ? { email: row.new_email, expiresAt: row.expires_at.toISOString() } : null;
}

/**
 * Checks `code` against the request pending for the caller's own account and,
 * on a match, applies it, returning the address it was changed to. A missing
 * or expired request, a wrong code, or a request that has already used up
 * MAX_ATTEMPTS all throw 400 -- the member has to call `requestEmailChange`
 * again, which also sends a fresh code.
 */
export async function confirmEmailChange(
  q: Queryable,
  caller: Caller,
  code: string
): Promise<string> {
  const pending = await one<{
    new_email: string;
    code_hash: string;
    attempts: number;
    expires_at: Date;
  }>(
    q,
    `select new_email::text as new_email, code_hash, attempts, expires_at
       from email_change_requests
      where app_user_id = $1`,
    [caller.appUserId]
  );
  if (!pending || pending.expires_at <= new Date() || pending.attempts >= MAX_ATTEMPTS) {
    throw new HTTPException(400, { message: "That code has expired; request a new one" });
  }

  // timingSafeEqual throws on a length mismatch, which is itself a wrong
  // answer -- comparing the hashes rather than the raw codes sidesteps having
  // to pad a short guess to CODE_LENGTH first.
  const expected = Buffer.from(pending.code_hash);
  const answer = Buffer.from(hashCode(String(code).trim()));
  const correct = expected.length === answer.length && timingSafeEqual(answer, expected);

  if (!correct) {
    await q.query(
      "update email_change_requests set attempts = attempts + 1 where app_user_id = $1",
      [caller.appUserId]
    );
    throw new HTTPException(400, { message: "That code is not right" });
  }

  const account = await loadAccount(q, caller.appUserId);
  await applyEmailChange(q, caller, {
    appUserId: caller.appUserId,
    cognitoSub: account.cognito_sub,
    fromEmail: account.email,
    toEmail: pending.new_email,
  });
  await q.query("delete from email_change_requests where app_user_id = $1", [caller.appUserId]);
  return pending.new_email;
}

/**
 * The shared tail: Cognito first (a failure there leaves nothing written,
 * same ordering as the invite flow), then one transaction that keeps
 * `app_users.email` and the linked person's `persons.email` in step and drops
 * any inheritance now contradicted by it, then the audit entry, then a
 * best-effort notice to the address being replaced.
 */
export async function applyEmailChange(
  q: Queryable,
  caller: Caller,
  params: { appUserId: string; cognitoSub: string | null; fromEmail: string; toEmail: string }
): Promise<void> {
  await updateUserEmail(params.cognitoSub ?? params.fromEmail, params.toEmail);

  await q.transaction(async (tx) => {
    await tx.query("update app_users set email = $2 where id = $1", [
      params.appUserId,
      params.toEmail,
    ]);
    await tx.query(
      `update persons
          set email = $2, inherit_email_from_person_id = null
        where app_user_id = $1`,
      [params.appUserId, params.toEmail]
    );
  });

  await audit(q, caller, {
    action: "user.changeEmail",
    entityType: "appUser",
    entityId: params.appUserId,
    changes: { from: params.fromEmail, to: params.toEmail },
  });

  const org = await one<{ name: string }>(
    q,
    `select o.name
       from app_users u
       join organizations o on o.id = u.organization_id
      where u.id = $1`,
    [params.appUserId]
  );

  // After the commit, and never fatal: a failed send leaves someone whose
  // address already changed, which is strictly better than failing the whole
  // request and leaving Cognito and Postgres disagreeing.
  try {
    await sendEmailChangedNoticeEmail({
      to: params.fromEmail,
      newEmail: params.toEmail,
      organizationName: org?.name ?? "the parish",
    });
  } catch (err) {
    console.error("Email-changed notice failed for", params.fromEmail, err);
  }
}
