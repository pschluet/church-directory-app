# Overview
A "Groups" feature for the directory app that lets members form groups, post messages, share files, schedule events, and get notified about group activity.

# Types of Groups
There are 3 types of groups:
1. **Public Groups**: Anyone can create a public group. Anyone can join, and anyone can see its messages. A public group can be converted to Private or Secret, but only by its creator or a group admin.
2. **Private Groups**: Anyone can create a private group. Only invited or approved members can join. Only members can see the group's messages. Everyone else can still see that the group exists — its title, description, image, and member count — but not its member list or its messages. Non-members can request to join; a group admin must approve or deny the request.
3. **Secret Groups**: Anyone can create a secret group. Membership is invite-only. Nobody outside the group — not even the fact that it exists — is visible to non-members. A secret group can be converted to Private, but only by a group admin.

**Conversion rules:**
- A group can only move toward being more closed, with one exception: Secret groups can loosen to Private.
- Allowed: Public → Private, Public → Secret, Private → Secret, Secret → Private.
- Never allowed: converting any group back to Public, once it has been changed.
- When a group's visibility changes, existing members keep full access to the group's past history regardless of which direction the conversion went.

**Invites:** Inviting someone to a Private or Secret group adds them immediately — there's no invitation to accept, the invited person is a member as soon as they're invited. By default any member can send invites, but a group admin can restrict invite permission to admins only.

# Membership & Admins
- Only people who have an account in the app can be added to or invited into a group. People who exist only as directory entries, without a login, are not eligible for group membership.
- The group's creator becomes its first admin. A group can have multiple admins, and any admin can promote another member to admin.
- An admin cannot leave a group while they're the only admin — they must promote someone else to admin first.
- Group admins can:
  - Delete any post in the group
  - Remove any member from the group
  - Restrict posting to admins only
  - Restrict who can send invites
  - Restrict who can reply to posts
  - Promote or demote other admins
  - Change the group's visibility (subject to the conversion rules above)
  - Archive the group
- Any member can leave a group at any time, except for the sole-admin restriction above. When a member leaves or is removed, their past posts stay in the group, still attributed to them — they aren't deleted.
- Public groups can be freely joined and left. Rejoining a public group restores full visibility into its past history.
- Parish admins and super admins have the same abilities as a group admin in every group, including Secret groups and their messages — they can see and act in any group regardless of membership. Because this crosses a meaningful privacy boundary, the app discloses it clearly in the product (for example, a notice shown when creating or viewing a secret group that parish administrators are able to view it). Every time a parish admin or super admin views or takes action in a group they don't belong to, that access is logged for accountability.
- There is currently no automatic age restriction on who can join a group — the directory doesn't reliably track ages, so this isn't enforced today. This is a known gap, flagged here as a future consideration rather than a current rule.

# Group Metadata
Groups have the following associated with them, shown on the groups page:
- Title
- Description
- Image

Tapping or clicking a group's title opens a modal showing:
- A searchable list of group members
- The group description
- The list of group admins
- For admins only, the admin settings panel described under Membership & Admins

For a Private group, non-members see the title, description, image, and a member count, but not the member list itself.

# Messaging
- Any member can post a message to the group.
- Senders can edit or delete their own posts. Edited posts show an "edited" indicator, and there's no time limit on how long after posting someone can edit.
- Deleting a post doesn't remove it from the thread entirely — it leaves a placeholder ("message deleted," or "event cancelled" for events) so replies underneath don't lose their context. Only the content is removed; the fact that something was posted there remains.
- Any member can reply to a post. Replies appear in an expandable thread under the original post. Replies are one level deep — you can reply to a top-level post, but you cannot reply to a reply.
- Posts support plain text with clickable links; there's no rich text formatting.
- Members can @ mention other members of the group, which notifies the person mentioned. You can only mention people who are already in the group.
- Posts can include attachments: photos and documents (PDF, Word, Excel, PowerPoint, plain text, and CSV files). Video attachments are planned for a future phase and are not supported in this release. Each attachment is capped at 25MB.
- A group's page has three tabs: Messages, Files, and Events. The Files and Events tabs are automatically populated from what's been posted in Messages, so members don't have to scroll back through the conversation to find a shared file or an upcoming event.
- **Events** are a special post type with:
  - A title (required)
  - A description (optional)
  - A date (required)
  - A start time (optional)
  - An end time (optional, and only allowed if a start time is set)
  - A location (optional)
  - Members can RSVP Yes, No, or Maybe, and optionally note how many guests they're bringing.
  - If an event's date, time, or location changes after people have RSVP'd, their RSVPs are kept and they're notified of the change.
  - The Events tab separates upcoming events from past events.

