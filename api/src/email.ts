import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { contentHtml, contentText, escapeHtml, type EmailContent } from "./email-content";

/**
 * Outbound email: the invitation, the sign-in code (see auth-challenge.ts,
 * which runs in its own Lambda with just the FROM_* variables set), the email
 * change messages, and notification emails (sent by the scheduled function in
 * send-notification-emails.ts).
 *
 * Each template is a pure `render*Email` returning subject, text and HTML, with
 * a `send*Email` wrapper around it -- so a test, or a script rendering them to
 * look at, needs no SES and no environment.
 *
 * Cognito's own invitation is suppressed (see cognito.ts) because a custom
 * Cognito template must contain the `{####}` placeholder, which means emailing
 * a temporary password. Since sign-in is a one-time code, that password is
 * both confusing and a live credential nobody needs. Sending our own message
 * instead says the one useful thing: you have been added, go and sign in.
 *
 * `useDualstackEndpoint` is not optional here. The Lambda's only route out of
 * the VPC is IPv6, and `email.us-east-1.amazonaws.com` is IPv4-only --
 * `email.us-east-1.api.aws` is the one with an AAAA record. Without this the
 * call hangs until the function times out.
 */

const MODE = (process.env.EMAIL_MODE ?? "aws") as "aws" | "local";
const FROM_EMAIL = process.env.FROM_EMAIL ?? "";
const FROM_NAME = process.env.FROM_NAME ?? "";
const SITE_URL = process.env.SITE_URL ?? "";

/**
 * The From header, with a display name when one is configured.
 *
 * This message used to go out from a bare `no-reply@` while Cognito's one-time
 * code came from a named sender, so an invited member's first two emails looked
 * like they were from two different places. The name comes from the stack
 * (`FROM_NAME`, set alongside Cognito's `fromName`) rather than being written
 * here, so the two cannot drift.
 *
 * Falls back to the bare address when unset, which is what a stack deployed
 * before that variable existed will do -- and is exactly the previous
 * behaviour, so nothing breaks in the gap between the two deploys.
 *
 * The name is quoted, because an unquoted display name containing a comma or a
 * colon is not a valid RFC 5322 address and SES will reject the whole send.
 * Any quote or backslash inside it has to be escaped for the same reason.
 */
export function fromHeader(name = FROM_NAME, email = FROM_EMAIL): string {
  if (!name) return email;
  const escaped = name.replace(/([\\"])/g, "\\$1");
  return `"${escaped}" <${email}>`;
}

let client: SESv2Client | undefined;
function ses(): SESv2Client {
  client ??= new SESv2Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    useDualstackEndpoint: true,
  });
  return client;
}

/** A message ready to send: what every template here renders to. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe on a notification email. */
  headers?: { name: string; value: string }[];
}

