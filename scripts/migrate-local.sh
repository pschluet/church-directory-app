#!/usr/bin/env bash
# Run the exact same Flyway image against the local Docker Postgres, so local
# and deployed schemas come from one source.
set -euo pipefail

cd "$(dirname "$0")/.."

SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-paul@paulschlueter.com}"

docker build -q -t church-directory-migrations ./db

# host.docker.internal reaches the compose Postgres published on :5432.
docker run --rm \
  -e FLYWAY_URL="jdbc:postgresql://host.docker.internal:5432/directory" \
  -e FLYWAY_USER=postgres \
  -e FLYWAY_PASSWORD=postgres \
  -e FLYWAY_PLACEHOLDERS_APPROLE=directory_app \
  -e FLYWAY_PLACEHOLDERS_APPROLELOCALPASSWORD=directory_app \
  -e FLYWAY_PLACEHOLDERS_LOCAL=true \
  -e FLYWAY_PLACEHOLDERS_SUPERADMINEMAIL="$SUPER_ADMIN_EMAIL" \
  church-directory-migrations migrate
