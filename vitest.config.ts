import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep pre-Wave-6 same-session follow-up fixtures working unless a test
    // opts into product isolated-pi default (see tests/setup-legacy-session.ts).
    setupFiles: ["./tests/setup-legacy-session.ts"],
  },
});