async function send(to: string, email: RenderedEmail): Promise<void> {
  const { subject, text, html, headers } = email;
  if (MODE === "local") {
    console.log(`[email:local] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await ses().send(
    new SendEmailCommand({
      FromEmailAddress: fromHeader(),
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" },
          },
          ...(headers?.length
            ? { Headers: headers.map((h) => ({ Name: h.name, Value: h.value })) }
            : {}),
        },
      },
    })
  );
}

/**
 * The frame every message here shares: the cream page, the white card, the
 * parish-red bar with a heading in it. Inline styles and a table, because
 * email clients strip stylesheets, ignore custom properties, and lay out divs
 * however they please.
 *
 * `bodyHtml` and `footerHtml` are trusted markup -- every caller escapes what
 * it puts into them -- and `heading` is escaped here.
 */
export function emailLayout(params: {
  heading: string;
  bodyHtml: string;
  footerHtml?: string;
}): string {
  const footer = params.footerHtml
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
      <tr>
        <td style="padding:16px 24px;font-size:12px;line-height:1.5;color:#6b6b6b;text-align:center;">
          ${params.footerHtml}
        </td>
      </tr>
    </table>`
    : "";
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf8f5;font-family:Helvetica,Arial,sans-serif;color:#333333;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e0d8;border-radius:8px;">
      <tr>
        <td style="background:#b42d23;color:#ffffff;padding:16px 24px;font-size:16px;font-weight:bold;border-radius:8px 8px 0 0;">
          ${escapeHtml(params.heading)}
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
${params.bodyHtml}
        </td>
      </tr>
    </table>${footer}
  </body>
</html>`;
}

/** The red call-to-action button, as an inline-styled link. */
export function emailButton(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:#b42d23;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;">${escapeHtml(label)}</a>`;
}

export function renderInvitationEmail(params: {
  firstName: string;
  organizationName: string;
  invitedBy: string;
}): RenderedEmail {
  const subject = `You have been added to the ${params.organizationName} directory`;

  const text = [
    `Hello ${params.firstName},`,
    "",
    `${params.invitedBy} has added you to the ${params.organizationName} parish directory.`,
    "",
    `Sign in here: ${SITE_URL}`,
    "",
    "There is no password to remember. Enter your email address and we will send",
    "you a one-time code each time you sign in.",
    "",
    "Once you are in, please check your contact details and add your family.",
  ].join("\n");

  const html = emailLayout({
    heading: params.organizationName,
    bodyHtml: `          <p style="margin:0 0 16px;">Hello ${escapeHtml(params.firstName)},</p>
          <p style="margin:0 0 16px;">
            ${escapeHtml(params.invitedBy)} has added you to the
            ${escapeHtml(params.organizationName)} parish directory.
          </p>
          <p style="margin:0 0 24px;">
            ${emailButton(SITE_URL, "Open the directory")}
          </p>
          <p style="margin:0 0 16px;color:#6b6b6b;">
            There is no password to remember. Enter your email address and we will send you a
            one-time code each time you sign in.
          </p>
          <p style="margin:0;color:#6b6b6b;">
            Once you are in, please check your contact details and add your family.
          </p>`,
  });

  return { subject, text, html };
}

export async function sendInvitationEmail(params: {
  to: string;
  firstName: string;
  organizationName: string;
  invitedBy: string;
}): Promise<void> {
  await send(params.to, renderInvitationEmail(params));
}

/**
 * The 6-digit sign-in code. The code is in the subject too, so it can be read
 * straight off a lock-screen notification without opening the message.
 */
export function renderSignInCodeEmail(params: { code: string }): RenderedEmail {
  const subject = `Your sign-in code: ${params.code}`;

  const text = [
    `Your sign-in code is ${params.code}`,
    "",
    "Enter it on the sign-in page. It works once and expires in 10 minutes.",
    "",
    "If you did not try to sign in, you can ignore this email.",
  ].join("\n");

  const html = emailLayout({
    heading: FROM_NAME || "Directory",
    bodyHtml: codeBody(
      "Your sign-in code is",
      params.code,
      "Enter it on the sign-in page. It works once and expires in 10 minutes.",
      "If you did not try to sign in, you can ignore this email."
    ),
  });

  return { subject, text, html };
}

export async function sendSignInCodeEmail(params: { to: string; code: string }): Promise<void> {
  await send(params.to, renderSignInCodeEmail(params));
}

/**
 * The code for a self-service sign-in email change (see
 * services/email-change.ts). A separate template from the sign-in code,
 * even though the shape is identical, because the two mean different things
 * to read mid-inbox: one signs you in, the other moves where your sign-ins go.
 */
export function renderEmailChangeCodeEmail(params: { code: string }): RenderedEmail {
  const subject = `Your verification code: ${params.code}`;

  const text = [
    `Your verification code is ${params.code}`,
    "",
    "Enter it to finish changing the email address you sign in with. It works",
    "once and expires in 10 minutes.",
    "",
    "If you did not request this, you can ignore this email -- your sign-in",
    "address will not change.",
  ].join("\n");

  const html = emailLayout({
    heading: FROM_NAME || "Directory",
    bodyHtml: codeBody(
      "Your verification code is",
      params.code,
      "Enter it to finish changing the email address you sign in with. It works once and expires in 10 minutes.",
      "If you did not request this, you can ignore this email -- your sign-in address will not change."
    ),
  });

  return { subject, text, html };
}

export async function sendEmailChangeCodeEmail(params: {
  to: string;
  code: string;
}): Promise<void> {
  await send(params.to, renderEmailChangeCodeEmail(params));
}

/** The body the two code emails share: a lead-in, the code large, two notes. */
function codeBody(lead: string, code: string, note: string, footnote: string): string {
  return `          <p style="margin:0 0 16px;">${escapeHtml(lead)}</p>
          <p style="margin:0 0 24px;font-size:32px;font-weight:bold;letter-spacing:8px;">
            ${escapeHtml(code)}
          </p>
          <p style="margin:0 0 16px;color:#6b6b6b;">
            ${escapeHtml(note)}
          </p>
          <p style="margin:0;color:#6b6b6b;">
            ${escapeHtml(footnote)}
          </p>`;
}

/**
 * Sent to the *old* address once a sign-in email change has already taken
 * effect -- self-service or an admin's override, both go through the same
 * notice. There is nothing to confirm or undo here; the point is only that an
 * unexpected copy of this is the signal that something is wrong.
 */
export function renderEmailChangedNoticeEmail(params: {
  newEmail: string;
  organizationName: string;
}): RenderedEmail {
  const subject = "Your sign-in address was changed";
  const masked = maskEmail(params.newEmail);

  const text = [
    `The address you use to sign in to the ${params.organizationName} directory was`,
    `changed to ${masked}.`,
    "",
    "If this was you, there is nothing else to do.",
    "",
    "If you did not make this change, contact your parish administrator right away.",
  ].join("\n");

  const html = emailLayout({
    heading: FROM_NAME || "Directory",
    bodyHtml: `          <p style="margin:0 0 16px;">
            The address you use to sign in to the ${escapeHtml(params.organizationName)} directory
            was changed to ${escapeHtml(masked)}.
          </p>
          <p style="margin:0 0 16px;">If this was you, there is nothing else to do.</p>
          <p style="margin:0;color:#6b6b6b;">
            If you did not make this change, contact your parish administrator right away.
          </p>`,
  });

  return { subject, text, html };
}

export async function sendEmailChangedNoticeEmail(params: {
  to: string;
  newEmail: string;
  organizationName: string;
}): Promise<void> {
  await send(params.to, renderEmailChangedNoticeEmail(params));
}

// ---------------------------------------------------------------------------
// Notification emails
// ---------------------------------------------------------------------------

/**
 * One notification, as the email shows it. Built by services/notification-email.ts.
 * What it says of the post itself -- text, event, poll, attachments -- is the
 * `EmailContent` it extends; see email-content.ts.
 */
export interface NotificationEmailItem extends EmailContent {
  /** "Prayer request", "You were mentioned" -- the bell's label for the type. */
  label: string;
  /** The prayer request's title, the group's name, the requester's name. */
  heading: string;
  /** Who and where, e.g. "Mary Smith in Youth Group". Null when there is nothing to say. */
  context: string | null;
  /** The subject when this is the only item, e.g. "Prayer request: For my mother". */
  subject: string;
  /** The button's words, e.g. "Read the prayer request". */
  action: string;
  /** Absolute URL into the app -- the same place the bell entry links to. */
  url: string;
}

/**
 * The notification email: one or more notifications for one person, batched
 * by the sender over a couple of minutes so a busy evening is one email rather
 * than ten.
 *
 * One item reads as that item -- its own subject, its own button. Several read
 * as a list, each with its own button, under a subject that counts them.
 *
 * The footer says why it arrived and how to stop it, and the List-Unsubscribe
 * headers let a mail client offer the same in its own UI (RFC 2369 / 8058).
 * Both matter to deliverability: a reader who cannot find the way out reaches
 * for "Report spam" instead, and that complaint lands on the same domain the
 * sign-in code is sent from.
 */
export function renderNotificationEmail(params: {
  organizationName: string;
  items: NotificationEmailItem[];
  settingsUrl: string;
  unsubscribeUrl: string;
  oneClickUnsubscribeUrl: string;
}): RenderedEmail {
  const { items } = params;
  const subject =
    items.length === 1
      ? items[0]!.subject
      : `${items.length} new notifications from ${params.organizationName}`;

  const intro =
    items.length === 1
      ? `Something new in the ${params.organizationName} directory.`
      : `${items.length} new things in the ${params.organizationName} directory.`;

  const text = [
    intro,
    "",
    ...items.flatMap((item) => [
      `${item.label.toUpperCase()}: ${item.heading}`,
      ...(item.context ? [item.context] : []),
      ...contentText(item),
      "",
      `${item.action}: ${item.url}`,
      "",
      "----",
      "",
    ]),
    "You are getting this because email notifications are on.",
    `Change what you are sent: ${params.settingsUrl}`,
    `Stop these emails: ${params.unsubscribeUrl}`,
  ].join("\n");

  const cards = items
    .map(
      (
        item
      ) => `          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border:1px solid #e5e0d8;border-radius:8px;">
            <tr>
              <td style="padding:16px 20px;">
                <p style="margin:0 0 6px;font-size:12px;font-weight:bold;letter-spacing:0.5px;text-transform:uppercase;color:#b42d23;">${escapeHtml(item.label)}</p>
                <p style="margin:0;font-size:18px;font-weight:bold;color:#333333;">${escapeHtml(item.heading)}</p>${
                  item.context
                    ? `
                <p style="margin:4px 0 0;font-size:14px;color:#6b6b6b;">${escapeHtml(item.context)}</p>`
                    : ""
                }
                ${contentHtml(item)}
                <p style="margin:16px 0 0;">${emailButton(item.url, item.action)}</p>
              </td>
            </tr>
          </table>`
    )
    .join("\n");

  const html = emailLayout({
    heading: params.organizationName,
    bodyHtml: `          <p style="margin:0 0 20px;">${escapeHtml(intro)}</p>
${cards}`,
    footerHtml: `You are getting this because email notifications are on.<br>
          <a href="${escapeHtml(params.settingsUrl)}" style="color:#6b6b6b;">Notification settings</a>
          &nbsp;&middot;&nbsp;
          <a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#6b6b6b;">Unsubscribe</a>`,
  });

  return {
    subject,
    text,
    html,
    headers: [
      { name: "List-Unsubscribe", value: `<${params.oneClickUnsubscribeUrl}>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ],
  };
}

export async function sendNotificationEmail(
  to: string,
  params: Parameters<typeof renderNotificationEmail>[0]
): Promise<void> {
  await send(to, renderNotificationEmail(params));
}

/** "name@example.com" -> "n***@example.com", for a notice that names the new address without fully disclosing it. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || !local) return email;
  return `${local[0]}${"*".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}
