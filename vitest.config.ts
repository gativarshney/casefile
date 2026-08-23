import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Property-based tests explore a large space; a default-timeout flake would
    // undermine the determinism claims these tests exist to make.
    testTimeout: 30_000,
    env: { CASEFILE_LLM_LIVE: "0" },
  },
});
