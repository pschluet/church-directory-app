# Church Directory

A multi-tenant parish directory at **directory.pauldev.io**. Members keep their own
contact details up to date, manage their family — including children and others who have
no account of their own — record birthdays, name days and wedding anniversaries, and
browse or search everyone else in their parish. Phone numbers are tappable to call. They can
also ask the parish to pray for someone: a prayer request is reviewed before anyone else sees
it, and once posted it notifies everyone who wants to hear about it.

There is no password: everyone signs in with a one-time code sent to their email address.
Accounts are invite-only, created by a parish administrator.

## Architecture

- **Frontend:** React 19 + Vite SPA (`app/`), Tailwind v4, on a private S3 bucket behind
  CloudFront. Themed after [allsaintsorthodox.org](https://allsaintsorthodox.org) — the
  same liturgical red (`#b42d23`), gold (`#b88c51`) and Karla typeface.
- **Client cache:** TanStack Query, in memory only. Nothing is persisted to disk, because
  the alternative is the parish's phone numbers and addresses sitting in `localStorage` on
  whatever phone last signed in. Every org-scoped key is namespaced by organization id in
  `app/src/lib/queryKeys.ts`: `api()` appends `?orgId=` from `localStorage` itself, so a
  key that left it out would serve one parish's directory to another.

  Two small exceptions arrived with *Going back*, both React Router's own and neither
  switchable off: the scroll offset of each history entry, and the pairs of paths it has
  animated between. They are per-tab `sessionStorage`, and what they hold is integers under
  opaque random history keys plus a list of `/people/<id>` and `/families/<id>` — record ids
  with no name, address or phone number attached, useless without a session, and gone when
  the tab closes. Signing out removes both regardless, beside the `queryClient.clear()` that
  is there for the same reason.
- **Going back:** the app is a stack. A left chevron appears in the top left of the header
  once you have moved off the page you started on, and walks back to it; going back slides
  the current page away to the right to uncover the previous one, which returns with its
  scroll offset and its settings intact. Three things make that work, and each of them is
  load-bearing. The router is a **data router** (`createBrowserRouter`), because
  `viewTransition` and `<ScrollRestoration>` do not exist in the declarative mode the app
  used before — the prop is accepted and silently ignored. The animation is the **View
  Transitions API**, not a transform on the live page: the browser snapshots into
  viewport-fixed pseudo-elements and leaves layout alone, where a transform on any ancestor
  would become the containing block for the audit log's `sticky` day headings and strand
  every one of them. And **every forward link opts in**, which is why they all come from
  `app/src/components/nav.tsx` rather than from `react-router` — the router only animates a
  *back* navigation for a pair of paths it recorded on the way in, so a link that forgot the
  prop would be a page you could slide into and not out of, and nothing would fail loudly.
  Browsers without the API simply navigate instantly; there is nothing to feature-detect.

  Two distinctions the obvious implementation gets wrong. "One entry back" is not "the
  previous page": Directory's filter and each of the audit log's five push deliberately, so
  the chevron steps over consecutive entries sharing its own path — and stays hidden when
  every entry behind it is one, because a chevron on the directory offering to return to the
  directory is claiming a parent it has not got. And a navigation that did not change the
  path is animated as neither direction but a plain cross-fade, since the browser's own back
  button can undo a checkbox and cannot be made to skip; without that, unticking one slid
  the whole page sideways. `app/src/components/NavStack.tsx` holds both, keyed off React
  Router's `history.state.idx` so the chevron survives a reload and is correctly absent for
  someone arriving on a deep link from outside.
- **Installable:** a PWA, so the directory can live on a home screen — this is the app
  someone opens standing in the parking lot after a service, and one tap beats recalling a
  URL. It is also what makes Web Push work at all, since iOS only delivers it to a site
  added to the home screen (see *Notifications*). The service worker is hand-written
  (`app/src/sw.ts`, `vite-plugin-pwa` in `injectManifest` mode) and precaches the app shell
  and **nothing else**: there is no runtime cache route, so `/api/*`, `/photos/*` and the
  presigned S3 uploads all fall straight through to the network. That is the same decision
  as *Client cache* above, for the same reason — a cache route would put the parish's phone
  numbers on disk in the Cache API instead of `localStorage`, which is no better.
  `app/test/serviceWorker.test.ts` asserts it against the built `dist/sw.js`, because
  nothing in the app would look different if it regressed. It was `generateSW` until push
  arrived; that mode cannot host a `push` listener, and its escape hatch
  (`workbox.importScripts`) would add a second fixed-name file to keep in step with three
  separate lists in `deploy.yml`. The icons in `app/public` are generated from
  `favicon.svg`; see `app/pwa-assets.config.js` for the command. One deploy consequence:
  `sw.js` must never be uploaded `immutable`, or every installed copy is pinned to that
  build with no address bar to reload from.
- **Auth:** Cognito user pool (Essentials tier), email-OTP passwordless sign-in. Self
  sign-up is disabled; administrators invite people and the API sends the invitation
  through SES. Both messages come from the same display name, defined once as
  `EMAIL_FROM_NAME` in the stack and passed to the Lambda as `FROM_NAME`: the code comes
  from Cognito and the invitation from the API, and they used to disagree — a named sender
  for one, a bare `no-reply@` for the other, which is two different-looking emails for the
  first two a member ever receives. Cognito's own invitation is suppressed, because a custom Cognito template
  must embed the `{####}` temporary-password placeholder — a live credential nobody needs
  when sign-in is a one-time code.
- **API:** API Gateway HTTP API with a Cognito JWT authorizer and one Lambda (Hono router,
  `api/src/api.ts`). CloudFront routes `/api/*` to it, so the SPA and API share an origin
  and there is no CORS in production.
- **Database:** RDS PostgreSQL 17 (`db.t4g.micro`, single-AZ, private), migrated with
  Flyway (`db/migrations`). The API authenticates with **RDS IAM auth** — a locally-signed
  token, so no secret is fetched at runtime.
- **Photos:** cropped and downscaled in the browser, then uploaded straight to a private
  S3 bucket via presigned URLs, so no image bytes pass through the Lambda. Two renditions
  are stored per photo -- a thumbnail for cards and avatars, a larger one for the
  full-screen view -- because a directory card renders at 56px and used to download the
  untouched original. Reads go through CloudFront with signed cookies rather than presigned
  GETs: the bucket stays private and no photo becomes a shareable public URL, but the paths
  are permanent, so the browser cache and the CloudFront edge both work. A presigned GET
  changes on every response and defeats both.
- **Retention:** people and photos are kept forever (`RemovalPolicy.RETAIN`; deletes are
  soft). One exception, and it is deliberate: `DELETE /api/admin/users/:id` on the People &
  Accounts screen removes an account, its Cognito user and the person behind it for good —
  for the rows that should never have existed, a duplicate or a mistake. Disabling
  (`PATCH` with `{status:"DISABLED"}`) is still the answer for someone who has simply
  stopped attending. The hard delete cascades `special_dates` on both `person_id` and
  `related_person_id`, so a wedding anniversary disappears from the surviving spouse's
  record too; the confirmation says so, and `api/test/api.admin.test.ts` pins it. The
  transaction commits before the Cognito user is deleted, because the reverse order can
  leave an account row whose `cognito_sub` names a user that no longer exists — it looks
  intact, can never sign in, and `bindByEmail` will not re-bind it.
- **Roles:** Super Admin, Admin, Prayer Request Admin and User, stored in Postgres rather
  than in Cognito groups — a group cannot express which organization an admin is scoped to.
  They form a hierarchy rather than a set of independent permissions, and the ladder is
  written once, in `hasRole` (`api/src/types.ts`), so `requireRole` on the server and the
  guards in the SPA cannot disagree about it. A Prayer Request Admin is a member with one
  extra privilege and sits between User and Admin, which is why an Admin can review prayer
  requests without being granted anything.
- **Notifications:** two things, deliberately separate. A bell in the nav counts rows in a
  `notifications` table, one per recipient per event, fanned out in the same transaction
  that posts a prayer request — so "unread" is a fact about a person, which a
  high-water-mark timestamp could count but could not list by title. There are two kinds:
  a request has been posted, and — for approvers — a request is waiting for approval. The
  second retires itself, because the query that lists it requires the request to still be
  `PENDING`: whoever gets there first clears it for everyone, and nothing has to go back
  and mark it read. They are separately switchable, because one is news and the other is
  work: an approver may want to be told a request needs them without hearing about every
  post, or the reverse. On top of that, **Web
  Push**: `web-push` in the API, a VAPID keypair from `scripts/create-push-key.sh`
  delivered exactly like the photo signing key, and the `push` listener in `app/src/sw.ts`.
  The push body is only ever a count — "3 new prayer requests", that recipient's own unread
  count — because a prayer request can name somebody's illness and a lock screen is not
  where that should be legible to whoever picks the phone up. The *title* says what the
  notification is about ("Prayer Requests", "Approval Needed") and deliberately never the
  app's own name: iOS composes the bold line as `{title} from {app name}` with no way to
  suppress the second half, so naming the app there printed it twice. A fixed notification `tag`
  makes each push replace the last rather than stacking. Sends go out after the approval
  commits and cannot fail it; a 404 or 410 back from a push service deletes that
  subscription, which is also how the table cleans itself up after a key rotation.
  Notably this needed **nothing** added to the network: all three push services publish
  AAAA records, so they are reachable over IPv6 through the egress-only gateway (see *Why
  there is no NAT gateway*). Push is optional — a deployment with no keypair posts prayer
  requests that simply arrive without a notification, and the settings page is careful to
  say that it is *push* that is unavailable rather than notifications as a whole, since the
  bell is unaffected.

  Everyone active in the parish is told, the author included: being told your request is
  now up is the most useful notification here, and until it arrives the author has no
  signal at all. The one exclusion is whoever just posted it — the reviewer who approved
  it, or a Prayer Request Admin posting their own request, which goes up without review
  because they are the person who would otherwise approve it.
- **Nothing polls.** The bell used to refetch every 60s, which is the obvious way to notice
  something posted by somebody else — and the wrong one here: its cost scales with
  concurrent open tabs rather than with events, around $2.70 per million requests, which at
  ten thousand members is tens of dollars a month to catch something that happens a few
  times a week. Instead the push that already goes out is the signal: `app/src/sw.ts`
  forwards it to every open tab and `useRealtimeRefresh` turns it into a cache
  invalidation, so anyone with notifications on gets a live page for nothing. Everyone else
  has window refocus and a refresh button on the page, which also says how old the list is.
  A corollary worth knowing: relative timestamps are computed at render and nothing
  re-renders on its own, so `useNow` ticks them — without it a page left open disagreed
  with the bell about when the same request was posted, from identical data.
- **Map View:** a Google Maps view of where everyone lives, reached from the Directory rather
  than from the nav, opening on the church at about a 30 mile radius. Four things about it are
  worth knowing before touching it.

  **Coordinates live in their own table, keyed by Google's `place_id`.** Google's Maps Platform
  terms allow `lat`/`lng` to be cached for 30 consecutive days *unless* the value is isolated to
  the one end user who looked it up -- and a parish map showing every home to every member is
  the opposite of that. `place_id` is separately exempt, so it is the durable key and the
  coordinates are a cache with a `geocoded_at` on them, refreshed daily at 25 days by
  `api/src/refresh-geocodes.ts` on an EventBridge schedule. The compliance is why it exists;
  the benefit is that it self-heals when Google corrects an address. Keying by `place_id`
  rather than putting columns on `persons` also means "everyone at the same address shares one
  pin" is a `group by` on a primary key instead of a comparison of two floats, and a family of
  five at one address costs one geocode rather than five.

  **Map View is a per-organization switch a super admin controls**, and it gates four things:
  the browser API key in `GET /api/me`, `GET /api/map` (404, not 403 -- this parish has no map
  page, and a 403 sends somebody to ask for access nobody can grant), the `/map` route and the
  Directory's link to it, and geocoding itself. That last one is the point rather than a
  detail: a parish with the map off makes *no* calls to Google at all, so in a multi-tenant
  deployment the bill is proportional to the parishes using the map rather than to the parishes
  that exist. It defaults off, so the flag alone populates nothing -- invoke the refresh
  function with `{"backfill": true}` after switching a parish on.

  **Two API keys, and the distinction is load-bearing.** The browser key necessarily reaches a
  page, so it is restricted in the Google console to this site's referrers and capped there;
  it is served from `GET /api/me` rather than baked into the bundle by a `VITE_` variable,
  which does not make it secret -- anyone signed in can read it in devtools -- but does keep it
  out of a public bundle that gets scraped. The server key carries no application restriction,
  because a Lambda leaving over IPv6 has no stable address to restrict it to, and so must never
  reach a browser. The Map ID is neither: it names a style, grants nothing, and is already sent
  to every signed-in browser, so it is a constant in `api/src/services/geocoding.ts` rather
  than three files of plumbing to hide a value that is published by design.

  **A `place_id` off the wire is a lookup key and never a coordinate.** It is in
  `PERSON_WRITE_COLUMNS` so Places Autocomplete's answer can reach the database, which is
  exactly what would let somebody point their row at the church roof if the server did not
  resolve the coordinates itself. `applyGeocode` in `api/src/routes/persons.ts` overwrites
  whatever arrived. A geocode that fails does not fail the save -- the address is stored with
  no pin and a warning comes back on the response, because refusing the write would tell
  somebody their address is invalid when it is merely one Google cannot place.

  Address autocomplete comes with the same switch, and is free rather than cheap: autocomplete
  requests carrying a session token bill under the session SKU, which has no limit, and only the
  single `Place.fetchFields` that closes the session costs anything. Minting a fresh token after
  each selection is not an optimisation -- a reused one silently moves the typing onto the
  per-request SKU, which works perfectly and costs money.

  **Pins are two weights of one red**, with gold kept for the church: a household is
  `--color-primary` and somebody living alone `--color-primary-light`, so they read as one set
  rather than two unrelated colours, and the one gold pin on the map is the only one that is
  not somebody's home. It gets a popover of its own naming the parish, because a marker whose
  only affordance is a browser tooltip does nothing at all on a phone.

  **A tapped pin opens a popover beside it**, not a drawer or a side panel. Those covered the
  map in order to describe a point on it, and on a phone the drawer took half the screen to name
  one household. It is a Google `InfoWindow`, which buys two things that would otherwise be
  rebuilt by hand: it stays attached to its marker through a pan or a zoom, and it moves the map
  if it would open off the edge. An individual gets their photo, name and address; a family gets
  its name, the members who live *there*, and the same address. The address is stated once for
  the whole pin and behaves exactly as an address does anywhere else in the app, because it is
  the same `AddressLink` -- which grew a second form taking a pre-formatted string, since a pin
  is a place rather than a person.

  That reuse turned up a bug in `Modal`, which is now portalled to the body. `position: fixed`
  is only relative to the viewport while no ancestor has made itself a containing block, and
  Google's InfoWindow positions its bubble with a transform and clips it -- so the
  which-map-app sheet, opened from an address inside a popover, came out as an unusable sliver
  trapped in the bubble. Nothing else in the app has an ancestor that does that, which is why
  it took a map to find it.

  **The map is measured, not given a fraction of the viewport.** `h-[70vh]` plus a header of up
  to 232px does not fit in 100vh, so the bottom of the map used to sit below the fold on every
  desktop. `useFillViewport` subtracts the element's own offset down the document from the
  visual viewport, because what sits above it is not a constant -- the header's height depends
  on the role, and an administrator may also be reading a warning about the church address.

  **Full screen is CSS, not the Fullscreen API.** iOS Safari will not take a `div` full screen,
  Google's own control hides itself below a size threshold, and the installed PWA has no chrome
  to leave -- the native path fails on the three cases that most want it. Swapping the
  container's classes also keeps the same `google.maps.Map`, so entering and leaving costs no
  billed map load; there is a test asserting the map mounts exactly once through both.

  **The base map's styling lives in the Google console**, against the Map ID, so the parish's
  colours can change with no deploy. A copy of the JSON and why it looks that way are committed
  at `docs/map-style.json` and `docs/map-style.md`.

  Nothing was added to the network for any of it. `maps.googleapis.com` publishes AAAA records,
  so the geocoder is reachable over IPv6 through the egress-only gateway -- the same story as
  Web Push (see *Why there is no NAT gateway*).
- **Tags:** every resource carries `Project=all-saints` for cost tracking.

### Why there is no NAT gateway

The API Lambda has to sit in the VPC to reach the private database, which normally means
paying ~$32/month for a NAT gateway so it can also call Cognito. Instead the subnets are
dual-stack with an egress-only internet gateway, which is free:
`cognito-idp.us-east-1.amazonaws.com` publishes an `AAAA` record, so the SDK reaches it
over IPv6.

The corollary is that `sts`, `s3` and `ses` are IPv4-only on their *standard* endpoints.
Nothing here needs STS (Lambda credentials come from the runtime's link-local endpoint),
and presigning an S3 URL is a local signature. Real S3 calls go over IPv4 through the free
S3 gateway endpoint. SES does have a dual-stack endpoint, so `api/src/email.ts` sets
`useDualstackEndpoint: true` — without it the invitation email hangs until the function
times out. If a future feature needs an AWS API with no IPv6 endpoint at all, add an
interface endpoint for it rather than reaching for NAT — `infra/test` asserts that no NAT
gateway and no interface endpoints exist. Anything that genuinely needs the IPv4 internet
runs in a public subnet with a public IP instead: the Flyway task, to pull its image, and the
bastion, so its SSM agent can register (see *Inspecting the deployed database*).

### Cost

RDS is the only meaningful line item, at roughly **$13–15/month** ($0 for the first twelve
months if the account is still free-tier eligible). Everything else is effectively free at
parish scale: no NAT gateway, Lambda and CloudFront free tiers, HTTP API at about
$1/million requests, Cognito Essentials free under 10,000 monthly actives, SES at
$0.10/1,000 emails, a few cents of S3, pennies per deploy for the Fargate migration task, and
about $0.60/month for the stopped bastion's root volume (see *Inspecting the deployed
database*).

**Google Maps is $0/month at parish scale**, and not marginally. Every SKU used here gets
10,000 free calls per month and the allowances do not pool: Dynamic Maps, Geocoding and Place
Details Essentials are 10,000 each, and session-scoped Autocomplete is free without limit. A
Dynamic Maps event is billed once per `new google.maps.Map()` -- loading the library, panning,
zooming, adding markers and clustering are all free -- so the cost of Map View is *how often
somebody opens the page*, not how much they use it. At 400 people, 250 distinct addresses and
150 accounts opening the map four times a month, that is about 910 calls against 10,000, or
roughly 6% of the free tier.

Two consequences to keep in mind rather than rediscover. **Do not remount the map** -- every
remount is another billable load, which is why selection state in `app/src/pages/MapView.tsx`
lives above `<Map>` and nothing keys the instance on anything that changes. And the daily
**quota cap in the Google console is the real cost control**, not the referrer restriction: a
`Referer` header is trivially forged outside a browser. Past the free tier, map loads are $7
per 1,000, so 20,000 opens in a month would be $70; the per-organization switch is what keeps
that proportional to the parishes actually using it.

## Local development

Everything runs on a laptop with no AWS account at all.

```sh
npm install
docker compose up -d          # Postgres 17 on localhost:5432
npm run db:migrate:local      # the same Flyway image CD uses
npm run db:seed               # two parishes, families, people, special dates
```

Then `npm run dev` for the database, the API on :3000 and the SPA on :5173, or the two
servers separately:

```sh
npm run dev:api     # auth bypassed, photos on disk, no Cognito
npm run dev:app     # SPA on :5173, proxying /api to :3000
```

Neither needs any environment: the connection settings default to the docker-compose
Postgres, and `api`'s `dev` script supplies the local-only ones (`DEV_AUTH_EMAIL`,
`DB_PASSWORD`, `PHOTO_STORAGE=local`, `COGNITO_MODE=local`, `PUSH_MODE=local`). Any of them
can be overridden from your shell — `DEV_AUTH_EMAIL=someone@example.com npm run dev:api`.
The same goes for `GEOCODING_MODE`, which the script also defaults to `local`.

