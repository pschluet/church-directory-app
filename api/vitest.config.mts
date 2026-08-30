import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // The database is created and migrated once, here, rather than per file.
    globalSetup: ["./test/globalSetup.ts"],
    // The database-backed suites truncate between tests, so they must not run
    // concurrently with each other.
    fileParallelism: false,
    // Injected here rather than read from a real .env so every test file sees
    // them before its top-level imports run -- db.ts / photos.ts / cognito.ts
    // read process.env at module load.
    env: {
      DB_HOST: "localhost",
      DB_PORT: "5432",
      DB_NAME: "directory_test",
      DB_USER: "postgres",
      DB_AUTH: "password",
      DB_PASSWORD: "postgres",
      // No AWS calls from tests: photos are presigned to local paths and
      // Cognito account creation is stubbed.
      PHOTO_STORAGE: "local",
      COGNITO_MODE: "local",
      EMAIL_MODE: "local",
      PHOTOS_BUCKET: "test-photos-bucket",
      USER_POOL_ID: "us-east-1_testpool",
      USER_POOL_CLIENT_ID: "test-client-id",
      AWS_REGION: "us-east-1",
      SITE_URL: "https://directory.test.example",
      FROM_EMAIL: "no-reply@test.example",
    },
  },
});
