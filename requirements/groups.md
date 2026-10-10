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