Google Maps is off by the same trick: with no keys the addresses save without coordinates,
the address fields are plain text inputs, and Map View reports itself unavailable. The two keys
go in **`api/.env`**, which is gitignored — copy the committed example and fill it in:

```sh
cp api/.env.example api/.env
```

```sh
GOOGLE_MAPS_BROWSER_KEY=AIza...
GOOGLE_MAPS_SERVER_KEY=AIza...
```

That is the whole list. **Nothing goes in `app/`**, because the browser key is served from
`GET /api/me` rather than baked into the bundle, and the Map ID is a constant in
`api/src/services/geocoding.ts` — it names a style rather than granting anything.

There is no dotenv dependency: the `dev` script passes Node's own
`--env-file-if-exists=.env`. One consequence worth knowing, because it is silent —
**`--env-file` does not override a variable already set in your shell**. So
`GOOGLE_MAPS_SERVER_KEY=... npm run dev` wins over the file, and a name the `dev` script
already exports (`DEV_AUTH_EMAIL`, `DB_PASSWORD`, `PHOTO_STORAGE`, `COGNITO_MODE`,
`PUSH_MODE`) cannot be set from the file at all. `GEOCODING_MODE` is deliberately *not* in
that list, so `GEOCODING_MODE=local` in `api/.env` can force Maps off with the keys still
present.

