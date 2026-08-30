import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Synthesizing a stack with a Docker image asset and bundled Lambdas is
    // slower than a typical unit test.
    testTimeout: 120_000,
  },
});
