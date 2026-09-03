# Church Directory

A multi-tenant parish directory at **directory.pauldev.io**. Members keep their own
contact details up to date, manage their family — including children and others who have
no account of their own — record birthdays, name days and wedding anniversaries, and
browse or search everyone else in their parish. Phone numbers are tappable to call.

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
- **Installable:** a PWA, so the directory can live on a home screen — this is the app
  someone opens standing in the parking lot after a service, and one tap beats recalling a
  URL. It is also what would make Web Push possible later, since iOS only delivers it to a
  site added to the home screen. The service worker (`vite-plugin-pwa`, Workbox
  `generateSW`) precaches the app shell and **nothing else**: `workbox.runtimeCaching` is
  empty, so `/api/*`, `/photos/*` and the presigned S3 uploads all fall straight through
  to the network. That is the same decision as *Client cache* above, for the same reason —
  a `runtimeCaching` entry would put the parish's phone numbers on disk in the Cache API
  instead of `localStorage`, which is no better. `app/test/serviceWorker.test.ts` asserts
  it against the built `dist/sw.js`, because nothing in the app would look different if it
  regressed. The icons in `app/public` are generated from `favicon.svg`; see
  `app/pwa-assets.config.js` for the command. One deploy consequence: `sw.js` must never
  be uploaded `immutable`, or every installed copy is pinned to that build with no address
  bar to reload from.
- **Auth:** Cognito user pool (Essentials tier), email-OTP passwordless sign-in. Self
  sign-up is disabled; administrators invite people and the API sends the invitation
  through SES. Cognito's own invitation is suppressed, because a custom Cognito template
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
- **Roles:** Super Admin, Admin and User, stored in Postgres rather than in Cognito
  groups — a group cannot express which organization an admin is scoped to.
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
gateway and no interface endpoints exist.

### Cost

RDS is the only meaningful line item, at roughly **$13–15/month** ($0 for the first twelve
months if the account is still free-tier eligible). Everything else is effectively free at
parish scale: no NAT gateway, Lambda and CloudFront free tiers, HTTP API at about
$1/million requests, Cognito Essentials free under 10,000 monthly actives, SES at
$0.10/1,000 emails, a few cents of S3, and pennies per deploy for the Fargate migration
task.

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
`DB_PASSWORD`, `PHOTO_STORAGE=local`, `COGNITO_MODE=local`). Any of them can be overridden
from your shell — `DEV_AUTH_EMAIL=someone@example.com npm run dev:api`.

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
npm test                                # 459 tests across api, app and infra
```

The API tests run against a real Postgres (`directory_test`, migrated automatically by
`api/test/globalSetup.ts`) rather than a fake query layer, because the inheritance
resolution view and the special-date CHECK constraints carry a lot of the logic. If
Postgres is not running they skip with a warning, so `npm test` still works offline.

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
   runtime with no network call, which is the only way a secret works in this VPC (see
   *Why there is no NAT gateway*: Secrets Manager and SSM are both unreachable).

   Re-running the script rotates the key. Deploy afterwards; browsers holding an old cookie
   get a 403 on photos until their next `GET /me`, which is one page load.

7. **Create the first parish** from *Churches*, then invite an administrator for it.

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
