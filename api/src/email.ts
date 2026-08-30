import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

/**
 * Outbound email. Currently just the invitation.
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
const SITE_URL = process.env.SITE_URL ?? "";

let client: SESv2Client | undefined;
function ses(): SESv2Client {
  client ??= new SESv2Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    useDualstackEndpoint: true,
  });
  return client;
}

async function send(to: string, subject: string, text: string, html: string): Promise<void> {
  if (MODE === "local") {
    console.log(`[email:local] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await ses().send(
    new SendEmailCommand({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            Html: { Data: html, Charset: "UTF-8" },
          },
        },
      },
    })
  );
}

export async function sendInvitationEmail(params: {
  to: string;
  firstName: string;
  organizationName: string;
  invitedBy: string;
}): Promise<void> {
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

  // Inline styles, and the parish palette, because email clients strip
  // stylesheets and ignore custom properties.
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf8f5;font-family:Helvetica,Arial,sans-serif;color:#333333;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e0d8;border-radius:8px;">
      <tr>
        <td style="background:#b42d23;color:#ffffff;padding:16px 24px;font-size:16px;font-weight:bold;border-radius:8px 8px 0 0;">
          ${escapeHtml(params.organizationName)}
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 16px;">Hello ${escapeHtml(params.firstName)},</p>
          <p style="margin:0 0 16px;">
            ${escapeHtml(params.invitedBy)} has added you to the
            ${escapeHtml(params.organizationName)} parish directory.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${SITE_URL}" style="display:inline-block;background:#b42d23;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;">
              Open the directory
            </a>
          </p>
          <p style="margin:0 0 16px;color:#6b6b6b;">
            There is no password to remember. Enter your email address and we will send you a
            one-time code each time you sign in.
          </p>
          <p style="margin:0;color:#6b6b6b;">
            Once you are in, please check your contact details and add your family.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  await send(params.to, subject, text, html);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
