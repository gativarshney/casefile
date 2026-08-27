import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Property-based tests explore a large space; a default-timeout flake would
    // undermine the determinism claims these tests exist to make.
    testTimeout: 30_000,
    // Fixtures generate a world and fit a model, which is slower than the default
    // hook budget on a shared CI runner.
    hookTimeout: 120_000,
    env: { CASEFILE_LLM_LIVE: "0" },
  },
});