# Reporting & Moderation
- Any member who can see a post can report it for review. This includes a parish admin viewing inside a Secret group, consistent with their broader visibility into every group.
- A report can include an optional note explaining why it was submitted. Reports are sent to both that group's admins and the parish administrators.
- A person can only have one open report on a given post at a time — they can't submit duplicate reports against the same post while one is still pending. They can report it again once their earlier report has been resolved.
- Resolving a report means either dismissing it or removing the reported post; either way, the report is closed. The person who filed the report is not told who resolved it or what the outcome was — this keeps moderation decisions separate from interpersonal conflict.
- Reports are retained even if the reported post is later deleted, preserving a record of what happened.

# Notifications
- Notifications are delivered in-app (a badge/bell) and as web push notifications to a member's device. Email and text message notifications are not part of this release.
- Members can set notification preferences on a per-group basis: notify on all new posts, notify only when they're @ mentioned, or don't notify at all.
- Notification content never reveals the message itself — this matters especially for Secret groups. A notification only indicates that there's new activity and roughly how much, not what was said.
- The group page refreshes automatically as new activity arrives if the member has notifications enabled on that device. It can always be refreshed manually as well, with a visible "last updated" indicator — the same pattern used elsewhere in the app, such as on Prayer Requests.

# Retention
- Posts and their attachments are automatically and permanently removed 5 years after they were posted. This is a hard deletion with no way to recover the content afterward, and no individual warning is given beforehand.
- A thread — the original post plus its replies — stays alive as long as any reply within it is still inside the 5-year window. A post that keeps getting replies won't disappear out from under an active conversation; the whole thread is only removed once it has gone quiet for 5+ years.
- For events, the 5-year retention clock starts after the event date, not the post date, so a far-future event scheduled today won't be deleted before it happens.
- Reports, mentions, and RSVPs tied to a post are removed along with it.

# Considerations for a Future Revision
- There's no way today to report content with full anonymity assurance. The UI doesn't disclose who filed a report, but a resolving admin could, in some cases, infer who it was from context.
- There's no mechanism for a group to export or archive its content before the 5-year retention deadline removes it.

- Make a search bar on the groups page to search by group name
- Allow users to pin groups on the groups page (those groups are then shown at the top)
- The group photo cropper aspect ration should match what's displayed on the groups page.
- Add the ability to delete a group photo from the group settings page.
- On the groups page, when the window is 927 wide, if a group has a picture, the group card extends below the end of the browser screen on this mac.
- On mobile, the "LEAVE" button in the group should stay on the same line as the group title until it absolutely has to flow to the next line in order to fit both.
- On the files tab in a group, if the whole filename doesn't fit, wrap it to the next line so you can see the whole filename.
- On an individual groups page, if there's a photo, the group messages extend beyond past the bottom of the screen, and I can't scroll to see them.
- On an event, when an individual RSVPs yes, they should be able to state how many guests. Then, all others should be able to see (maybe via a modal) what all the RSVPs are and, for the yes RSVPs, how many guests each person is bringing. There should also be a total listed that indicates the overall total and the total member/guest counts

TODO
- On the settings page, add a section for groups notifications. It should enable you to set the default for all groups (all messages, only mentions, or none). On individual group settings, you should be able to set exceptions (notification settings different from the default that are specific for that group). On the settings page, it should show a list of the exceptions, and you should be able to delete that exception (then the notification settings for that group go back to the default). You should also be able to change that exception's settings right from the settings page.
- Clicking on user names, user profile photos or profile photo placeholders, or @ mentions in the posts of a group page should link to that user's user page in the app.
- @ mentions should be editable when editing a post
- Location (on events) should be a google maps powered auto-complete like the address on a user (only if maps is turned on in the church's settings)
- Streamline the groups posts page to make it more streamlined. The UI to write messages should be on the bottom with just a message bar and a + icon to add attachments. Messages should be displayed most recent on the bottom. Users can scroll up to see past messages. Messages should be paginated. When you scroll up to the end of a page, it should auto load the next page. Make the UI more like Slack. Also, we don't need a box around every message/post.
- The group search should have higlighting like the other searches in the app.
- Make the pin icon (for pinning groups) look more like a pin. The top part (above the horizontal crossbar) should be wider.
- Don't show the group photo on the individual group's page. Only on the page that shows all the groups.

- The group description should be editable.
- If the group description is long, the description should only show a preview on the group's page with the option to expand so it doesn't take up too much of the messages space.
- On the group settings page, when you click the 3 dots button next to a group member's name, the modal is hidden. Fix this.
- The group messages/posts must be realtime. When one user posts a message, it should be immediately visible to everyone (like Slack). The messages page should also indicate when another user (or potentially multiple users) are typing (like Slack).