# Architecture Patterns
Similar to https://github.com/pschluet/secure-transfer

# Architecture Overview
- **Folder structure:** seperate folders/package.json for app, api, and infra
- **Infrastructure:** use AWS CDK for infrastructure as code
- **Frontend:** React + Vite SPA, hosted on a private S3 bucket behind CloudFront.
- **Auth:** Cognito User Pool (Essentials tier), email-OTP passwordless sign-in for everyone.
  Admin is a user in the `Admins` group.
- **API:** API Gateway HTTP API with a Cognito JWT authorizer, one Lambda (Hono router). CloudFront routes `/api/*` to it, so the SPA and API share an origin
  (no CORS needed in production).
- **Storage:** files are uploaded directly to S3 via presigned URLs — no zipping, no server
  bottleneck.
- **Database:** Postgres database. Requirements are defined in database.md in this repo. Use Flyway for the database migrations.
- **Retention:** files and data are kept forever (`RemovalPolicy.RETAIN` on the files
  bucket)
- **Email:** SES, from `no-reply@pauldev.io` — used for OTP codes (via Cognito).
- **Tags:** all resources tagged with "all-saints" so I can track cost for this project
- **CI/CD:** CI checks should run on PR creation and on push/merge to main (lint, format, unit tests). CD should run after the CI checks on push/merge to main. CD includes deploying the api, the front-end, the infra, and running the database migrations. Use Github Actions.
- **Local Development:** I should be able to fully run the app locally so I can test on my laptop.
- **Testing:** App should have a unit test suite
