import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      thresholds: {
        "src/shared/ranges.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "src/shared/state-machine.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