Two more things to do once, or the map will be correct and empty:

1. **Add `http://localhost:5173/*`** to the browser key's referrer restrictions in the Google
   console. Without it Maps refuses the script and the address field falls back to a plain
   input — which is the designed behaviour for a missing key, so nothing looks broken.
2. **Switch Map View on** for the parish, from *Churches* as the super administrator, and then
   backfill. Until the switch, `GET /api/me` returns a null key however many are set, `/map`
   redirects home and the Directory offers no link; and the switch alone populates nothing,
   because a parish with the map off was never geocoded:

   ```sh
   npm run geocode:backfill -w api            # every enabled parish
   npm run geocode:backfill -w api -- <orgId> # just one
   ```

   It reads `api/.env` too, and prints what it did — `{ refreshed, backfilled, dropped,
   failed }`. Editing an address through the UI and picking a suggestion is the other way, and
   the one that exercises Autocomplete. The same handler runs on the daily schedule in
   production, where it is invoked with `{"backfill": true}`.

`PUSH_MODE=local` makes push a no-op, so everything except the notification itself works
with no VAPID keys. The in-app bell is unaffected and is the part worth exercising locally;
Web Push needs `npm run build:app && npm run preview` (the only local server that runs the
service worker) and, on iOS, an app added to the home screen.

