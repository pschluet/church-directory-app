import { db } from "../src/db";
import { BATCH_WINDOW_MS, sendPendingEmails } from "../src/services/notification-email";

/**
 * One run of the notification email sender, locally -- what EventBridge does
 * every minute in the deployed stack (see src/send-notification-emails.ts).
 *
 *   npm run emails:send -w api            # what is due now
 *   npm run emails:send -w api -- --now   # skip the 2-minute batch window
 *
 * EMAIL_MODE defaults to `local` in the npm script, so the emails are printed
 * rather than sent. Notifications it prints are stamped as emailed, exactly as
 * a real send would stamp them.
 */
async function main(): Promise<void> {
  const skipWindow = process.argv.includes("--now");
  const result = await sendPendingEmails(db, {
    now: new Date(Date.now() + (skipWindow ? BATCH_WINDOW_MS + 1000 : 0)),
    siteUrl: process.env.SITE_URL ?? "http://localhost:5173",
    deadline: Date.now() + 60_000,
  });
  console.log("Notification emails", result);
  process.exit(0);
}

void main();
