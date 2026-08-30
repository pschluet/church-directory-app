# Flyway plus this repo's migrations, baked together so the SQL is versioned
# with the commit that deploys it. Run as a one-off ECS Fargate task by the CD
# workflow (the RDS instance is private, so CI cannot reach it directly) and
# locally against the Docker Postgres via scripts/migrate-local.sh.
FROM flyway/flyway:11-alpine

COPY migrations /flyway/sql

# Connection details, credentials and placeholders all arrive as FLYWAY_* env
# vars so nothing sensitive is baked into the image.
ENV FLYWAY_LOCATIONS=filesystem:/flyway/sql \
    FLYWAY_CONNECT_RETRIES=10 \
    FLYWAY_BASELINE_ON_MIGRATE=false

CMD ["migrate"]