`DEV_AUTH_EMAIL` makes every request act as that person. The seed prints two addresses to
try: `paul@example.com` (an administrator) and the super administrator.

To exercise the real sign-in flow instead, set `DEV_AUTH_EMAIL` to the empty string (that
overrides the script's default, where unsetting it cannot), drop `VITE_DEV_AUTH`, and pass
`USER_POOL_ID` and `USER_POOL_CLIENT_ID` from the stack outputs:

```sh
DEV_AUTH_EMAIL= USER_POOL_ID=... USER_POOL_CLIENT_ID=... npm run dev:api
```

The local server then verifies real Cognito ID tokens with `aws-jwt-verify` and one-time
codes arrive in your actual inbox.

### Checks

```sh
npm run ci:check                        # Biome lint + format
npm run typecheck --workspaces
npm test                                # 1124 tests across api, app and infra
```

The API tests run against a real Postgres (`directory_test`, migrated automatically by
`api/test/globalSetup.ts`) rather than a fake query layer, because the inheritance
resolution view and the special-date CHECK constraints carry a lot of the logic. If
Postgres is not running they skip with a warning, so `npm test` still works offline.

### Inspecting the deployed database

The instance is in an isolated subnet and admits only the API Lambda, the Flyway task and a
bastion, so a database client cannot reach it directly. `npm run db:tunnel` forwards a local
port through the bastion with Session Manager, which needs the plugin the AWS CLI shells out
to:

```sh
brew install --cask session-manager-plugin
npm run db:tunnel
```

It prints the connection details — `localhost:15432`, database `directory`, user `postgres`
— and puts the master password on the clipboard rather than in your scrollback
(`SHOW_PASSWORD=1` prints it instead). Set SSL mode to **require**, not verify-full: the
server certificate is issued for the RDS hostname while the client connects to localhost, and
the parameter group will not accept a plaintext connection either.

The bastion is a `t4g.nano` that is normally stopped, so it costs its root volume and nothing
else. The script starts it and stops it again when you quit, including when it found the
bastion already running, so a second tunnel in another terminal loses its bastion when the
first one closes. It also stops itself after twenty idle minutes, so a script killed before
its trap ran cannot leave it billing. `LOCAL_PORT=5433 npm run db:tunnel` moves the local end
if something already holds the default.

## One-time setup

Most of this is already done in the account; these are the steps that are not part of a
normal `git push`.

1. **Install and bootstrap.**

   ```sh
   npm install
   npx --prefix infra cdk bootstrap aws://435432815368/us-east-1
   ```

   Everything deploys to **us-east-1**, where the `pauldev.io` SES identity and the
   `*.pauldev.io` ACM certificate already live.

2. **Confirm SES is ready.**

   ```sh
   aws sesv2 get-email-identity --email-identity pauldev.io --region us-east-1
   aws sesv2 get-account --region us-east-1 --query ProductionAccessEnabled
   ```

   If `ProductionAccessEnabled` is `false`, request production access from the SES console
   — until then, one-time codes only reach addresses verified manually in SES.

3. **Create the deploy role.** GitHub Actions runs every deploy, including the first, so
   the role it assumes has to exist before CI can do anything. It is created out-of-band
   rather than by the stack — see the comment block in the script for why:

   ```sh
   ./scripts/create-deploy-role.sh
   ```

   IAM calls only, and idempotent: re-run it to update the policy.

4. **Push to `main`.** CI runs the checks, then CD deploys the infrastructure, runs the
   Flyway migrations as a Fargate task, and publishes the SPA. There is nothing to do from
   a laptop — which matters if yours is managed and cannot publish assets to S3 or ECR.

5. **Create the Cognito user for the super admin.** `V3__bootstrap_super_admin.sql`
   inserts the `app_users` row with no `cognito_sub` (the database is private, so the row
   has to arrive with the migrations); this creates the matching sign-in:

   ```sh
   USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name ChurchDirectoryStack \
     --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
     --output text)

   aws cognito-idp admin-create-user \
     --user-pool-id "$USER_POOL_ID" \
     --username paul@paulschlueter.com \
     --user-attributes Name=email,Value=paul@paulschlueter.com \
                       Name=email_verified,Value=true \
                       Name=given_name,Value=Paul Name=family_name,Value=Schlueter \
     --message-action SUPPRESS \
     --region us-east-1
   ```

   On first sign-in the two are bound by email (`findOrBindAppUser` in `api/src/auth.ts`).
   Every account after this one is created from the admin screen, which calls
   `AdminCreateUser` and stores the subject immediately.

6. **Create the photo signing keypair.** CloudFront gates `/photos/*` on a trusted key
   group, and neither half of the keypair can be synthesised by CDK -- a private key in the
   template would be readable by anyone who can describe the stack.

   ```sh
   ./scripts/create-photo-key.sh
   ```

   Commit the public key it writes to `infra/photo-public-key.pem`, and store the private
   key as the `CLOUDFRONT_PRIVATE_KEY` repository secret. The deploy passes it to CDK,
   which puts it in a Lambda environment variable -- encrypted at rest and decrypted by the
   runtime with no network call, which is the only way a secret works in the Lambda's subnet
   (see *Why there is no NAT gateway*: from there, Secrets Manager and SSM are both
   unreachable).

   Re-running the script rotates the key. Deploy afterwards; browsers holding an old cookie
   get a 403 on photos until their next `GET /me`, which is one page load.

7. **Create the VAPID keypair for Web Push.** Optional, and skippable: without it prayer
   requests still work and the in-app bell still counts them, they just arrive without a
   notification on anyone's phone. The settings page says so in as many words.

   ```sh
   ./scripts/create-push-key.sh
   ```

   Commit the public key it writes to `infra/push-public-key.txt`, and store the private key
   as the `VAPID_PRIVATE_KEY` repository secret. Same reasoning as the photo key: CDK cannot
   generate a keypair, and a private key in the template would be readable by anyone who can
   describe the stack.

   The two can land in either order — the secret is set in GitHub, the public key arrives in a
   commit, and neither should be able to break a deploy that catches the other half in
   flight. Committing the public key *without* the secret does fail the synth on purpose
   (`readPushKeys` in `infra/bin/app.ts`): a public key browsers can subscribe against with no
   private key behind it is worse than no push at all. The reverse only warns, and deploys
   with push switched off until the commit lands.

   Re-running the script **rotates** the keypair and invalidates every existing subscription.
   Nobody has to clean anything up — a send to a stale subscription answers 410 and the row
   is deleted — but every member has to turn notifications back on from the settings page
   before they hear anything again.

8. **Set up Google Maps.** Optional and skippable: without it every parish's Map View stays
   unavailable, addresses save without coordinates, and the address fields are plain text
   inputs. The page and the settings say so in as many words. All of it is console work in one
   project, with nothing to wait for.

   - Create a Cloud project and **attach a billing account**. Maps Platform serves nothing
     without one even entirely inside the free tier, which is the step that surprises people.
     Set a budget alert while you are there; expected spend is $0.
   - Enable **Maps JavaScript API**, **Places API (New)** and **Geocoding API**. Nothing else --
     an unused enabled API is surface area on a key that gets scraped.
   - Create **two** keys, because the browser's cannot be kept secret and the server's can:
     - *directory browser* — restricted to **Websites**, referrers `https://directory.pauldev.io/*`
       (add `http://localhost:5173/*` for local work), and to the Maps JavaScript and Places
       APIs only.
     - *directory server* — **no** application restriction, because the Lambda leaves over IPv6
       from a shifting address, and restricted to the Geocoding API only. This is why it has to
       be a second key: one with no application restriction must never reach a browser.
   - Set **daily quota caps** per API (APIs & Services → Quotas). This is the control that
     actually bounds a leaked browser key. Around 2,000 map loads, 500 Places requests and
     1,000 geocodes per day is far above real use and well under a painful bill.
   - Create a **Map ID** (Map Management → JavaScript, **Vector**) and associate it with a
     **map style**. Required, not cosmetic: Advanced Markers do not render without a Map ID.
     The style is where the base map gets muted toward the parish's own colours -- it is edited
     in the console and takes effect with no deploy. **Paste `docs/map-style.json` into the
     style editor's JSON tab** rather than building one by hand -- that is the parish's own
     palette, and `docs/map-style.md` says why each choice is there. The Map ID itself is
     **not** a secret and is a constant in `api/src/services/geocoding.ts`; a deployment
     against a different Google project needs that line changed.
   - Store the two keys as repository secrets: `GOOGLE_MAPS_BROWSER_KEY` and
     `GOOGLE_MAPS_SERVER_KEY`. Setting only one fails the synth on purpose (`readMapsConfig` in
     `infra/bin/app.ts`) -- with the browser key missing the map cannot load, and with the
     server key missing no address ever gets a pin, and both look like a working deployment
     until somebody opens the page.

   Then switch Map View on for a parish from *Churches*, and invoke the refresh function with
   `{"backfill": true}` to geocode the addresses it already has. The flag alone populates
   nothing.

9. **Create the first parish** from *Churches*, then invite an administrator for it.

## CI/CD

`ci.yml` runs on every pull request and on pushes to `main`: Biome, typecheck, an SPA
build, then the full test suite against a Postgres service container. The build comes
before the tests because `app/test/serviceWorker.test.ts` reads `app/dist/sw.js`.

`deploy.yml` runs after CI passes on `main` (and can be dispatched manually). It deploys
the infrastructure, runs the Flyway migrations as a one-off Fargate task and fails if they
do, builds the SPA with the pool ids from the stack outputs, publishes it to S3, and
invalidates CloudFront. Migrations run after the infrastructure and before the SPA is
published, so the frontend is never serving against a schema that has not been applied.

## Layout

```
app/    React + Vite SPA
api/    Hono router (one Lambda) and the local dev server
infra/  CDK v2, one stack
db/     Flyway migrations, baked into an image for the migration task
```

`api/src/types.ts` holds the Zod schemas and shared helpers; the SPA imports them through
the `@shared` alias, so both sides agree on every payload shape and the same validation
runs in the browser and on the server.
